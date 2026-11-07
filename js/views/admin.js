// Administration (français, passable en portugais) : validations, paiements, reversements, partenaires, villes.
// Accès réservé au compte qui a le rôle « admin » dans la base (le tout premier créé ici).
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, cents, parseCents, fmtMoment, fmtDay, qrSvg, appLink, notify, confirmTwice, validTaxId, fmtTaxId, onlyDigits } from '../util.js';
import * as store from '../store.js';
import { forgotLink, mountForgot, resetView, statusBadge } from './shared.js';
import { maskTaxId, photoToJpeg } from '../util.js';
import { topicLabel, alertStatus } from './help.js';

const TABS = ['dashboard', 'alertas', 'validations', 'payments', 'payouts', 'pix', 'referral', 'transactions', 'partners', 'cities', 'journal'];

export async function adminView([tab = 'dashboard']) {
  if (store.inRecovery() && await store.hasSession()) return resetView();
  const me = await store.currentAdmin();
  if (!me) return loginView();
  if (!me.isAdmin) {
    return {
      html: `<div class="notice bad">${t('admin.notadmin', { email: me.email })}</div>
        <button class="btn ghost" id="logout">${t('common.logout')}</button>`,
      mount: mountLogout,
    };
  }
  if (!TABS.includes(tab)) tab = 'dashboard';
  const data = await loadAll();
  const todo = todoCounts(data);
  const nav = `<nav class="tabs">${TABS.map((k) => `<a href="#/${k}" class="${k === tab ? 'on' : ''}">${t(`admin.tab.${k}`)}${todo[k] ? `<span class="todo" title="${esc(tRaw('admin.todo.hint'))}">${todo[k]}</span>` : ''}</a>`).join('')}</nav>`;
  const view = await ({ dashboard, alertas, validations, payments, payouts, pix: pixAdmin, referral, transactions, partners, cities, journal })[tab](data);
  return {
    html: `<div class="spread"><h1>${t('admin.title')}</h1>
        <span class="hint">${esc(me.email)} <button class="btn ghost small" id="logout">${t('common.logout')}</button></span></div>
      ${nav}${view.html}`,
    mount(root, ctx) { mountLogout(root, ctx); if (view.mount) view.mount(root, ctx); },
  };
}

function mountLogout(root, ctx) {
  root.querySelector('#logout').onclick = async () => { await store.signOut(); ctx.go(''); };
}

function loginView() {
  return {
    html: `
      <h1>${t('admin.title')}</h1>
      <form class="card" id="login">
        <h2>${t('auth.login')}</h2>
        <div class="field"><label for="a-email">${t('auth.email')}</label><input id="a-email" name="email" type="email" required autocomplete="email"></div>
        <div class="field"><label for="a-pass">${t('auth.password')}</label><input id="a-pass" name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn block">${t('auth.login')}</button>
        ${forgotLink()}
      </form>
      <details class="card">
        <summary>${t('admin.first')}</summary>
        <form id="first" style="margin-top:12px">
          <p class="hint">${t('admin.first.hint')}</p>
          <div class="field"><label for="f-email">${t('auth.email')}</label><input id="f-email" name="email" type="email" required autocomplete="email"></div>
          <div class="field"><label for="f-pass">${t('auth.password.new')}</label><input id="f-pass" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
          <button class="btn secondary block">${t('admin.first.create')}</button>
        </form>
      </details>`,
    mount(root, ctx) {
      mountForgot(root.querySelector('#login'));
      root.querySelector('#login').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try { await store.signIn(f.email.trim(), f.password); ctx.refresh(); } catch { notify(tRaw('auth.err.login')); }
      };
      root.querySelector('#first').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try {
          const ready = await store.signUpAdmin(f.email.trim(), f.password);
          ctx.refresh(tRaw(ready ? 'admin.first.done' : 'auth.confirm'));
        } catch (err) { notify(tRaw(err.message === 'exists' ? 'auth.err.exists' : 'auth.err.signup')); }
      };
    },
  };
}

// « 1 guide actif » / « 2 guides actifs ».
const plural = (key, n) => tRaw(`${key}.${n === 1 ? 'one' : 'other'}`, { n });

async function loadAll() {
  const [cityList, guides, partnerList, visits, payoutList, paymentList, adjustments, pixChecks, expenses, cadChecks, alerts] = await Promise.all([
    store.listCities(), store.listGuides(), store.listPartners(), store.listVisits(), store.listPayouts(), store.listPayments(),
    store.listAdjustments(), store.listPixVerifications(), store.listExpenses(), store.listCadasturChecks(), store.adminListAlerts(),
  ]);
  const city = (id) => cityList.find((c) => c.id === id);
  const guide = (id) => guides.find((g) => g.id === id);
  const partner = (id) => partnerList.find((p) => p.id === id);
  const cur = (n, cityId) => cents(n, city(cityId)?.currency || 'BRL', getLang());
  return { cityList, guides, partnerList, visits, payoutList, paymentList, adjustments, pixChecks, expenses, cadChecks, alerts, city, guide, partner, cur };
}
// Corrections pas encore reversées et déjà dues au guide : une baisse tout de suite, une hausse une fois le complément reçu.
const openAdjustments = (adjustments, guideId) => adjustments.filter((a) => (!guideId || a.guideId === guideId) && !a.payoutId
  && (a.guideDelta < 0 || a.partnerStatus === 'settled'));

// Pastilles des onglets : nombre de tâches qui attendent une action de l'admin.
function todoCounts({ guides, payoutList, paymentList, visits, adjustments, pixChecks, partnerList, alerts }) {
  const openPix = (g) => pixChecks.some((c) => c.guideId === g.id && ['pending', 'sent'].includes(c.status) && !c.verifiedAt);
  const late = new Set(visits.filter((v) => v.status === 'declared' && v.declaredAt && Date.now() - new Date(v.declaredAt) > 30 * 864e5).map((v) => v.partnerId));
  return {
    alertas: alerts.filter((a) => a.status === 'new').length,
    validations: guides.filter((g) => g.status === 'pending').length,
    payments: paymentList.filter((p) => p.status === 'submitted').length,
    payouts: payoutList.filter((p) => p.status === 'in_progress').length
      + guides.filter((g) => visits.some((v) => v.guideId === g.id && v.status === 'received') && !blockReason(g, payoutList)).length,
    pix: guides.filter((g) => g.status === 'validated' && g.pixStatus !== undefined
      && (g.pixStatus === 'review' || pixChecks.some((c) => c.guideId === g.id && c.status === 'pending') || (g.pixStatus !== 'verified' && g.pixKey && !openPix(g)))).length,
    transactions: visits.filter((v) => v.status === 'disputed').length + adjustments.filter((a) => a.partnerStatus !== 'settled').length,
    partners: partnerList.filter((p) => p.status === 'active' && late.has(p.id)).length,
  };
}

