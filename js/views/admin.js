// Administration (français, passable en portugais) : validations, paiements, reversements, partenaires, villes.
// Accès réservé au compte qui a le rôle « admin » dans la base (le tout premier créé ici).
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, cents, parseCents, fmtMoment, qrSvg, appLink, notify, confirmTwice, validTaxId, fmtTaxId, onlyDigits } from '../util.js';
import * as store from '../store.js';
import { forgotLink, mountForgot, resetView, statusBadge } from './shared.js';
import { maskTaxId, photoToJpeg } from '../util.js';

const TABS = ['dashboard', 'validations', 'payments', 'payouts', 'transactions', 'partners', 'cities', 'journal'];

export async function adminView([tab = 'dashboard']) {
  const me = await store.currentAdmin();
  if (me && store.inRecovery()) return resetView();
  if (!me) return loginView();
  if (!me.isAdmin) {
    return {
      html: `<div class="notice bad">${t('admin.notadmin', { email: me.email })}</div>
        <button class="btn ghost" id="logout">${t('common.logout')}</button>`,
      mount: mountLogout,
    };
  }
  if (!TABS.includes(tab)) tab = 'dashboard';
  const nav = `<nav class="tabs">${TABS.map((k) => `<a href="#/${k}" class="${k === tab ? 'on' : ''}">${t(`admin.tab.${k}`)}</a>`).join('')}</nav>`;
  const data = await loadAll();
  const view = await ({ dashboard, validations, payments, payouts, transactions, partners, cities, journal })[tab](data);
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
  const [cityList, guides, partnerList, visits, payoutList, paymentList] = await Promise.all([
    store.listCities(), store.listGuides(), store.listPartners(), store.listVisits(), store.listPayouts(), store.listPayments(),
  ]);
  const city = (id) => cityList.find((c) => c.id === id);
  const guide = (id) => guides.find((g) => g.id === id);
  const partner = (id) => partnerList.find((p) => p.id === id);
  const cur = (n, cityId) => cents(n, city(cityId)?.currency || 'BRL', getLang());
  return { cityList, guides, partnerList, visits, payoutList, paymentList, city, guide, partner, cur };
}

const sumOf = (list, key) => list.reduce((s, v) => s + (v[key] || 0), 0);
const IN = (v, ...st) => st.includes(v.status);

