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
  code: r.code || '', methods: r.methods || [], licenseLabel: r.license_label, payTo: r.pay_to,
});
const toGuide = (r) => r && ({
  id: r.id, cityId: r.city_id, name: r.name, phone: r.phone, license: r.license, photo: r.photo,
  status: r.status, email: r.email, cpf: r.cpf, cnpj: r.cnpj || '', taxKind: r.tax_kind === 'cnpj' ? 'cnpj' : 'cpf', pixKey: r.pix_key, pixHolder: r.pix_holder || '', createdAt: r.created_at, weeklyPayout: !!r.weekly_payout, code: r.code || '',
  referralEnabled: !!r.referral_enabled,
  // Module Pix (v30) : undefined tant que le script 015 n'est pas lancé.
  pixKeyType: r.pix_key_type || '', pixKeyVersion: r.pix_key_version ?? null, pixStatus: r.pix_status, pixVerifiedAt: r.pix_verified_at || '',
  isTest: !!r.is_test, badgeName: r.badge_name || '', cadasturValidUntil: r.cadastur_valid_until || '', cadasturNumber: r.cadastur_number || '', cadasturCategory: r.cadastur_category || '',
});
const toPartner = (r) => r && ({
  id: r.id, cityId: r.city_id, type: r.type, name: r.name, area: r.area, offer: r.offer || '', token: r.token, status: r.status, taxId: r.tax_id,
  photo: r.photo || '', address: r.address || '', reportToken: r.report_token || '', managerToken: r.manager_token || '',
  activationCode: r.activation_code || '', managerName: r.manager_name || '', managerEmail: r.manager_email || '',
  managerPhone: r.manager_phone || '', commissionRate: r.commission_rate == null ? 0.1 : Number(r.commission_rate), termsVersion: r.terms_version || '', termsAcceptedAt: r.terms_accepted_at || '', termsSha: r.terms_sha256 || '', circleEnabled: !!r.circle_enabled, founderUntil: r.founder_until || '',
});
const toStay = (r) => r && ({
  id: r.id, guideId: r.guide_id, client: r.client, people: r.people, start: r.start_day, end: r.end_day,
  token: r.token, createdAt: r.created_at, archivedAt: r.archived_at || '', direct: !!r.direct,
});
const num = (x) => (x == null ? null : Number(x));
// Une transaction (passage) : montants en centavos, jamais en nombres à virgule.
const toVisit = (r) => r && ({
  id: r.id, num: num(r.num), code: r.code || '', stayId: r.stay_id, partnerId: r.partner_id, guideId: r.guide_id, at: r.at,
  people: r.people, peopleServed: r.people_served ?? r.people, offerGiven: r.offer_given, status: r.status,
  declaredCents: num(r.declared_cents), receivedCents: num(r.received_cents), guideCents: num(r.guide_cents),
  kombrioCents: num(r.kombrio_cents), invoiceCents: num(r.invoice_cents), rate: r.commission_rate == null ? null : Number(r.commission_rate),
  platformShare: r.platform_share == null ? null : Number(r.platform_share), paymentId: r.payment_id, payoutId: r.payout_id, prevStatus: r.prev_status,
  statusNote: r.status_note, declaredAt: r.declared_at, receivedAt: r.received_at, client: r.client, guideName: r.guide_name,
  guideTaxKind: r.guide_tax_kind || null, floorApplied: !!r.floor_applied,
  // v59 : saisie au restaurant et présence du guide.
  tableLabel: r.table_label || '', guideMeal: !!r.guide_meal, computedCents: num(r.computed_cents), commissionNote: r.commission_note || '',
  declaredBy: r.declared_by || null, hasPhoto: !!r.has_photo, guidePresent: !!r.guide_present, direct: !!r.direct,
});
const toPayout = (r) => r && ({
  id: r.id, num: num(r.num), guideId: r.guide_id, cents: num(r.amount_cents), status: r.status, reference: r.reference,
  // v53 : cents = montant NET envoyé ; grossCents = avant retenue ; inssCents = INSS retenu (guide CPF).
  grossCents: num(r.gross_cents ?? r.amount_cents), inssCents: num(r.inss_cents || 0), receivedNote: r.received_note || '',
  at: r.at, paidAt: r.paid_at, receivedStatus: r.received_status || null, receivedAt: r.received_at || '',
  // v65 : envoi par Pix Inter.
  interStatus: r.inter_status || '', interCodigo: r.inter_codigo || '', interE2e: r.inter_e2e || '', interRecebedor: r.inter_recebedor_nome || '',
  interHolderOk: r.inter_holder_ok ?? null, interError: r.inter_error || '', interSentAt: r.inter_sent_at || '',
});
// Vérification Pix de 1 R$ (dépense Kombrio, jamais une commission).
const toPixVerif = (r) => r && ({
  id: r.id, num: num(r.num), guideId: r.guide_id, keyVersion: r.pix_key_version, keyMasked: r.pix_key_masked || '',
  status: r.status, e2e: r.end_to_end_id || '', confirmation: r.guide_confirmation, failureReason: r.failure_reason || '',
  initiatedAt: r.initiated_at, sentAt: r.sent_at || '', confirmedAt: r.guide_confirmed_at || '', verifiedAt: r.verified_at || '',
});
const toExpense = (r) => r && ({
  id: r.id, num: num(r.num), category: r.category, cents: num(r.amount_cents), verificationId: r.verification_id,
  reference: r.reference || '', createdAt: r.created_at,
});
const toPayment = (r) => r && ({
  id: r.id, num: num(r.num), partnerId: r.partner_id, cents: num(r.amount_cents), method: r.method, pixRef: r.pix_ref,
  receipt: r.receipt || null, status: r.status, receivedCents: num(r.received_cents), note: r.note,
  submittedAt: r.submitted_at, verifiedAt: r.verified_at,
});
// Correction après encaissement (contre-écriture) : l'original ne bouge pas, l'écart est ajouté.
const toAdjustment = (r) => r && ({
  id: r.id, num: num(r.num), visitId: r.visit_id, visitNum: num(r.visit_num), guideId: r.guide_id, partnerId: r.partner_id,
  deltaCents: num(r.delta_cents), guideDelta: num(r.guide_delta), kombrioDelta: num(r.kombrio_delta), reason: r.reason,
  partnerStatus: r.partner_status, partnerRef: r.partner_ref, settledAt: r.settled_at, payoutId: r.payout_id, createdAt: r.created_at,
});
export const adjNum = (n) => (n == null ? '' : `KC-${String(n).padStart(6, '0')}`);
export const txNum = (n) => (n == null ? '' : `KB-${String(n).padStart(6, '0')}`);
// Code de passage (v41) : 6 consonnes, affiché « KTR-BMX ». À citer en cas de réclamation.
export const fmtCode = (c) => (c && c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : '');
export const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
// Référence d'un passage à l'écran : le code s'il existe, sinon le numéro KB.
export const visitRef = (v) => (v ? fmtCode(v.code) || txNum(v.num) : '');

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

