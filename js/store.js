// Données du prototype, en MODE DÉMO : tout reste dans ce navigateur (localStorage).
// Les fonctions sont asynchrones pour être remplacées plus tard, une à une,
// par des appels Supabase (voir supabase/schema.sql) sans toucher aux écrans.
import { randomToken, todayIn, addDays, stayIsValid } from './util.js';

export const DEMO = true;
export const SHARE = { platform: 0.2, guide: 0.8 };
// Types de partenaires : un libellé par langue dans js/lang/ (clé ptype.xxx).
export const PARTNER_TYPES = ['restaurant', 'shop'];

const KEY = 'kombrio-demo-v2';
const ME_KEY = 'kombrio-demo-guide';

const id = (prefix) => `${prefix}_${randomToken(8)}`;
const now = () => new Date().toISOString();

function seed() {
  const city = {
    id: 'rio', name: 'Rio de Janeiro', country: 'BR', currency: 'BRL', timezone: 'America/Sao_Paulo',
    methods: ['pix', 'transfer'], licenseLabel: 'Cadastur',
    payTo: 'Pix : exemplo-pix@kombrio.com.br · Banco 000, ag. 0000, c/c 00000-0 (exemplo)',
  };
  const today = todayIn(city.timezone);
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const guides = [
    { id: 'g_marcos', cityId: 'rio', name: 'Marcos Silva', phone: '+55 21 90000-0001', license: '00.000000.00.0001-0', status: 'validated', createdAt: daysAgo(30) },
    { id: 'g_ana', cityId: 'rio', name: 'Ana Costa', phone: '+55 21 90000-0002', license: '00.000000.00.0002-0', status: 'pending', createdAt: daysAgo(1) },
  ];
  const partners = [
    { id: 'p_boteco', cityId: 'rio', type: 'restaurant', name: 'Boteco da Praia', area: 'Copacabana', offer: 'Uma caipirinha por pessoa', token: 'P-boteco-demo', status: 'active' },
    { id: 'p_cantina', cityId: 'rio', type: 'restaurant', name: 'Cantina Santa Teresa', area: 'Santa Teresa', offer: '', token: 'P-cantina-demo', status: 'active' },
    { id: 'p_sabor', cityId: 'rio', type: 'shop', name: 'Ateliê do Morro', area: 'Vidigal', offer: '10 % de desconto no artesanato', token: 'P-sabor-demo', status: 'active' },
  ];
  const stays = [
    { id: 's_martin', guideId: 'g_marcos', client: 'Famille Martin', people: 4, start: addDays(today, -3), end: addDays(today, 4), token: 'C-martin-demo', createdAt: daysAgo(4) },
    { id: 's_smith', guideId: 'g_marcos', client: 'Smith group', people: 6, start: addDays(today, -20), end: addDays(today, -15), token: 'C-smith-demo', createdAt: daysAgo(21) },
  ];
  const visits = [
    { id: 'v_1', stayId: 's_smith', partnerId: 'p_cantina', guideId: 'g_marcos', at: daysAgo(18), people: 6, offerGiven: false,
      status: 'paid', amount: 90, method: 'pix', receipt: null, declaredAt: daysAgo(17), receivedAt: daysAgo(16), payoutId: 'po_1' },
    { id: 'v_2', stayId: 's_martin', partnerId: 'p_boteco', guideId: 'g_marcos', at: daysAgo(2), people: 4, offerGiven: true,
      status: 'received', amount: 50, method: 'pix', receipt: null, declaredAt: daysAgo(2), receivedAt: daysAgo(1) },
    { id: 'v_3', stayId: 's_martin', partnerId: 'p_sabor', guideId: 'g_marcos', at: daysAgo(1), people: 4, offerGiven: true,
      status: 'declared', amount: 60, method: 'transfer', receipt: null, declaredAt: daysAgo(1) },
    { id: 'v_4', stayId: 's_martin', partnerId: 'p_cantina', guideId: 'g_marcos', at: daysAgo(0.2), people: 4, offerGiven: false,
      status: 'visited' },
  ];
  const payouts = [{ id: 'po_1', guideId: 'g_marcos', amount: 72, at: daysAgo(10), visitIds: ['v_1'] }];
  return { cities: [city], guides, partners, stays, visits, payouts };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* données illisibles : on repart de la démo */ }
  const data = seed();
  save(data);
  return data;
}

function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {
    throw new Error('storage-full');
  }
}

function mutate(fn) {
  const data = load();
  const result = fn(data);
  save(data);
  return result;
}

export async function resetDemo() {
  try { localStorage.removeItem(KEY); localStorage.removeItem(ME_KEY); } catch { /* rien */ }
}

/* ---------- Villes ---------- */
export async function listCities() { return load().cities; }
export async function getCity(cityId) { return load().cities.find((c) => c.id === cityId); }
export async function addCity(city) {
  return mutate((d) => {
    const c = { ...city, id: id('city') };
    d.cities.push(c);
    return c;
  });
}
export async function updateCity(cityId, patch) {
  return mutate((d) => Object.assign(d.cities.find((c) => c.id === cityId), patch));
}

/* ---------- Guides ---------- */
export async function listGuides(status) {
  return load().guides.filter((g) => !status || g.status === status);
}
export async function getGuide(guideId) { return load().guides.find((g) => g.id === guideId); }
export async function addGuide(guide) {
  return mutate((d) => {
    const g = { ...guide, id: id('g'), status: 'pending', createdAt: now() };
    d.guides.push(g);
    return g;
  });
}
export async function setGuideStatus(guideId, status) {
  return mutate((d) => { d.guides.find((g) => g.id === guideId).status = status; });
}