async function dashboard({ guides, partnerList, visits, cur, cityList }) {
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
        <div class="stat"><b>${cur(sumOf(cashed, 'kombrioCents'), cityId)}</b><span>${t('admin.stat.platform')}</span></div>
        <div class="stat"><b>${cur(sumOf(live.filter((v) => IN(v, 'received')), 'guideCents'), cityId)}</b><span>${t('admin.stat.topay')}</span></div>
        <div class="stat"><b>${cur(sumOf(live.filter((v) => IN(v, 'paid')), 'guideCents'), cityId)}</b><span>${t('admin.stat.guidepaid')}</span></div>
      </div>
      <div class="card">
        <p>${t('admin.stat.people', { guides: plural('admin.stat.guides', guides.filter((g) => g.status === 'validated').length), pending: guides.filter((g) => g.status === 'pending').length, partners: plural('admin.stat.partners', partnerList.length) })}</p>
      </div>`,
  };
}

async function validations({ guides, city }) {
  const pending = guides.filter((g) => g.status === 'pending');
  return {
    html: `<div class="card">
      <h2>${t('admin.val.title')}</h2>
      ${pending.length ? `<ul class="list">${pending.map((g) => `<li>
        <div class="spread"><b>${esc(g.name)}</b><span class="hint">${esc(city(g.cityId)?.name || '')}</span></div>
        <div class="hint">${esc(g.email || '')} · ${esc(g.phone || '')} · ${esc(city(g.cityId)?.licenseLabel || '')} ${esc(g.license || '')}</div>
        <div class="hint">${t('admin.val.cpf')} ${g.cpf ? esc(fmtTaxId(g.cpf)) : `<b>${t('admin.missing')}</b>`} · ${t('admin.val.pix')} ${g.pixKey ? esc(g.pixKey) : `<b>${t('admin.missing')}</b>`}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn small" data-ok="${esc(g.id)}">${t('admin.val.accept')}</button>
          <button class="btn ghost small" data-no="${esc(g.id)}">${t('admin.val.refuse')}</button>
        </div></li>`).join('')}</ul>` : `<p class="hint">${t('admin.val.none')}</p>`}
      <p class="hint">${t('admin.val.hint')}</p>
    </div>`,
    mount(root, ctx) {
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
async function payouts({ guides, visits, payoutList, cur, guide }) {
  const lang = getLang();
  const due = guides.map((g) => {
    const items = visits.filter((v) => v.guideId === g.id && v.status === 'received');
    return { g, items, total: sumOf(items, 'guideCents') };
  }).filter((x) => x.items.length);
  const running = payoutList.filter((p) => p.status === 'in_progress');
  const paid = payoutList.filter((p) => p.status === 'paid');
  return {
    html: `<div class="card">
      <h2>${t('admin.out.title')}</h2>
      <p class="hint">${t('admin.out.hint2')}</p>
      ${due.length ? `<ul class="list">${due.map(({ g, items, total }) => `<li>
        <div class="spread"><b>${esc(g.name)}</b><b>${cur(total, g.cityId)}</b></div>
        <div class="hint">${t('admin.out.line', { n: items.length, pix: g.pixKey || tRaw('admin.missing'), cpf: g.cpf ? fmtTaxId(g.cpf) : tRaw('admin.missing') })}</div>
        <div class="hint">${items.map((v) => esc(store.txNum(v.num))).join(' · ')}</div>
        <button class="btn small" style="margin-top:8px" data-start="${esc(g.id)}">${t('admin.out.start')}</button>
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
        ${paid.map((p) => `<tr><td>${p.num}</td><td>${fmtMoment(p.paidAt || p.at, lang)}</td><td>${esc(guide(p.guideId)?.name)}</td><td>${cur(p.cents, guide(p.guideId)?.cityId)}</td><td>${esc(p.reference || '')}</td></tr>`).join('')}
      </table></div>` : `<p class="hint">${t('admin.out.history.none')}</p>`}
    </div>`,
    mount(root, ctx) {
      root.querySelectorAll('[data-start]').forEach((b) => confirmTwice(b, tRaw('admin.out.start.confirm'), async () => {
        await store.startPayout(b.dataset.start);
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

// Toutes les transactions : déclaré / encaissé / parts, corrections tracées (motif obligatoire).
async function transactions({ visits, guide, partner, cur, city }) {
  const lang = getLang();
  const rows = visits.slice(0, 300);
  const actions = (v) => {
    const a = [];
    if (IN(v, 'zero', 'declared')) a.push('correct');
    if (!IN(v, 'paid', 'cancelled', 'disputed')) a.push('dispute');
    if (IN(v, 'disputed')) a.push('resolve');
    if (IN(v, 'visited', 'zero', 'declared') || (IN(v, 'disputed') && ['visited', 'zero', 'declared'].includes(v.prevStatus || 'visited'))) a.push('cancel');
    return a;
  };
  return {
    html: `<div class="card">
      <h2>${t('admin.tx.title')}</h2>
      <p class="hint">${t('admin.tx.hint')}</p>
      ${rows.length ? `<div class="table-wrap"><table>
        <tr><th>ID</th><th>${t('common.date')}</th><th>${t('admin.part.title')}</th><th>${t('common.guide')}</th><th>${t('admin.tx.people')}</th><th>${t('admin.tx.declared')}</th><th>${t('admin.tx.received')}</th><th>Kombrio</th><th>${t('common.guide')}</th><th>${t('admin.col.status')}</th></tr>
        ${rows.map((v) => {
          const p = partner(v.partnerId);
          const c = (n) => (n == null ? '—' : cur(n, p?.cityId));
          const acts = actions(v);
          return `<tr><td style="white-space:nowrap">${esc(store.txNum(v.num))}</td><td style="white-space:nowrap">${fmtMoment(v.at, lang, city(p?.cityId)?.timezone)}</td>
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
    </div>`,
    mount(root, ctx) {
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
async function journal({ visits, paymentList, payoutList }) {
  const lang = getLang();
  const rows = await store.listLedger(300);
  const ref = (r) => {
    if (r.visit_id) return store.txNum(visits.find((v) => v.id === r.visit_id)?.num) || '';
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
        ${rows.map((r) => `<tr><td style="white-space:nowrap">${fmtMoment(r.at, lang)}</td><td>${esc(r.actor_kind)}</td><td>${esc(tRaw(`log.${r.event}`))}</td><td>${esc(ref(r))}</td><td class="hint">${detail(r.data)}</td></tr>`).join('')}
      </table></div>` : `<p class="hint">${t('admin.log.none')}</p>`}
    </div>`,
  };
}

async function partners({ partnerList, cityList, city }) {
  return {
    html: `<div class="card">
      <h2>${t('admin.part.title')}</h2>
      <ul class="list">${partnerList.map((p) => `<li>
        <div class="spread"><b>${esc(p.name)}</b><span class="hint">${t(`ptype.${p.type}`)} · ${esc(p.area || '')} · ${esc(city(p.cityId)?.name || '')}</span></div>
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
            ? `<p class="hint" style="margin-top:8px">${t('admin.part.activated', { name: p.managerName, email: p.managerEmail, phone: p.managerPhone, terms: p.termsVersion, date: fmtMoment(p.termsAcceptedAt, getLang(), city(p.cityId)?.timezone) })}</p>`
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
        <tr><th>${t('admin.city.name')}</th><th>${t('admin.city.currency')}</th><th>${t('admin.city.tz')}</th><th>${t('admin.city.methods')}</th><th>${t('admin.city.license')}</th></tr>
        ${cityList.map((c) => `<tr><td>${esc(c.name)} (${esc(c.country)})</td><td>${esc(c.currency)}</td><td>${esc(c.timezone)}</td><td>${c.methods.map((m) => t(`method.${m}`)).join(', ')}</td><td>${esc(c.licenseLabel)}</td></tr>`).join('')}
      </table></div>
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