export async function setCityCode(cityId, code) {
  return check(await sb.rpc('set_city_code', { p_city: cityId, p_code: code }));
}
export async function suspendLatePartners() {
  return check(await sb.rpc('suspend_late_partners'));
}
export async function setCityPayTo(cityId, payTo) {
  check(await sb.from('cities').update({ pay_to: payTo }).eq('id', cityId));
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
// Lien d'e-mail périmé ou déjà utilisé : Supabase renvoie « error_code=… » dans l'adresse.
const LINK_ERROR = /error_code=([a-z_]+)/.exec(location.hash)?.[1] || null;
export function takeLinkError() {
  if (!LINK_ERROR) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return LINK_ERROR;
}
// Liens des e-mails : « #token_hash=…&type=… ». Les messageries (AOL, Outlook…) ouvrent les liens
// pour les vérifier, ce qui grillerait un lien à usage unique : on ne le valide qu'au clic sur « Continuar ».
let OTP = (() => {
  const h = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  const tokenHash = h.get('token_hash');
  return tokenHash ? { tokenHash, type: h.get('type') || 'email' } : null;
})();
export function pendingOtp() { return OTP; }
export async function confirmOtp() {
  const { tokenHash, type } = OTP;
  OTP = null;
  history.replaceState(null, '', location.pathname + location.search);
  const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'otp_expired' : 'link');
  if (type === 'recovery') { try { sessionStorage.setItem(RECOVERY_KEY, '1'); } catch { /* rien */ } }
  return type;
}
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
export async function signUpGuide({ email, password, name, phone, license, cityId, cpf, cnpj = null, pixKey, pixType = null, pixHolder = null, refCode }) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { role: 'guide', name, phone, license, city_id: cityId, cpf, cnpj, pix_key: pixKey, pix_type: pixType, pix_holder: pixHolder, ref_code: refCode || null }, emailRedirectTo: location.href.split('#')[0] },
  });
  if (error) throw new Error(error.message.includes('registered') ? 'exists' : 'auth');
  return Boolean(data.session);
}

