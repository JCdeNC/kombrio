// Espace du guide : connexion, séjours, QR, suivi des passages et de ses gains.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, cents, locale, fmtDay, fmtMoment, todayIn, addDays, stayIsValid, qrSvg, appLink, notify, validCpf, validCnpj, onlyDigits, maskCadastur, validCadastur, validPixKey } from '../util.js';
import * as store from '../store.js';
import { validity, statusBadge, guideAmounts, notFound, forgotLink, mountForgot, resetView } from './shared.js';
import { maskTaxId, qrCardBlob, shareOrDownload, photoToJpeg } from '../util.js';
import { helpButton, problemLink, mountHelp, topicLabel, alertStatus } from './help.js';
import { WEEKLY_OPTION } from '../config.js';
// Durée maximale d'un séjour (K-15, décidé le 06/11/2026) : les clients restent au plus une semaine. Même règle dans la base (script 014).
const MAX_STAY_DAYS = 7;

export async function guideView(params, ctx) {
  // Lien « nouveau mot de passe » : il suffit d'être connecté par le lien, même sans fiche guide complète.
  if (store.inRecovery() && await store.hasSession()) return resetView();
  const me = await store.currentGuide();
  if (!me) {
    // Connecté, mais pas guide (ex. un compte partenaire) : on l'envoie vers la bonne application.
    if (await store.hasSession()) {
      // Le message dépend du compte connecté : administrateur ou partenaire.
      const who = await store.currentAdmin().catch(() => null);
      // Compte supprimé (plus de profil) : on ferme cette ancienne session et on montre l'inscription.
      if (who && !who.role) { await store.signOut(); return loginView(); }
      const admin = Boolean(who && who.isAdmin);
      return {
        html: `<div class="card"><p>${admin ? t('guide.notguide.admin', { email: who.email }) : t('guide.notguide')}</p>
          <a class="btn block" href="${appLink(admin ? 'admin' : 'partner')}">${t(admin ? 'guide.notguide.goadmin' : 'guide.notguide.go')}</a>
          <button type="button" class="btn block secondary" id="ng-out" style="margin-top:12px">${t(admin ? 'guide.notguide.outsignup' : 'guide.notguide.out')}</button></div>`,
        mount(root, ctx) { root.querySelector('#ng-out').onclick = async () => { await store.signOut(); ctx.refresh(); }; },
      };
    }
    return loginView();
  }
  if (me.status !== 'validated') return pendingView(me);
  const city = await store.getCity(me.cityId);
  if (params[0] === 'sejour') return stayView(me, city, params[1]);
  if (params[0] === 'releve') return statementView(me, city);
  if (params[0] === 'indicacao') return referralView(me, city);
  if (params[0] === 'cracha') return badgeView(me, city);
  if (['clientes', 'ganhos', 'conta'].includes(params[0])) return dashboardView(me, city, params[0]);
  return dashboardView(me, city);
}

async function loginView() {
  const cities = await store.listCities();
  return {
    html: `
      <h1>${t('guide.login.title')}</h1>
      <form class="card" id="login">
        <h2>${t('auth.login')}</h2>
        <div class="field"><label for="l-email">${t('auth.email')}</label><input id="l-email" name="email" type="email" required autocomplete="email"></div>
        <div class="field"><label for="l-pass">${t('auth.password')}</label><input id="l-pass" name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn block">${t('auth.login')}</button>
        ${forgotLink()}
      </form>
      <form class="card" id="signup">
        <h2>${t('guide.signup.title')}</h2>
        <h3 class="su-step">1. ${t('su.s.you')}</h3>
        <div class="field"><label for="g-name">${t('guide.signup.name')}</label><input id="g-name" name="name" required autocomplete="name"></div>
        <div class="grid2">
          <div class="field"><label for="g-phone">${t('guide.signup.phone')}</label><input id="g-phone" name="phone" type="tel" required autocomplete="tel" placeholder="(21) 90000-0000"></div>
          <div class="field"><label for="g-city">${t('guide.signup.city')}</label>
            <select id="g-city" name="cityId">${cities.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        </div>
        <h3 class="su-step">2. ${t('su.s.id')}</h3>
        <div class="field" role="radiogroup" aria-label="${t('guide.signup.taxkind')}"><span class="hint">${t('guide.signup.taxkind')}</span>
          <div class="row" style="gap:18px;margin-top:4px">
            <label style="display:flex;gap:6px;align-items:center;font-weight:400;margin:0"><input type="radio" name="taxKind" value="cpf" checked style="width:auto">${t('guide.signup.kind.cpf')}</label>
            <label style="display:flex;gap:6px;align-items:center;font-weight:400;margin:0"><input type="radio" name="taxKind" value="cnpj" style="width:auto">${t('guide.signup.kind.cnpj')}</label></div></div>
        <div class="grid2">
          <div class="field"><label for="g-cpf" id="g-cpf-l">${t('guide.signup.cpf')}</label><input id="g-cpf" name="cpf" required inputmode="numeric" placeholder="000.000.000-00"></div>
          <div class="field"><label for="g-license">${t('guide.signup.license')}</label><input id="g-license" name="license" required inputmode="numeric" placeholder="00.000000.00-0"></div>
        </div>
        <p class="hint" style="margin-top:-6px">${t('guide.signup.license.hint')}</p>
        <h3 class="su-step">3. ${t('su.s.pix')}</h3>
        <div class="grid2">
          <div class="field"><label for="g-ptype">${t('pix.type')}</label><select id="g-ptype" name="pixType">${PIX_TYPES.map((k) => `<option value="${k}"${k === 'cpf' ? ' selected' : ''}>${t(`pix.type.${k}`)}</option>`).join('')}</select></div>
          <div class="field"><label for="g-pix">${t('guide.signup.pix')}</label><input id="g-pix" name="pixKey" required autocomplete="off"></div>
        </div>
        <div class="field"><label for="g-holder">${t('su.pix.holder')}</label><input id="g-holder" name="pixHolder" required minlength="3" maxlength="120" autocomplete="off"></div>
        <p class="hint" style="margin-top:-6px">${t('su.pix.holder.hint')}</p>
        <h3 class="su-step">4. ${t('su.s.access')}</h3>
        <div class="field"><label for="g-email">${t('auth.email')}</label><input id="g-email" name="email" type="email" required autocomplete="email"></div>
        <div class="grid2">
          <div class="field"><label for="g-pass">${t('auth.password.new')}</label><input id="g-pass" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
          <div class="field"><label for="g-pass2">${t('auth.password.confirm')}</label><input id="g-pass2" name="password2" type="password" required minlength="8" autocomplete="new-password"></div>
        </div>
        ${refFromUrl() ? `<p class="notice">${t('su.ref.from', { code: refFromUrl() })}</p><input type="hidden" name="refCode" value="${esc(refFromUrl())}">` : ''}
        <p class="hint">${t('guide.signup.hint')}</p>
        <button class="btn block">${t('guide.signup.submit')}</button>
      </form>`,
    mount(root, ctx) {
      mountForgot(root.querySelector('#login'));
      // Case CPF / CNPJ : le champ s'adapte (masque, libellé, exemple) et se vide au changement.
      let kind = 'cpf';
      const taxIn = root.querySelector('#g-cpf');
      maskTaxId(taxIn, () => kind);
      root.querySelectorAll('input[name="taxKind"]').forEach((r) => { r.onchange = () => {
        kind = r.value; taxIn.value = '';
        taxIn.placeholder = kind === 'cnpj' ? '00.000.000/0000-00' : '000.000.000-00';
        root.querySelector('#g-cpf-l').textContent = tRaw(kind === 'cnpj' ? 'guide.signup.cnpj' : 'guide.signup.cpf');
        taxIn.focus();
      }; });
      maskCadastur(root.querySelector('#g-license'));
      // Clé Pix CPF / CNPJ : reprise du numéro saisi plus haut (modifiable).
      const pType = root.querySelector('#g-ptype'); const pKey = root.querySelector('#g-pix');
      const fillKey = () => { if (['cpf', 'cnpj'].includes(pType.value) && !pKey.value) pKey.value = taxIn.value; };
      pType.onchange = () => { pKey.value = ''; fillKey(); pKey.placeholder = tRaw(`su.pix.ph.${pType.value}`); };
      pKey.placeholder = tRaw('su.pix.ph.cpf');
      pKey.onfocus = fillKey;
      root.querySelector('#login').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try { await store.signIn(f.email.trim(), f.password); ctx.refresh(); } catch { notify(tRaw('auth.err.login')); }
      };
      root.querySelector('#signup').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (f.password !== f.password2) { notify(tRaw('auth.err.mismatch')); return; }
        const cnpj = f.taxKind === 'cnpj';
        if (cnpj ? !validCnpj(f.cpf) : !validCpf(f.cpf)) { notify(tRaw(cnpj ? 'guide.signup.err.cnpj' : 'guide.signup.err.cpf')); return; }
        if (!validCadastur(f.license) || (onlyDigits(f.license).length === 11 && onlyDigits(f.license) === onlyDigits(f.cpf))) { notify(tRaw('guide.signup.err.license')); return; }
        if (!validPixKey(f.pixType, f.pixKey)) { notify(tRaw('pix.err.key')); return; }
        if ((f.pixHolder || '').trim().length < 3) { notify(tRaw('su.pix.holder.err')); return; }
        try {
          const ready = await store.signUpGuide({
            email: f.email.trim(), password: f.password, name: f.name.trim(), phone: f.phone.trim(),
            license: f.license.trim(), cityId: f.cityId, cpf: onlyDigits(f.cpf), taxKind: cnpj ? 'cnpj' : 'cpf', pixKey: f.pixKey.trim(), pixType: f.pixType, pixHolder: f.pixHolder.trim().replace(/\s+/g, ' '), refCode: (f.refCode || '').trim(),
          });
          ctx.refresh(tRaw(ready ? 'guide.signup.done' : 'auth.confirm'));
        } catch (err) { notify(tRaw(err.message === 'exists' ? 'auth.err.exists' : 'auth.err.signup')); }
      };
    },
  };
}