// Alertes (v33) : envoyées par les guides et les partenaires quand la FAQ ne suffit pas. L'autre partie ne les voit jamais.
async function alertas({ alerts }) {
  const lang = getLang();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const faq = await store.adminFaqSolvedSince(monthStart.toISOString());
  const c = (st) => alerts.filter((a) => a.status === st).length;
  const resolvedMonth = alerts.filter((a) => a.status === 'resolved' && a.resolvedAt && new Date(a.resolvedAt) >= monthStart).length;
  const order = { new: 0, in_progress: 1, resolved: 2 };
  const list = [...alerts].sort((a, b) => order[a.status] - order[b.status] || new Date(b.createdAt) - new Date(a.createdAt));
  const item = (a) => {
    const kind = a.authorKind;
    return `<li><div class="spread"><b>nº ${a.num} · ${esc(topicLabel(kind, a.topic))}</b>
        <span class="badge ${a.status === 'resolved' ? 'ok' : a.status === 'new' ? 'bad' : 'warn'}">${esc(alertStatus(a.status))}</span></div>
      <div class="hint"><span class="badge">${t(kind === 'guide' ? 'admin.al.guide' : 'admin.al.partner')}</span>
        ${esc(kind === 'guide' ? a.guideName : a.partnerName)} · ${fmtMoment(a.createdAt, lang, 'America/Sao_Paulo')}${a.visitNum ? ` · ${esc(store.fmtCode(a.visitCode) || store.txNum(a.visitNum))}` : ''}</div>
      <p style="margin:6px 0">${a.message ? esc(a.message) : `<span class="hint">${t('admin.al.empty')}</span>`}</p>
      <form class="al-form" data-id="${esc(a.id)}">
        <div class="field" style="margin:0 0 6px"><label>${t('admin.al.answer')}</label><textarea name="answer" rows="2" maxlength="1000" style="width:100%">${esc(a.answer)}</textarea></div>
        <div class="row" style="gap:6px">
          ${a.status === 'new' ? `<button class="btn small" data-st="in_progress">${t('admin.al.take')}</button>` : ''}
          ${a.status !== 'resolved' ? `<button class="btn small secondary" data-st="${a.status}">${t('admin.al.save')}</button><button class="btn small ghost" data-st="resolved">${t('admin.al.close')}</button>`
            : `<button class="btn small ghost" data-st="in_progress">${t('admin.al.reopen')}</button>`}
        </div></form></li>`;
  };
  return {
    html: `<div class="pd-kpis">
        <div class="pd-kpi ${c('new') ? 'bad' : ''}"><span>${t('admin.al.new')}</span><b>${c('new')}</b><em>${t('admin.al.new.hint')}</em></div>
        <div class="pd-kpi ${c('in_progress') ? 'warn' : ''}"><span>${t('admin.al.progress')}</span><b>${c('in_progress')}</b><em>${t('admin.al.progress.hint')}</em></div>
        <div class="pd-kpi ok"><span>${t('admin.al.faq')}</span><b>${faq}</b><em>${t('admin.al.faq.hint')}</em></div>
        <div class="pd-kpi"><span>${t('admin.al.resolved')}</span><b>${resolvedMonth}</b><em>${t('admin.al.resolved.hint')}</em></div>
      </div>
      <div class="card"><h2>${t('admin.al.list')}</h2>${list.length ? `<ul class="list">${list.map(item).join('')}</ul>` : `<p class="hint">${t('admin.al.none')}</p>`}</div>`,
    mount(root, ctx) {
      root.querySelectorAll('.al-form').forEach((f) => {
        f.querySelectorAll('[data-st]').forEach((b) => {
          b.onclick = async (e) => {
            e.preventDefault(); b.disabled = true;
            try { await store.adminSetAlert(f.dataset.id, b.dataset.st, f.answer.value); ctx.refresh(tRaw('common.saved')); }
            catch { b.disabled = false; notify(tRaw('err.generic')); }
          };
        });
      });
    },
  };
}

const sumOf = (list, key) => list.reduce((s, v) => s + (v[key] || 0), 0);
const IN = (v, ...st) => st.includes(v.status);

async function dashboard({ guides, partnerList, visits, adjustments, cur, cityList }) {
  const cityId = cityList[0]?.id;
  const live = visits.filter((v) => v.status !== 'cancelled');
  const declared = live.filter((v) => IN(v, 'declared', 'verifying', 'received', 'payout_pending', 'paid'));
  const cashed = live.filter((v) => IN(v, 'received', 'payout_pending', 'paid'));
  return {
    html: `
      <div class="stats">
        <div class="stat"><b>${live.length}</b><span>${t('admin.stat.visits')}</span></div>
        <div class="stat"><b>${live.filter((v) => IN(v, 'zero')).length}</b><span>${t('admin.stat.zero')}</span></div>
        <div class="stat"><b>${live.filter((v) => IN(v, 'disputed')).length}</b><span>${t('admin.stat.disputed')}</span></div>
      </div>
      <div class="stats">
        <div class="stat"><b>${cur(sumOf(declared, 'declaredCents'), cityId)}</b><span>${t('admin.stat.declared')}</span></div>
        <div class="stat"><b>${cur(sumOf(cashed, 'receivedCents'), cityId)}</b><span>${t('admin.stat.cashed')}</span></div>
        <div class="stat"><b>${cur(sumOf(live.filter((v) => IN(v, 'declared', 'verifying')), 'declaredCents'), cityId)}</b><span>${t('admin.stat.awaiting')}</span></div>
      </div>
      <div class="stats">
        <div class="stat"><b>${cur(sumOf(cashed, 'kombrioCents') + sumOf(adjustments, 'kombrioDelta'), cityId)}</b><span>${t('admin.stat.platform')}</span></div>
        <div class="stat"><b>${cur(sumOf(live.filter((v) => IN(v, 'received')), 'guideCents') + sumOf(openAdjustments(adjustments), 'guideDelta'), cityId)}</b><span>${t('admin.stat.topay')}</span></div>
        <div class="stat"><b>${cur(sumOf(live.filter((v) => IN(v, 'paid')), 'guideCents'), cityId)}</b><span>${t('admin.stat.guidepaid')}</span></div>
      </div>
      <div class="card">
        <p>${t('admin.stat.people', { guides: plural('admin.stat.guides', guides.filter((g) => g.status === 'validated').length), pending: guides.filter((g) => g.status === 'pending').length, partners: plural('admin.stat.partners', partnerList.length) })}</p>
      </div>`,
  };
}

