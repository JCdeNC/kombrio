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
  status: r.status, email: r.email, cpf: r.cpf, cnpj: r.cnpj || '', taxKind: r.tax_kind === 'cnpj' ? 'cnpj' : 'cpf', fiscalStatus: r.fiscal_status || (r.tax_kind === 'cnpj' ? 'mei' : 'cpf'), pixKey: r.pix_key, pixHolder: r.pix_holder || '', createdAt: r.created_at, weeklyPayout: !!r.weekly_payout, code: r.code || '',
  referralEnabled: !!r.referral_enabled, actorKind: r.actor_kind || 'guide', // v99 : guide, tc (Tour Company), agency
  // v103 : compte actif dès l'e-mail confirmé ; verifiedAt = validé par Kombrio (null = virements en attente ; undefined = script 067 pas lancé).
  verifiedAt: r.verified_at === undefined ? undefined : (r.verified_at || null), contactName: r.contact_name || '',
  // Module Pix (v30) : undefined tant que le script 015 n'est pas lancé.
  pixKeyType: r.pix_key_type || '', pixKeyVersion: r.pix_key_version ?? null, pixStatus: r.pix_status, pixVerifiedAt: r.pix_verified_at || '',
  termsVersion: r.terms_version || '', termsAcceptedAt: r.terms_accepted_at || '', lang: r.lang || '',
  // v136 : photo du guide validée par Kombrio (none | pending | validated | refused) ; undefined = script 077 pas lancé.
  photoStatus: r.photo_status, photoReason: r.photo_reason || '', photoSubmittedAt: r.photo_submitted_at || '', photoValidatedAt: r.photo_validated_at || '',
  isTest: !!r.is_test, badgeName: r.badge_name || '', cadasturValidUntil: r.cadastur_valid_until || '', cadasturNumber: r.cadastur_number || '', cadasturCategory: r.cadastur_category || '',
});
const toPartner = (r) => r && ({
  id: r.id, cityId: r.city_id, type: r.type, name: r.name, area: r.area, offer: r.offer || '', token: r.token, status: r.status, taxId: r.tax_id,
  photo: r.photo || '', address: r.address || '', reportToken: r.report_token || '', managerToken: r.manager_token || '',
  lang: r.lang || 'pt', validatedAt: r.validated_at || '', rateTc: Number(r.rate_tc) || 0, rateAgency: Number(r.rate_agency) || 0, groupId: r.group_id || null, ownership: r.ownership === 'franchise' ? 'franchise' : 'own',
  activationCode: r.activation_code || '', managerName: r.manager_name || '', managerEmail: r.manager_email || '',
  managerPhone: r.manager_phone || '', commissionRate: r.commission_rate == null ? 0.1 : Number(r.commission_rate), termsVersion: r.terms_version || '', termsAcceptedAt: r.terms_accepted_at || '', termsSha: r.terms_sha256 || '', circleEnabled: !!r.circle_enabled, founderUntil: r.founder_until || '',
  // v66 : ancien QR caisse actif ou coupé ; photo de l'addition obligatoire (personnel) à partir de ce montant.
  counterEnabled: r.counter_enabled !== false, photoRequiredCents: r.photo_required_cents == null ? 30000 : Number(r.photo_required_cents),
  // v67 : photo de la note obligatoire pour l'équipe (réglage du gérant) ; frais du mode 2 (réglés par Kombrio).
  // v84 : qui déclare l'INSS des guides (Kombrio par procuration, ou le comptable du partenaire).
  inssFiling: r.inss_filing || 'kombrio', inssProcuracaoAt: r.inss_procuracao_at || '', inssProcuracaoNote: r.inss_procuracao_note || '',
  staffPhotoRequired: r.staff_photo_required !== false, mode2FeeRate: r.mode2_fee_rate == null ? 0.03 : Number(r.mode2_fee_rate),
  mode2FeeCapCents: r.mode2_fee_cap_cents == null ? 9900 : Number(r.mode2_fee_cap_cents),
  j1Enabled: !!r.j1_enabled,   // v77 : le partenaire propose le virement J+1 du guide présent
  // v68 : modèle de commission — « percent » (% de l'addition) ou « per_person » (forfait par client).
  commissionModel: r.commission_model === 'per_person' ? 'per_person' : 'percent', perPersonCents: num(r.per_person_cents) || 0,
  // v69 : bonus « X tous les N clients » et repas offert au guide présent « 1 tous les N clients » (0 = aucun).
  bonusEvery: num(r.bonus_every) || 0, bonusCents: num(r.bonus_cents) || 0, mealEvery: num(r.meal_every) || 0,
  // v70 : prix Kombrio pour le client (prix normal → prix Kombrio) et dates de l'offre (vides = toujours).
  childCents: num(r.child_cents) || 0, askChildren: !!r.ask_children, // v71 : forfait enfant (0 = comme un adulte)
  offerPriceCents: num(r.offer_price_cents), offerPromoCents: num(r.offer_promo_cents), offerStart: r.offer_start || '', offerEnd: r.offer_end || '', offerDays: (r.offer_days || []).map(Number),
  // v123 (script 074) : part non commissionnable (libellé), plafond / minimum par addition, palier du mois.
  excludedLabel: r.excluded_label || '', capCents: num(r.commission_cap_cents), minCents: num(r.commission_min_cents),
  tierClients: num(r.tier_clients) || 0, tierRate: r.tier_rate == null ? null : Number(r.tier_rate), tierPpCents: num(r.tier_pp_cents),
});
const toStay = (r) => r && ({
  id: r.id, guideId: r.guide_id, client: r.client, people: r.people, start: r.start_day, end: r.end_day,
  token: r.token, createdAt: r.created_at, archivedAt: r.archived_at || '', direct: !!r.direct, code: r.code || '',
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
  // v66 : équipe du partenaire (qui a scanné, qui a saisi ; correction possible 15 min par la même personne).
  scanStaff: r.scan_staff || '', billStaff: r.bill_staff || '', byMe: !!r.by_me, canFix: !!r.can_fix,
  // v67 : mode 1 (clients seuls, 80/20) ou 2 (guide présent : 100 % guide + frais payés par le partenaire). À payer = commission + frais.
  bonusEvery: num(r.bonus_every) || 0, bonusCents: num(r.bonus_cents) || 0, mealEvery: num(r.meal_every) || 0, meals: num(r.meals) || 0, // v69
  children: num(r.children) || 0, childCents: num(r.child_cents), // v71 : enfants du groupe et forfait enfant figé
  noCommission: !!r.no_commission, noCommissionNote: r.no_commission_note || '', // v118 : jour sans commission
  perPersonCents: num(r.per_person_cents), // v68 : forfait figé sur le passage (null = % de l'addition)
  mode: r.mode == null ? 1 : Number(r.mode), feeCents: num(r.fee_cents) || 0, feeRate: r.fee_rate == null ? null : Number(r.fee_rate),
  dueCents: r.declared_cents == null ? null : Number(r.declared_cents) + (Number(r.fee_cents) || 0),
  parentVisitId: r.parent_visit_id || null, actorRole: r.actor_role || null, // v101 : ligne de commission par rôle
  // v123 : part non commissionnable, plafond / minimum figés au scan, « turbo » ou « palier » appliqué.
  // v138 : relevé du comptable (code du guide, ticket et vendeuse de l'import, n° et date de vérification du paiement).
  guideCode: r.guide_code || '', extTicket: r.ext_ticket || '', extSeller: r.ext_seller || '', paymentNum: num(r.payment_num), paidAt: r.paid_at || '',
  excludedCents: num(r.excluded_cents), capCents: num(r.cap_cents), minCents: num(r.min_cents), incentive: r.incentive || '', incentiveNote: r.incentive_note || '',
});
// v102 : chaque ligne de commission (TC, guide d'un groupe d'agence) juste après son passage principal.
export function nestLines(visits) {
  const kids = new Map();
  visits.filter((v) => v.parentVisitId).forEach((v) => { if (!kids.has(v.parentVisitId)) kids.set(v.parentVisitId, []); kids.get(v.parentVisitId).push(v); });
  const mainIds = new Set(visits.filter((v) => !v.parentVisitId).map((v) => v.id));
  const out = [];
  visits.forEach((v) => {
    if (v.parentVisitId && mainIds.has(v.parentVisitId)) return;
    out.push(v);
    if (!v.parentVisitId) (kids.get(v.id) || []).forEach((k) => out.push(k));
  });
  return out;
}
// Un passage (pas une ligne de commission) : pour compter les visites, les personnes et les additions.
export const isMainVisit = (v) => !v.parentVisitId;
const toPayout = (r) => r && ({
  id: r.id, num: num(r.num), guideId: r.guide_id, cents: num(r.amount_cents), status: r.status, reference: r.reference,
  // v53 : cents = montant NET envoyé ; grossCents = avant retenue ; inssCents = INSS retenu (guide CPF).
  grossCents: num(r.gross_cents ?? r.amount_cents), inssCents: num(r.inss_cents || 0), irrfCents: (num(r.irrf_pf_cents) || 0) + (num(r.irrf_pj_cents) || 0), receivedNote: r.received_note || '',
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
  submittedAt: r.submitted_at, verifiedAt: r.verified_at, groupId: r.group_id || null,
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
export async function signUpGuide({ email, password, name, phone, license, cityId, cpf, cnpj = null, pixKey, pixType = null, pixHolder = null, refCode, actorKind = 'guide', contactName = null }) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { role: 'guide', name, phone, license, city_id: cityId, cpf, cnpj, pix_key: pixKey, pix_type: pixType, pix_holder: pixHolder, ref_code: refCode || null, actor_kind: actorKind, contact_name: contactName || null }, emailRedirectTo: location.href.split('#')[0] },
  });
  if (error) throw new Error(error.message.includes('registered') ? 'exists' : error.message.includes('cnpj_required') ? 'cnpj' : error.message.includes('contact_required') ? 'contact' : 'auth');
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
// v89 : un établissement s'inscrit lui-même (établissement + accès du gérant), puis l'administrateur le valide.
export async function signUpPartnerSelf({ email, password, partnerName, partnerType, city, area, address, taxId, name, phone, terms, lang }) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { role: 'partner_signup', partner_name: partnerName, partner_type: partnerType, city, area, address, tax_id: taxId, name, phone, terms, lang },
      emailRedirectTo: location.href.split('#')[0] },
  });
  if (error) throw new Error(error.message.includes('registered') ? 'exists' : 'signup');
  return Boolean(data.session);
}
// Le gérant connecté dont l'établissement attend la validation (null sinon).
export async function myPartnerPending() {
  if (!(await currentUser())) return null;
  return check(await sb.rpc('my_partner_pending'));
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
  // v103 : « validé » par l'admin = compte vérifié (les virements sont débloqués).
  check(await sb.from('guides').update(status === 'validated' ? { status, verified_at: new Date().toISOString() } : { status }).eq('id', guideId));
  // Guide validé : e-mail « Sua conta foi validada! » (fonction Supabase conta-validada). Un échec ne bloque pas.
  if (status === 'validated') {
    try { await sb.functions.invoke('conta-validada', { body: { guideId } }); } catch { /* rien */ }
  }
}

