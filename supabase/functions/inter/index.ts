// Fonction Supabase « inter » : seule porte entre Kombrio et l'API Banco Inter (Pix).
// Lot 0 (11/11/2026) : vérifier la connexion — jeton OAuth avec le certificat client (mTLS), puis lecture du solde.
// Seul un administrateur connecté peut l'appeler. Les clés ne sortent jamais de cette fonction.
//
// Secrets à définir dans Supabase › Edge Functions › Secrets :
//   INTER_ENV            « sandbox » ou « production »
//   INTER_CLIENT_ID      Client Id de l'intégration
//   INTER_CLIENT_SECRET  Client Secret de l'intégration
//   INTER_CERT           contenu du fichier .crt (texte « -----BEGIN CERTIFICATE----- … » ou le même en base64)
//   INTER_KEY            contenu du fichier .key (texte « -----BEGIN … PRIVATE KEY----- … » ou le même en base64)
//   INTER_ACCOUNT        (facultatif) numéro de compte courant, seulement si l'intégration a plusieurs comptes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = (path: string, init: RequestInit = {}) =>
  fetch(`${URL_}${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });

const ENV = (Deno.env.get('INTER_ENV') || 'sandbox').toLowerCase();
const BASE = ENV === 'production' ? 'https://cdpj.partners.bancointer.com.br' : 'https://cdpj-sandbox.partners.uatinter.co';
const SCOPES = 'extrato.read pagamento-pix.write pagamento-pix.read webhook-banking.write webhook-banking.read';

// Un PEM peut être collé tel quel ou encodé en base64 (une seule ligne, plus simple à coller).
function pem(name: string): string | null {
  const raw = (Deno.env.get(name) || '').trim();
  if (!raw) return null;
  if (raw.includes('-----BEGIN')) return raw.replace(/\\n/g, '\n');
  try { return new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/\s+/g, '')), (c) => c.charCodeAt(0))); } catch { return null; }
}

// Client HTTP qui présente le certificat Inter (mTLS). Deux noms d'options selon la version de Deno.
let client: unknown = null;
let mtlsMode = '';
function httpClient(): unknown {
  if (client) return client;
  const cert = pem('INTER_CERT'); const key = pem('INTER_KEY');
  if (!cert || !key) throw new Error('missing_cert');
  // deno-lint-ignore no-explicit-any
  const D = Deno as any;
  if (typeof D.createHttpClient !== 'function') throw new Error('mtls_unsupported: Deno.createHttpClient absent');
  const errs: string[] = [];
  for (const [mode, opts] of [['cert/key', { cert, key }], ['certChain/privateKey', { certChain: cert, privateKey: key }]] as const) {
    try { client = D.createHttpClient(opts); mtlsMode = mode; return client; } catch (e) { errs.push(`${mode}: ${(e as Error).message}`); }
  }
  throw new Error(`mtls_unsupported: ${errs.join(' | ')}`);
}

// Jeton OAuth : valable 1 h, gardé en mémoire et réutilisé (Inter limite à 5 demandes par minute).
let token: { value: string; until: number; scope: string } | null = null;
async function getToken(): Promise<string> {
  if (token && Date.now() < token.until) return token.value;
  const id = Deno.env.get('INTER_CLIENT_ID'); const secret = Deno.env.get('INTER_CLIENT_SECRET');
  if (!id || !secret) throw new Error('missing_client');
  const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials', scope: SCOPES });
  // deno-lint-ignore no-explicit-any
  const r = await fetch(`${BASE}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, client: httpClient() } as any);
  const text = await r.text();
  if (!r.ok) throw new Error(`token ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000, scope: j.scope || '' };
  return token.value;
}

async function inter(path: string, init: RequestInit = {}) {
  const t = await getToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> || {}) };
  const acc = Deno.env.get('INTER_ACCOUNT'); if (acc) headers['x-conta-corrente'] = acc;
  // deno-lint-ignore no-explicit-any
  const r = await fetch(`${BASE}${path}`, { ...init, headers, client: httpClient() } as any);
  const text = await r.text();
  let data: unknown = text; try { data = JSON.parse(text); } catch { /* texte brut */ }
  return { status: r.status, ok: r.ok, data };
}

/* ---------- Lot 2 : virement d'un guide par Pix Inter ---------- */
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// Statuts Inter : « payé » seulement avec un E2E et un statut de réussite ; échec = erreur, annulation, refus…
const OK_ST = /PAGO|REALIZADO|EFETIVADO|PROCESSADO|CONCLU|SUCESSO|LIQUIDADO|APROVADO/i;
const KO_ST = /ERRO|CANCEL|REPROV|DEVOLV|EXPIR|REJEIT|NAO_/i;

async function one(path: string) { const r = await db(path); const j = await r.json().catch(() => []); return Array.isArray(j) ? j[0] : null; }
async function patchPayout(id: string, fields: Record<string, unknown>) {
  await db(`/rest/v1/payouts?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
}
// Clé Pix au format attendu par Inter (CPF/CNPJ en chiffres, téléphone +55…, e-mail en minuscules).
function pixKeyFor(g: Record<string, string>): string {
  const k = String(g.pix_key || '').trim(); const type = String(g.pix_key_type || '');
  if (type === 'cpf' || type === 'cnpj') return k.replace(/\D/g, '');
  if (type === 'phone') { const d = k.replace(/\D/g, ''); return '+' + (d.startsWith('55') ? d : '55' + d); }
  if (type === 'email') return k.toLowerCase();
  return k;
}
// Titulaire : le CPF/CNPJ renvoyé par la banque (parfois masqué « ***.456.789-** ») comparé à celui du guide.
function holderMatches(doc: string, expected: string): boolean | null {
  const d = String(doc || '').replace(/[^0-9*]/g, ''); const e = String(expected || '').replace(/\D/g, '');
  if (!d || !e) return null;
  if (d.length !== e.length) return false;
  for (let i = 0; i < d.length; i++) if (d[i] !== '*' && d[i] !== e[i]) return false;
  return true;
}

