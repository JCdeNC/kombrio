// Données de Kombrio : base Supabase (projet « kombrio », São Paulo).
// - Guide et administrateur : un compte (e-mail + mot de passe). La base ne leur montre que ce qui les concerne.
// - Client et partenaire : pas de compte. Le code secret de leur QR passe par des fonctions de la base
//   (supabase/002_branchement.sql) qui vérifient tout côté serveur.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { randomToken } from './util.js';

export const DEMO = false;
export const SHARE = { platform: 0.2, guide: 0.8 };
export const PARTNER_TYPES = ['restaurant', 'shop'];

// Chaque application garde sa propre session (un guide et l'admin peuvent être connectés sur le même ordinateur).
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, storageKey: `kombrio-auth-${window.KOMBRIO_APP || 'hub'}` },
});

const round = (n) => Math.round(n * 100) / 100;
export const guideShare = (amount) => round((amount || 0) * SHARE.guide);
export const platformShare = (amount) => round((amount || 0) * SHARE.platform);

function check({ data, error }) {
  if (error) { console.error(error); throw new Error(error.message || 'db'); }
  return data;
}

/* ---------- Conversion base → écrans ---------- */
const toCity = (r) => r && ({
  id: r.id, name: r.name, country: r.country, currency: r.currency, timezone: r.timezone,
  methods: r.methods || [], licenseLabel: r.license_label, payTo: r.pay_to,
});
const toGuide = (r) => r && ({
  id: r.id, cityId: r.city_id, name: r.name, phone: r.phone, license: r.license, photo: r.photo,
  status: r.status, email: r.email, cpf: r.cpf, pixKey: r.pix_key, createdAt: r.created_at,
});
const toPartner = (r) => r && ({
  id: r.id, cityId: r.city_id, type: r.type, name: r.name, area: r.area, offer: r.offer || '', token: r.token, status: r.status, taxId: r.tax_id,
});
const toStay = (r) => r && ({
  id: r.id, guideId: r.guide_id, client: r.client, people: r.people, start: r.start_day, end: r.end_day,
  token: r.token, createdAt: r.created_at,
});
function toReceipt(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
const toVisit = (r) => r && ({
  id: r.id, stayId: r.stay_id, partnerId: r.partner_id, guideId: r.guide_id, at: r.at, people: r.people,
  offerGiven: r.offer_given, status: r.status, amount: r.amount == null ? null : Number(r.amount), method: r.method,
  receipt: toReceipt(r.receipt), rejected: r.rejected, declaredAt: r.declared_at, receivedAt: r.received_at,
  payoutId: r.payout_id, client: r.client, guideName: r.guide_name,
});
const toPayout = (r) => r && ({ id: r.id, guideId: r.guide_id, amount: Number(r.amount), at: r.at });

/* ---------- Villes ---------- */
export async function listCities() {
  return check(await sb.from('cities').select('*').order('name')).map(toCity);
}
export async function getCity(cityId) {
  return toCity(check(await sb.from('cities').select('*').eq('id', cityId).maybeSingle()));
}
export async function addCity(c) {
  const id = c.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return check(await sb.from('cities').insert({
    id, name: c.name, country: c.country, currency: c.currency, timezone: c.timezone,
    methods: c.methods, license_label: c.licenseLabel, pay_to: c.payTo,
  }));
}

/* ---------- Comptes (guide et administrateur) ---------- */
async function currentUser() {
  const { data } = await sb.auth.getSession();
  return data.session?.user || null;
}

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error('auth');
}
export async function signOut() { await sb.auth.signOut(); }

// Mot de passe oublié : Supabase envoie un lien qui ramène sur cette même page.
// Le lien arrive avec « type=recovery » dans l'adresse : on le note avant que Supabase ne l'efface.
const RECOVERY_KEY = `kombrio-recovery-${window.KOMBRIO_APP || 'hub'}`;
try { if (/type=recovery/.test(location.hash)) sessionStorage.setItem(RECOVERY_KEY, '1'); } catch { /* rien */ }
export function inRecovery() {
  try { return sessionStorage.getItem(RECOVERY_KEY) === '1'; } catch { return false; }
}
export async function sendPasswordReset(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
  if (error) throw new Error('auth');
}
export async function setNewPassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw new Error('auth');
  try { sessionStorage.removeItem(RECOVERY_KEY); } catch { /* rien */ }
}

// Inscription d'un guide. Renvoie false si la base demande d'abord de confirmer l'e-mail.
export async function signUpGuide({ email, password, name, phone, license, cityId, cpf, pixKey }) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { role: 'guide', name, phone, license, city_id: cityId, cpf, pix_key: pixKey }, emailRedirectTo: location.href.split('#')[0] },
  });
  if (error) throw new Error(error.message.includes('registered') ? 'exists' : 'auth');
  return Boolean(data.session);
}

// Premier compte administrateur (accepté seulement s'il n'en existe aucun).
export async function signUpAdmin(email, password) {
  const { data, error } = await sb.auth.signUp({
    email, password, options: { data: { role: 'admin' }, emailRedirectTo: location.href.split('#')[0] },
  });
  if (error) throw new Error(error.message.includes('registered') ? 'exists' : 'auth');
  return Boolean(data.session);
}

