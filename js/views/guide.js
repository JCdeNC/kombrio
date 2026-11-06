// Espace du guide : connexion, séjours, QR, suivi des passages et de ses gains.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, cents, locale, fmtDay, fmtMoment, todayIn, addDays, stayIsValid, qrSvg, appLink, notify, validCpf, onlyDigits } from '../util.js';
import * as store from '../store.js';
import { validity, statusBadge, guideAmounts, notFound, forgotLink, mountForgot, resetView } from './shared.js';
import { maskTaxId, qrCardBlob, shareOrDownload } from '../util.js';
// Durée maximale d'un séjour (K-15, décidé le 06/11/2026) : les clients restent au plus une semaine. Même règle dans la base (script 014).
const MAX_STAY_DAYS = 7;

export async function guideView(params, ctx) {
  // Lien « nouveau mot de passe » : il suffit d'être connecté par le lien, même sans fiche guide complète.
  if (store.inRecovery() && await store.hasSession()) return resetView();
  const me = await store.currentGuide();
  if (!me) {
    // Connecté, mais pas guide (ex. un compte partenaire) : on l'envoie vers la bonne application.
    if (await store.hasSession()) {
      return {
        html: `<div class="card"><p>${t('guide.notguide')}</p>
          <a class="btn block" href="${appLink('partner')}">${t('guide.notguide.go')}</a>
          <button type="button" class="btn block secondary" id="ng-out" style="margin-top:12px">${t('guide.notguide.out')}</button></div>`,
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
        <div class="field"><label for="g-name">${t('guide.signup.name')}</label><input id="g-name" name="name" required autocomplete="name"></div>
        <div class="grid2">
          <div class="field"><label for="g-phone">${t('guide.signup.phone')}</label><input id="g-phone" name="phone" type="tel" required autocomplete="tel"></div>
          <div class="field"><label for="g-city">${t('guide.signup.city')}</label>
            <select id="g-city" name="cityId">${cities.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label for="g-license">${t('guide.signup.license')}</label><input id="g-license" name="license" required inputmode="numeric" placeholder="000.000.000-00 / 00.000.000/0000-00"></div>
        <div class="grid2">
          <div class="field"><label for="g-cpf">${t('guide.signup.cpf')}</label><input id="g-cpf" name="cpf" required inputmode="numeric" placeholder="000.000.000-00"></div>
          <div class="field"><label for="g-pix">${t('guide.signup.pix')}</label><input id="g-pix" name="pixKey" required></div>
        </div>
        <p class="hint">${t('guide.signup.pix.hint')}</p>
        <div class="grid2">
          <div class="field"><label for="g-email">${t('auth.email')}</label><input id="g-email" name="email" type="email" required autocomplete="email"></div>
          <div class="field"><label for="g-pass">${t('auth.password.new')}</label><input id="g-pass" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
        </div>
        <div class="field"><label for="g-pass2">${t('auth.password.confirm')}</label><input id="g-pass2" name="password2" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="field"><label for="g-ref">${t('guide.signup.ref')}</label><input id="g-ref" name="refCode" autocomplete="off" placeholder="RIO-KG-00000" value="${esc(refFromUrl())}"></div>
        <p class="hint">${t('guide.signup.hint')}</p>
        <button class="btn block">${t('guide.signup.submit')}</button>
      </form>`,
    mount(root, ctx) {
      mountForgot(root.querySelector('#login'));
      maskTaxId(root.querySelector('#g-cpf'), 'cpf');
      maskTaxId(root.querySelector('#g-license'));
      root.querySelector('#login').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try { await store.signIn(f.email.trim(), f.password); ctx.refresh(); } catch { notify(tRaw('auth.err.login')); }
      };
      root.querySelector('#signup').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (f.password !== f.password2) { notify(tRaw('auth.err.mismatch')); return; }
        if (!validCpf(f.cpf)) { notify(tRaw('guide.signup.err.cpf')); return; }
        try {
          const ready = await store.signUpGuide({
            email: f.email.trim(), password: f.password, name: f.name.trim(), phone: f.phone.trim(),
            license: f.license.trim(), cityId: f.cityId, cpf: onlyDigits(f.cpf), pixKey: f.pixKey.trim(), refCode: (f.refCode || '').trim(),
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
      <div class="notice warn">${t(me.status === 'refused' ? 'guide.refused' : 'guide.pending')}</div>`,
    mount: mountLogout,
  };
}

async function dashboardView(me, city) {
  const lang = getLang();
  const [stays, visits, adjustments, payouts, pixChecks] = await Promise.all([
    store.listStays(me.id), store.listVisits({ guideId: me.id }), store.listAdjustments(me.id), store.listPayouts(me.id),
    store.listPixVerifications(me.id)]);
  const today = todayIn(city.timezone);
  const cur = (n) => cents(n, city.currency, lang);
  const pick = (st, key) => visits.filter((v) => st.includes(v.status)).reduce((s, v) => s + (v[key] || 0), 0);
  // Corrections (contre-écritures) : une baisse compte tout de suite, une hausse seulement une fois le complément reçu.
  const openAdj = adjustments.filter((a) => !a.payoutId && (a.guideDelta < 0 || a.partnerStatus === 'settled'))
    .reduce((s, a) => s + a.guideDelta, 0);
  const payoutSum = (st) => payouts.filter((p) => p.status === st).reduce((s, p) => s + (p.cents || 0), 0);
  const sum = {
    expected: pick(['declared', 'verifying'], 'declaredCents'),
    available: pick(['received'], 'guideCents') + payoutSum('in_progress') + openAdj,
    paid: payoutSum('paid'),
  };

  const stayItem = (s) => {
    const count = visits.filter((v) => v.stayId === s.id).length;
    return `<li><a href="#/sejour/${encodeURIComponent(s.id)}">
      <div class="spread"><b>${esc(s.client)}</b>${validity(s, stayIsValid(s, city), lang)}</div>
      <div class="hint">${t('stay.people', { n: s.people })} · ${fmtDay(s.start, lang)} → ${fmtDay(s.end, lang)} · ${t('stay.visits', { n: count })}</div>
    </a></li>`;
  };

  return {
    html: `
      <div class="spread"><h1>${t('guide.hello', { name: me.name })}</h1>${logoutButton()}</div>
      <div class="stats">
        <div class="stat"><b>${cur(sum.available)}</b><span>${t('guide.sum.available')}</span></div>
        <div class="stat"><b>${cur(sum.paid)}</b><span>${t('guide.sum.paid')}</span></div>
        <div class="stat"><b>${cur(sum.expected)}</b><span>${t('guide.sum.expected')}</span></div>
      </div>
      <p class="hint">${t('guide.sum.note', { pct: me.weeklyPayout ? 75 : 80 })} <a href="#/releve">${t('guide.statement.open')}</a></p>

      ${me.code ? `<p class="hint">${t('guide.code')} <b>${esc(me.code)}</b></p>` : ''}
      ${me.referralEnabled ? `<a class="card" href="#/indicacao" style="display:block;text-decoration:none;color:inherit">
        <b>${t('ref.card.title')}</b><span class="hint" style="display:block">${t('ref.card.hint')}</span></a>` : ''}
      ${pixCard(me, pixChecks, payouts, cur, lang)}
      <label class="card" style="display:block"><input type="checkbox" id="weekly"${me.weeklyPayout ? ' checked' : ''}> <b>${t('guide.weekly.title')}</b>
        <span class="hint" style="display:block">${t('guide.weekly.hint')}</span></label>

      <form class="card" id="new-stay">
        <h2>${t('guide.stay.new')}</h2>
        <div class="grid2">
          <div class="field"><label for="s-client">${t('guide.stay.client')}</label><input id="s-client" name="client" required placeholder="${t('guide.stay.client.ph')}"></div>
          <div class="field"><label for="s-people">${t('guide.stay.people')}</label><input id="s-people" name="people" type="number" min="1" max="99" value="2" required></div>
          <div class="field"><label for="s-start">${t('guide.stay.start')}</label><input id="s-start" name="start" type="date" value="${today}" required></div>
          <div class="field"><label for="s-end">${t('guide.stay.end')}</label><input id="s-end" name="end" type="date" value="${addDays(today, 3)}" required></div>
        </div>
        <p class="hint">${t('guide.stay.hint')}</p>
        <button class="btn block">${t('guide.stay.create')}</button>
      </form>

      <div class="card">
        <h2>${t('guide.stays')}</h2>
        ${stays.length ? `<ul class="list">${stays.map(stayItem).join('')}</ul>` : `<p class="hint">${t('guide.stays.none')}</p>`}
      </div>`,
    mount(root, ctx) {
      mountLogout(root, ctx);
      mountPix(root, ctx);
      root.querySelector('#weekly').onchange = async (e) => {
        await store.setWeeklyPayout(e.target.checked);
        ctx.refresh(tRaw('common.saved'));
      };
      root.querySelector('#new-stay').onsubmit = async (e) => {
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
  const toConfirm = payouts.filter((p) => p.status === 'paid' && p.receivedStatus === 'waiting');
  return `<div class="card" id="pix-card">
      <h2>${t('pix.title')}</h2>
      <div class="spread"><span>${t('pix.key')} <b>${esc(masked)}</b>${me.pixKeyType ? ` · ${t(`pix.type.${me.pixKeyType}`)}` : ''}</span>
        <span class="badge ${me.pixStatus === 'verified' ? 'ok' : me.pixStatus === 'failed' ? 'bad' : 'warn'}">${t(`pix.st.${me.pixStatus}`)}</span></div>
      ${me.pixStatus === 'verified' && me.pixVerifiedAt ? `<p class="hint">${t('pix.verified.on', { date: fmtDay(me.pixVerifiedAt.slice(0, 10), lang) })}</p>` : ''}
      ${me.pixStatus !== 'verified' ? `<div class="notice warn">${t('pix.suspended')}</div>` : ''}
      ${open ? `<div class="notice">${t('pix.sent.msg')}
        <div class="row" style="margin-top:10px"><button class="btn small" data-pix-ok="${esc(open.id)}">${t('pix.confirm')}</button>
        <button class="btn small ghost" data-pix-no="${esc(open.id)}">${t('pix.notreceived')}</button></div></div>` : ''}
      ${toConfirm.map((p) => `<div class="notice">${t('pix.payout.msg', { amount: cur(p.cents), ref: esc(p.reference || '') })}
        <div class="row" style="margin-top:10px"><button class="btn small" data-po-ok="${esc(p.id)}">${t('pix.payout.ok')}</button>
        <button class="btn small ghost" data-po-no="${esc(p.id)}">${t('pix.notreceived')}</button></div></div>`).join('')}
      <details style="margin-top:8px"><summary class="hint">${t('pix.change')}</summary>
        <form id="pix-form" style="margin-top:8px">
          <div class="grid2">
            <div class="field"><label for="pix-type">${t('pix.type')}</label><select id="pix-type" name="type">${PIX_TYPES.map((k) => `<option value="${k}"${k === me.pixKeyType ? ' selected' : ''}>${t(`pix.type.${k}`)}</option>`).join('')}</select></div>
            <div class="field"><label for="pix-key">${t('pix.newkey')}</label><input id="pix-key" name="key" required autocomplete="off"></div>
          </div>
          <p class="hint">${t('pix.change.hint')}</p>
          <button class="btn small">${t('common.save')}</button>
        </form>
      </details>
    </div>`;
}
function mountPix(root, ctx) {
  const card = root.querySelector('#pix-card');
  if (!card) return;
  const act = async (fn, okMsg) => { try { const r = await fn(); if (r === false || r?.ok === false) { notify(tRaw('err.generic')); return; } ctx.refresh(tRaw(okMsg)); } catch { notify(tRaw('err.generic')); } };
  card.querySelectorAll('[data-pix-ok]').forEach((b) => { b.onclick = () => act(() => store.confirmPixVerification(b.dataset.pixOk, true), 'pix.done.ok'); });
  card.querySelectorAll('[data-pix-no]').forEach((b) => { b.onclick = () => act(() => store.confirmPixVerification(b.dataset.pixNo, false), 'pix.done.no'); });
  card.querySelectorAll('[data-po-ok]').forEach((b) => { b.onclick = () => act(() => store.confirmPayoutReceived(b.dataset.poOk, true), 'pix.done.ok'); });
  card.querySelectorAll('[data-po-no]').forEach((b) => { b.onclick = () => act(() => store.confirmPayoutReceived(b.dataset.poNo, false), 'pix.done.no'); });
  const f = card.querySelector('#pix-form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const ok = await store.setMyPixKey(f.key.value.trim(), f.type.value).catch(() => false);
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
            return `<tr><td style="white-space:nowrap">${esc(store.txNum(v.num))}</td><td>${short(v.at)}</td><td>${esc(pname(v.partnerId))}</td><td>${v.peopleServed}</td>
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