// Premier accès du gérant d'un partenaire : le code d'activation relie le compte à l'établissement.
export async function signUpPartner({ email, password, code, name, phone, terms }) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { role: 'partner', code: code.trim().toUpperCase(), name, phone, terms }, emailRedirectTo: location.href.split('#')[0] },
  });
  if (error) throw new Error(error.message.includes('registered') ? 'exists' : 'code');
  return Boolean(data.session);
}
// Le gérant connecté : le lien de son espace (null si pas connecté ou pas gérant).
export async function myPartnerToken() {
  if (!(await currentUser())) return null;
  return check(await sb.rpc('my_partner_token'));
}
export async function hasSession() { return Boolean(await currentUser()); }
export async function setActivationCode(partnerId) {
  return check(await sb.rpc('new_activation_code', { p_partner: partnerId }));
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
  return { email: user.email, isAdmin: profile?.role === 'admin', role: profile?.role || null };
}

/* ---------- Guides (administrateur) ---------- */
export async function listGuides(status) {
  let q = sb.from('guides').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  return check(await q).map(toGuide);
}
export async function setGuideStatus(guideId, status) {
  check(await sb.from('guides').update({ status }).eq('id', guideId));
  // Guide validé : e-mail « Sua conta foi validada! » (fonction Supabase conta-validada). Un échec ne bloque pas.
  if (status === 'validated') {
    try { await sb.functions.invoke('conta-validada', { body: { guideId } }); } catch { /* rien */ }
  }
}

/* ---------- Partenaires ---------- */
// Cercle Kombrio et Parceiro Fundador (v52) : réglages admin par partenaire (journalisés par le trigger d'audit).
export async function setPartnerCircle(partnerId, on) {
  check(await sb.from('partners').update({ circle_enabled: on }).eq('id', partnerId));
}
export async function setPartnerFounder(partnerId, until) {
  check(await sb.from('partners').update({ founder_until: until || null }).eq('id', partnerId));
}
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
    manager_token: `G-${randomToken(32)}`,
    address: p.address || null,
  }));
}
// Photo (JPEG réduite) et adresse, pour la vitrine du client.
export async function setPartnerDetails(partnerId, { photo, address }) {
  const row = { address: address || null };
  if (photo !== undefined) row.photo = photo || null;
  check(await sb.from('partners').update(row).eq('id', partnerId));
}
export async function renewManagerToken(partnerId) {
  check(await sb.from('partners').update({ manager_token: `G-${randomToken(32)}` }).eq('id', partnerId));
}
export async function renewPartnerToken(partnerId) {
  check(await sb.from('partners').update({ token: `P-${randomToken(24)}` }).eq('id', partnerId));
}

