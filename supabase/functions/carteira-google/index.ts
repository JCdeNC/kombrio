// Fonction Supabase « carteira-google » : fabrique le lien « Adicionar à Carteira do Google »
// pour le QR d'un client. Elle signe le pass avec la clé du compte de service Google,
// qui ne doit jamais se trouver dans l'app.
//
// Secrets à définir dans Supabase (Edge Functions → Secrets) :
//   GOOGLE_WALLET_ISSUER_ID : l'identifiant émetteur (Google Pay & Wallet Console)
//   GOOGLE_WALLET_SA        : le contenu complet du fichier JSON du compte de service
// L'app l'appelle avec sa clé publique (en-tête apikey) : le client n'a pas de compte,
// c'est le token secret du séjour qui fait foi.

const APP = 'https://app.kombrio.com.br';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://pdgmmucyzixfxzmrtwhh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xAkmmV2JSogQ7F45fp9OAQ_gqGhd6cb'; // clé publique, comme dans js/config.js
const ORIGINS = [APP, 'http://localhost:8765'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, content-type, authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const LABELS: Record<string, Record<string, string>> = {
  pt: { lang: 'pt-BR', sub: 'Cliente', until: 'Válido até', people: 'Pessoas', guide: 'Guia', link: 'Parceiros e ofertas', scan: 'Mostre no caixa' },
  en: { lang: 'en', sub: 'Client', until: 'Valid until', people: 'People', guide: 'Guide', link: 'Partners and offers', scan: 'Show at checkout' },
  es: { lang: 'es', sub: 'Cliente', until: 'Válido hasta', people: 'Personas', guide: 'Guía', link: 'Socios y ofertas', scan: 'Muéstralo en caja' },
  fr: { lang: 'fr', sub: 'Client', until: 'Valable jusqu\'au', people: 'Personnes', guide: 'Guide', link: 'Partenaires et offres', scan: 'À montrer en caisse' },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Décalage horaire de la ville à une date donnée, ex. « -03:00 ».
function offset(timeZone: string, day: string) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${day}T12:00:00Z`)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : '+00:00';
}

function today(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()); // AAAA-MM-JJ
}

const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function signJwt(payload: unknown, pem: string) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    return await handle(req);
  } catch (e) {
    // Message d'erreur seul (jamais le contenu des secrets), pour comprendre une panne.
    return json({ error: 'crash', step: (e as Error & { step?: string }).step ?? '', detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});

async function handle(req: Request) {
  const issuer = Deno.env.get('GOOGLE_WALLET_ISSUER_ID');
  const saRaw = Deno.env.get('GOOGLE_WALLET_SA');
  if (!issuer || !saRaw) return json({ error: 'not_configured' }, 503);

  const params = new URL(req.url).searchParams;
  const token = params.get('token') ?? '';
  const L = LABELS[params.get('lang') ?? 'pt'] ?? LABELS.pt;
  if (!/^[A-Za-z0-9-]{8,80}$/.test(token)) return json({ error: 'qr' }, 404);

  // Même vérification que la page du client : le séjour doit exister.
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/stay_public`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token }),
  });
  const d = r.ok ? await r.json() : null;
  if (!d?.stay) return json({ error: 'qr' }, 404);
  const { stay, guide, city } = d;
  const tz = city.timezone || 'UTC';
  if (today(tz) > stay.end_day) return json({ error: 'expired' }, 410);

  let sa;
  try { sa = JSON.parse(saRaw); } catch (e) { throw Object.assign(new Error(`secret JSON illisible (${saRaw.length} caractères)`), { step: 'sa' }); }
  if (!sa.client_email || !sa.private_key) throw Object.assign(new Error('client_email ou private_key absent du secret'), { step: 'sa' });
  const t = (value: string) => ({ defaultValue: { language: L.lang, value } });
  const [y, m, dd] = String(stay.end_day).split('-');
  const classId = `${issuer}.kombrio_cliente`;

  const object = {
    id: `${issuer}.stay_${token}`,
    classId,
    state: 'ACTIVE',
    hexBackgroundColor: '#007F65',
    logo: { sourceUri: { uri: `${APP}/icon-512.png` }, contentDescription: t('Kombrio') },
    cardTitle: t('Kombrio'),
    subheader: t(L.sub),
    header: t(stay.client),
    textModulesData: [
      { id: 'validade', header: L.until, body: `${dd}/${m}/${y}` },
      { id: 'pessoas', header: L.people, body: String(stay.people) },
      { id: 'guia', header: L.guide, body: guide?.name ?? '' },
    ],
    // Texte court sous le QR (sinon Google affiche l'adresse coupée).
    barcode: { type: 'QR_CODE', value: `${APP}/partner/#/s/${token}`, alternateText: L.scan },
    validTimeInterval: {
      start: { date: `${stay.start_day}T00:00:00${offset(tz, stay.start_day)}` },
      end: { date: `${stay.end_day}T23:59:59${offset(tz, stay.end_day)}` },
    },
    linksModuleData: { uris: [{ id: 'app', uri: `${APP}/client/#/c/${token}`, description: L.link }] },
  };

  const jwt = await signJwt({
    iss: sa.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: ORIGINS,
    payload: { genericClasses: [{ id: classId }], genericObjects: [object] },
  }, sa.private_key);

  return json({ url: `https://pay.google.com/gp/v/save/${jwt}` });
}