// Connexion du guide : en démo, on choisit simplement son nom.
export async function currentGuide() {
  let me = null;
  try { me = localStorage.getItem(ME_KEY); } catch { /* rien */ }
  return me ? getGuide(me) : null;
}
export async function loginGuide(guideId) { try { localStorage.setItem(ME_KEY, guideId); } catch { /* rien */ } }
export async function logoutGuide() { try { localStorage.removeItem(ME_KEY); } catch { /* rien */ } }

/* ---------- Partenaires ---------- */
export async function listPartners(cityId) {
  return load().partners.filter((p) => !cityId || p.cityId === cityId);
}
export async function getPartner(partnerId) { return load().partners.find((p) => p.id === partnerId); }
export async function partnerByToken(token) { return load().partners.find((p) => p.token === token); }
export async function addPartner(partner) {
  return mutate((d) => {
    const p = { ...partner, id: id('p'), token: `P-${randomToken(16)}`, status: 'active' };
    d.partners.push(p);
    return p;
  });
}
export async function updatePartner(partnerId, patch) {
  return mutate((d) => Object.assign(d.partners.find((p) => p.id === partnerId), patch));
}
// Si le QR Partenaire a été copié : on en fabrique un nouveau, l'ancien ne marche plus.
export async function renewPartnerToken(partnerId) {
  return updatePartner(partnerId, { token: `P-${randomToken(16)}` });
}

/* ---------- Séjours ---------- */
export async function addStay(guideId, stay) {
  return mutate((d) => {
    const s = { ...stay, id: id('s'), guideId, token: `C-${randomToken(20)}`, createdAt: now() };
    d.stays.push(s);
    return s;
  });
}
export async function listStays(guideId) {
  return load().stays.filter((s) => s.guideId === guideId).sort((a, b) => b.end.localeCompare(a.end));
}
export async function getStay(stayId) { return load().stays.find((s) => s.id === stayId); }
export async function stayByToken(token) { return load().stays.find((s) => s.token === token); }

/* ---------- Passages et commissions ---------- */
// Statuts : visited (passé) → declared (déclaré + comprovante) → received (argent reçu) → paid (reversé au guide).

export async function listVisits(filter = {}) {
  return load().visits
    .filter((v) => Object.entries(filter).every(([k, val]) => (Array.isArray(val) ? val.includes(v[k]) : v[k] === val)))
    .sort((a, b) => b.at.localeCompare(a.at));
}
export async function getVisit(visitId) { return load().visits.find((v) => v.id === visitId); }

// Le partenaire a scanné le QR du client puis son QR Partenaire.
export async function recordVisit(stayToken, partnerId) {
  return mutate((d) => {
    const stay = d.stays.find((s) => s.token === stayToken);
    if (!stay) return { ok: false, reason: 'unknown' };
    const guide = d.guides.find((g) => g.id === stay.guideId);
    const partner = d.partners.find((p) => p.id === partnerId);
    const city = d.cities.find((c) => c.id === partner.cityId);
    if (!stayIsValid(stay, city)) return { ok: false, reason: 'expired' };
    if (guide.status !== 'validated') return { ok: false, reason: 'guide' };
    // L'offre du partenaire (s'il en a une) vaut une fois par groupe et par séjour.
    const earlier = d.visits.find((v) => v.stayId === stay.id && v.partnerId === partnerId && v.offerGiven);
    const visit = {
      id: id('v'), stayId: stay.id, partnerId, guideId: stay.guideId, at: now(), people: stay.people,
      offerGiven: Boolean(partner.offer) && !earlier, status: 'visited',
    };
    d.visits.push(visit);
    return { ok: true, visit, earlier };
  });
}

export async function declareVisit(visitId, { amount, method, receipt }) {
  return mutate((d) => Object.assign(d.visits.find((v) => v.id === visitId), {
    status: 'declared', amount, method, receipt, declaredAt: now(), rejected: false,
  }));
}

export async function confirmVisit(visitId) {
  return mutate((d) => Object.assign(d.visits.find((v) => v.id === visitId), { status: 'received', receivedAt: now() }));
}

// Comprovante absent ou illisible : le partenaire doit redéclarer.
export async function rejectVisit(visitId) {
  return mutate((d) => Object.assign(d.visits.find((v) => v.id === visitId), { status: 'visited', rejected: true }));
}

export async function listPayouts(guideId) {
  return load().payouts.filter((p) => !guideId || p.guideId === guideId).sort((a, b) => b.at.localeCompare(a.at));
}

// Virement mensuel au guide : regroupe tout ce qui a été reçu et pas encore reversé.
export async function payGuide(guideId) {
  return mutate((d) => {
    const due = d.visits.filter((v) => v.guideId === guideId && v.status === 'received');
    if (!due.length) return null;
    const payout = {
      id: id('po'), guideId, at: now(), visitIds: due.map((v) => v.id),
      amount: round(due.reduce((sum, v) => sum + v.amount * SHARE.guide, 0)),
    };
    due.forEach((v) => { v.status = 'paid'; v.payoutId = payout.id; });
    d.payouts.push(payout);
    return payout;
  });
}

export const guideShare = (amount) => round((amount || 0) * SHARE.guide);
export const platformShare = (amount) => round((amount || 0) * SHARE.platform);
function round(n) { return Math.round(n * 100) / 100; }

export async function guideSummary(guideId) {
  const visits = await listVisits({ guideId });
  const sum = (status) => round(visits.filter((v) => v.status === status).reduce((s, v) => s + guideShare(v.amount), 0));
  return {
    toDeclare: visits.filter((v) => v.status === 'visited').length,
    checking: sum('declared'),
    due: sum('received'),
    paid: sum('paid'),
  };
}