/* ---------- Partenaires ---------- */
// Cercle Kombrio et Parceiro Fundador (v52) : réglages admin par partenaire (journalisés par le trigger d'audit).
// v95 : groupes d'établissements (ex. Pierim, 3 lojas) ; Pix unique ('single') ou Pix par loja ('each').
export async function listGroups() {
  try { return check(await sb.from('partner_groups').select('*').order('name')).map((g) => ({ id: g.id, name: g.name, payMode: g.pay_mode, ownerId: g.owner_partner_id || null })); } catch { return []; }
}
// v120 : responsável du groupe (script 071), choisi par l'admin pour les groupes déjà créés.
export async function setGroupOwner(groupId, partnerId) {
  check(await sb.from('partner_groups').update({ owner_partner_id: partnerId || null }).eq('id', groupId));
}
export async function addGroup(name, payMode) {
  check(await sb.from('partner_groups').insert({ name: name.trim(), pay_mode: payMode }));
}
export async function setGroupMode(groupId, payMode) {
  check(await sb.from('partner_groups').update({ pay_mode: payMode }).eq('id', groupId));
}
export async function setPartnerGroup(partnerId, groupId) {
  check(await sb.from('partners').update({ group_id: groupId || null }).eq('id', partnerId));
}
export async function groupSpace(managerToken) {
  const d = check(await sb.rpc('group_space', { p_manager_token: managerToken }));
  if (!d) return null;
  return {
    group: { id: d.group.id, name: d.group.name, payMode: d.group.pay_mode }, me: d.me,
    members: (d.members || []).map((m) => ({ id: m.id, name: m.name, area: m.area || '', status: m.status, managerToken: m.manager_token,
      toPayCents: Number(m.to_pay_cents) || 0, toPayCount: Number(m.to_pay_count) || 0, toDeclare: Number(m.to_declare) || 0,
      verifyingCents: Number(m.verifying_cents) || 0, monthVisits: Number(m.month_visits) || 0 })),
    toPay: (d.to_pay || []).map((v) => ({ ...toVisit(v), partnerName: v.partner_name })),
    payments: (d.payments || []).map((y) => ({ id: y.id, num: num(y.num), cents: num(y.amount_cents), status: y.status, submittedAt: y.submitted_at, note: y.note || '' })),
    franchises: (d.franchises || []).map((f) => ({ name: f.name, area: f.area || '' })),   // v118
  };
}
export async function submitGroupPayment(managerToken, { visitIds, method, pixRef, receipt }) {
  return check(await sb.rpc('submit_group_payment', {
    p_manager_token: managerToken, p_visits: visitIds, p_method: method, p_pix_ref: pixRef || null, p_receipt: receipt,
  }));
}
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
  const [rows, bl] = await Promise.all([sb.rpc('public_partners', { p_city: cityId }), sb.rpc('public_blackouts', { p_city: cityId })]);
  // v118 : jours sans commission à venir (liste vide tant que le script 070 n'est pas lancé).
  const black = bl.error ? [] : (bl.data || []);
  return check(rows).map((r) => ({
    ...r, offer: r.offer || '', offerPriceCents: num(r.offer_price_cents), offerPromoCents: num(r.offer_promo_cents), offerEnd: r.offer_end || '', offerDays: (r.offer_days || []).map(Number), j1Enabled: !!r.j1_enabled,
    blackouts: black.filter((b) => b.partner_id === r.id).map(toBlackout) }));
}
// v118 : jours sans commission (ex. jours de match), choisis par le gérant. v120 : horaire facultatif (from/to, « HH:MM »).
const toBlackout = (b) => ({ day: b.day, note: b.note || '', from: b.from || '', to: b.to || '' });
export async function partnerBlackouts(token) {
  const { data, error } = await sb.rpc('partner_blackouts_list', { p_token: token });
  return error ? null : (data || []).map(toBlackout);   // null = script 070 pas lancé
}
export async function addBlackouts(managerToken, days, note, allGroup = false, from = '', to = '') {
  const args = { p_manager_token: managerToken, p_days: days, p_note: note, p_all_group: allGroup };
  if (from || to) { args.p_from = from || null; args.p_to = to || null; }   // seulement si une heure est choisie (marche aussi sans le script 071)
  return check(await sb.rpc('partner_blackouts_add', args));
}
export async function removeBlackout(managerToken, day, allGroup = false) {
  return check(await sb.rpc('partner_blackouts_remove', { p_manager_token: managerToken, p_day: day, p_all_group: allGroup }));
}
/* ---------- v120 : « Minha empresa » (script 071) — le patron gère son groupe de lojas ---------- */
export async function companySpace(managerToken) {
  const { data: d, error } = await sb.rpc('company_space', { p_manager_token: managerToken });
  if (error) return undefined;   // script 071 pas lancé
  if (!d) return null;
  return {
    me: { id: d.me.id, name: d.me.name, ownership: d.me.ownership === 'franchise' ? 'franchise' : 'own', taxRoot: d.me.tax_root || '' },
    group: d.group ? { id: d.group.id, name: d.group.name, payMode: d.group.pay_mode, isOwner: !!d.group.is_owner, hasOwner: !!d.group.has_owner, ownerName: d.group.owner_name || '' } : null,
    members: (d.members || []).map((m) => ({ id: m.id, name: m.name, area: m.area || '', status: m.status, ownership: m.ownership === 'franchise' ? 'franchise' : 'own',
      isOwner: !!m.is_owner, isMe: !!m.is_me, sameTax: !!m.same_tax, managerToken: m.manager_token || '' })),
    invites: (d.invites || []).map((i) => ({ id: i.id, code: i.code, ownership: i.ownership, expiresAt: i.expires_at })),
  };
}
const rpcOk = async (fn, args) => check(await sb.rpc(fn, args));
export const companyCreate = (tok, name) => rpcOk('company_create', { p_manager_token: tok, p_name: name });
export const companyUpdate = (tok, name, payMode) => rpcOk('company_update', { p_manager_token: tok, p_name: name || null, p_pay_mode: payMode || null });
export const companyInvite = (tok, ownership) => rpcOk('company_invite', { p_manager_token: tok, p_ownership: ownership });
export const companyInviteCancel = (tok, id) => rpcOk('company_invite_cancel', { p_manager_token: tok, p_invite: id });
export const companyInvitePeek = (tok, code) => rpcOk('company_invite_peek', { p_manager_token: tok, p_code: code });
export const companyInviteAnswer = (tok, code, accept) => rpcOk('company_invite_answer', { p_manager_token: tok, p_code: code, p_accept: accept });
export const companyAddShop = (tok, { name, area, address }) => rpcOk('company_add_shop', { p_manager_token: tok, p_name: name, p_area: area || '', p_address: address || '' });
export const companyRemove = (tok, partnerId) => rpcOk('company_remove', { p_manager_token: tok, p_partner: partnerId });
export const companyLeave = (tok) => rpcOk('company_leave', { p_manager_token: tok });
export const companyTransfer = (tok, partnerId) => rpcOk('company_transfer', { p_manager_token: tok, p_partner: partnerId });
export async function setPartnerOwnership(partnerId, ownership) {
  check(await sb.from('partners').update({ ownership }).eq('id', partnerId));
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
  return { role: d.role, staff: d.staff || null, partner: toPartner(d.partner), city: toCity(d.city), visits: nestLines((d.visits || []).map((v) => toVisit({ ...v, code: codes[v.id] }))), payments: (d.payments || []).map(toPayment),
    adjustments: (d.adjustments || []).map(toAdjustment) };
}
// Relevé du comptable (lecture seule), à partir de son lien. null si le lien n'est pas reconnu.
export async function partnerReport(reportToken) {
  const d = check(await sb.rpc('partner_report', { p_token: reportToken }));
  if (!d) return null;
  return { partner: toPartner(d.partner), city: toCity(d.city), visits: nestLines((d.visits || []).map(toVisit)), payments: (d.payments || []).map(toPayment),
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

// v70 : offre complète du partenaire (cadeau, prix Kombrio, dates) ; offre valable tel jour ?
export async function setPartnerOfferFull(managerToken, { offer, priceCents, promoCents, start, end, days }) {
  return check(await sb.rpc('set_partner_offer_full', {
    p_manager_token: managerToken, p_offer: offer, p_price_cents: priceCents, p_promo_cents: promoCents, p_start: start || null, p_end: end || null,
    p_days: days && days.length && days.length < 7 ? days : null }));
}
// v92 : jour ISO (1 = lundi … 7 = dimanche) d'une date « AAAA-MM-JJ ».
export const isoWeekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
export const offerActive = (p, day) => (!p.offerStart || day >= p.offerStart) && (!p.offerEnd || day <= p.offerEnd)
  && (!p.offerDays || !p.offerDays.length || p.offerDays.includes(isoWeekday(day)));
// v99 : taux du partenaire pour les Tour Companies et les agences (s'ajoutent au taux guide).
export async function setPartnerRoleRates(managerToken, tc, agency) {
  return check(await sb.rpc('set_partner_role_rates', { p_manager_token: managerToken, p_tc: tc, p_agency: agency }));
}
export async function setCommissionRate(managerToken, rate) {
  return check(await sb.rpc('set_commission_rate', { p_manager_token: managerToken, p_rate: rate }));
}
// v68 : le gérant choisit son modèle de commission (% de l'addition ou forfait par personne, en centavos).
export async function setCommissionModel(managerToken, model, perPersonCents = null) {
  return check(await sb.rpc('set_commission_model', { p_manager_token: managerToken, p_model: model, p_per_person_cents: perPersonCents }));
}
// v68 : commission d'un passage, comme le calcule la base (commission_for).
export function commissionFor(partner, visit, invoiceCents, people, children = 0, excludedCents = null) {
  const pp = visit ? (visit.perPersonCents ?? null) : forfaitOf(partner);
  if (invoiceCents == null) return null;
  const n = Math.max(1, Number(people) || 1);
  const cc = visit ? (visit.childCents ?? null) : (partner.askChildren ? partner.childCents : null);
  const kids = cc == null ? 0 : Math.min(n, Math.max(0, Number(children) || 0));
  const every = visit ? visit.bonusEvery : partner.bonusEvery;
  const bonus = invoiceCents > 0 && every > 0 ? Math.floor(n / every) * ((visit ? visit.bonusCents : partner.bonusCents) || 0) : 0;
  // v123 : la part non commissionnable (ex. bebidas) est retirée de l'addition pour le % ; plafond et minimum par passage.
  const ex = excludedCents != null ? excludedCents : (visit && visit.excludedCents) || 0;
  const base = Math.max(0, invoiceCents - (partner.excludedLabel || (visit && visit.excludedCents) ? ex : 0));
  const raw = pp == null ? Math.round(base * ((visit && visit.rate) ?? partner.commissionRate)) + bonus
    : invoiceCents === 0 ? 0 : (n - kids) * pp + kids * cc + bonus;
  const cap = visit ? visit.capCents : partner.capCents; const min = visit ? visit.minCents : partner.minCents;
  return raw > 0 ? Math.min(cap ?? raw, Math.max(min || 0, raw)) : raw;
}
// v123 : règles de commission du gérant (part non commissionnable, plafond, minimum, palier) et horaires turbo.
export async function setCommissionRules(managerToken, { excludedLabel, capCents, minCents, tierClients, tierRate, tierPpCents }) {
  return check(await sb.rpc('set_commission_rules', { p_manager_token: managerToken, p_excluded_label: excludedLabel || null, p_cap_cents: capCents || null,
    p_min_cents: minCents || null, p_tier_clients: tierClients || null, p_tier_rate: tierRate || null, p_tier_pp_cents: tierPpCents || null }));
}
const toBoost = (b) => ({ id: b.id, day: b.day || '', weekdays: (b.weekdays || []).map(Number), from: b.from || '', to: b.to || '',
  rate: b.rate == null ? null : Number(b.rate), ppCents: num(b.pp_cents), note: b.note || '' });
export async function partnerBoosts(token) {
  const { data, error } = await sb.rpc('partner_boosts_list', { p_token: token });
  return error ? null : (data || []).map(toBoost);   // null = script 074 pas lancé
}
export async function addBoosts(managerToken, { days, weekdays, from, to, rate, ppCents, note }) {
  return check(await sb.rpc('partner_boosts_add', { p_manager_token: managerToken, p_days: days && days.length ? days : null,
    p_weekdays: weekdays && weekdays.length ? weekdays : null, p_from: from || null, p_to: to || null, p_rate: rate ?? null, p_pp_cents: ppCents ?? null, p_note: note || '' }));
}
export async function removeBoost(managerToken, id) {
  return check(await sb.rpc('partner_boosts_remove', { p_manager_token: managerToken, p_id: id }));
}
// Pour le guide connecté : horaires turbo, paliers et parts non commissionnées des partenaires de sa ville ([] sans le script 074).
export async function guideIncentives(cityId) {
  const { data, error } = await sb.rpc('guide_incentives', { p_city: cityId });
  return error ? [] : (data || []).map((x) => ({ partnerId: x.partner_id, model: x.model, rate: x.rate == null ? null : Number(x.rate), ppCents: num(x.pp_cents),
    tier: x.tier ? { clients: Number(x.tier.clients), rate: x.tier.rate == null ? null : Number(x.tier.rate), ppCents: num(x.tier.pp_cents) } : null,
    excludedLabel: x.excluded_label || '', boosts: (x.boosts || []).map(toBoost) }));
}
// v71 : forfait enfant — le serveur indique les enfants du groupe ; le gérant fixe le montant par enfant.
export async function setVisitChildren(token, visitId, children) {
  return check(await sb.rpc('set_visit_children', { p_token: token, p_visit: visitId, p_children: children }));
}
export async function setChildCents(managerToken, cents) {
  return check(await sb.rpc('set_child_cents', { p_manager_token: managerToken, p_cents: cents }));
}
// v69 : repas offerts au guide présent sur un passage (« 1 tous les N clients »).
export const mealsFor = (every, people) => (every > 0 ? Math.floor(Math.max(1, Number(people) || 1) / every) : 0);
export async function setPartnerExtras(managerToken, bonusEvery, bonusCents, mealEvery) {
  return check(await sb.rpc('set_partner_extras', { p_manager_token: managerToken, p_bonus_every: bonusEvery, p_bonus_cents: bonusCents, p_meal_every: mealEvery }));
}
const forfaitOf = (partner) => (partner && partner.commissionModel === 'per_person' ? partner.perPersonCents : null);
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
// v100 : agences et TC : rattacher un TC ou des guides à un groupe, par leur code.
export async function linkActor(stayId, code) { return check(await sb.rpc('link_actor', { p_stay: stayId, p_code: code })); }
export async function unlinkActor(stayId, actorId) { return check(await sb.rpc('unlink_actor', { p_stay: stayId, p_actor: actorId })); }
export async function stayActors(stayId) { try { return check(await sb.rpc('stay_actors', { p_stay: stayId })) || []; } catch { return []; } }
export async function myLinkedStays() { try { return check(await sb.rpc('my_linked_stays')) || []; } catch { return []; } }
export async function stayCommissionLines(stayId) { try { return check(await sb.rpc('stay_commission_lines', { p_stay: stayId })) || []; } catch { return []; } } // v102
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
export async function declareVisit(token, visitId, { invoiceCents, commissionCents = null, guideMeal = false, table = null, photo = null, note = null, excludedCents = null }) {
  // v123 : avec une part non commissionnable, declare_visit_ex l'enregistre puis fait la même saisie (script 074).
  if (excludedCents != null) return check(await sb.rpc('declare_visit_ex', {
    p_token: token, p_visit: visitId, p_invoice_cents: invoiceCents, p_excluded_cents: excludedCents, p_commission_cents: commissionCents,
    p_guide_meal: guideMeal, p_table: table, p_photo: photo, p_note: note,
  }));
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
export async function recordDirectSale(partnerToken, guideRef, { invoiceCents, people = 1, commissionCents = null, note = null, photo = null }) {
  return check(await sb.rpc('record_direct_sale', {
    p_partner_token: partnerToken, p_guide: guideRef, p_invoice_cents: invoiceCents, p_people: people, p_commission_cents: commissionCents, p_note: note, p_photo: photo,
  }));
}
// v66 : « Minha equipe » — le gérant invite, renvoie un lien, retire ; le téléphone de la personne s'inscrit avec le lien ou le code.
export async function staffList(managerToken) {
  return check(await sb.rpc('staff_list', { p_manager_token: managerToken })) || [];
}
export async function staffInvite(managerToken, name, post) {
  return check(await sb.rpc('staff_invite', { p_manager_token: managerToken, p_name: name, p_post: post }));
}
export async function staffReinvite(managerToken, staffId) {
  return check(await sb.rpc('staff_reinvite', { p_manager_token: managerToken, p_staff: staffId }));
}
export async function staffRevoke(managerToken, staffId) {
  return check(await sb.rpc('staff_revoke', { p_manager_token: managerToken, p_staff: staffId }));
}
export async function staffEnroll(ref) {
  return check(await sb.rpc('staff_enroll', { p_ref: ref }));
}
export async function partnerSetCounter(managerToken, enabled) {
  return check(await sb.rpc('partner_set_counter', { p_manager_token: managerToken, p_enabled: enabled }));
}
// v67 : fiche du serveur (guide présent / clients seuls), QR « Guia + grupo », réglages.
export async function identifyRef(token, ref) {
  return check(await sb.rpc('identify_ref', { p_token: token, p_ref: ref }));
}
export async function recordBill(token, { guide = null, client = null, invoiceCents = null, people = null, table = null, photo = null, note = null, commissionCents = null }) {
  return check(await sb.rpc('record_bill', {
    p_token: token, p_guide: guide, p_client: client, p_invoice_cents: invoiceCents, p_people: people, p_table: table,
    p_photo: photo, p_note: note, p_commission_cents: commissionCents,
  }));
}
export async function setVisitGuide(token, visitId, guideRef) {
  return check(await sb.rpc('set_visit_guide', { p_token: token, p_visit: visitId, p_guide: guideRef }));
}
export async function visitGuideCard(token, visitId) {
  return check(await sb.rpc('visit_guide_card', { p_token: token, p_visit: visitId }));
}
export async function partnerSetStaffPhoto(managerToken, on) {
  return check(await sb.rpc('partner_set_staff_photo', { p_manager_token: managerToken, p_on: on }));
}
export async function guideGroupToken(stayId) {
  return check(await sb.rpc('guide_group_token', { p_stay: stayId }));
}
// v68 · Admin : modèle de commission d'un partenaire (% de l'addition ou forfait par client), journalisé par le trigger d'audit.
export async function setPartnerCommission(partnerId, { model, rate, perPersonCents }) {
  const row = model === 'per_person' ? { commission_model: 'per_person', per_person_cents: perPersonCents } : { commission_model: 'percent', commission_rate: rate };
  check(await sb.from('partners').update(row).eq('id', partnerId));
}
// Admin : frais du mode 2 d'un partenaire (taux et plafond mensuel), journalisés par le trigger d'audit.
export async function setPartnerFees(partnerId, rate, capCents) {
  check(await sb.from('partners').update({ mode2_fee_rate: rate, mode2_fee_cap_cents: capCents }).eq('id', partnerId));
}
// v77 : virement J+1 du guide présent, au choix du partenaire (gérant par son lien ; admin directement).
export async function partnerSetJ1(managerToken, on) {
  return check(await sb.rpc('partner_set_j1', { p_manager_token: managerToken, p_on: on }));
}
export async function setPartnerJ1(partnerId, on) {
  check(await sb.from('partners').update({ j1_enabled: on }).eq('id', partnerId));
}
// v66 : photo de l'addition pour l'admin, seulement dans un litige (alerte sur le passage).
export async function adminBillPhoto(visitId) {
  return check(await sb.rpc('admin_bill_photo', { p_visit: visitId }));
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
// v96 : statut fiscal du guide payé en CNPJ (mei, company, rep) et NFS-e par partenaire sur chaque virement.
// v97 : Document B = NFS-e de Kombrio par partenaire et par mois (montant = part Kombrio du mois).
export async function adminDocumentB(month) { return check(await sb.rpc('admin_document_b', { p_month: `${month}-01` })) || []; }
export async function adminSetPartnerNfse(partnerId, month, number, amountCents, file) {
  return check(await sb.rpc('admin_set_partner_nfse', { p_partner: partnerId, p_month: `${month}-01`, p_number: number, p_amount_cents: amountCents, p_file: file || null }));
}
export async function partnerNfseList(token) { try { return check(await sb.rpc('partner_nfse_list', { p_token: token })) || []; } catch { return []; } }
export async function partnerNfseFile(token, month, partnerId = null) { return check(await sb.rpc('partner_nfse_file', { p_token: token, p_month: `${String(month).slice(0, 7)}-01`, p_partner: partnerId })); }
export async function setMyFiscalStatus(status) { return check(await sb.rpc('set_my_fiscal_status', { p_status: status })); }
export async function attachPayoutNf(payoutId, partnerId, number, file) {
  return check(await sb.rpc('guide_attach_nf', { p_payout: payoutId, p_partner: partnerId, p_number: number, p_file: file }));
}
export async function payoutNfFile(payoutId, partnerId) { return check(await sb.rpc('payout_nf_file', { p_payout: payoutId, p_partner: partnerId })); }
export async function payoutNfLines(payoutIds) {
  if (!payoutIds.length) return [];
  try { return check(await sb.from('payout_lines').select('payout_id,partner_id,tax_kind,gross_cents,nf_number,nf_at').in('payout_id', payoutIds)); } catch { return []; }
}
export async function setMyTaxIds(cpf, cnpj) { return check(await sb.rpc('set_my_tax_ids', { p_cpf: cpf || null, p_cnpj: cnpj || null })); }
export async function setMyPixKey(key, type, holder) { return check(await sb.rpc('set_my_pix_key', { p_key: key, p_type: type, p_holder: holder })); }
export async function startPixVerification(guideId) { return check(await sb.rpc('start_pix_verification', { p_guide: guideId })); }
export async function recordPixSent(verifId, e2e, feeCents, receipt = null) {
  return check(await sb.rpc('record_pix_sent', { p_verification: verifId, p_e2e: e2e, p_receipt: receipt, p_fee_cents: feeCents || 0 }));
}
// v90 : comprovante d'un paiement fait par Kombrio (virement guide, prime de parrainage). Jamais bloquant.
export async function attachReceipt(kind, refId, receipt, e2e) {
  if (!receipt) return false;
  try { return check(await sb.rpc('admin_attach_receipt', { p_kind: kind, p_ref: refId, p_receipt: receipt, p_e2e: e2e || null })); } catch { return false; }
}
export async function receiptIndex() {
  try { return check(await sb.from('payment_receipts').select('kind,ref_id')); } catch { return []; }
}
export async function getReceipt(kind, refId) {
  return check(await sb.from('payment_receipts').select('receipt').eq('kind', kind).eq('ref_id', refId).maybeSingle())?.receipt || null;
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
// v72 : paiement rapide J+1 du guide présent — virement des seuls passages « guide présent » reçus ; liste des virements à faire.
export async function startPayoutExpress(guideId) {
  return check(await sb.rpc('start_payout_express', { p_guide: guideId }));
}
export async function expressPayoutsDue() {
  return check(await sb.rpc('express_payouts_due')) || [];
}
// Jour ouvré suivant ('AAAA-MM-JJ'), samedi et dimanche sautés (jours fériés non gérés).
export function nextBusinessDay(day) {
  const d = new Date(`${day}T12:00:00Z`); const w = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (w === 5 ? 3 : w === 6 ? 2 : 1));
  return d.toISOString().slice(0, 10);
}
export async function startPayout(guideId) {
  return check(await sb.rpc('start_payout', { p_guide: guideId }));
}
// Récapitulatif INSS d'un mois (admin) : par partenaire et par guide, virements payés ce mois-là. month = 'AAAA-MM'.
export async function adminInssReport(month) {
  return check(await sb.rpc('admin_inss_report', { p_month: `${month}-01` }));
}
/* ---------- Déclarations INSS (v84, script 049) ---------- */
// Taux datés (admin). [] si la table manque.
export async function listTaxRules() {
  const { data, error } = await sb.from('tax_rules').select('*').order('city_id').order('kind').order('valid_from', { ascending: false });
  return error ? [] : data || [];
}
export async function setTaxRule({ city, kind = 'inss_ci', rate, ceilingCents, from, note, source }) {
  return check(await sb.rpc('set_tax_rule', { p_city: city, p_kind: kind, p_rate: rate, p_ceiling_cents: ceilingCents ?? null,
    p_from: from, p_note: note || null, p_source: source || null }));
}
// v98 : règles IRRF (Kombrio source payeuse) : table CPF progressive ('irrf_pf') ou taux CNPJ ('irrf_pj').
export async function setIrrfRule({ city, kind, rate, brackets, params, from, note, source }) {
  return check(await sb.rpc('set_irrf_rule', { p_city: city, p_kind: kind, p_rate: rate ?? null, p_brackets: brackets ?? null,
    p_params: params || {}, p_from: from, p_note: note || null, p_source: source || null }));
}
export async function adminSetInssFiling(partnerId, mode, procuracao, note) {
  return check(await sb.rpc('admin_set_inss_filing', { p_partner: partnerId, p_mode: mode, p_procuracao: procuracao || null, p_note: note || null }));
}
export async function adminInssPrepare(month) { return check(await sb.rpc('admin_inss_prepare', { p_month: `${month}-01` })); }
export async function adminInssOverview(month) { return check(await sb.rpc('admin_inss_overview', { p_month: `${month}-01` })); }
// À faire tous mois passés confondus ; null si le script 049 manque.
export async function adminInssTodo() {
  const { data, error } = await sb.rpc('admin_inss_todo');
  return error ? null : data || [];
}
export async function adminInssStep(declId, step, data) {
  return check(await sb.rpc('admin_inss_step', { p_decl: declId, p_step: step, p_data: data || {} }));
}
// Côté partenaire (code du gérant ou lien du comptable). null si le script 049 manque ou si le lien est inconnu.
export async function partnerInss(token) {
  const { data, error } = await sb.rpc('partner_inss_list', { p_token: token });
  return error ? null : data;
}
export async function partnerSetInssFiling(managerToken, mode) {
  return check(await sb.rpc('partner_set_inss_filing', { p_manager_token: managerToken, p_mode: mode }));
}
// Pièce jointe : 'darf' (PDF du DARF) ou 'proof' (preuve de paiement). token = null pour l'admin.
export async function inssFile(token, declId, kind) {
  return check(await sb.rpc('inss_declaration_file', { p_token: token, p_decl: declId, p_kind: kind }));
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
  internal: !!r.internal, urgent: r.urgent !== false, partnerLang: r.partners?.lang || 'pt',
  guideName: r.guides?.name || '', partnerName: r.partners?.name || '', visitNum: num(r.visits?.num), visitCode: r.visits?.code || '',
});
// v116 : niveau choisi (urgent = e-mail tout de suite ; sinon la demande attend dans l'admin, script 068).
// Tant que le script 068 n'est pas lancé, l'ancienne fonction (sans niveau) est appelée : tout reste urgent, comme avant.
async function alertRpc(fn, args, urgent) {
  const r = await sb.rpc(fn, { ...args, p_urgent: urgent !== false });
  if (r.error && /p_urgent|function|schema cache/i.test(r.error.message || '')) return check(await sb.rpc(fn, args));
  return check(r);
}
export async function guideCreateAlert(topic, message, visitId = null, urgent = true) {
  return alertRpc('guide_create_alert', { p_topic: topic, p_message: message, p_visit: visitId }, urgent);
}
export async function partnerCreateAlert(token, topic, message, visitId = null, urgent = true) {
  return alertRpc('partner_create_alert', { p_token: token, p_topic: topic, p_message: message, p_visit: visitId }, urgent);
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
/* ---------- v117 : avisos (script 069) — messages de Kombrio aux groupes ---------- */
// Tant que le script 069 n'est pas lancé, les lectures renvoient une liste vide (l'app reste utilisable).
const toBroadcast = (r) => ({
  id: r.id, num: r.num, level: r.level, title: r.title || {}, body: r.body || {}, createdAt: r.created_at,
  seenAt: r.seen_at || null, ackedAt: r.acked_at || null, audience: r.audience || [], emails: r.emails || 0,
  archivedAt: r.archived_at || null, targets: r.targets ?? null, seen: r.seen ?? null, acked: r.acked ?? null,
});
export async function guideBroadcasts() {
  const { data, error } = await sb.rpc('guide_broadcasts');
  return error ? [] : (data || []).map(toBroadcast);
}
export async function guideBroadcastMark(id, ack = false) {
  return check(await sb.rpc('guide_broadcast_mark', { p_id: id, p_ack: ack }));
}
export async function guideSetLang(lang) {
  try { await sb.rpc('guide_set_lang', { p_lang: lang }); } catch { /* script 069 pas lancé */ }
}
export async function partnerBroadcasts(token) {
  const { data, error } = await sb.rpc('partner_broadcasts', { p_token: token });
  return error ? [] : (data || []).map(toBroadcast);
}
export async function partnerBroadcastMark(token, id, ack = false) {
  return check(await sb.rpc('partner_broadcast_mark', { p_token: token, p_id: id, p_ack: ack }));
}
export async function adminBroadcasts() {
  const { data, error } = await sb.rpc('admin_broadcasts');
  if (error) return null;   // null = script 069 pas encore lancé
  return (data || []).map(toBroadcast);
}
export async function adminBroadcastSend(audience, level, title, body) {
  return check(await sb.rpc('admin_broadcast_send', { p_audience: audience, p_level: level, p_title: title, p_body: body }));
}
export async function adminBroadcastReaders(id) {
  return check(await sb.rpc('admin_broadcast_readers', { p_id: id })) || [];
}
export async function adminBroadcastArchive(id, archived = true) {
  return check(await sb.rpc('admin_broadcast_archive', { p_id: id, p_archived: archived }));
}

export async function countFaqSolved(kind, topic) {
  try { await sb.rpc('count_faq_solved', { p_kind: kind, p_topic: topic }); } catch { /* simple compteur */ }
}
export async function adminListAlerts() {
  const { data, error } = await sb.from('alerts').select('*, guides(name), partners(name, lang), visits(num, code)').order('created_at', { ascending: false }).limit(200);
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
// v74 : acceptation d'une version des conditions (guide connecté ; gérant du partenaire par son lien).
export async function acceptGuideTerms(version) {
  return check(await sb.rpc('accept_guide_terms', { p_version: version }));
}
export async function acceptPartnerTerms(managerToken, version) {
  return check(await sb.rpc('accept_partner_terms', { p_manager_token: managerToken, p_version: version }));
}

/* ---------- Agenda administratif (v85, script 050) ---------- */
// Échéances d'un mois (obligations + échéances vivantes) ; null si le script 050 manque. month = 'AAAA-MM'.
export async function adminAgenda(month) {
  const { data, error } = await sb.rpc('admin_agenda', { p_month: `${month}-01` });
  return error ? null : data;
}
export async function listObligations() {
  const { data, error } = await sb.from('admin_obligations').select('*').order('sort').order('id');
  return error ? [] : data || [];
}
export async function saveObligation(o) { return check(await sb.rpc('admin_obligation_save', { p: o })); }
export async function markObligation(id, due, done, ref, note) {
  return check(await sb.rpc('admin_obligation_mark', { p_obligation: id, p_due: due, p_done: done, p_ref: ref || null, p_note: note || null }));
}
// v101 : part de Kombrio sur les commissions d'agence et de TC.
export async function getActorShare() {
  try { const r = check(await sb.from('admin_settings').select('actor_platform_share').eq('id', 1).maybeSingle()); return r ? Number(r.actor_platform_share) : null; } catch { return null; }
}
export async function setActorShare(share) { return check(await sb.rpc('admin_set_actor_share', { p_share: share })); }
export async function saveAdminSettings({ name, cnpj, opened, regime }) {
  return check(await sb.rpc('admin_settings_save', { p_name: name || null, p_cnpj: cnpj || null, p_opened: opened || null, p_regime: regime }));
}

// v134 : import du relevé du mois (« dossier Pierim ») — le gérant dépose la planilha de ses ventes avec guide.
export async function importSpace(managerToken) {
  const { data, error } = await sb.rpc('import_space', { p_manager_token: managerToken });
  return error ? null : data;   // null = script 075 pas lancé (ou jeton inconnu)
}
export async function importTemplateSet(managerToken, mapping) {
  return check(await sb.rpc('import_template_set', { p_manager_token: managerToken, p_mapping: mapping }));
}
export async function importMatchGuides(managerToken, refs) {
  return check(await sb.rpc('import_match_guides', { p_manager_token: managerToken, p_refs: refs })) || [];
}
export async function importAliasSet(managerToken, label, guideCode) {
  return check(await sb.rpc('import_alias_set', { p_manager_token: managerToken, p_label: label, p_guide_code: guideCode || '' }));
}
export async function importSales(managerToken, month, fileName, rows) {
  return check(await sb.rpc('import_sales', { p_manager_token: managerToken, p_month: month, p_file: fileName, p_rows: rows }));
}
export async function importUndo(managerToken, importId) {
  return check(await sb.rpc('import_undo', { p_manager_token: managerToken, p_import: importId }));
}

// v136 : la photo du guide fait foi — validation par l'admin ; « Não é a pessoa da foto » à la caisse.
export async function adminPhotoDecide(guideId, ok, reason = null) {
  return check(await sb.rpc('admin_photo_decide', { p_guide: guideId, p_ok: ok, p_reason: reason }));
}
export async function guidePhotoMismatch(token, ref) {
  return check(await sb.rpc('guide_photo_mismatch', { p_token: token, p_ref: ref }));
}

// v137 (lot A) : comptes de guides qui partagent une clé Pix, un CPF ou un CNPJ — visible seulement de l'admin.
export async function adminGuideDuplicates() {
  const { data, error } = await sb.rpc('admin_guide_duplicates');
  return error ? [] : (data || []);   // [] = script 078 pas lancé
}
export async function adminGuideDuplicateOk(kind, key, note = '') {
  return check(await sb.rpc('admin_guide_duplicate_ok', { p_kind: kind, p_key: key, p_note: note }));
}