function logoutButton() {
  return `<button class="btn ghost small" id="logout">${t('common.logout')}</button>`;
}
function mountLogout(root, ctx) {
  root.querySelector('#logout').onclick = async () => { await store.signOut(); ctx.go(''); };
}

async function pendingView(me) {
  return {
    html: `
      <div class="spread"><h1>${t('guide.hello', { name: me.name })}</h1>${logoutButton()}</div>
      <div class="notice warn">${t(me.status === 'refused' ? 'guide.refused' : me.status === 'suspended' ? 'guide.suspended' : 'guide.pending')}</div>`,
    mount: mountLogout,
  };
}

// Espace du guide (v33) : onglets Início, Clientes, Ganhos, Conta (+ Indicação). Mêmes données qu'avant, autre présentation.
// Indépendance du guide (Portaria MTur 37/2021, art. 9 VI) : aucun classement des parceiros, aucun objectif de vente.
const G_TABS = ['inicio', 'clientes', 'ganhos', 'conta'];
const LATE_DAYS = 7;
const ageDays = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 864e5) : 0);
const gDoneKey = (id) => `kb-gtodo-${id}`;
const readDone = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch { return new Set(); } };
const saveDone = (k, set) => { try { localStorage.setItem(k, JSON.stringify([...set])); } catch { /* rien */ } };
const CASHED = ['received', 'payout_pending', 'paid'];

// Suivi d'une commission, comme un colis : Visita → Declarada → Paga → Recebida → Repassada, avec déviation si retard ou contestation.
const TRK_STEP = { visited: 1, declared: 2, verifying: 3, received: 4, payout_pending: 4, paid: 5 };
function tracker(v) {
  if (v.status === 'zero' || v.status === 'cancelled') return `<div class="g-trk-none">${statusBadge(v)}</div>`;
  const late = v.status === 'declared' && ageDays(v.declaredAt) >= LATE_DAYS;
  const dev = late ? 'bad' : v.status === 'disputed' ? 'wrn' : '';
  const n = v.status === 'disputed' ? 1 : TRK_STEP[v.status] ?? 1;
  const steps = ['visit', 'declared', 'paid', 'cashed', 'repaid'].map((k, i) => {
    let c = 'off'; let mark = String(i + 1); let label = t(`g.trk.${k}`);
    if (i < n) { c = 'on'; mark = '✓'; } else if (i === n) { c = dev || 'now'; if (dev) { mark = '!'; label = t(late ? 'g.trk.late' : 'g.trk.disputed'); } }
    return `<span class="st ${c}" title="${esc(tRaw(`g.trk.${k}.hint`))}"><span class="c">${mark}</span>${label}</span>`;
  }).join('');
  const msg = late ? `<div class="g-dev bad">${t('g.dev.late', { n: ageDays(v.declaredAt) })}</div>`
    : v.status === 'disputed' ? `<div class="g-dev wrn">${t('g.dev.disputed')}${v.statusNote ? ` (${esc(v.statusNote)})` : ''}</div>` : '';
  return `<div class="g-trk">${steps}</div>${msg}`;
}
// Part du guide : réelle une fois encaissée, sinon estimée sur la déclaration (part figée au jour de la visite).
const shareOf = (v) => (CASHED.includes(v.status) ? v.guideCents
  : v.declaredCents == null ? null : Math.floor(v.declaredCents * (1 - (v.platformShare ?? 0.2))));