// Espace du partenaire, à partir de son QR Partenaire. null si le QR n'est pas reconnu.
export async function partnerSpace(token) {
  const d = check(await sb.rpc('partner_space', { p_token: token }));
  if (!d) return null;
  const codes = await sb.rpc('partner_visit_codes', { p_token: token }).then((x) => x.data || {}, () => ({}));
  return { role: d.role, partner: toPartner(d.partner), city: toCity(d.city), visits: (d.visits || []).map((v) => toVisit({ ...v, code: codes[v.id] })), payments: (d.payments || []).map(toPayment),
    adjustments: (d.adjustments || []).map(toAdjustment) };
}
// Relevé du comptable (lecture seule), à partir de son lien. null si le lien n'est pas reconnu.
export async function partnerReport(reportToken) {
  const d = check(await sb.rpc('partner_report', { p_token: reportToken }));
  if (!d) return null;
  return { partner: toPartner(d.partner), city: toCity(d.city), visits: (d.visits || []).map(toVisit), payments: (d.payments || []).map(toPayment),
    adjustments: (d.adjustments || []).map(toAdjustment) };
}
// Clôture mensuelle (v54) : le gérant fige son mois (nouvelle version si quelque chose a changé). month = 'AAAA-MM'.
export async function partnerCloseMonth(managerToken, month) {
  return check(await sb.rpc('partner_close_month', { p_manager_token: managerToken, p_month: `${month}-01` }));
}
// Toutes les clôtures du partenaire (code du gérant ou lien du comptable), la plus récente d'abord. [] si le script 029 manque.
export async function partnerClosings(token) {
  const { data, error } = await sb.rpc('partner_closings_list', { p_token: token });
  return error ? [] : (data || []);
}
// v56 : derniers e-mails automatiques (boîte d'envoi). [] si le script 031 manque.
export async function listMails(limit = 40) {
  const { data, error } = await sb.from('mail_outbox').select('num, kind, to_email, status, last_error, created_at, sent_at').order('created_at', { ascending: false }).limit(limit);
  return error ? [] : (data || []);
}
// v57 : contrôle de cohérence de l'argent (admin). Note aussi le résultat du jour au journal.
export async function booksCheck() {
  return check(await sb.rpc('books_check_daily'));
}
export async function adminCloseMonth(month) {
  return check(await sb.rpc('admin_close_month', { p_month: `${month}-01` }));
}
export async function renewReportToken(partnerToken) {
  return check(await sb.rpc('renew_report_token', { p_partner_token: partnerToken }));
}
export async function setPartnerOffer(token, offer) {
  check(await sb.rpc('set_partner_offer', { p_token: token, p_offer: offer }));
}

export async function setCommissionRate(managerToken, rate) {
  return check(await sb.rpc('set_commission_rate', { p_manager_token: managerToken, p_rate: rate }));
}
export async function setWeeklyPayout(on) {
  return check(await sb.rpc('set_weekly_payout', { p_on: on }));
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
// v61 : le guide range (archive) ou supprime un client. Supprimer est refusé s'il y a un passage.
export async function setStayArchived(stayId, on) {
  return check(await sb.rpc('set_stay_archived', { p_stay: stayId, p_on: on }));
}
export async function deleteStay(stayId) {
  return check(await sb.rpc('delete_stay', { p_stay: stayId }));
}
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
  return r.ok ? { ok: true, visitId: r.visit_id, duplicate: r.duplicate } : { ok: false, reason: r.reason };
}
export async function setPeopleServed(partnerToken, visitId, people) {
  return check(await sb.rpc('set_people_served', { p_partner_token: partnerToken, p_visit: visitId, p_people: people }));
}

// v59 : saisie d'un passage par la caisse ou le gérant (montant final, commission éventuellement baissée, repas du guide, table, photo).
export async function declareVisit(token, visitId, { invoiceCents, commissionCents = null, guideMeal = false, table = null, photo = null, note = null }) {
  return check(await sb.rpc('declare_visit', {
    p_token: token, p_visit: visitId, p_invoice_cents: invoiceCents, p_commission_cents: commissionCents,
    p_guide_meal: guideMeal, p_table: table, p_photo: photo, p_note: note,
  }));
}
export async function setVisitTable(token, visitId, table) {
  return check(await sb.rpc('set_visit_table', { p_token: token, p_visit: visitId, p_table: table }));
}
export async function visitNoConsumption(token, visitId) {
  return check(await sb.rpc('visit_no_consumption', { p_token: token, p_visit: visitId }));
}
export async function visitBillPhoto(managerToken, visitId) {
  return check(await sb.rpc('visit_bill_photo', { p_manager_token: managerToken, p_visit: visitId }));
}
// v59 : le partenaire scanne le badge du guide (présence).
export async function markGuidePresent(partnerToken, badgeToken) {
  return check(await sb.rpc('mark_guide_present', { p_partner_token: partnerToken, p_badge_token: badgeToken }));
}
// v59 : « Devenir partenaire » (établissement non partenaire).
// v63 : vente sans QR client (comme la planilha de la loja) : le guide (code ou crachá) et le montant de la vente.
export async function findGuides(partnerToken, q) {
  return check(await sb.rpc('find_guides', { p_partner_token: partnerToken, p_q: q })) || [];
}
export async function recordDirectSale(partnerToken, guideRef, { invoiceCents, people = 1, commissionCents = null, note = null }) {
  return check(await sb.rpc('record_direct_sale', {
    p_partner_token: partnerToken, p_guide: guideRef, p_invoice_cents: invoiceCents, p_people: people, p_commission_cents: commissionCents, p_note: note,
  }));
}
export async function createPartnerLead({ name, contact, phone, email, type, message }) {
  return check(await sb.rpc('create_partner_lead', {
    p_name: name, p_contact: contact, p_phone: phone || null, p_email: email || null, p_type: type || null, p_message: message || null,
  }));
}
export async function adminLeads() {
  return check(await sb.from('partner_leads').select('*').order('created_at', { ascending: false }).limit(100));
}
export async function adminSetLead(id, status) {
  return check(await sb.rpc('admin_set_lead', { p_lead: id, p_status: status }));
}

