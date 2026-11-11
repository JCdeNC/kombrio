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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    // Qui appelle ? Il doit être administrateur.
    const me = await (await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: req.headers.get('Authorization') ?? '' } })).json();
    if (!me?.id) return json({ error: 'auth' }, 401);
    const prof = await (await db(`/rest/v1/profiles?id=eq.${me.id}&select=role`)).json();
    if (prof?.[0]?.role !== 'admin') return json({ error: 'forbidden' }, 403);

    const { action } = await req.json().catch(() => ({}));
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