async function loadGuide(me, city) {
  const [stays, visits, adjustments, payouts, pixChecks, partners, alerts] = await Promise.all([
    store.listStays(me.id), store.listVisits({ guideId: me.id }), store.listAdjustments(me.id), store.listPayouts(me.id),
    store.listPixVerifications(me.id), store.publicPartners(city.id), store.listMyAlerts()]);
  return { stays, visits, adjustments, payouts, pixChecks, partners, alerts };
}

async function dashboardView(me, city, tab = 'inicio') {
  const lang = getLang();
  const d = await loadGuide(me, city);
  const { stays, visits, adjustments, payouts, pixChecks, partners, alerts } = d;
  const today = todayIn(city.timezone);
  const cur = (n) => cents(n, city.currency, lang);
  const pname = (id) => partners.find((p) => p.id === id)?.name || '?';
  const stayOf = (id) => stays.find((s) => s.id === id);
  const pick = (st, key) => visits.filter((v) => st.includes(v.status)).reduce((s, v) => s + (v[key] || 0), 0);
  const openAdj = adjustments.filter((a) => !a.payoutId && (a.guideDelta < 0 || a.partnerStatus === 'settled')).reduce((s, a) => s + a.guideDelta, 0);
  const payoutSum = (st) => payouts.filter((p) => p.status === st).reduce((s, p) => s + (p.cents || 0), 0);
  const sum = {
    expected: visits.filter((v) => ['declared', 'verifying', 'disputed'].includes(v.status)).reduce((s, v) => s + (shareOf(v) || 0), 0),
    available: pick(['received'], 'guideCents') + payoutSum('in_progress') + openAdj,
    paid: payoutSum('paid'),
  };
  const live = visits.filter((v) => v.status !== 'cancelled');
  const openCheck = pixChecks.find((c) => c.status === 'sent' && !c.verifiedAt && c.confirmation === 'waiting' && c.keyVersion === me.pixKeyVersion);
  const toConfirm = payouts.filter((p) => p.status === 'paid' && p.receivedStatus === 'waiting');
  const pixOk = me.pixStatus === undefined || me.pixStatus === 'verified';
  const blocked = !pixOk || toConfirm.length > 0;
  const stayState = (s) => (stayIsValid(s, city) ? 'active' : s.start > today ? 'soon' : 'done');
  const soonStays = stays.filter((s) => stayState(s) === 'soon');
  const soon60 = addDays(today, 60);
  const cad = me.cadasturValidUntil;
  const alertOf = (vId) => alerts.find((a) => a.visitId === vId && a.status !== 'resolved');

  // Bandeaux : Pix à confirmer, virement à confirmer, Pix suspendu, Cadastur, alertes en cours.
  let banners = '';
  if (openCheck) banners += `<div class="notice warn"><b>${t('pix.sent.msg')}</b>
      <div class="row" style="margin-top:10px"><button class="btn small" data-pix-ok="${esc(openCheck.id)}">${t('pix.confirm')}</button>
      <button class="btn small ghost" data-pix-no="${esc(openCheck.id)}">${t('pix.notreceived')}</button></div></div>`;
  toConfirm.forEach((p) => { banners += `<div class="notice warn">${t('pix.payout.msg', { amount: cur(p.cents), ref: esc(p.reference || '') })}
      <div class="row" style="margin-top:10px"><button class="btn small" data-po-ok="${esc(p.id)}">${t('pix.payout.ok')}</button>
      <button class="btn small ghost" data-po-no="${esc(p.id)}">${t('pix.notreceived')}</button></div></div>`; });
  if (!pixOk && !openCheck) banners += `<div class="notice bad">${t('pix.suspended')}</div>`;
  if (cad && cad < today) banners += `<div class="notice bad">${t('g.cad.expired', { date: fmtDay(cad, lang) })}</div>`;
  else if (cad && cad < soon60) banners += `<div class="notice warn">${t('g.cad.soon', { date: fmtDay(cad, lang) })}</div>`;
  alerts.filter((a) => a.status !== 'resolved' || (a.answer && ageDays(a.resolvedAt) < 7)).forEach((a) => {
    banners += `<div class="notice ${a.status === 'resolved' ? 'ok' : ''}"><b>${t('alert.line', { num: a.num, topic: topicLabel('guide', a.topic), status: alertStatus(a.status) })}</b>
      ${a.answer ? `<br>${t('alert.answer', { text: a.answer })}` : `<br>${t('alert.wait')}`}</div>`;
  });

  // Une commission.
  const txRow = (v) => {
    const sh = shareOf(v); const a = alertOf(v.id);
    return `<div class="g-tx" data-p="${esc(v.partnerId)}" data-s="${esc(v.status)}">
      <div class="spread"><span><b>${esc(pname(v.partnerId))}</b> · ${esc(stayOf(v.stayId)?.client || '')}<br>
        <span class="hint">${fmtDay(v.at.slice(0, 10), lang)} · ${esc(store.visitRef(v))} · ${t('stay.people', { n: v.peopleServed })}</span></span>
        <span class="g-amt">${sh == null ? `<span class="hint">${t('g.amt.none')}</span>` : CASHED.includes(v.status) ? `<b>${cur(sh)}</b>` : `<b>≈ ${cur(sh)}</b><br><span class="hint">${t('g.amt.est')}</span>`}</span></div>
      ${tracker(v)}
      <div class="g-tx-f">${a ? `<span class="badge">${t('alert.short', { num: a.num, status: alertStatus(a.status) })}</span>` : problemLink(v.id)}</div>
    </div>`;
  };
  const txCard = (title, list, more) => `<div class="card g-card"><div class="spread"><h2 style="margin:0">${title}</h2>${more || ''}</div>
      ${list.length ? list.map(txRow).join('') : `<p class="hint">${t('g.tx.none')}</p>`}</div>`;

  const stayItem = (s) => {
    const n = visits.filter((v) => v.stayId === s.id).length; const k = stayState(s);
    return `<li><a href="#/sejour/${encodeURIComponent(s.id)}"><div class="spread"><b>${esc(s.client)}</b>
      <span class="badge ${k === 'active' ? 'ok' : k === 'soon' ? '' : 'warn'}">${t(`g.stay.${k}`)}</span></div>
      <div class="hint">${t('stay.people', { n: s.people })} · ${fmtDay(s.start, lang)} → ${fmtDay(s.end, lang)} · ${t('stay.visits', { n })}</div></a></li>`;
  };
  const staysCard = (list, full) => `<div class="card"><div class="spread"><h2 style="margin:0">${t('guide.stays')}</h2>
      ${full ? '' : `<a class="btn small" href="#/clientes">${t('g.newqr')}</a>`}</div>
      ${list.length ? `<ul class="list">${list.map(stayItem).join('')}</ul>` : `<p class="hint">${t('g.stays.none')}</p>`}</div>`;

  // À faire (cases à cocher gardées sur l'appareil).
  const dk = gDoneKey(me.id); const done = readDone(dk);
  const todo = [];
  if (!pixOk) todo.push([`pix-${me.pixKeyVersion}`, t(openCheck ? 'g.todo.pixconfirm' : 'g.todo.pix')]);
  toConfirm.forEach((p) => todo.push([`po-${p.id}`, t('g.todo.payout', { amount: cur(p.cents) })]));
  if (!stays.length) todo.push(['firstqr', t('g.todo.firstqr')]);
  soonStays.forEach((s) => todo.push([`send-${s.id}`, t('g.todo.send', { client: s.client, date: fmtDay(s.start, lang) })]));
  if (cad && cad < soon60) todo.push([`cad-${cad}`, t('g.todo.cad')]);
  const left = todo.filter(([k]) => !done.has(k)).length;
  const todoCard = `<div class="card"><div class="spread"><h2 style="margin:0">${t('pd.todo.title')}</h2><span class="hint">${t('pd.todo.left', { n: left })}</span></div>
    <div class="pd-todo">${todo.length ? todo.map(([k, l]) => `<label class="${done.has(k) ? 'pd-done' : ''}"><input type="checkbox" data-todo="${esc(k)}"${done.has(k) ? ' checked' : ''}> ${l}</label>`).join('') : `<p class="hint">${t('g.todo.none')}</p>`}</div></div>`;

  const pct = me.weeklyPayout ? 75 : 80;
  const nextCard = `<div class="card"><div class="spread"><h2 style="margin:0">${t('g.next.title')}</h2>
      <span class="badge ${blocked ? 'bad' : sum.available > 0 ? 'ok' : ''}">${t(blocked ? 'g.next.blocked' : sum.available > 0 ? 'g.next.planned' : 'g.next.nothing')}</span></div>
      <div class="spread" style="margin-top:8px"><span>${t(me.weeklyPayout ? 'g.next.weekly' : 'g.next.monthly')}</span><b>${cur(Math.max(0, sum.available))}</b></div>
      <p class="hint" style="margin:4px 0 0">${t('g.next.hint', { pct })}</p></div>`;

  const kpis = `<div class="pd-kpis">
      <div class="pd-kpi ${sum.available > 0 && !blocked ? 'ok' : ''}"><span>${t('g.k.available')}</span><b>${cur(Math.max(0, sum.available))}</b><em>${t('g.k.available.hint')}</em></div>
      <div class="pd-kpi"><span>${t('g.k.expected')}</span><b>≈ ${cur(sum.expected)}</b><em>${t('g.k.expected.hint')}</em></div>
      <div class="pd-kpi"><span>${t('g.k.paid')}</span><b>${cur(sum.paid)}</b><em>${t('g.k.paid.hint')}</em></div>
      <div class="pd-kpi"><span>${t('g.k.visits')}</span><b>${live.length}</b><em>${t('g.k.visits.hint', { n: new Set(live.map((v) => v.partnerId)).size })}</em></div>
    </div>`;

  const newStayForm = `<form class="card" id="new-stay">
        <h2>${t('guide.stay.new')}</h2>
        <div class="grid2">
          <div class="field"><label for="s-client">${t('guide.stay.client')}</label><input id="s-client" name="client" required placeholder="${t('guide.stay.client.ph')}"></div>
          <div class="field"><label for="s-people">${t('guide.stay.people')}</label><input id="s-people" name="people" type="number" min="1" max="99" value="2" required></div>
          <div class="field"><label for="s-start">${t('guide.stay.start')}</label><input id="s-start" name="start" type="date" value="${today}" required></div>
          <div class="field"><label for="s-end">${t('guide.stay.end')}</label><input id="s-end" name="end" type="date" value="${addDays(today, 3)}" required></div>
        </div>
        <p class="hint">${t('guide.stay.hint')}</p>
        <button class="btn block">${t('guide.stay.create')}</button>
      </form>`;

  const statuses = ['visited', 'declared', 'verifying', 'received', 'paid', 'disputed', 'zero'];
  const filters = `<div class="row" style="margin:8px 0">
      <select id="g-fp" style="width:auto"><option value="">${t('g.f.allpartners')}</option>${[...new Set(visits.map((v) => v.partnerId))].map((id) => `<option value="${esc(id)}">${esc(pname(id))}</option>`).join('')}</select>
      <select id="g-fs" style="width:auto"><option value="">${t('g.f.allstatus')}</option>${statuses.map((k) => `<option value="${k}">${t(`status.${k}`)}</option>`).join('')}</select></div>`;
  const payoutsCard = `<div class="card"><h2>${t('g.payouts')}</h2>${payouts.length ? `<ul class="list">${payouts.map((p) => `<li><div class="spread"><b>${t('g.payout.line', { num: p.num, amount: cur(p.cents) })}</b>
      <span class="badge ${p.status === 'paid' ? 'ok' : 'warn'}">${t(p.status === 'paid' ? 'g.payout.paid' : 'status.payout_pending')}</span></div>
      <div class="hint">${fmtDay(String(p.paidAt || p.at).slice(0, 10), lang)}${p.reference ? ` · ${esc(p.reference)}` : ''}</div></li>`).join('')}</ul>` : `<p class="hint">${t('g.payouts.none')}</p>`}</div>`;
  const adjCard = adjustments.length ? `<div class="card"><h2>${t('guide.adj.title')}</h2><ul class="list">${adjustments.map((a) => `<li><div class="spread"><span>${esc(store.adjNum(a.num))} · ${esc(a.reason)}</span><b>${cur(a.guideDelta)}</b></div>
      <div class="hint">${t(a.payoutId ? 'g.adj.done' : 'g.adj.next')}</div></li>`).join('')}</ul></div>` : '';

  const contaBody = `${pixCard(me, pixChecks, payouts, cur, lang)}
      ${WEEKLY_OPTION || me.weeklyPayout ? `<label class="card" style="display:block"><input type="checkbox" id="weekly"${me.weeklyPayout ? ' checked' : ''}> <b>${t('guide.weekly.title')}</b>
        <span class="hint" style="display:block">${t('guide.weekly.hint')}</span></label>` : ''}
      <div class="card"><div class="spread"><h2 style="margin:0">${t('g.cad.title')}</h2>
        <span class="badge ${!cad ? '' : cad < today ? 'bad' : cad < soon60 ? 'warn' : 'ok'}">${t(!cad ? 'g.cad.unknown' : cad < today ? 'g.cad.st.expired' : cad < soon60 ? 'g.cad.st.soon' : 'g.cad.st.ok')}</span></div>
        <p class="hint" style="margin:6px 0 0">${esc(me.license || '')}${cad ? ` · ${t('g.cad.until', { date: fmtDay(cad, lang) })}` : ''}</p></div>
      <a class="card" href="#/cracha" style="display:block;text-decoration:none;color:inherit"><div class="spread"><b>${t('bdg.card.title')}</b><span>→</span></div>
        <span class="hint" style="display:block">${t('bdg.card.hint')}</span></a>
      <div class="card"><h2>${t('g.docs')}</h2><ul class="list">
        <li><a href="#/releve"><div class="spread"><span>${t('guide.statement.title')}</span><span>→</span></div></a></li></ul>
        <p class="hint">${t('g.docs.hint')}</p></div>
      ${me.code ? `<p class="hint">${t('guide.code')} <b>${esc(me.code)}</b></p>` : ''}`;

  const recent = visits.slice(0, 5);
  const body = {
    inicio: `${kpis}<div class="pd-cols"><div class="pd-side">${txCard(t('g.recent'), recent, visits.length > 5 ? `<a href="#/ganhos">${t('g.seeall')}</a>` : '')}
        ${staysCard(stays.filter((s) => stayState(s) !== 'done').slice(0, 4), false)}</div>
      <div class="pd-side">${todoCard}${nextCard}${me.referralEnabled ? `<a class="card" href="#/indicacao" style="display:block;text-decoration:none;color:inherit"><b>${t('ref.card.title')}</b><span class="hint" style="display:block">${t('ref.card.hint')}</span></a>` : ''}</div></div>`,
    clientes: `<div class="pd-cols"><div class="pd-side">${staysCard(stays, true)}</div><div class="pd-side">${newStayForm}</div></div>`,
    ganhos: `${kpis}<div class="pd-cols"><div class="pd-side"><div class="card g-card"><div class="spread"><h2 style="margin:0">${t('g.all')}</h2>
        <span class="hint">${t('guide.sum.note', { pct })}</span></div>${filters}<div id="g-list">${visits.length ? visits.map(txRow).join('') : `<p class="hint">${t('g.tx.none')}</p>`}</div></div></div>
      <div class="pd-side">${nextCard}${adjCard}${payoutsCard}<a class="card" href="#/releve" style="display:block;text-decoration:none;color:inherit"><b>${t('guide.statement.title')}</b><span class="hint" style="display:block">${t('g.statement.hint')}</span></a></div></div>`,
    conta: `<div class="pd-cols"><div class="pd-side">${contaBody}</div><div class="pd-side">${nextCard}</div></div>`,
  }[tab];

  const counts = { inicio: todo.filter(([k]) => !done.has(k)).length, clientes: soonStays.length, ganhos: toConfirm.length, conta: !pixOk ? 1 : 0 };
  const tabs = me.referralEnabled ? ['inicio', 'clientes', 'ganhos', 'indicacao', 'conta'] : G_TABS;
  const nav = `<nav class="tabs no-print">${tabs.map((k) => `<a href="#/${k === 'inicio' ? '' : k}" class="${k === tab ? 'on' : ''}">${t(`g.tab.${k}`)}${counts[k] ? `<span class="todo">${counts[k]}</span>` : ''}</a>`).join('')}</nav>`;

  return {
    html: `<div class="dash-wide">
      <div class="spread"><div><h1 style="margin-bottom:2px">${t('guide.hello', { name: me.name })}</h1>
        <p class="hint" style="margin:0">${esc(city.name || '')}${me.code ? ` · ${esc(me.code)}` : ''}</p></div>
        <div class="row" style="gap:6px">${helpButton()}${logoutButton()}</div></div>
      ${nav}${banners}${body}</div>`,
    mount(root, ctx) {
      mountLogout(root, ctx);
      mountPix(root, ctx);
      mountHelp(root, { kind: 'guide', send: (topic, msg, vId) => store.guideCreateAlert(topic, msg, vId),
        findCode: (c) => visits.find((x) => x.code === c)?.id || null,
        label: (vId) => { const v = visits.find((x) => x.id === vId); return v ? `${pname(v.partnerId)} · ${stayOf(v.stayId)?.client || ''} · ${store.visitRef(v)}` : ''; },
        onSent: () => ctx.refresh() });
      root.querySelectorAll('[data-todo]').forEach((b) => { b.onchange = () => { b.checked ? done.add(b.dataset.todo) : done.delete(b.dataset.todo); saveDone(dk, done); b.parentElement.classList.toggle('pd-done', b.checked); }; });
      const fp = root.querySelector('#g-fp'); const fs = root.querySelector('#g-fs');
      const filter = () => root.querySelectorAll('#g-list .g-tx').forEach((r) => {
        r.hidden = (fp.value && r.dataset.p !== fp.value) || (fs.value && r.dataset.s !== fs.value && !(fs.value === 'paid' && r.dataset.s === 'payout_pending'));
      });
      if (fp) { fp.onchange = filter; fs.onchange = filter; }
      const weekly = root.querySelector('#weekly');
      if (weekly) weekly.onchange = async (e) => { await store.setWeeklyPayout(e.target.checked); ctx.refresh(tRaw('common.saved')); };
      const form = root.querySelector('#new-stay');
      if (form) form.onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (f.end < f.start) { notify(tRaw('guide.stay.err.dates')); return; }
        if (addDays(f.start, MAX_STAY_DAYS) < f.end) { notify(tRaw('guide.stay.err.long', { n: MAX_STAY_DAYS })); return; }
        const s = await store.addStay(me.id, { client: f.client.trim(), people: Number(f.people), start: f.start, end: f.end });
        ctx.go(`sejour/${s.id}`, tRaw('guide.stay.created'));
      };
    },
  };
}