// Gérant : déclarer (montant libre, zéro possible), puis payer séparément.
export async function declareCommissions(managerToken, items) {
  return check(await sb.rpc('declare_commissions', { p_manager_token: managerToken, p_items: items }));
}
export async function submitPayment(managerToken, { visitIds, method, pixRef, receipt }) {
  return check(await sb.rpc('submit_payment', {
    p_manager_token: managerToken, p_visits: visitIds, p_method: method, p_pix_ref: pixRef || null, p_receipt: receipt,
  }));
}

// Administrateur
export async function listPayments() {
  return check(await sb.from('payments').select('*').order('submitted_at', { ascending: false })).map(toPayment);
}
export async function verifyPayment(paymentId, receivedCents, pixRef) {
  return check(await sb.rpc('verify_payment', { p_payment: paymentId, p_received_cents: receivedCents, p_pix_ref: pixRef || null }));
}
export async function rejectPayment(paymentId, reason) {
  return check(await sb.rpc('reject_payment', { p_payment: paymentId, p_reason: reason }));
}
export async function listPayouts(guideId) {
  let q = sb.from('payouts').select('*').order('at', { ascending: false });
  if (guideId) q = q.eq('guide_id', guideId);
  return check(await q).map(toPayout);
}
/* ---------- Validation Pix 1 R$ (v30) ---------- */
export async function listPixVerifications(guideId) {
  let q = sb.from('pix_verifications').select('*').order('initiated_at', { ascending: false });
  if (guideId) q = q.eq('guide_id', guideId);
  const { data, error } = await q;
  return error ? [] : (data || []).map(toPixVerif);
}
export async function listExpenses() {
  const { data, error } = await sb.from('kombrio_expenses').select('*').order('created_at', { ascending: false });
  return error ? [] : (data || []).map(toExpense);
}
// v64 : CPF (à compléter s'il manque) et CNPJ facultatif du guide.
export async function setMyTaxIds(cpf, cnpj) { return check(await sb.rpc('set_my_tax_ids', { p_cpf: cpf || null, p_cnpj: cnpj || null })); }
export async function setMyPixKey(key, type, holder) { return check(await sb.rpc('set_my_pix_key', { p_key: key, p_type: type, p_holder: holder })); }
export async function startPixVerification(guideId) { return check(await sb.rpc('start_pix_verification', { p_guide: guideId })); }
export async function recordPixSent(verifId, e2e, feeCents) {
  return check(await sb.rpc('record_pix_sent', { p_verification: verifId, p_e2e: e2e, p_receipt: null, p_fee_cents: feeCents || 0 }));
}
export async function failPixVerification(verifId, reason) { return check(await sb.rpc('fail_pix_verification', { p_verification: verifId, p_reason: reason })); }
export async function recordPixReturn(verifId, ref) { return check(await sb.rpc('record_pix_return', { p_verification: verifId, p_ref: ref })); }
export async function confirmPixVerification(verifId, received) {
  return check(await sb.rpc('confirm_pix_verification', { p_verification: verifId, p_received: received }));
}
// v55 : réponse du guide à un virement : 'confirmed' | 'not_received' | 'wrong_amount' (avec un mot).
export async function guideAnswerPayout(payoutId, answer, note) {
  return check(await sb.rpc('guide_answer_payout', { p_payout: payoutId, p_answer: answer, p_note: note || null }));
}
// Relevé d'un virement (guide ou admin) : passages, corrections, brut / INSS / net, lignes par partenaire (RPA).
export async function payoutStatement(payoutId) {
  return check(await sb.rpc('payout_statement', { p_payout: payoutId }));
}
export async function confirmPayoutReceived(payoutId, received) {
  return check(await sb.rpc('confirm_payout_received', { p_payout: payoutId, p_received: received }));
}
/* ---------- Vérification Cadastur (v31) ---------- */
// La liste ne charge jamais les captures (lourdes) : une capture se charge seulement quand on l'ouvre.
export async function listCadasturChecks() {
  const { data, error } = await sb.from('guide_cadastur_checks').select('id, num, guide_id, valid_until, checked_at, cadastur_number, category').order('checked_at', { ascending: false });
  return error ? [] : (data || []).map((r) => ({ id: r.id, num: num(r.num), guideId: r.guide_id, validUntil: r.valid_until, checkedAt: r.checked_at,
    number: r.cadastur_number || '', category: r.category || '' }));
}
export async function cadasturProof(checkId) {
  return check(await sb.from('guide_cadastur_checks').select('proof').eq('id', checkId).maybeSingle())?.proof || '';
}
export async function recordCadasturCheck(guideId, validUntil, proof, number, category) {
  return check(await sb.rpc('record_cadastur_check', { p_guide: guideId, p_valid_until: validUntil, p_proof: proof, p_number: number, p_category: category }));
}
export async function setGuideTest(guideId, on) { return check(await sb.rpc('set_guide_test', { p_guide: guideId, p_on: on })); }