async function payoutSend(id: string, adminJwt: string) {
  const p = await one(`/rest/v1/payouts?id=eq.${id}&select=id,num,guide_id,amount_cents,status,inter_codigo,inter_idem`);
  if (!p) return { ok: false, reason: 'payout' };
  if (p.status !== 'in_progress') return { ok: false, reason: 'status' };
  if (p.inter_codigo) return payoutCheck(id, adminJwt);   // déjà envoyé : on suit, on ne renvoie jamais
  const g = await one(`/rest/v1/guides?id=eq.${p.guide_id}&select=name,pix_key,pix_key_type,pix_status`);
  if (!g || !g.pix_key) return { ok: false, reason: 'pix_key' };
  if (g.pix_status !== 'verified') return { ok: false, reason: 'pix' };
  const cents = Number(p.amount_cents || 0);
  if (!(cents > 0)) return { ok: false, reason: 'amount' };
  await patchPayout(id, { inter_status: 'ENVIANDO', inter_sent_at: new Date().toISOString(), inter_error: null });
  // Idempotence : la même clé (l'identifiant du virement) à chaque essai → Inter ne paie jamais deux fois.
  const r = await inter('/banking/v2/pix', { method: 'POST', headers: { 'x-id-idempotente': p.inter_idem || id },
    body: JSON.stringify({ valor: cents / 100, descricao: `Kombrio repasse nº ${p.num}`, destinatario: { tipo: 'CHAVE', chave: pixKeyFor(g) } }) });
  const d = (r.data || {}) as Record<string, unknown>;
  if (!r.ok || !d.codigoSolicitacao) {
    await patchPayout(id, { inter_status: 'ERRO_ENVIO', inter_error: JSON.stringify(r.data).slice(0, 500) });
    return { ok: false, reason: 'inter', status: r.status, detail: r.data };
  }
  await patchPayout(id, { inter_codigo: d.codigoSolicitacao, inter_status: String(d.tipoRetorno || 'ENVIADO') });
  return payoutCheck(id, adminJwt);
}