// Dados bancários / Pix (v30) : statut de la clé, confirmation du test de 1 R$ et des virements reçus.
// Le 1 R$ n'apparaît jamais dans le solde : c'est une dépense de la Kombrio.
const PIX_TYPES = ['random', 'email', 'phone', 'cpf', 'cnpj'];
function pixCard(me, checks, payouts, cur, lang) {
  if (me.pixStatus === undefined) return '';
  const open = checks.find((c) => c.status === 'sent' && !c.verifiedAt && c.confirmation === 'waiting' && c.keyVersion === me.pixKeyVersion);
  const masked = me.pixKey ? `${me.pixKey.slice(0, 2)}•••${me.pixKey.slice(-3)}` : '—';
  return `<div class="card" id="pix-card">
      <h2>${t('pix.title')}</h2>
      <div class="spread"><span>${t('pix.key')} <b>${esc(masked)}</b>${me.pixKeyType ? ` · ${t(`pix.type.${me.pixKeyType}`)}` : ''}${me.pixHolder ? `<br><span class="hint">${t('su.pix.holder')} : ${esc(me.pixHolder)}</span>` : ''}</span>
        <span class="badge ${me.pixStatus === 'verified' ? 'ok' : me.pixStatus === 'failed' ? 'bad' : 'warn'}">${t(`pix.st.${me.pixStatus}`)}</span></div>
      ${me.pixStatus === 'verified' && me.pixVerifiedAt ? `<p class="hint">${t('pix.verified.on', { date: fmtDay(me.pixVerifiedAt.slice(0, 10), lang) })}</p>` : ''}
      ${open ? `<p class="hint">${t('g.pix.seebanner')}</p>` : ''}
      <details style="margin-top:8px"><summary class="hint">${t('pix.change')}</summary>
        <form id="pix-form" style="margin-top:8px">
          <div class="grid2">
            <div class="field"><label for="pix-type">${t('pix.type')}</label><select id="pix-type" name="type">${PIX_TYPES.map((k) => `<option value="${k}"${k === me.pixKeyType ? ' selected' : ''}>${t(`pix.type.${k}`)}</option>`).join('')}</select></div>
            <div class="field"><label for="pix-key">${t('pix.newkey')}</label><input id="pix-key" name="key" required autocomplete="off"></div>
          </div>
          <div class="field"><label for="pix-holder">${t('su.pix.holder')}</label><input id="pix-holder" name="holder" required minlength="3" maxlength="120" autocomplete="off" value="${esc(me.pixHolder || '')}"></div>
          <p class="hint">${t('pix.change.hint')}</p>
          <button class="btn small">${t('common.save')}</button>
        </form>
      </details>
    </div>`;
}
function mountPix(root, ctx) {
  const card = root;
  const act = async (fn, okMsg) => { try { const r = await fn(); if (r === false || r?.ok === false) { notify(tRaw('err.generic')); return; } ctx.refresh(tRaw(okMsg)); } catch { notify(tRaw('err.generic')); } };
  card.querySelectorAll('[data-pix-ok]').forEach((b) => { b.onclick = () => act(() => store.confirmPixVerification(b.dataset.pixOk, true), 'pix.done.ok'); });
  card.querySelectorAll('[data-pix-no]').forEach((b) => { b.onclick = () => act(() => store.confirmPixVerification(b.dataset.pixNo, false), 'pix.done.no'); });
  card.querySelectorAll('[data-po-ok]').forEach((b) => { b.onclick = () => act(() => store.confirmPayoutReceived(b.dataset.poOk, true), 'pix.done.ok'); });
  card.querySelectorAll('[data-po-no]').forEach((b) => { b.onclick = () => act(() => store.confirmPayoutReceived(b.dataset.poNo, false), 'pix.done.no'); });
  const f = card.querySelector('#pix-form');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const ok = await store.setMyPixKey(f.key.value.trim(), f.type.value, f.holder.value.trim().replace(/\s+/g, ' ')).catch(() => false);
    if (ok) ctx.refresh(tRaw('pix.changed')); else notify(tRaw('pix.err.key'));
  };
}