// Corrections après encaissement. Liste vide si la base n'a pas encore le script 013 (lot 0).
export async function listAdjustments(guideId) {
  let q = sb.from('adjustments').select('*').order('created_at', { ascending: false });
  if (guideId) q = q.eq('guide_id', guideId);
  const { data, error } = await q;
  return error ? [] : (data || []).map(toAdjustment);
}
export async function adjustCommission(visitId, cents, reason) {
  return check(await sb.rpc('adjust_commission', { p_visit: visitId, p_new_cents: cents, p_reason: reason }));
}
export async function settleAdjustment(adjustmentId, ref) {
  return check(await sb.rpc('settle_adjustment', { p_adjustment: adjustmentId, p_ref: ref }));
}
export async function startPayout(guideId) {
  return check(await sb.rpc('start_payout', { p_guide: guideId }));
}
// Récapitulatif INSS d'un mois (admin) : par partenaire et par guide, virements payés ce mois-là. month = 'AAAA-MM'.
export async function adminInssReport(month) {
  return check(await sb.rpc('admin_inss_report', { p_month: `${month}-01` }));
}
// v65 : virement envoyé par Pix Banco Inter (fonction Edge « inter ») et suivi de son statut.
export async function sendPayoutInter(payoutId) {
  const { data, error } = await sb.functions.invoke('inter', { body: { action: 'payout_send', payout: payoutId } });
  if (error) throw new Error('inter');
  return data;
}
export async function checkPayoutInter(payoutId) {
  const { data, error } = await sb.functions.invoke('inter', { body: { action: 'payout_check', payout: payoutId } });
  if (error) throw new Error('inter');
  return data;
}
export async function confirmPayout(payoutId, reference) {
  return check(await sb.rpc('confirm_payout', { p_payout: payoutId, p_reference: reference }));
}
export async function correctCommission(visitId, cents, reason) {
  return check(await sb.rpc('correct_commission', { p_visit: visitId, p_cents: cents, p_reason: reason }));
}
export async function disputeVisit(visitId, reason) {
  return check(await sb.rpc('dispute_visit', { p_visit: visitId, p_reason: reason }));
}
export async function resolveDispute(visitId, note) {
  return check(await sb.rpc('resolve_dispute', { p_visit: visitId, p_note: note }));
}
export async function cancelVisit(visitId, reason) {
  return check(await sb.rpc('cancel_visit', { p_visit: visitId, p_reason: reason }));
}
export async function listLedger(limit = 200) {
  return check(await sb.from('ledger').select('*').order('id', { ascending: false }).limit(limit));
}

export async function resetDemo() { /* plus de mode démo */ }

