// Administration (français, passable en portugais) : validations, paiements, reversements, partenaires, villes.
// Accès réservé au compte qui a le rôle « admin » dans la base (le tout premier créé ici).
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, fmtMoment, qrSvg, appLink, notify, confirmTwice, validTaxId, fmtTaxId, onlyDigits } from '../util.js';
import * as store from '../store.js';
import { forgotLink, mountForgot, resetView } from './shared.js';
import { maskTaxId } from '../util.js';

const TABS = ['dashboard', 'validations', 'payments', 'payouts', 'partners', 'cities'];

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
  const view = await ({ dashboard, validations, payments, payouts, partners, cities })[tab](data);
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
  const [cityList, guides, partnerList, visits, payoutList] = await Promise.all([
    store.listCities(), store.listGuides(), store.listPartners(), store.listVisits(), store.listPayouts(),
  ]);
  const city = (id) => cityList.find((c) => c.id === id);
  const guide = (id) => guides.find((g) => g.id === id);
  const partner = (id) => partnerList.find((p) => p.id === id);
  const cur = (n, cityId) => money(n, city(cityId)?.currency || 'BRL', getLang());
  return { cityList, guides, partnerList, visits, payoutList, city, guide, partner, cur };
}

async function dashboard({ guides, partnerList, visits, cur, cityList }) {
  const cityId = cityList[0]?.id;
  const sum = (status) => visits.filter((v) => status.includes(v.status)).reduce((s, v) => s + (v.amount || 0), 0);
  const received = sum(['received', 'paid']);
  return {
    html: `
      <div class="stats">
        <div class="stat"><b>${visits.length}</b><span>${t('admin.stat.visits')}</span></div>
        <div class="stat"><b>${visits.filter((v) => v.status === 'visited').length}</b><span>${t('admin.stat.todeclare')}</span></div>
        <div class="stat"><b>${visits.filter((v) => v.status === 'declared').length}</b><span>${t('admin.stat.tocheck')}</span></div>
      </div>
      <div class="stats">
        <div class="stat"><b>${cur(received, cityId)}</b><span>${t('admin.stat.received')}</span></div>
        <div class="stat"><b>${cur(store.platformShare(received), cityId)}</b><span>${t('admin.stat.platform')}</span></div>
        <div class="stat"><b>${cur(store.guideShare(sum(['received'])), cityId)}</b><span>${t('admin.stat.topay')}</span></div>
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

function receiptCell(v) {
  if (!v.receipt) return `<span class="hint">${t('admin.pay.noreceipt')}</span>`;
  if (v.receipt.type?.startsWith('image/')) return `<a href="#" data-receipt="${esc(v.id)}" class="receipt"><img src="${v.receipt.data}" alt="${esc(v.receipt.name)}"></a>`;
  return `<a href="#" data-receipt="${esc(v.id)}">${esc(v.receipt.name)}</a>`;
}

async function payments({ visits, guide, partner, cur, city }) {
  const lang = getLang();
  const list = visits.filter((v) => v.status === 'declared');
  return {
    html: `<div class="card">
      <h2>${t('admin.pay.title')}</h2>
      <p class="hint">${t('admin.pay.hint')}</p>
      ${list.length ? `<ul class="list">${list.map((v) => {
        const p = partner(v.partnerId);
        return `<li>
        <div class="spread"><b>${esc(p?.name)} → ${cur(v.amount, p?.cityId)}</b><span class="badge">${t(`method.${v.method}`)}</span></div>
        <div class="hint">${t('admin.pay.line', { guide: guide(v.guideId)?.name, date: fmtMoment(v.declaredAt, lang, city(p?.cityId)?.timezone) })}</div>
        <div style="margin:8px 0">${receiptCell(v)}</div>
        <div class="row">
          <button class="btn small" data-ok="${esc(v.id)}">${t('admin.pay.confirm')}</button>
          <button class="btn ghost small" data-no="${esc(v.id)}">${t('admin.pay.reject')}</button>
        </div></li>`;
      }).join('')}</ul>` : `<p class="hint">${t('admin.pay.none')}</p>`}
    </div>`,
    mount(root, ctx) {
      root.querySelectorAll('[data-ok]').forEach((b) => { b.onclick = async () => { await store.confirmVisit(b.dataset.ok); ctx.refresh(tRaw('admin.pay.confirmed')); }; });
      root.querySelectorAll('[data-no]').forEach((b) => { b.onclick = async () => { await store.rejectVisit(b.dataset.no); ctx.refresh(tRaw('admin.pay.rejected')); }; });
      root.querySelectorAll('[data-receipt]').forEach((a) => {
        a.onclick = async (e) => {
          e.preventDefault();
          const v = list.find((x) => x.id === a.dataset.receipt);
          const blob = await (await fetch(v.receipt.data)).blob();
          window.open(URL.createObjectURL(blob), '_blank');
        };
      });
    },
  };
}

async function payouts({ guides, visits, payoutList, cur, guide }) {
  const lang = getLang();
  const due = guides.map((g) => {
    const items = visits.filter((v) => v.guideId === g.id && v.status === 'received');
    return { g, items, total: items.reduce((s, v) => s + store.guideShare(v.amount), 0) };
  }).filter((x) => x.items.length);
  return {
    html: `<div class="card">
      <h2>${t('admin.out.title')}</h2>
      <p class="hint">${t('admin.out.hint')}</p>
      ${due.length ? `<ul class="list">${due.map(({ g, items, total }) => `<li>
        <div class="spread"><b>${esc(g.name)}</b><b>${cur(total, g.cityId)}</b></div>
        <div class="hint">${t('admin.out.line', { n: items.length, pix: g.pixKey || tRaw('admin.missing'), cpf: g.cpf ? fmtTaxId(g.cpf) : tRaw('admin.missing') })}</div>
        <button class="btn small" style="margin-top:8px" data-pay="${esc(g.id)}">${t('admin.out.pay')}</button>
      </li>`).join('')}</ul>` : `<p class="hint">${t('admin.out.none')}</p>`}
    </div>
    <div class="card">
      <h2>${t('admin.out.history')}</h2>
      ${payoutList.length ? `<div class="table-wrap"><table>
        <tr><th>${t('common.date')}</th><th>${t('common.guide')}</th><th>${t('common.amount')}</th></tr>
        ${payoutList.map((p) => `<tr><td>${fmtMoment(p.at, lang)}</td><td>${esc(guide(p.guideId)?.name)}</td><td>${cur(p.amount, guide(p.guideId)?.cityId)}</td></tr>`).join('')}
      </table></div>` : `<p class="hint">${t('admin.out.history.none')}</p>`}
    </div>`,
    mount(root, ctx) {
      root.querySelectorAll('[data-pay]').forEach((b) => confirmTwice(b, tRaw('admin.out.confirm'), async () => {
        await store.payGuide(b.dataset.pay);
        ctx.refresh(tRaw('admin.out.done'));
      }, tRaw('err.generic')));
    },
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
        <details style="margin-top:8px"><summary>${t('admin.part.qr')}</summary>
          <div class="qr">${qrSvg(appLink('partner', `p/${p.token}`))}</div>
          <div class="row">
            <a class="btn ghost small" target="_blank" rel="noopener" href="${esc(appLink('partner', `p/${p.token}`))}">${t('admin.part.open')}</a>
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
      root.querySelector('#add-partner').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (!validTaxId(f.taxId)) { notify(tRaw('admin.part.err.taxid')); return; }
        try {
          await store.addPartner({ name: f.name.trim(), type: f.type, area: f.area.trim(), cityId: f.cityId, offer: f.offer.trim(), taxId: onlyDigits(f.taxId) });
          ctx.refresh(tRaw('admin.part.created'));
        } catch { notify(tRaw('err.generic')); }
      };
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