// Lien d'invitation : https://app.kombrio.com.br/guide/?ref=RIO-KG-12345
function refFromUrl() {
  try { return (new URLSearchParams(location.search).get('ref') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20); } catch { return ''; }
}

// Parrainage du guide : code, progression, filleuls, primes, règles.
async function referralView(me, city) {
  const r = await store.myReferral();
  const lang = getLang();
  const back = `<p><a href="#/">← ${t('common.back')}</a></p>`;
  if (!r) return { html: `${back}<div class="notice warn">${t('ref.off')}</div>` };
  const cur = (n) => cents(n, city.currency, lang);
  const day = (d) => (d ? fmtDay(String(d).slice(0, 10), lang) : '');
  const st = r.settings;
  const link = `${appLink('guide')}?ref=${encodeURIComponent(r.code)}`;
  const qualified = r.filleuls.filter((f) => f.qualified_at).length;
  const pct = (x) => `${Math.round(Number(x) * 100)} %`;
  const sum = (s) => r.rewards.filter((w) => w.status === s).reduce((a, w) => a + Number(w.reward_cents), 0);
  const msg = tRaw('ref.share.msg', { code: r.code, link });
  const fItem = (f) => `<li><div class="spread"><b>${esc(f.label)}</b>
      <span class="badge ${f.qualified_at ? 'ok' : ''}">${f.qualified_at ? t('ref.f.qualified') : (f.validated ? t('ref.f.active') : t('ref.f.pending'))}</span></div>
      <div class="hint">${t('ref.f.tx', { n: f.tx, need: st.tx_needed })}${f.promo_until ? ` · ${t('ref.f.promo', { date: day(f.promo_until) })}` : ''}${f.qualified_at && !f.rewarded ? ` · ${t('ref.f.extra')}` : ''}</div></li>`;
  const wItem = (w) => `<li><div class="spread"><b>${esc(new Date(`${w.month}T12:00:00`).toLocaleDateString(locale(lang), { month: 'long', year: 'numeric' }))} · ${esc(w.filleul || '')}</b>
      <b>${cur(w.reward_cents)}</b></div>
      <div class="hint">${t(`ref.w.${w.status}`)}${w.paid_at ? ` · ${day(w.paid_at)}` : ''}${w.pix_ref ? ` · Pix ${esc(w.pix_ref)}` : ''} · ${t('ref.w.base', { k: cur(w.k_cents), n: w.tx })}</div></li>`;
  return {
    html: `${back}
      <h1>${t('ref.title')}</h1>
      <div class="card">
        <p class="hint">${t('ref.code')}</p>
        <p style="font-size:1.6rem;font-weight:800;margin:0 0 12px">${esc(r.code)}</p>
        <div class="grid2">
          <button type="button" class="btn secondary" id="ref-copy">${t('ref.copy')}</button>
          <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">${t('ref.share')}</a>
        </div>
      </div>
      <div class="card">
        <h2>${t('ref.progress', { n: Math.min(qualified, st.needed), need: st.needed })}</h2>
        <progress max="${st.needed}" value="${Math.min(qualified, st.needed)}" style="width:100%"></progress>
        <p class="hint">${r.qualified_at
          ? t('ref.active', { start: day(r.qualified_at), end: day(r.period_end) })
          : t('ref.todo', { need: st.needed, tx: st.tx_needed })}</p>
      </div>
      <div class="stats">
        <div class="stat"><b>${cur(sum('estimated'))}</b><span>${t('ref.sum.estimated')}</span></div>
        <div class="stat"><b>${cur(sum('validated'))}</b><span>${t('ref.sum.validated')}</span></div>
        <div class="stat"><b>${cur(sum('paid'))}</b><span>${t('ref.sum.paid')}</span></div>
      </div>
      <div class="card">
        <h2>${t('ref.filleuls')}</h2>
        ${r.filleuls.length ? `<ul class="list">${r.filleuls.map(fItem).join('')}</ul>` : `<p class="hint">${t('ref.filleuls.none')}</p>`}
      </div>
      <div class="card">
        <h2>${t('ref.history')}</h2>
        ${r.rewards.length ? `<ul class="list">${r.rewards.map(wItem).join('')}</ul>` : `<p class="hint">${t('ref.history.none')}</p>`}
      </div>
      <details class="card">
        <summary><b>${t('ref.rules')}</b></summary>
        <ul>
          <li>${t('ref.rule.1', { share: pct(st.filleul_share), days: st.promo_days })}</li>
          <li>${t('ref.rule.2', { need: st.needed, tx: st.tx_needed })}</li>
          <li>${t('ref.rule.3', { rate: pct(st.parrain_rate), months: st.months })}</li>
          <li>${t('ref.rule.4')}</li>
          <li>${t('ref.rule.5')}</li>
        </ul>
      </details>`,
    mount(root) {
      root.querySelector('#ref-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(link); notify(tRaw('ref.copied')); } catch { prompt(tRaw('ref.copy'), link); }
      };
    },
  };
}