async function payoutCheck(id: string, adminJwt: string) {
  const p = await one(`/rest/v1/payouts?id=eq.${id}&select=id,guide_id,status,inter_codigo`);
  if (!p || !p.inter_codigo) return { ok: false, reason: 'not_sent' };
  const g = await one(`/rest/v1/guides?id=eq.${p.guide_id}&select=cpf,cnpj,tax_kind`);
  const r = await inter(`/banking/v2/pix/${p.inter_codigo}`);
  if (!r.ok) return { ok: false, reason: 'inter', status: r.status, detail: r.data };
  const tx = ((r.data || {}) as Record<string, Record<string, unknown>>).transacaoPix || {};
  const st = String(tx.status || ''); const e2e = String(tx.endToEnd || '');
  const rec = (tx.recebedor || {}) as Record<string, string>;
  const holder = holderMatches(rec.cpfCnpj, g?.tax_kind === 'cnpj' ? g?.cnpj : g?.cpf);
  const done = !!e2e && OK_ST.test(st) && !KO_ST.test(st);
  await patchPayout(id, { inter_status: st || 'ENVIADO', inter_e2e: e2e || null, inter_recebedor_nome: rec.nome || null,
    inter_recebedor_doc: rec.cpfCnpj || null, inter_holder_ok: holder, inter_checked_at: new Date().toISOString(),
    inter_error: Array.isArray(tx.erros) && (tx.erros as unknown[]).length ? JSON.stringify(tx.erros).slice(0, 500) : null });
  // Échec chez Inter : le virement reste « en cours » et pourra être renvoyé (nouvelle clé d'idempotence).
  if (KO_ST.test(st)) await patchPayout(id, { inter_codigo: null, inter_idem: crypto.randomUUID(), inter_status: `FALHOU ${st}`.slice(0, 60) });
  let paid = p.status === 'paid';
  if (done && !paid) {
    // « Payé » par la fonction habituelle de l'admin (même journal, mêmes e-mails), avec l'E2E comme référence.
    const c = await fetch(`${URL_}/rest/v1/rpc/confirm_payout`, { method: 'POST',
      headers: { apikey: ANON, Authorization: adminJwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_payout: id, p_reference: e2e }) });
    paid = c.ok && (await c.json().catch(() => false)) === true;
  }
  return { ok: true, status: st, e2e, done, paid, holder_ok: holder, recebedor: rec.nome || null, failed: KO_ST.test(st) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    // Qui appelle ? Il doit être administrateur.
    const me = await (await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: req.headers.get('Authorization') ?? '' } })).json();
    if (!me?.id) return json({ error: 'auth' }, 401);
    const prof = await (await db(`/rest/v1/profiles?id=eq.${me.id}&select=role`)).json();
    if (prof?.[0]?.role !== 'admin') return json({ error: 'forbidden' }, 403);

    const body = await req.json().catch(() => ({}));
    const { action } = body;
    const adminJwt = req.headers.get('Authorization') ?? '';

    // Lot 2 (12/11/2026) : envoyer le virement d'un guide par Pix Inter, puis suivre son statut.
    if (action === 'payout_send' || action === 'payout_check') {
      const id = String(body.payout || '');
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'payout' }, 400);
      return json(action === 'payout_send' ? await payoutSend(id, adminJwt) : await payoutCheck(id, adminJwt));
    }
    // Essai dans le sandbox seulement : un Pix vers une clé donnée, sans toucher aux virements (pour voir les réponses d'Inter).
    if (action === 'pix_test') {
      if (ENV !== 'sandbox') return json({ error: 'sandbox_only' }, 403);
      const r = await inter('/banking/v2/pix', { method: 'POST', headers: { 'x-id-idempotente': crypto.randomUUID() },
        body: JSON.stringify({ valor: Number(body.valor || 0.01), descricao: 'Kombrio teste sandbox', destinatario: { tipo: 'CHAVE', chave: String(body.chave || '') } }) });
      const cod = (r.data as Record<string, unknown>)?.codigoSolicitacao as string | undefined;
      const st = cod ? await inter(`/banking/v2/pix/${cod}`) : null;
      return json({ envio: r, consulta: st });
    }
    if (action === 'ping') {
      // Étape par étape, pour savoir exactement où ça bloque.
      const out: Record<string, unknown> = { env: ENV, base: BASE };
      try { httpClient(); out.mtls = mtlsMode; } catch (e) { return json({ ...out, ok: false, step: 'mtls', error: (e as Error).message }); }
      try { await getToken(); out.token = 'ok'; out.scope = token?.scope; } catch (e) { return json({ ...out, ok: false, step: 'token', error: (e as Error).message }); }
      const s = await inter('/banking/v2/saldo');
      return json({ ...out, ok: s.ok, step: 'saldo', status: s.status, saldo: s.data });
    }
    return json({ error: 'action' }, 400);
  } catch (e) {
    return json({ error: 'crash', detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