export async function currentGuide() {
  const user = await currentUser();
  if (!user) return null;
  return toGuide(check(await sb.from('guides').select('*').eq('id', user.id).maybeSingle()));
}

// null = pas connecté ; { isAdmin } sinon.
export async function currentAdmin() {
  const user = await currentUser();
  if (!user) return null;
  const profile = check(await sb.from('profiles').select('role').eq('id', user.id).maybeSingle());
  return { email: user.email, isAdmin: profile?.role === 'admin' };
}

/* ---------- Guides (administrateur) ---------- */
export async function listGuides(status) {
  let q = sb.from('guides').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  return check(await q).map(toGuide);
}
export async function setGuideStatus(guideId, status) {
  check(await sb.from('guides').update({ status }).eq('id', guideId));
}

/* ---------- Partenaires ---------- */
export async function listPartners() {
  return check(await sb.from('partners').select('*').order('name')).map(toPartner);
}
// Version publique, sans code secret (page du client, noms pour le guide).
export async function publicPartners(cityId) {
  return check(await sb.rpc('public_partners', { p_city: cityId })).map((r) => ({ ...r, offer: r.offer || '' }));
}
export async function addPartner(p) {
  check(await sb.from('partners').insert({
    city_id: p.cityId, type: p.type, name: p.name, area: p.area, offer: p.offer || null, tax_id: p.taxId, token: `P-${randomToken(24)}`,
  }));
}
export async function renewPartnerToken(partnerId) {
  check(await sb.from('partners').update({ token: `P-${randomToken(24)}` }).eq('id', partnerId));
}

// Espace du partenaire, à partir de son QR Partenaire. null si le QR n'est pas reconnu.
export async function partnerSpace(token) {
  const d = check(await sb.rpc('partner_space', { p_token: token }));
  if (!d) return null;
  return { partner: toPartner(d.partner), city: toCity(d.city), visits: (d.visits || []).map(toVisit) };
}
export async function setPartnerOffer(token, offer) {
  check(await sb.rpc('set_partner_offer', { p_token: token, p_offer: offer }));
}

/* ---------- Séjours ---------- */
export async function addStay(guideId, s) {
  const row = check(await sb.from('stays').insert({
    guide_id: guideId, client: s.client, people: s.people, start_day: s.start, end_day: s.end, token: `C-${randomToken(24)}`,
  }).select().single());
  return toStay(row);
}
export async function listStays(guideId) {
  return check(await sb.from('stays').select('*').eq('guide_id', guideId).order('end_day', { ascending: false })).map(toStay);
}
export async function getStay(stayId) {
  return toStay(check(await sb.from('stays').select('*').eq('id', stayId).maybeSingle()));
}
// Page du client et page du scan, à partir du QR du client. null si le QR n'est pas reconnu.
export async function stayPublic(token) {
  const d = check(await sb.rpc('stay_public', { p_token: token }));
  if (!d) return null;
  return { stay: toStay(d.stay), guide: toGuide(d.guide), city: toCity(d.city) };
}

/* ---------- Passages et commissions ---------- */
export async function listVisits(filter = {}) {
  let q = sb.from('visits').select('*').order('at', { ascending: false });
  const cols = { guideId: 'guide_id', stayId: 'stay_id', partnerId: 'partner_id', status: 'status' };
  Object.entries(filter).forEach(([k, v]) => { q = Array.isArray(v) ? q.in(cols[k], v) : q.eq(cols[k], v); });
  return check(await q).map(toVisit);
}

export async function recordVisit(stayToken, partnerToken) {
  const r = check(await sb.rpc('record_visit', { p_stay_token: stayToken, p_partner_token: partnerToken }));
  return r.ok ? { ok: true, visitId: r.visit_id } : { ok: false, reason: r.reason };
}

export async function declareVisit(partnerToken, visitId, { amount, method, receipt }) {
  const ok = check(await sb.rpc('declare_visit', {
    p_partner_token: partnerToken, p_visit: visitId, p_amount: amount, p_method: method,
    p_receipt: receipt ? JSON.stringify(receipt) : null,
  }));
  if (!ok) throw new Error('declare');
}

export async function confirmVisit(visitId) {
  check(await sb.from('visits').update({ status: 'received', received_at: new Date().toISOString() }).eq('id', visitId));
}
export async function rejectVisit(visitId) {
  check(await sb.from('visits').update({ status: 'visited', rejected: true }).eq('id', visitId));
}

export async function listPayouts(guideId) {
  let q = sb.from('payouts').select('*').order('at', { ascending: false });
  if (guideId) q = q.eq('guide_id', guideId);
  return check(await q).map(toPayout);
}
export async function payGuide(guideId) {
  return check(await sb.rpc('pay_guide', { p_guide: guideId }));
}

export async function guideSummary(guideId) {
  const visits = await listVisits({ guideId });
  const sum = (status) => round(visits.filter((v) => v.status === status).reduce((s, v) => s + guideShare(v.amount), 0));
  return {
    toDeclare: visits.filter((v) => v.status === 'visited').length,
    checking: sum('declared'), due: sum('received'), paid: sum('paid'),
  };
}

export async function resetDemo() { /* plus de mode démo */ }