async function stayView(me, city, stayId) {
  const stay = await store.getStay(stayId);
  if (!stay || stay.guideId !== me.id) return notFound();
  const lang = getLang();
  const valid = stayIsValid(stay, city);
  const visits = await store.listVisits({ stayId: stay.id });
  const partners = await store.publicPartners(city.id);
  const partnerName = (id) => partners.find((p) => p.id === id)?.name || '?';
  const clientLink = appLink('client', `c/${stay.token}`);
  const scanLink = appLink('partner', `s/${stay.token}`);
  const share = tRaw('guide.share.text', { client: stay.client, guide: me.name, link: clientLink });

  const visitItem = (v) => `<li>
    <div class="spread"><b>${esc(partnerName(v.partnerId))}</b>${statusBadge(v)}</div>
    <div class="hint">${fmtMoment(v.at, lang, city.timezone)} · ${t('stay.people', { n: v.people })}</div>
    ${guideAmounts(v, city, lang) ? `<div>${guideAmounts(v, city, lang)}</div>` : ''}
  </li>`;

  return {
    html: `
      <p><a href="#/">← ${t('guide.back')}</a></p>
      <div class="card">
        <div class="spread"><h1>${esc(stay.client)}</h1>${validity(stay, valid, lang)}</div>
        <p class="hint">${t('stay.people', { n: stay.people })} · ${fmtDay(stay.start, lang)} → ${fmtDay(stay.end, lang)}</p>
        <div class="qr">${qrSvg(scanLink)}</div>
        <p class="hint" style="text-align:center">${t('guide.stay.qr.hint')}</p>
        <div class="row">
          <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(share)}">${t('guide.stay.whatsapp')}</a>
          <button type="button" class="btn secondary" id="sendqr">${t('guide.stay.sendqr')}</button>
          <button class="btn secondary" id="copy">${t('guide.stay.copy')}</button>
          <a class="btn ghost" target="_blank" rel="noopener" href="${esc(clientLink)}">${t('guide.stay.preview')}</a>
        </div>
      </div>
      <div class="card">
        <h2>${t('guide.stay.visits')}</h2>
        ${visits.length ? `<ul class="list">${visits.map(visitItem).join('')}</ul>` : `<p class="hint">${t('guide.stay.visits.none')}</p>`}
      </div>`,
    mount(root) {
      root.querySelector('#sendqr').onclick = async () => {
        const blob = await qrCardBlob(scanLink, {
          title: stay.client, line1: tRaw('client.valid.until', { end: fmtDay(stay.end, lang) }), line2: tRaw('guide.stay.qr.hint'),
        });
        await shareOrDownload(blob, 'kombrio-qr.png', share);
      };
      root.querySelector('#copy').onclick = async (e) => {
        try { await navigator.clipboard.writeText(clientLink); e.target.textContent = tRaw('common.copied'); } catch { prompt('', clientLink); }
      };
    },
  };
}