// Fenêtre intérieure : le site du Cadastur ou une capture, sans quitter l'app.
const CADASTUR_URL = 'https://cadastur.turismo.gov.br/hotsite/#!/public/sou-turista/inicio';
function openSheet(title, inner) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="sheet"><div class="sheet-head"><b>${title}</b><span class="row" style="gap:6px">
    <a class="btn ghost small" href="${CADASTUR_URL}" target="_blank" rel="noopener">${t('admin.cad.newwin')}</a>
    <button class="btn small" data-close>${t('admin.cad.close')}</button></span></div>${inner}</div>`;
  const close = () => o.remove();
  o.querySelector('[data-close]').onclick = close;
  o.onclick = (e) => { if (e.target === o) close(); };
  document.body.appendChild(o);
}
const lastCheck = (cadChecks, gId) => cadChecks.find((c) => c.guideId === gId);

async function validations({ guides, city, cadChecks }) {
  const pending = guides.filter((g) => g.status === 'pending');
  const lang = getLang();
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const expiring = guides.filter((g) => g.status === 'validated' && g.cadasturValidUntil !== undefined && (!g.cadasturValidUntil || g.cadasturValidUntil < soon));
  const cadBlock = (g) => {
    const c = lastCheck(cadChecks, g.id);
    return `<div class="row" style="margin-top:8px;gap:6px;align-items:center">
        <button class="btn small secondary" data-cad-open="${esc(g.id)}">${t('admin.cad.open')}</button>
        ${c ? `<span class="hint">${t('admin.cad.done', { date: fmtDay(c.checkedAt.slice(0, 10), lang), until: fmtDay(c.validUntil, lang) })}${c.number ? ` · nº ${esc(c.number)} · ${t(`cad.cat.${c.category}`)}` : ''}</span>
          <button class="btn ghost small" data-cad-proof="${esc(c.id)}">${t('admin.cad.proof')}</button>` : `<span class="hint">${t('admin.cad.none')}</span>`}
      </div>
      <form class="cadform row" data-id="${esc(g.id)}" style="align-items:flex-end;gap:6px;margin-top:6px">
        <div class="field" style="margin:0"><label>${t('admin.cad.number')}</label><input name="number" maxlength="40" required autocomplete="off" placeholder="21.123456.10-1"></div>
        <div class="field" style="margin:0"><label>${t('admin.cad.category')}</label><select name="category" required><option value=""></option>
          ${['regional', 'nacional', 'internacional', 'atrativo'].map((k) => `<option value="${k}">${t(`cad.cat.${k}`)}</option>`).join('')}</select></div>
        <div class="field" style="margin:0"><label>${t('admin.cad.until')}</label><input type="date" name="until" min="${today}" required></div>
        <div class="field" style="margin:0;flex:1"><label>${t('admin.cad.shot')}</label><input type="file" name="shot" accept="image/*" required></div>
        <button class="btn small">${t('admin.cad.save')}</button>
      </form>`;
  };
  return {
    html: `<div class="card">
      <h2>${t('admin.val.title')}</h2>
      ${pending.length ? `<ul class="list">${pending.map((g) => `<li>
        <div class="spread"><b>${esc(g.name)}</b><span class="hint">${esc(city(g.cityId)?.name || '')}</span></div>
        <div class="hint">${esc(g.email || '')} · ${esc(g.phone || '')} · ${esc(city(g.cityId)?.licenseLabel || '')} ${esc(g.license || '')}</div>
        <div class="hint">${g.taxKind === 'cnpj' ? 'CNPJ' : 'CPF'} ${g.cpf ? esc(fmtTaxId(g.cpf)) : `<b>${t('admin.missing')}</b>`} · ${t('admin.val.pix')} ${g.pixKey ? esc(g.pixKey) : `<b>${t('admin.missing')}</b>`}</div>
        ${cadBlock(g)}
        <div class="row" style="margin-top:8px">
          ${(() => { const c = lastCheck(cadChecks, g.id); return c && c.validUntil >= today
            ? `<button class="btn small" data-ok="${esc(g.id)}">${t('admin.val.accept')}</button>`
            : `<button class="btn small" disabled title="${esc(tRaw('admin.cad.required'))}">${t('admin.val.accept')}</button><span class="hint">${t('admin.cad.required')}</span>`; })()}
          <button class="btn ghost small" data-no="${esc(g.id)}">${t('admin.val.refuse')}</button>
        </div></li>`).join('')}</ul>` : `<p class="hint">${t('admin.val.none')}</p>`}
      <p class="hint">${t('admin.val.hint')}</p>
    </div>
    ${expiring.length ? `<div class="card"><h2>${t('admin.cad.expiring')}</h2><ul class="list">${expiring.map((g) => `<li>
      <div class="spread"><b>${esc(g.name)}</b><span class="badge ${g.cadasturValidUntil && g.cadasturValidUntil >= today ? 'warn' : 'bad'}">${g.cadasturValidUntil ? t('admin.cad.until.short', { date: fmtDay(g.cadasturValidUntil, lang) }) : t('admin.cad.never')}</span></div>
      <div class="hint">${esc(city(g.cityId)?.licenseLabel || '')} ${esc(g.license || '')}</div>${cadBlock(g)}</li>`).join('')}</ul></div>` : ''}
    ${activeCard(guides.filter((g) => ['validated', 'suspended'].includes(g.status)), 'guide')}`,
    mount(root, ctx) {
      root.querySelectorAll('[data-cad-open]').forEach((b) => { b.onclick = () => {
        const g = guides.find((x) => x.id === b.dataset.cadOpen);
        openSheet(`${esc(g.name)} · ${esc(g.license || '')}${g.cpf ? ` · ${g.taxKind === 'cnpj' ? 'CNPJ' : 'CPF'} ${esc(fmtTaxId(g.cpf))}` : ''}`, `<iframe src="${CADASTUR_URL}" title="Cadastur"></iframe>`);
      }; });
      root.querySelectorAll('[data-cad-proof]').forEach((b) => { b.onclick = async () => {
        const src = await store.cadasturProof(b.dataset.cadProof).catch(() => '');
        if (!src) { notify(tRaw('err.generic')); return; }
        openSheet(t('admin.cad.proof'), `<div class="sheet-body"><img src="${esc(src)}" alt=""></div>`);
      }; });
      root.querySelectorAll('form.cadform').forEach((f) => { f.onsubmit = async (e) => {
        e.preventDefault();
        const file = f.shot.files[0];
        if (!file || !f.until.value || !f.number.value.trim() || !f.category.value) { notify(tRaw('admin.cad.required')); return; }
        try {
          const proof = await photoToJpeg(file, 1200, 0.72);
          const r = await store.recordCadasturCheck(f.dataset.id, f.until.value, proof, f.number.value.trim(), f.category.value);
          const errs = { date: 'admin.cad.err.date', number: 'admin.cad.err.number', category: 'admin.cad.err.category', cpf: 'admin.cad.err.cpf' }; // « cpf » = CPF ou CNPJ du guide
          if (r && r.ok) ctx.refresh(tRaw('admin.cad.saved')); else notify(tRaw(errs[r && r.reason] || 'err.generic'));
        } catch { notify(tRaw('err.generic')); }
      }; });
      mountActive(root, ctx);
      root.querySelectorAll('[data-ok]').forEach((b) => { b.onclick = async () => { await store.setGuideStatus(b.dataset.ok, 'validated'); ctx.refresh(tRaw('admin.val.accepted')); }; });
      root.querySelectorAll('[data-no]').forEach((b) => { b.onclick = async () => { await store.setGuideStatus(b.dataset.no, 'refused'); ctx.refresh(tRaw('admin.val.refused')); }; });
    },
  };
}

function receiptCell(pay) {
  const r = pay.receipt;
  if (!r || !r.data) return `<span class="hint">${t('admin.pay.noreceipt')}</span>`;
  if (r.type?.startsWith('image/')) return `<a href="#" data-receipt="${esc(pay.id)}" class="receipt"><img src="${r.data}" alt="${esc(r.name)}"></a>`;
  return `<a href="#" data-receipt="${esc(pay.id)}">${esc(r.name)}</a>`;
}

// Paiements reçus des partenaires : l'admin saisit le montant réellement reçu (doit être égal au total déclaré).
async function payments({ paymentList, visits, partner, cur, city }) {
  const lang = getLang();
  const open = paymentList.filter((y) => y.status === 'submitted');
  const done = paymentList.filter((y) => y.status !== 'submitted').slice(0, 30);
  const covered = (y) => visits.filter((v) => v.paymentId === y.id);
  return {
    html: `<div class="card">
      <h2>${t('admin.pay.title')}</h2>
      <p class="hint">${t('admin.pay.hint2')}</p>
      ${open.length ? `<ul class="list">${open.map((y) => {
        const p = partner(y.partnerId);
        return `<li>
        <div class="spread"><b>${t('admin.pay.num', { num: y.num })} · ${esc(p?.name)} → ${cur(y.cents, p?.cityId)}</b><span class="badge">${t(`method.${y.method}`)}</span></div>
        <div class="hint">${fmtMoment(y.submittedAt, lang, city(p?.cityId)?.timezone)}${y.pixRef ? ` · Pix ${esc(y.pixRef)}` : ''}</div>
        <div class="hint">${covered(y).map((v) => `${esc(store.txNum(v.num))} (${cur(v.declaredCents, p?.cityId)})`).join(' · ')}</div>
        <div style="margin:8px 0">${receiptCell(y)}</div>
        <form class="verify row" data-id="${esc(y.id)}" style="align-items:flex-end">
          <div class="field" style="margin:0"><label>${t('admin.pay.received')}</label><input name="cents" inputmode="decimal" style="width:130px" placeholder="${(y.cents / 100).toFixed(2).replace('.', ',')}"></div>
          <div class="field" style="margin:0;flex:1"><label>${t('admin.pay.pixref')}</label><input name="ref" value="${esc(y.pixRef || '')}"></div>
          <button class="btn small">${t('admin.pay.confirm')}</button>
        </form>
        <form class="reject row" data-id="${esc(y.id)}" style="align-items:flex-end;margin-top:6px">
          <div class="field" style="margin:0;flex:1"><input name="reason" placeholder="${t('admin.pay.reason')}"></div>
          <button class="btn ghost small">${t('admin.pay.reject')}</button>
        </form></li>`;
      }).join('')}</ul>` : `<p class="hint">${t('admin.pay.none')}</p>`}
    </div>
    ${done.length ? `<div class="card"><h2>${t('admin.pay.history')}</h2><div class="table-wrap"><table>
      <tr><th>N°</th><th>${t('admin.part.title')}</th><th>${t('common.amount')}</th><th>${t('admin.col.status')}</th><th>Pix</th></tr>
      ${done.map((y) => `<tr><td>${y.num}</td><td>${esc(partner(y.partnerId)?.name)}</td><td>${cur(y.receivedCents ?? y.cents, partner(y.partnerId)?.cityId)}</td><td>${t(`payment.${y.status}`)}${y.note ? ` · ${esc(y.note)}` : ''}</td><td>${esc(y.pixRef || '')}</td></tr>`).join('')}
    </table></div></div>` : ''}`,
    mount(root, ctx) {
      root.querySelectorAll('form.verify').forEach((f) => {
        f.onsubmit = async (e) => {
          e.preventDefault();
          const y = open.find((x) => x.id === f.dataset.id);
          const got = f.cents.value.trim() === '' ? y.cents : parseCents(f.cents.value);
          if (got == null) { notify(tRaw('admin.err.amount')); return; }
          const r = await store.verifyPayment(y.id, got, f.ref.value.trim()).catch(() => null);
          if (!r) { notify(tRaw('err.generic')); return; }
          if (!r.ok) { notify(tRaw(`admin.pay.err.${r.reason}`, { expected: cur(r.expected) })); return; }
          ctx.refresh(tRaw('admin.pay.confirmed'));
        };
      });
      root.querySelectorAll('form.reject').forEach((f) => {
        f.onsubmit = async (e) => {
          e.preventDefault();
          if (!f.reason.value.trim()) { notify(tRaw('admin.err.reason')); return; }
          const ok = await store.rejectPayment(f.dataset.id, f.reason.value.trim()).catch(() => false);
          if (ok) ctx.refresh(tRaw('admin.pay.rejected')); else notify(tRaw('err.generic'));
        };
      });
      root.querySelectorAll('[data-receipt]').forEach((a) => {
        a.onclick = async (e) => {
          e.preventDefault();
          const y = open.find((x) => x.id === a.dataset.receipt);
          const blob = await (await fetch(y.receipt.data)).blob();
          window.open(URL.createObjectURL(blob), '_blank');
        };
      });
    },
  };
}

// Reversements : « lancer » (montant figé, statut en cours), puis « confirmer » avec la référence du virement.
// Parrainage V1 : activation par guide, progression, clôture mensuelle, validation et versement des primes.
async function referral({ cur, guide }) {
  const lang = getLang();
  const list = await store.adminReferrals();
  const day = (d) => (d ? fmtDay(String(d).slice(0, 10), lang) : '');
  const money_ = (n, id) => cur(Number(n), guide(id)?.cityId);
  const lastMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
  const rewards = list.flatMap((r) => r.rewards.map((w) => ({ ...w, parrain: r.name, gid: r.guide_id })));
  const todo = rewards.filter((w) => w.status === 'estimated' || w.status === 'validated');
  const item = (r) => {
    const q = r.filleuls.filter((f) => f.qualified_at).length;
    return `<li>
      <div class="spread"><b>${esc(r.name)} <span class="hint">${esc(r.code || '')}</span></b>
        <label style="white-space:nowrap"><input type="checkbox" data-ref-on="${esc(r.guide_id)}"${r.enabled ? ' checked' : ''}> ${t('admin.ref.enabled')}</label></div>
      <div class="hint">${t('admin.ref.line', { n: r.filleuls.length, q: Math.min(q, r.settings.needed), need: r.settings.needed })}${r.qualified_at ? ` · ${t('admin.ref.period', { start: day(r.qualified_at), end: day(r.period_end) })}` : ''}</div>
      ${r.filleuls.length ? `<div class="hint">${r.filleuls.map((f) => `${esc(f.label)} (${f.tx} tx${f.qualified_at ? ' ✓' : ''})`).join(' · ')}</div>` : ''}
    </li>`;
  };
  const wItem = (w) => `<li>
      <div class="spread"><b>${esc(w.parrain)} ← ${esc(w.filleul || '')} · ${esc(String(w.month).slice(0, 7))}</b><b>${money_(w.reward_cents, w.gid)}</b></div>
      <div class="hint">${t(`admin.ref.st.${w.status}`)} · ${t('admin.ref.base', { k: money_(w.k_cents, w.gid), n: w.tx })}</div>
      ${w.status === 'estimated' ? `<div class="row" style="margin-top:6px"><button class="btn small" data-rw-ok="${esc(w.id)}">${t('admin.ref.validate')}</button>
        <button class="btn ghost small" data-rw-cancel="${esc(w.id)}">${t('admin.ref.cancel')}</button></div>` : ''}
      ${w.status === 'validated' ? `<form class="row rw-pay" data-id="${esc(w.id)}" style="align-items:flex-end;margin-top:6px">
        <div class="field" style="margin:0;flex:1"><label>${t('admin.out.ref')}</label><input name="ref" required placeholder="E2E…"></div>
        <button class="btn small">${t('admin.ref.paid')}</button></form>` : ''}
    </li>`;
  return {
    html: `<div class="card">
      <h2>${t('admin.ref.title')}</h2>
      <p class="hint">${t('admin.ref.hint')}</p>
      ${list.length ? `<ul class="list">${list.map(item).join('')}</ul>` : `<p class="hint">${t('admin.ref.none')}</p>`}
    </div>
    <form class="card" id="ref-close">
      <h2>${t('admin.ref.close')}</h2>
      <p class="hint">${t('admin.ref.close.hint')}</p>
      <div class="row" style="align-items:flex-end"><div class="field" style="margin:0"><label for="ref-month">${t('admin.ref.month')}</label>
        <input id="ref-month" name="month" type="month" value="${lastMonth}" required></div>
        <button class="btn">${t('admin.ref.close.go')}</button></div>
    </form>
    <div class="card">
      <h2>${t('admin.ref.todo')}</h2>
      ${todo.length ? `<ul class="list">${todo.map(wItem).join('')}</ul>` : `<p class="hint">${t('admin.ref.todo.none')}</p>`}
    </div>`,
    mount(root, ctx) {
      root.querySelectorAll('[data-ref-on]').forEach((b) => {
        b.onchange = async () => { await store.setReferralEnabled(b.dataset.refOn, b.checked); ctx.refresh(tRaw('common.saved')); };
      });
      root.querySelector('#ref-close').onsubmit = async (e) => {
        e.preventDefault();
        const n = await store.closeReferralMonth(`${e.target.month.value}-01`);
        ctx.refresh(tRaw('admin.ref.closed', { n }));
      };
      root.querySelectorAll('[data-rw-ok]').forEach((b) => {
        b.onclick = async () => { await store.setReferralReward(b.dataset.rwOk, 'validate'); ctx.refresh(tRaw('common.saved')); };
      });
      root.querySelectorAll('[data-rw-cancel]').forEach((b) => {
        b.onclick = async () => {
          const why = prompt(tRaw('admin.ref.cancel.why'));
          if (!why) return;
          await store.setReferralReward(b.dataset.rwCancel, 'cancel', why);
          ctx.refresh(tRaw('common.saved'));
        };
      });
      root.querySelectorAll('form.rw-pay').forEach((f) => {
        f.onsubmit = async (e) => {
          e.preventDefault();
          const ok = await store.setReferralReward(f.dataset.id, 'pay', e.target.ref.value);
          ctx.refresh(tRaw(ok ? 'admin.ref.paid.done' : 'err.generic'));
        };
      });
    },
  };
}

// Pourquoi un virement de commissions est bloqué (même règle que la base, payout_block_reason).
const blockReason = (g, payoutList) => {
  if (g.pixStatus === undefined) return null;
  if (!g.cpf) return 'cpf';
  if (g.pixStatus !== 'verified') return 'pix';
  if (payoutList.some((p) => p.guideId === g.id && p.status === 'paid' && ['waiting', 'not_received'].includes(p.receivedStatus))) return 'receipt';
  return null;
};
async function payouts({ guides, visits, payoutList, adjustments, cur, guide }) {
  const lang = getLang();
  const due = guides.map((g) => {
    const items = visits.filter((v) => v.guideId === g.id && v.status === 'received');
    const adj = sumOf(openAdjustments(adjustments, g.id), 'guideDelta');
    return { g, items, adj, total: sumOf(items, 'guideCents') + adj };
  }).filter((x) => x.total > 0);
  const running = payoutList.filter((p) => p.status === 'in_progress');
  const paid = payoutList.filter((p) => p.status === 'paid');
  return {
    html: `<div class="card">
      <h2>${t('admin.out.title')}</h2>
      <p class="hint">${t('admin.out.hint2')}</p>
      ${due.length ? `<ul class="list">${due.map(({ g, items, adj, total }) => `<li>
        <div class="spread"><b>${esc(g.name)}</b><b>${cur(total, g.cityId)}</b></div>
        <div class="hint">${t('admin.out.line', { n: items.length, pix: g.pixKey || tRaw('admin.missing'), cpf: g.cpf ? `${g.taxKind === 'cnpj' ? 'CNPJ' : 'CPF'} ${fmtTaxId(g.cpf)}` : tRaw('admin.missing') })}</div>
        <div class="hint">${items.map((v) => esc(store.txNum(v.num))).join(' · ')}${adj ? ` · ${t('admin.out.adj', { amount: cur(adj, g.cityId) })}` : ''}</div>
        ${blockReason(g, payoutList) ? `<div class="notice warn" style="margin-top:8px">${t(`admin.out.blocked.${blockReason(g, payoutList)}`)}</div>`
          : `<button class="btn small" style="margin-top:8px" data-start="${esc(g.id)}">${t('admin.out.start')}</button>`}
      </li>`).join('')}</ul>` : `<p class="hint">${t('admin.out.none')}</p>`}
    </div>
    ${running.length ? `<div class="card"><h2>${t('admin.out.running')}</h2><ul class="list">${running.map((p) => `<li>
        <div class="spread"><b>${t('admin.out.num', { num: p.num })} · ${esc(guide(p.guideId)?.name)}</b><b>${cur(p.cents, guide(p.guideId)?.cityId)}</b></div>
        <div class="hint">Pix : ${esc(guide(p.guideId)?.pixKey || tRaw('admin.missing'))}</div>
        <form class="confirm row" data-id="${esc(p.id)}" style="align-items:flex-end;margin-top:6px">
          <div class="field" style="margin:0;flex:1"><label>${t('admin.out.ref')}</label><input name="ref" placeholder="E2E… / n° de virement"></div>
          <button class="btn small">${t('admin.out.confirm2')}</button>
        </form></li>`).join('')}</ul></div>` : ''}
    <div class="card">
      <h2>${t('admin.out.history')}</h2>
      ${paid.length ? `<div class="table-wrap"><table>
        <tr><th>N°</th><th>${t('common.date')}</th><th>${t('common.guide')}</th><th>${t('common.amount')}</th><th>${t('admin.out.ref')}</th></tr>
        ${paid.map((p) => `<tr><td>${p.num}</td><td>${fmtMoment(p.paidAt || p.at, lang)}</td><td>${esc(guide(p.guideId)?.name)}</td><td>${cur(p.cents, guide(p.guideId)?.cityId)}</td><td>${esc(p.reference || '')}${p.receivedStatus ? `<div class="hint">${t(`admin.out.rcv.${p.receivedStatus}`)}</div>` : ''}</td></tr>`).join('')}
      </table></div>` : `<p class="hint">${t('admin.out.history.none')}</p>`}
    </div>`,
    mount(root, ctx) {
      root.querySelectorAll('[data-start]').forEach((b) => confirmTwice(b, tRaw('admin.out.start.confirm'), async () => {
        const r = await store.startPayout(b.dataset.start);
        if (r && r.blocked) { notify(tRaw(`admin.out.blocked.${r.blocked}`)); return; }
        ctx.refresh(tRaw('admin.out.started'));
      }, tRaw('err.generic')));
      root.querySelectorAll('form.confirm').forEach((f) => {
        f.onsubmit = async (e) => {
          e.preventDefault();
          if (!f.ref.value.trim()) { notify(tRaw('admin.err.ref')); return; }
          const ok = await store.confirmPayout(f.dataset.id, f.ref.value.trim()).catch(() => false);
          if (ok) ctx.refresh(tRaw('admin.out.done')); else notify(tRaw('err.generic'));
        };
      });
    },
  };
}

// Validations Pix (v30, V1 manuelle) : le 1 R$ est envoyé depuis l'app de la banque, puis saisi ici. Dépense Kombrio, jamais une commission.
async function pixAdmin({ guides, pixChecks, expenses, cur, guide }) {
  const lang = getLang();
  if (guides.length && guides[0].pixStatus === undefined) return { html: `<div class="notice warn">${t('admin.pix.notinstalled')}</div>` };
  const sumCat = (c) => expenses.filter((e) => e.category === c).reduce((s, e) => s + e.cents, 0);
  const sent = sumCat('pix_validation'), fees = sumCat('bank_fee'), back = sumCat('pix_validation_return');
  const verifiedGuides = guides.filter((g) => g.pixStatus === 'verified').length;
  const retries = guides.filter((g) => pixChecks.filter((c) => c.guideId === g.id).length > 1).length;
  const net = sent + fees + back;
  const open = (g) => pixChecks.find((c) => c.guideId === g.id && ['pending', 'sent'].includes(c.status) && !c.verifiedAt);
  const list = guides.filter((g) => g.status === 'validated');
  const order = { review: 0, failed: 1, sent: 2, pending: 3, unverified: 4, verified: 5 };
  list.sort((a, b) => (order[a.pixStatus] ?? 9) - (order[b.pixStatus] ?? 9));
  const masked = (k) => (k ? `${k.slice(0, 2)}•••${k.slice(-3)}` : t('admin.missing'));
  const row = (g) => {
    const o = open(g);
    let actions = '';
    if (g.pixStatus !== 'verified' && !o && g.pixKey) actions = `<button class="btn small" data-pix-start="${esc(g.id)}">${t('admin.pix.start')}</button>`;
    if (o && o.status === 'pending') actions = `<form class="pixsent row" data-id="${esc(o.id)}" style="align-items:flex-end;gap:6px">
        <div class="field" style="margin:0;flex:2"><label>${t('admin.pix.e2e')}</label><input name="e2e" placeholder="E2E…" required></div>
        <div class="field" style="margin:0;flex:1"><label>${t('admin.pix.fee')}</label><input name="fee" inputmode="decimal" placeholder="0,00"></div>
        <button class="btn small">${t('admin.pix.sent')}</button></form>`;
    if (o) actions += `<form class="pixfail row" data-id="${esc(o.id)}" style="align-items:flex-end;gap:6px;margin-top:6px">
        <div class="field" style="margin:0;flex:1"><input name="reason" placeholder="${t('admin.pix.reason')}" required></div>
        <button class="btn small ghost">${t('admin.pix.fail')}</button></form>`;
    return `<li><div class="spread"><b>${esc(g.name)}${g.isTest ? ` <span class="badge">${t('admin.pix.test')}</span>` : ''}</b>
        <span class="badge ${g.pixStatus === 'verified' ? 'ok' : ['failed', 'review'].includes(g.pixStatus) ? 'bad' : 'warn'}">${t(`pix.st.${g.pixStatus}`)}</span></div>
      <div class="hint">Pix ${esc(masked(g.pixKey))}${g.pixKeyType ? ` · ${t(`pix.type.${g.pixKeyType}`)}` : ''} · v${g.pixKeyVersion ?? 1}${g.pixStatus === 'review' ? ` · <b>${t('admin.pix.incident')}</b>` : ''}</div>
      <div style="margin-top:6px">${actions}</div>
      <label class="hint" style="display:block;margin-top:6px"><input type="checkbox" data-test="${esc(g.id)}"${g.isTest ? ' checked' : ''}> ${t('admin.pix.test.toggle')}</label></li>`;
  };
  return {
    html: `<div class="stats">
        <div class="stat"><b>${pixChecks.length}</b><span>${t('admin.pix.k.started')}</span></div>
        <div class="stat"><b>${pixChecks.filter((c) => c.sentAt).length}</b><span>${t('admin.pix.k.sent')}</span></div>
        <div class="stat"><b>${verifiedGuides}</b><span>${t('admin.pix.k.verified')}</span></div>
        <div class="stat"><b>${pixChecks.filter((c) => c.status === 'failed' || c.status === 'returned').length}</b><span>${t('admin.pix.k.failed')}</span></div>
        <div class="stat"><b>${retries}</b><span>${t('admin.pix.k.retries')}</span></div>
      </div>
      <div class="stats">
        <div class="stat"><b>${cur(sent)}</b><span>${t('admin.pix.k.gross')}</span></div>
        <div class="stat"><b>${cur(fees)}</b><span>${t('admin.pix.k.fees')}</span></div>
        <div class="stat"><b>${cur(-back)}</b><span>${t('admin.pix.k.returns')}</span></div>
        <div class="stat"><b>${cur(net)}</b><span>${t('admin.pix.k.net')}</span></div>
        <div class="stat"><b>${verifiedGuides ? cur(Math.round(net / verifiedGuides)) : '—'}</b><span>${t('admin.pix.k.avg')}</span></div>
      </div>
      <div class="card"><h2>${t('admin.pix.title')}</h2><p class="hint">${t('admin.pix.hint')}</p>
        ${list.length ? `<ul class="list">${list.map(row).join('')}</ul>` : `<p class="hint">${t('admin.pix.none')}</p>`}</div>
      <div class="card"><h2>${t('admin.pix.history')}</h2>
        ${pixChecks.length ? `<div class="table-wrap"><table>
          <tr><th>N°</th><th>${t('common.date')}</th><th>${t('common.guide')}</th><th>${t('admin.pix.keycol')}</th><th>${t('admin.col.status')}</th><th>${t('admin.pix.guidecol')}</th><th>E2E</th><th></th></tr>
          ${pixChecks.map((c) => `<tr><td>${c.num}</td><td style="white-space:nowrap">${fmtMoment(c.sentAt || c.initiatedAt, lang)}</td><td>${esc(guide(c.guideId)?.name || '?')}</td>
            <td>${esc(c.keyMasked)} · v${c.keyVersion}</td><td>${t(`admin.pix.s.${c.status}`)}${c.failureReason ? `<div class="hint">${esc(c.failureReason)}</div>` : ''}</td>
            <td>${t(`admin.pix.c.${c.confirmation}`)}</td><td>${esc(c.e2e)}</td>
            <td>${c.e2e && ['sent', 'failed'].includes(c.status) && !expenses.some((e) => e.verificationId === c.id && e.category === 'pix_validation_return')
              ? `<form class="pixret" data-id="${esc(c.id)}" style="min-width:180px"><input name="ref" placeholder="${t('admin.pix.retref')}" required><button class="btn small ghost" style="margin-top:4px">${t('admin.pix.ret')}</button></form>` : ''}</td></tr>`).join('')}
        </table></div>` : `<p class="hint">${t('admin.pix.none')}</p>`}</div>`,
    mount(root, ctx) {
      const done = (ok, msg) => (ok ? ctx.refresh(tRaw(msg || 'common.saved')) : notify(tRaw('err.generic')));
      root.querySelectorAll('[data-pix-start]').forEach((b) => confirmTwice(b, tRaw('admin.pix.start.confirm'), async () => {
        const r = await store.startPixVerification(b.dataset.pixStart); done(r && r.ok, 'admin.pix.started');
      }, tRaw('err.generic')));
      root.querySelectorAll('form.pixsent').forEach((f) => { f.onsubmit = async (e) => {
        e.preventDefault();
        const fee = f.fee.value.trim() ? parseCents(f.fee.value) : 0;
        if (fee == null) { notify(tRaw('admin.err.amount')); return; }
        const r = await store.recordPixSent(f.dataset.id, f.e2e.value.trim(), fee).catch(() => null);
        if (r && r.reason === 'duplicate') { notify(tRaw('admin.pay.err.duplicate')); return; }
        done(r && r.ok, 'admin.pix.recorded');
      }; });
      root.querySelectorAll('form.pixfail').forEach((f) => { f.onsubmit = async (e) => {
        e.preventDefault(); done(await store.failPixVerification(f.dataset.id, f.reason.value.trim()).catch(() => false));
      }; });
      root.querySelectorAll('form.pixret').forEach((f) => { f.onsubmit = async (e) => {
        e.preventDefault(); done(await store.recordPixReturn(f.dataset.id, f.ref.value.trim()).catch(() => false));
      }; });
      root.querySelectorAll('[data-test]').forEach((c) => { c.onchange = async () => {
        done(await store.setGuideTest(c.dataset.test, c.checked).catch(() => false));
      }; });
    },
  };
}

// Toutes les transactions : déclaré / encaissé / parts, corrections tracées (motif obligatoire).
async function transactions({ visits, adjustments, guide, partner, cur, city }) {
  const lang = getLang();
  const rows = visits.slice(0, 300);
  const actions = (v) => {
    const a = [];
    if (IN(v, 'zero', 'declared')) a.push('correct');
    if (IN(v, 'received', 'payout_pending', 'paid')) a.push('adjust');
    if (!IN(v, 'paid', 'cancelled', 'disputed')) a.push('dispute');
    if (IN(v, 'disputed')) a.push('resolve');
    if (IN(v, 'visited', 'zero', 'declared') || (IN(v, 'disputed') && ['visited', 'zero', 'declared'].includes(v.prevStatus || 'visited'))) a.push('cancel');
    return a;
  };
  return {
    html: `<div class="card">
      <h2>${t('admin.tx.title')}</h2>
      <p class="hint">${t('admin.tx.hint')}</p>
      <div class="field"><label for="tx-find">${t('admin.tx.find')}</label><input id="tx-find" autocomplete="off" spellcheck="false" placeholder="KTR-BMX · KB-000123" style="max-width:260px"></div>
      ${rows.length ? `<div class="table-wrap"><table>
        <tr><th>ID</th><th>${t('common.date')}</th><th>${t('admin.part.title')}</th><th>${t('common.guide')}</th><th>${t('admin.tx.people')}</th><th>${t('admin.tx.declared')}</th><th>${t('admin.tx.received')}</th><th>Kombrio</th><th>${t('common.guide')}</th><th>${t('admin.col.status')}</th></tr>
        ${rows.map((v) => {
          const p = partner(v.partnerId);
          const c = (n) => (n == null ? '—' : cur(n, p?.cityId));
          const acts = actions(v);
          return `<tr data-find="${esc(`${v.code} ${store.txNum(v.num).replace('-', '')}`)}"><td style="white-space:nowrap">${esc(store.txNum(v.num))}${v.code ? `<div class="hint">${esc(store.fmtCode(v.code))}</div>` : ''}</td><td style="white-space:nowrap">${fmtMoment(v.at, lang, city(p?.cityId)?.timezone)}</td>
            <td>${esc(p?.name || '?')}</td><td>${esc(guide(v.guideId)?.name || '?')}</td><td>${v.peopleServed}</td>
            <td>${c(v.declaredCents)}</td><td>${c(v.receivedCents)}</td><td>${c(v.kombrioCents)}</td><td>${c(v.guideCents)}</td>
            <td>${statusBadge(v)}${v.statusNote ? `<div class="hint">${esc(v.statusNote)}</div>` : ''}
              ${acts.length ? `<details><summary class="hint">${t('admin.tx.act')}</summary>
                <form class="txact" data-id="${esc(v.id)}" style="margin-top:6px;min-width:220px">
                  <select name="act">${acts.map((k) => `<option value="${k}">${t(`admin.tx.${k}`)}</option>`).join('')}</select>
                  <input name="cents" inputmode="decimal" placeholder="${t('admin.tx.newamount')}" style="margin-top:4px">
                  <input name="reason" placeholder="${t('admin.tx.reason')}" style="margin-top:4px" required>
                  <button class="btn small" style="margin-top:4px">${t('common.save')}</button>
                </form></details>` : ''}</td></tr>`;
        }).join('')}
      </table></div>` : `<p class="hint">${t('admin.tx.none')}</p>`}
    </div>
    <div class="card">
      <h2>${t('admin.adj.title')}</h2>
      <p class="hint">${t('admin.adj.hint')}</p>
      ${adjustments.length ? `<div class="table-wrap"><table>
        <tr><th>ID</th><th>${t('common.date')}</th><th>${t('admin.part.title')}</th><th>${t('common.guide')}</th><th>${t('guide.col.diff')}</th><th>${t('common.guide')}</th><th>Kombrio</th><th>${t('guide.col.reason')}</th><th>${t('admin.col.status')}</th></tr>
        ${adjustments.map((a) => {
          const p = partner(a.partnerId);
          const v = visits.find((x) => x.id === a.visitId);
          const c = (n) => cur(n, p?.cityId);
          return `<tr><td style="white-space:nowrap">${esc(store.adjNum(a.num))}<div class="hint">${esc(store.txNum(v?.num))}</div></td>
            <td style="white-space:nowrap">${fmtMoment(a.createdAt, lang, city(p?.cityId)?.timezone)}</td>
            <td>${esc(p?.name || '?')}</td><td>${esc(guide(a.guideId)?.name || '?')}</td>
            <td>${c(a.deltaCents)}</td><td>${c(a.guideDelta)}</td><td>${c(a.kombrioDelta)}</td><td>${esc(a.reason)}</td>
            <td>${t(`admin.adj.${a.partnerStatus}`)}${a.partnerRef ? `<div class="hint">${esc(a.partnerRef)}</div>` : ''}
              ${a.partnerStatus !== 'settled' ? `<form class="adjsettle" data-id="${esc(a.id)}" style="margin-top:6px;min-width:200px">
                <input name="ref" placeholder="${t('admin.adj.ref')}" required>
                <button class="btn small" style="margin-top:4px">${t('admin.adj.settle')}</button>
              </form>` : ''}</td></tr>`;
        }).join('')}
      </table></div>` : `<p class="hint">${t('admin.adj.none')}</p>`}
    </div>`,
    mount(root, ctx) {
      const find = root.querySelector('#tx-find');
      if (find) find.oninput = () => {
        const q = find.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        root.querySelectorAll('tr[data-find]').forEach((r) => { r.hidden = Boolean(q) && !r.dataset.find.replace(/[^A-Z0-9 ]/g, '').split(' ').some((x) => x.includes(q)); });
      };
      root.querySelectorAll('form.adjsettle').forEach((f) => {
        f.onsubmit = async (e) => {
          e.preventDefault();
          if (!f.ref.value.trim()) { notify(tRaw('admin.err.ref')); return; }
          const ok = await store.settleAdjustment(f.dataset.id, f.ref.value.trim()).catch(() => false);
          if (ok) ctx.refresh(tRaw('common.saved')); else notify(tRaw('err.generic'));
        };
      });
      root.querySelectorAll('form.txact').forEach((f) => {
        f.onsubmit = async (e) => {
          e.preventDefault();
          const id = f.dataset.id;
          const reason = f.reason.value.trim();
          if (!reason) { notify(tRaw('admin.err.reason')); return; }
          let ok = false;
          try {
            if (f.act.value === 'correct') {
              const cts = parseCents(f.cents.value);
              if (cts == null) { notify(tRaw('admin.err.amount')); return; }
              ok = await store.correctCommission(id, cts, reason);
            } else if (f.act.value === 'adjust') {
              const cts = parseCents(f.cents.value);
              if (cts == null) { notify(tRaw('admin.err.amount')); return; }
              ok = Boolean(await store.adjustCommission(id, cts, reason));
            } else if (f.act.value === 'dispute') ok = await store.disputeVisit(id, reason);
            else if (f.act.value === 'resolve') ok = await store.resolveDispute(id, reason);
            else if (f.act.value === 'cancel') ok = await store.cancelVisit(id, reason);
          } catch { ok = false; }
          if (ok) ctx.refresh(tRaw('common.saved')); else notify(tRaw('err.generic'));
        };
      });
    },
  };
}

// Journal non modifiable des opérations.
// Libellé d'un événement du journal ; sans traduction, le nom technique devient des mots lisibles.
const evLabel = (ev) => { const s = tRaw(`log.${ev}`); return s === `log.${ev}` ? ev.replace(/_/g, ' ') : s; };
async function journal({ visits, paymentList, payoutList }) {
  const lang = getLang();
  const rows = await store.listLedger(300);
  const ref = (r) => {
    if (r.visit_id) return store.visitRef(visits.find((v) => v.id === r.visit_id)) || '';
    if (r.payment_id) return t('admin.pay.num', { num: paymentList.find((y) => y.id === r.payment_id)?.num ?? '?' });
    if (r.payout_id) return t('admin.out.num', { num: payoutList.find((p) => p.id === r.payout_id)?.num ?? '?' });
    return '';
  };
  const detail = (d) => Object.entries(d || {}).filter(([k]) => k !== 'visits').map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' · ');
  return {
    html: `<div class="card">
      <h2>${t('admin.log.title')}</h2>
      <p class="hint">${t('admin.log.hint')}</p>
      ${rows.length ? `<div class="table-wrap"><table>
        <tr><th>${t('common.date')}</th><th>${t('admin.log.who')}</th><th>${t('admin.log.event')}</th><th>${t('admin.log.ref')}</th><th>${t('admin.log.detail')}</th></tr>
        ${rows.map((r) => `<tr><td style="white-space:nowrap">${fmtMoment(r.at, lang)}</td><td>${esc(r.actor_kind)}</td><td>${esc(evLabel(r.event))}</td><td>${esc(ref(r))}</td><td class="hint">${detail(r.data)}</td></tr>`).join('')}
      </table></div>` : `<p class="hint">${t('admin.log.none')}</p>`}
    </div>`,
  };
}

// Boutons Actif / Suspendu (v38) : guides validés ou suspendus, et partenaires. Suspendre demande un motif (journal).
const isOn = (kind, x) => (kind === 'guide' ? x.status === 'validated' : x.status === 'active');
const activeToggle = (kind, x) => `<span class="row" style="gap:6px;align-items:center">
    <span class="badge ${isOn(kind, x) ? 'ok' : 'bad'}">${t(isOn(kind, x) ? 'admin.act.on' : 'admin.act.off')}</span>
    <button type="button" class="btn small ${isOn(kind, x) ? 'ghost' : ''}" data-act-kind="${kind}" data-act-id="${esc(x.id)}" data-act-on="${isOn(kind, x) ? '0' : '1'}" data-act-name="${esc(x.name)}">${t(isOn(kind, x) ? 'admin.act.suspend' : 'admin.act.reactivate')}</button></span>`;
function activeCard(list, kind) {
  if (!list.length) return '';
  const sorted = [...list].sort((a, b) => Number(isOn(kind, a)) - Number(isOn(kind, b)) || a.name.localeCompare(b.name));
  return `<div class="card"><h2>${t(kind === 'guide' ? 'admin.act.guides' : 'admin.act.partners')}</h2><p class="hint">${t(`admin.act.hint.${kind}`)}</p>
    <ul class="list">${sorted.map((x) => `<li><div class="spread"><span><b>${esc(x.name)}</b>${x.code ? ` <span class="hint">${esc(x.code)}</span>` : ''}</span>${activeToggle(kind, x)}</div></li>`).join('')}</ul></div>`;
}
function mountActive(root, ctx) {
  root.querySelectorAll('[data-act-kind]').forEach((b) => {
    b.onclick = async () => {
      const kind = b.dataset.actKind; const on = b.dataset.actOn === '1'; const name = b.dataset.actName;
      let reason = null;
      if (on) { if (!confirm(tRaw('admin.act.confirm.on', { name }))) return; }
      else {
        reason = prompt(tRaw(`admin.act.reason.${kind}`, { name }));
        if (reason === null) return;
        if (!reason.trim()) { notify(tRaw('admin.act.reason.required')); return; }
      }
      b.disabled = true;
      try {
        const r = kind === 'guide'
          ? await store.adminSetGuideStatus(b.dataset.actId, on ? 'validated' : 'suspended', reason)
          : await store.adminSetPartnerStatus(b.dataset.actId, on ? 'active' : 'paused', reason);
        if (r && r.ok) ctx.refresh(tRaw(on ? 'admin.act.done.on' : 'admin.act.done.off', { name }));
        else { b.disabled = false; notify(tRaw('err.generic')); }
      } catch { b.disabled = false; notify(tRaw('err.generic')); }
    };
  });
}

async function partners({ partnerList, cityList, city }) {
  return {
    html: `<div class="card">
      <h2>${t('admin.part.title')}</h2>
      <button type="button" class="btn ghost small" id="suspend-late">${t('admin.part.late')}</button>
      <ul class="list">${partnerList.map((p) => `<li>
        <div class="spread"><b>${esc(p.name)}</b>${activeToggle('partner', p)}</div>
        <div class="hint">${t(`ptype.${p.type}`)} · ${esc(p.area || '')} · ${esc(city(p.cityId)?.name || '')}</div>
        <div class="hint">${t('admin.part.taxid')} ${p.taxId ? esc(fmtTaxId(p.taxId)) : `<b>${t('admin.missing')}</b>`}</div>
        ${p.offer ? `<div class="offer">${esc(p.offer)}</div>` : `<div class="hint">${t('admin.part.nooffer')}</div>`}
        <details style="margin-top:8px"><summary>${t('admin.part.showcase')}</summary>
          <form class="pdetails" data-id="${esc(p.id)}" style="margin-top:10px">
            <div class="row" style="align-items:flex-start">
              ${p.photo && p.photo.startsWith('data:image/') ? `<img class="thumb" src="${esc(p.photo)}" alt="">` : ''}
              <div class="field" style="flex:1"><label>${t('admin.part.photo')}</label><input type="file" name="photo" accept="image/*"></div>
            </div>
            <div class="field"><label>${t('admin.part.address')}</label><input name="address" value="${esc(p.address)}" placeholder="${t('admin.part.address.ph')}"></div>
            <button class="btn small">${t('admin.part.save')}</button>
          </form>
        </details>
        <details style="margin-top:8px" ${p.managerName ? '' : 'open'}><summary>${t('admin.part.access')}</summary>
          ${p.managerName
            ? `<p class="hint" style="margin-top:8px">${t('admin.part.activated', { name: p.managerName, email: p.managerEmail, phone: p.managerPhone, terms: p.termsVersion, date: fmtMoment(p.termsAcceptedAt, getLang(), city(p.cityId)?.timezone) })}${p.termsSha ? `<br>${t('admin.part.sha', { sha: p.termsSha.slice(0, 16) })}` : ''}</p>`
            : `<p class="hint" style="margin-top:8px">${t('admin.part.access.hint')}</p>
              ${p.activationCode ? `<p style="font-size:1.4rem;font-weight:700;letter-spacing:.04em;margin:6px 0">${esc(p.activationCode)}</p>
                <div class="row">
                  <a class="btn small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(tRaw('admin.part.access.text', { name: p.name, link: appLink('partner', ''), code: p.activationCode }))}">WhatsApp</a>
                  <button type="button" class="btn ghost small" data-code="${esc(p.id)}">${t('admin.part.code.new')}</button>
                </div>`
              : `<button type="button" class="btn small" data-code="${esc(p.id)}">${t('admin.part.code.create')}</button>`}`}
        </details>
        <details style="margin-top:8px"><summary>${t('admin.part.manager')}</summary>
          <p class="hint" style="margin-top:8px">${t('admin.part.manager.hint')}</p>
          ${p.managerToken ? `<input readonly value="${esc(appLink('partner', `p/${p.managerToken}`))}" style="margin-bottom:8px">
          <div class="row">
            <button type="button" class="btn small" data-copy="${esc(appLink('partner', `p/${p.managerToken}`))}">${t('report.share.copy')}</button>
            <a class="btn secondary small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(tRaw('admin.part.manager.text', { name: p.name, link: appLink('partner', `p/${p.managerToken}`) }))}">WhatsApp</a>
            <a class="btn ghost small" target="_blank" rel="noopener" href="${esc(appLink('partner', `p/${p.managerToken}`))}">${t('admin.part.open')}</a>
          </div>` : ''}
          <div class="row" style="margin-top:8px"><button type="button" class="btn ghost small" data-renewm="${esc(p.id)}">${t('admin.part.manager.renew')}</button></div>
        </details>
        <details style="margin-top:8px"><summary>${t('admin.part.qr')}</summary>
          <div class="qr">${qrSvg(appLink('partner', `p/${p.token}`))}</div>
          <div class="row">
            <button class="btn ghost small" data-renew="${esc(p.id)}">${t('admin.part.renew')}</button>
          </div>
        </details></li>`).join('')}</ul>
    </div>
    <form class="card" id="add-partner">
      <h2>${t('admin.part.add')}</h2>
      <div class="grid2">
        <div class="field"><label for="p-name">${t('admin.part.name')}</label><input id="p-name" name="name" required></div>
        <div class="field"><label for="p-type">${t('admin.part.type')}</label>
          <select id="p-type" name="type">${store.PARTNER_TYPES.map((k) => `<option value="${k}">${t(`ptype.${k}`)}</option>`).join('')}</select></div>
        <div class="field"><label for="p-tax">${t('admin.part.taxid')}</label><input id="p-tax" name="taxId" required inputmode="numeric" placeholder="00.000.000/0000-00"></div>
        <div class="field"><label for="p-area">${t('admin.part.area')}</label><input id="p-area" name="area"></div>
        <div class="field"><label for="p-city">${t('admin.part.city')}</label>
          <select id="p-city" name="cityId">${cityList.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="p-offer">${t('admin.part.offer')}</label><input id="p-offer" name="offer" placeholder="${t('admin.part.offer.ph')}"></div>
      </div>
      <button class="btn block">${t('admin.part.create')}</button>
    </form>`,
    mount(root, ctx) {
      mountActive(root, ctx);
      maskTaxId(root.querySelector('#p-tax'));
      root.querySelectorAll('.pdetails').forEach((form) => {
        form.onsubmit = async (e) => {
          e.preventDefault();
          const file = form.photo.files[0];
          try {
            const photo = file ? await photoToJpeg(file) : undefined;
            await store.setPartnerDetails(form.dataset.id, { photo, address: form.address.value.trim() });
            ctx.refresh(tRaw('admin.part.saved'));
          } catch { notify(tRaw('err.generic')); }
        };
      });
      root.querySelector('#add-partner').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (!validTaxId(f.taxId)) { notify(tRaw('admin.part.err.taxid')); return; }
        try {
          await store.addPartner({ name: f.name.trim(), type: f.type, area: f.area.trim(), cityId: f.cityId, offer: f.offer.trim(), taxId: onlyDigits(f.taxId) });
          ctx.refresh(tRaw('admin.part.created'));
        } catch { notify(tRaw('err.generic')); }
      };
      root.querySelector('#suspend-late').onclick = async () => {
        if (!confirm(tRaw('admin.part.late.confirm'))) return;
        try { const n = await store.suspendLatePartners(); ctx.refresh(tRaw('admin.part.late.done', { n })); } catch { notify(tRaw('err.generic')); }
      };
      root.querySelectorAll('[data-code]').forEach((b) => {
        b.onclick = async () => { try { await store.setActivationCode(b.dataset.code); ctx.refresh(); } catch { notify(tRaw('err.generic')); } };
      });
      root.querySelectorAll('[data-copy]').forEach((b) => {
        b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = tRaw('common.copied'); } catch { prompt('', b.dataset.copy); } };
      });
      root.querySelectorAll('[data-renewm]').forEach((b) => confirmTwice(b, tRaw('admin.part.manager.confirm'), async () => {
        await store.renewManagerToken(b.dataset.renewm);
        ctx.refresh(tRaw('admin.part.manager.renewed'));
      }, tRaw('err.generic')));
      root.querySelectorAll('[data-renew]').forEach((b) => confirmTwice(b, tRaw('admin.part.renew.confirm'), async () => {
        await store.renewPartnerToken(b.dataset.renew);
        ctx.refresh(tRaw('admin.part.renewed'));
      }, tRaw('err.generic')));
    },
  };
}

async function cities({ cityList }) {
  return {
    html: `<div class="card">
      <h2>${t('admin.city.title')}</h2>
      <p class="hint">${t('admin.city.hint')}</p>
      <div class="table-wrap"><table>
        <tr><th>${t('admin.city.name')}</th><th>${t('admin.city.currency')}</th><th>${t('admin.city.tz')}</th><th>${t('admin.city.methods')}</th><th>${t('admin.city.license')}</th><th>${t('admin.city.code')}</th></tr>
        ${cityList.map((c) => `<tr><td>${esc(c.name)} (${esc(c.country)})</td><td>${esc(c.currency)}</td><td>${esc(c.timezone)}</td><td>${c.methods.map((m) => t(`method.${m}`)).join(', ')}</td><td>${esc(c.licenseLabel)}</td><td><b>${esc(c.code || '—')}</b></td></tr>`).join('')}
      </table></div>
      ${cityList.map((c) => `<form class="citycode row" data-city="${esc(c.id)}" style="margin-top:12px;align-items:flex-end">
        <div class="field" style="flex:1;margin:0"><label>${t('admin.city.code')} · ${esc(c.name)}</label><input name="code" value="${esc(c.code)}" maxlength="3" placeholder="RIO" style="text-transform:uppercase"></div>
        <button class="btn small">${t('common.save')}</button></form>`).join('')}
      ${cityList.map((c) => `<form class="payto row" data-city="${esc(c.id)}" style="margin-top:12px;align-items:flex-end">
        <div class="field" style="flex:1;margin:0"><label>${t('admin.city.payto')} · ${esc(c.name)}</label><input name="payTo" value="${esc(c.payTo)}"></div>
        <button class="btn small">${t('common.save')}</button></form>`).join('')}
    </div>
    <form class="card" id="add-city">
      <h2>${t('admin.city.add')}</h2>
      <div class="grid2">
        <div class="field"><label for="c-name">${t('admin.city.name')}</label><input id="c-name" name="name" required placeholder="Lisboa"></div>
        <div class="field"><label for="c-country">${t('admin.city.country')}</label><input id="c-country" name="country" required maxlength="2" placeholder="PT"></div>
        <div class="field"><label for="c-currency">${t('admin.city.currency')}</label><input id="c-currency" name="currency" required maxlength="3" placeholder="EUR"></div>
        <div class="field"><label for="c-tz">${t('admin.city.tz')}</label><input id="c-tz" name="timezone" required placeholder="Europe/Lisbon"></div>
        <div class="field"><label for="c-license">${t('admin.city.license')}</label><input id="c-license" name="licenseLabel" required placeholder="RNAAT"></div>
        <div class="field"><label for="c-payto">${t('admin.city.payto')}</label><input id="c-payto" name="payTo" required placeholder="IBAN …"></div>
      </div>
      <div class="field"><label><input type="checkbox" name="pix" style="width:auto"> ${t('method.pix')}</label></div>
      <button class="btn block">${t('admin.city.create')}</button>
    </form>`,
    mount(root, ctx) {
      root.querySelectorAll('.citycode').forEach((f) => {
        f.onsubmit = async (e) => {
          e.preventDefault();
          try {
            const ok = await store.setCityCode(f.dataset.city, f.code.value);
            if (ok) ctx.refresh(tRaw('common.saved')); else notify(tRaw('admin.city.code.err'));
          } catch { notify(tRaw('err.generic')); }
        };
      });
      root.querySelectorAll('.payto').forEach((f) => {
        f.onsubmit = async (e) => {
          e.preventDefault();
          try { await store.setCityPayTo(f.dataset.city, f.payTo.value.trim()); ctx.refresh(tRaw('common.saved')); } catch { notify(tRaw('err.generic')); }
        };
      });
      root.querySelector('#add-city').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try { new Intl.DateTimeFormat('en', { timeZone: f.timezone }); } catch { notify(tRaw('admin.city.err.tz')); return; }
        try { new Intl.NumberFormat('en', { style: 'currency', currency: f.currency.toUpperCase() }); } catch { notify(tRaw('admin.city.err.currency')); return; }
        await store.addCity({
          name: f.name.trim(), country: f.country.trim().toUpperCase(), currency: f.currency.trim().toUpperCase(),
          timezone: f.timezone.trim(), licenseLabel: f.licenseLabel.trim(), payTo: f.payTo.trim(),
          methods: f.pix ? ['pix', 'transfer'] : ['transfer'],
        });
        ctx.refresh(tRaw('admin.city.created'));
      };
    },
  };
}