/* ---------- Parrainage (supabase/012_parrainage.sql) ---------- */
export async function myReferral() { return check(await sb.rpc('my_referral')); }
export async function adminReferrals() { return check(await sb.rpc('admin_referrals')) || []; }
export async function setReferralEnabled(guideId, on) { return check(await sb.rpc('set_referral_enabled', { p_guide: guideId, p_on: on })); }
export async function closeReferralMonth(month) { return check(await sb.rpc('close_referral_month', { p_month: month })); }
export async function setReferralReward(id, action, text = null) {
  return check(await sb.rpc('set_referral_reward', { p_reward: id, p_action: action, p_text: text }));
}

/* ---------- Aide et alertes (v33, script 017) ---------- */
// L'alerte va uniquement à Kombrio. Un problème réglé par la FAQ est seulement compté (sujet).
const toAlert = (r) => r && ({
  id: r.id, num: num(r.num), authorKind: r.author_kind, guideId: r.guide_id, partnerId: r.partner_id, visitId: r.visit_id,
  topic: r.topic, message: r.message || '', status: r.status, answer: r.answer || '', createdAt: r.created_at, resolvedAt: r.resolved_at || '',
  guideName: r.guides?.name || '', partnerName: r.partners?.name || '', visitNum: num(r.visits?.num), visitCode: r.visits?.code || '',
});
export async function guideCreateAlert(topic, message, visitId = null) {
  return check(await sb.rpc('guide_create_alert', { p_topic: topic, p_message: message, p_visit: visitId }));
}
export async function partnerCreateAlert(token, topic, message, visitId = null) {
  return check(await sb.rpc('partner_create_alert', { p_token: token, p_topic: topic, p_message: message, p_visit: visitId }));
}
// Tant que le script 017 n'est pas lancé, ces lectures renvoient une liste vide (l'app reste utilisable).
export async function listMyAlerts() {
  const { data, error } = await sb.from('alerts').select('*').order('created_at', { ascending: false }).limit(20);
  return error ? [] : data.map(toAlert);
}
export async function partnerAlerts(token) {
  const { data, error } = await sb.rpc('partner_alerts', { p_token: token });
  return error ? [] : (data || []).map(toAlert);
}
export async function countFaqSolved(kind, topic) {
  try { await sb.rpc('count_faq_solved', { p_kind: kind, p_topic: topic }); } catch { /* simple compteur */ }
}
export async function adminListAlerts() {
  const { data, error } = await sb.from('alerts').select('*, guides(name), partners(name), visits(num, code)').order('created_at', { ascending: false }).limit(200);
  return error ? [] : data.map(toAlert);
}
export async function adminFaqSolvedSince(iso) {
  const { count, error } = await sb.from('faq_solved').select('id', { count: 'exact', head: true }).gte('at', iso);
  return error ? 0 : count || 0;
}
export async function adminSetAlert(id, status, answer = null) {
  return check(await sb.rpc('admin_set_alert', { p_alert: id, p_status: status, p_answer: answer }));
}

/* ---------- Crachá du guide (v35, script 018) ---------- */
// Le QR du badge contient un code secret (B-…), jamais le code public RIO-KG.
export async function myBadgeToken() {
  const { data, error } = await sb.rpc('my_badge_token');
  return error ? null : data;
}
export async function renewBadgeToken() {
  return check(await sb.rpc('renew_badge_token'));
}
export async function setMyPhoto(dataUrl) {
  return check(await sb.rpc('set_my_photo', { p_photo: dataUrl }));
}
export async function setMyBadgeName(name) { return check(await sb.rpc('set_my_badge_name', { p_name: name })); }
export async function guideBadge(token) {
  const { data, error } = await sb.rpc('guide_badge', { p_token: token });
  return error ? null : data;
}

/* ---------- Actif / suspendu (v38, script 019) : l'admin suspend ou réactive, avec un motif au journal. ---------- */
export async function adminSetGuideStatus(guideId, status, reason = null) {
  return check(await sb.rpc('admin_set_guide_status', { p_guide: guideId, p_status: status, p_reason: reason }));
}
export async function adminSetPartnerStatus(partnerId, status, reason = null) {
  return check(await sb.rpc('admin_set_partner_status', { p_partner: partnerId, p_status: status, p_reason: reason }));
}

/* ---------- Conditions acceptées (v41) : texte gardé en base avec son empreinte ---------- */
export async function termsText(kind, version = null) {
  return check(await sb.rpc('terms_text', { p_kind: kind, p_version: version }));
}