// Relevé du guide : chaque transaction, déclaré ≠ encaissé, parts 80/20 seulement sur l'encaissé, reversement.
async function statementView(me, city) {
  const lang = getLang();
  const [visits, partners, payouts, adjustments] = await Promise.all([
    store.listVisits({ guideId: me.id }), store.publicPartners(city.id), store.listPayouts(me.id), store.listAdjustments(me.id),
  ]);
  const cur = (n) => (n == null ? '—' : cents(n, city.currency, lang));
  const pname = (id) => partners.find((p) => p.id === id)?.name || '?';
  const payout = (id) => payouts.find((p) => p.id === id);
  const short = (iso) => new Intl.DateTimeFormat(locale(lang), { dateStyle: 'short', timeZone: city.timezone }).format(new Date(iso));
  const cashed = (v) => ['received', 'payout_pending', 'paid'].includes(v.status);
  return {
    html: `
      <p><a href="#/">← ${t('guide.back')}</a></p>
      <div class="card">
        <h1>${t('guide.statement.title')}</h1>
        <p class="hint">${t('guide.statement.hint', { pct: me.weeklyPayout ? 75 : 80 })}</p>
        ${visits.length ? `<div class="table-wrap"><table>
          <tr><th>ID</th><th>${t('report.col.date')}</th><th>${t('guide.col.partner')}</th><th>${t('report.col.people')}</th><th>${t('guide.col.declared')}</th><th>${t('guide.col.cashed')}</th><th>Kombrio</th><th>${t('guide.col.share')}</th><th>${t('report.col.status')}</th><th>${t('guide.col.payout')}</th></tr>
          ${visits.map((v) => {
            const po = v.payoutId && payout(v.payoutId);
            return `<tr><td style="white-space:nowrap">${esc(store.visitRef(v))}</td><td>${short(v.at)}</td><td>${esc(pname(v.partnerId))}</td><td>${v.peopleServed}</td>
              <td>${cur(v.declaredCents)}</td><td>${cashed(v) ? cur(v.receivedCents) : cur(v.declaredCents == null ? null : 0)}</td>
              <td>${cashed(v) ? cur(v.kombrioCents) : '—'}</td><td>${cashed(v) ? `<b>${cur(v.guideCents)}</b>` : '—'}</td>
              <td>${statusBadge(v)}</td><td>${po && po.status === 'paid' ? `${short(po.paidAt || po.at)} · ${esc(po.reference || '')}` : po ? t('status.payout_pending') : '—'}</td></tr>`;
          }).join('')}
        </table></div>` : `<p class="hint">${t('guide.stay.visits.none')}</p>`}
      </div>
      ${adjustments.length ? `<div class="card">
        <h2>${t('guide.adj.title')}</h2>
        <p class="hint">${t('guide.adj.hint')}</p>
        <div class="table-wrap"><table>
          <tr><th>ID</th><th>${t('report.col.date')}</th><th>${t('guide.col.diff')}</th><th>${t('guide.col.share')}</th><th>${t('guide.col.reason')}</th><th>${t('guide.col.payout')}</th></tr>
          ${adjustments.map((a) => {
            const v = visits.find((x) => x.id === a.visitId);
            const po = a.payoutId && payout(a.payoutId);
            return `<tr><td style="white-space:nowrap">${esc(store.adjNum(a.num))}<div class="hint">${esc(store.txNum(v?.num))}</div></td><td>${short(a.createdAt)}</td>
              <td>${cur(a.deltaCents)}</td><td><b>${cur(a.guideDelta)}</b></td><td>${esc(a.reason)}</td>
              <td>${po && po.status === 'paid' ? `${short(po.paidAt || po.at)} · ${esc(po.reference || '')}` : po ? t('status.payout_pending') : '—'}</td></tr>`;
          }).join('')}
        </table></div>
      </div>` : ''}`,
  };
}

// Crachá du guide (v35) : badge au format carte de crédit (54 × 85,6 mm), recto et verso, à imprimer.
// Le QR mène à la page publique de vérification avec un code secret propre au badge (renouvelable si perdu).
async function badgeView(me, city) {
  const lang = getLang();
  const back = `<p class="no-print"><a href="#/conta">← ${t('common.back')}</a></p>`;
  const tok = await store.myBadgeToken();
  if (!tok || !tok.ok) return { html: `${back}<div class="notice warn">${t('bdg.unavailable')}</div>` };
  const link = appLink('verify', tok.token);
  const initials = String(me.name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const photo = me.photo && me.photo.startsWith('data:image/') ? `<img class="bd-photo" src="${esc(me.photo)}" alt="">` : `<div class="bd-photo">${esc(initials)}</div>`;
  // Jamais le numéro saisi à l'inscription (il peut s'agir du CPF) : seulement la validité vérifiée par Kombrio.
  const cad = me.cadasturValidUntil ? `Cadastur ${tRaw('bdg.until', { date: fmtDay(me.cadasturValidUntil, 'pt') })}` : '';
  const issued = tok.issued_at ? fmtDay(String(tok.issued_at).slice(0, 10), 'pt') : '';
  const front = `<div class="bdg" role="img" aria-label="${esc(tRaw('bdg.front'))}">
      <div class="bd-band"></div><div class="bd-slot"></div>
      <div class="bd-top"><span class="bd-logo"><span class="bd-k">K</span>kombrio</span><span class="bd-pill">Guia parceiro</span></div>
      ${photo}
      <div class="bd-name">${esc(me.name)}</div>
      <div class="bd-sub">Guia de turismo · ${esc(city.name || 'Rio de Janeiro')}</div>
      <div class="bd-code">${esc(me.code || '')}</div>
      ${cad ? `<div class="bd-cad">${cad}</div>` : ''}
      <div class="bd-qr">${qrSvg(link)}</div>
      <div class="bd-qrcap">Escaneie para verificar este guia</div>
      <div class="bd-foot">kombrio.com.br</div>
    </div>`;
  const verso = `<div class="bdg back" role="img" aria-label="${esc(tRaw('bdg.back'))}">
      <div class="bd-topline"></div><div class="bd-slot"></div>
      <div><div class="bd-over">Para a loja parceira</div><h2>Este guia faz parte da rede Kombrio</h2></div>
      <ol><li><span><b>Escaneie o QR da frente.</b> O perfil verificado do guia abre no celular.</span></li>
        <li><span><b>Confira o nome e a foto</b> com a pessoa à sua frente.</span></li>
        <li><span><b>Registre a visita</b> no aplicativo Kombrio, como sempre.</span></li></ol>
      <div class="bd-box"><span><b>Perfil suspenso ou QR inválido?</b> Não registre a visita e avise a Kombrio.</span>
        <span style="color:#5B6F78">O guia é independente e recomenda livremente. O turista é livre para comprar ou não.</span></div>
      <div class="bd-small"><span>Crachá pessoal e intransferível.</span><span>Encontrou este crachá? contato@kombrio.com.br</span>${issued ? `<span>Emitido em ${esc(issued)}</span>` : ''}</div>
      <div class="bd-foot">kombrio</div>
    </div>`;
  return {
    html: `${back}
      <div class="no-print"><h1>${t('bdg.title')}</h1><p class="hint">${t('bdg.intro')}</p></div>
      <div class="badge-sheet">${front}${verso}</div>
      <div class="card no-print">
        <div class="row" style="gap:8px"><button class="btn" id="bdg-print">${t('bdg.print')}</button>
          <a class="btn secondary" href="${esc(link)}" target="_blank" rel="noopener">${t('bdg.test')}</a></div>
        <p class="hint" style="margin-top:10px">${t('bdg.print.hint')}</p>
      </div>
      <form class="card no-print" id="bdg-photo">
        <h2>${t('bdg.photo.title')}</h2>
        <p class="hint">${t('bdg.photo.hint')}</p>
        <div class="field"><input type="file" name="photo" accept="image/*" required></div>
        <button class="btn secondary small">${t('common.save')}</button>
      </form>
      <div class="card no-print"><h2>${t('bdg.lost.title')}</h2><p class="hint">${t('bdg.lost.hint')}</p>
        <button class="btn ghost small" id="bdg-renew">${t('bdg.lost.btn')}</button></div>`,
    mount(root, ctx) {
      root.querySelector('#bdg-print').onclick = () => window.print();
      root.querySelector('#bdg-photo').onsubmit = async (e) => {
        e.preventDefault();
        const file = e.target.photo.files[0]; if (!file) return;
        try {
          const jpg = await photoToJpeg(file, 480, 0.8);
          const r = await store.setMyPhoto(jpg);
          if (r && r.ok) ctx.refresh(tRaw('common.saved')); else notify(tRaw('bdg.photo.err'));
        } catch { notify(tRaw('bdg.photo.err')); }
      };
      root.querySelector('#bdg-renew').onclick = async () => {
        if (!confirm(tRaw('bdg.lost.confirm'))) return;
        try { await store.renewBadgeToken(); ctx.refresh(tRaw('bdg.lost.done')); } catch { notify(tRaw('err.generic')); }
      };
    },
  };
}
