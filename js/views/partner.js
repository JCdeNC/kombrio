// App Partenaire : son QR Partenaire enregistre le passage, puis il déclare et paie la commission.
// Sans passage en attente, le même QR ouvre son espace (historique, offre, QR à imprimer).
// Pas de compte : tout passe par le code secret du QR Partenaire, vérifié par la base.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, cents, parseCents, fmtMoment, fmtDay, qrSvg, appLink, readFileAsDataUrl, notify, pixPayload, pixKeyOf, photoToJpeg, confirmTwice, fmtTaxId, locale } from '../util.js';
import * as store from '../store.js';
import { statusBadge, notFound, forgotLink, mountForgot, resetView } from './shared.js';
import { readPendingStay, clearPendingStay } from './scan.js';

const MAX_RECEIPT = 1.5 * 1024 * 1024;
export const TERMS_VERSION = 'v1 · 30/10/2026';
const ME_KEY = 'kombrio-partner';

// L'app ouverte sans lien (icône sur l'écran d'accueil) : on rouvre l'espace du partenaire de ce téléphone.
// Lien unique https://app.kombrio.com.br/partner/ : le gérant se connecte (ou fait son premier accès) ;
// un téléphone de caisse déjà relié rouvre directement la caisse.
export async function partnerHome(params, ctx) {
  if (store.inRecovery() && await store.hasSession()) return resetView();
  let mine = null;
  try { mine = await store.myPartnerToken(); } catch { /* rien */ }
  if (mine) return { html: '', mount: () => ctx.replace(`p/${mine}`) };
  let me = null;
  try { me = localStorage.getItem(ME_KEY); } catch { /* rien */ }
  if (me) return { html: '', mount: () => ctx.replace(`p/${me}`) };
  return {
    html: `
      <h1>${t('pm.title')}</h1>
      <form class="card" id="login">
        <h2>${t('auth.login')}</h2>
        <div class="field"><label for="m-email">${t('auth.email')}</label><input id="m-email" name="email" type="email" required autocomplete="email"></div>
        <div class="field"><label for="m-pass">${t('auth.password')}</label><input id="m-pass" name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn block">${t('auth.login')}</button>
        ${forgotLink()}
      </form>
      <div class="card">
        <h2>${t('pm.first')}</h2>
        <p class="hint">${t('pm.first.hint')}</p>
        <a class="btn secondary block" href="#/ativar">${t('pm.first.button')}</a>
      </div>
      <p class="hint">${t('partner.home')}</p>`,
    mount(root, c) {
      mountForgot(root.querySelector('#login'));
      root.querySelector('#login').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try { await store.signIn(f.email.trim(), f.password); c.refresh(); } catch { notify(tRaw('auth.err.login')); }
      };
    },
  };
}

// Premier accès : code d'activation, responsable, e-mail, mot de passe, conditions générales.
export async function activateView([code = ''], ctx) {
  return {
    html: `
      <p><a href="#/">← ${t('pm.title')}</a></p>
      <form class="card" id="activate">
        <h1>${t('pm.first')}</h1>
        <p class="hint">${t('pm.activate.hint')}</p>
        <div class="field"><label for="a-code">${t('pm.code')}</label><input id="a-code" name="code" required value="${esc(code)}" placeholder="KBR-12345" autocapitalize="characters" style="text-transform:uppercase"></div>
        <div class="grid2">
          <div class="field"><label for="a-name">${t('pm.name')}</label><input id="a-name" name="name" required autocomplete="name"></div>
          <div class="field"><label for="a-phone">${t('guide.signup.phone')}</label><input id="a-phone" name="phone" type="tel" required autocomplete="tel"></div>
        </div>
        <div class="field"><label for="a-email">${t('auth.email')}</label><input id="a-email" name="email" type="email" required autocomplete="email"></div>
        <div class="grid2">
          <div class="field"><label for="a-pass">${t('auth.password.new')}</label><input id="a-pass" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
          <div class="field"><label for="a-pass2">${t('auth.password.confirm')}</label><input id="a-pass2" name="password2" type="password" required minlength="8" autocomplete="new-password"></div>
        </div>
        <label style="font-weight:400;display:flex;gap:10px;align-items:flex-start;margin:4px 0 14px">
          <input type="checkbox" name="terms" required style="width:auto;margin-top:4px">
          <span>${t('pm.terms.accept')} <a href="#/termos" target="_blank" rel="noopener">${t('pm.terms.link')}</a> (${esc(TERMS_VERSION)}).</span>
        </label>
        <button class="btn block">${t('pm.activate.submit')}</button>
      </form>`,
    mount(root) {
      root.querySelector('#activate').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (f.password !== f.password2) { notify(tRaw('auth.err.mismatch')); return; }
        const button = e.target.querySelector('button');
        button.disabled = true;
        try {
          const ready = await store.signUpPartner({
            email: f.email.trim(), password: f.password, code: f.code, name: f.name.trim(), phone: f.phone.trim(), terms: TERMS_VERSION,
          });
          ctx.go('', tRaw(ready ? 'pm.activate.done' : 'pm.activate.confirm'));
        } catch (err) {
          button.disabled = false;
          notify(tRaw(err.message === 'exists' ? 'auth.err.exists' : 'pm.activate.err'));
        }
      };
    },
  };
}

export async function partnerView([token, action, visitId], ctx) {
  let space = token && await store.partnerSpace(token);
  if (!space) {
    try { if (localStorage.getItem(ME_KEY) === token) localStorage.removeItem(ME_KEY); } catch { /* rien */ }
    return notFound('err.partner');
  }
  try { localStorage.setItem(ME_KEY, token); } catch { /* rien */ }
  space.key = token;
  space.loggedIn = space.role === 'manager' && await store.hasSession();

  if (!action) {
    const pending = readPendingStay();
    if (pending) {
      clearPendingStay();
      const res = await store.recordVisit(pending, token);
      if (res.ok) {
        // On change d'adresse pour qu'un rechargement n'enregistre pas un second passage.
        return { html: '', mount: () => ctx.replace(`p/${token}/${res.duplicate ? 'deja' : 'passage'}/${res.visitId}`) };
      }
      const view = spaceView(space);
      return { ...view, html: `<div class="notice bad">${t(`visit.err.${res.reason}`)}</div>${view.html}` };
    }
    return spaceView(space);
  }

  // La caisse n'a accès qu'aux passages qu'elle vient d'enregistrer.
  if (space.role !== 'manager' && action !== 'passage' && action !== 'deja') return spaceView(space);
  if (action === 'declarar') return declareManyView(space);
  if (action === 'pagar') return payView(space);
  if (action === 'relatorio') return reportPage(space, visitId);
  const visit = space.visits.find((v) => v.id === visitId);
  if (!visit) return notFound();
  return scannedView(space, visit, action);
}

// Après le scan (caisse ou gérant) : passage enregistré, offre à accorder, nombre de personnes réellement accueillies.
function scannedView({ partner, city, key, role }, visit, action) {
  const lang = getLang();
  const fresh = action === 'passage';
  let offer = '';
  if (partner.offer && fresh) {
    offer = visit.offerGiven
      ? `<div class="notice ok"><b>${t('partner.offer.give')}</b><div class="offer">${esc(partner.offer)}</div></div>`
      : `<div class="notice warn">${t('partner.offer.already')}</div>`;
  }
  return {
    html: `
      <div class="notice ${fresh ? 'ok' : 'warn'}"><b>${t(fresh ? 'partner.visit.saved' : 'partner.visit.duplicate')}</b></div>
      ${offer}
      <div class="card">
        <div class="spread"><h2>${esc(visit.client)}</h2><span class="hint">${esc(store.txNum(visit.num))}</span></div>
        <p class="hint">${t('partner.visit.guide', { guide: visit.guideName })} · ${fmtMoment(visit.at, lang, city.timezone)}</p>
        ${visit.status === 'visited' ? `<form id="people" class="row" style="align-items:flex-end;margin-top:8px">
            <div class="field" style="margin:0;flex:1"><label for="p-n">${t('partner.people.served')}</label>
              <input id="p-n" name="n" type="number" min="1" max="500" step="1" inputmode="numeric" value="${visit.peopleServed}"></div>
            <button class="btn secondary">${t('common.save')}</button></form>`
          : `<p>${t('scan.people', { n: visit.peopleServed })}</p>`}
      </div>
      <a class="btn ghost" href="#/p/${encodeURIComponent(key)}">${t(role === 'manager' ? 'partner.space' : 'counter.back')}</a>`,
    mount(root, ctx) {
      const f = root.querySelector('#people');
      if (f) {
        f.onsubmit = async (e) => {
          e.preventDefault();
          const n = Number(f.n.value);
          if (!Number.isInteger(n) || n < 1 || n > 500) { notify(tRaw('partner.people.err')); return; }
          const ok = await store.setPeopleServed(key, visit.id, n).catch(() => false);
          if (ok) ctx.refresh(tRaw('common.saved')); else notify(tRaw('err.generic'));
        };
      }
    },
  };
}

// Une ligne de transaction dans l'espace du gérant (jamais le partage interne).
function txLine(v, city, lang) {
  const c = (n) => cents(n, city.currency, lang);
  return `<li>
    <div class="spread"><b>${esc(v.client || '?')}</b>${statusBadge(v, 'partner')}</div>
    <div class="hint">${esc(store.txNum(v.num))} · ${fmtMoment(v.at, lang, city.timezone)} · ${t('scan.people', { n: v.peopleServed })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</div>
    ${v.declaredCents != null ? `<div>${t('partner.visit.declared', { amount: c(v.declaredCents) })}</div>` : ''}
    ${v.statusNote && ['disputed', 'cancelled'].includes(v.status) ? `<div class="hint">${esc(v.statusNote)}</div>` : ''}
  </li>`;
}

function spaceView({ partner, city, visits, payments, key, role, loggedIn }) {
  if (role !== 'manager') return counterView({ partner, city, visits, key });
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const toDeclare = visits.filter((v) => v.status === 'visited').length;
  const toPay = visits.filter((v) => v.status === 'declared');
  const toPayCents = toPay.reduce((s, v) => s + v.declaredCents, 0);

  return {
    html: `
      <div class="spread"><h1>${esc(partner.name)}</h1>${loggedIn ? `<button class="btn ghost small no-print" id="logout">${t('common.logout')}</button>` : ''}</div>
      <p class="hint">${partner.managerName ? t('pm.hello', { name: partner.managerName }) : t('manager.badge')}</p>
      ${toDeclare ? `<div class="notice">${t('partner.nodeclared', { n: toDeclare })}
        <a class="btn block" style="margin-top:10px" href="#/p/${encodeURIComponent(key)}/declarar">${t('partner.declare.open')}</a></div>` : ''}
      ${toPay.length ? `<div class="notice warn">${t('partner.topay', { n: toPay.length, amount: c(toPayCents) })}
        <a class="btn block" style="margin-top:10px" href="#/p/${encodeURIComponent(key)}/pagar">${t('partner.pay.button')}</a></div>` : ''}
      <div class="card">
        <h2>${t('partner.visits')}</h2>
        ${visits.length ? `<ul class="list">${visits.map((v) => txLine(v, city, lang)).join('')}</ul>` : `<p class="hint">${t('partner.visits.none')}</p>`}
      </div>
      ${payments.length ? `<div class="card"><h2>${t('partner.payments')}</h2><ul class="list">${payments.map((y) => `<li>
          <div class="spread"><b>${t('partner.payment.line', { num: y.num, amount: c(y.cents) })}</b><span class="badge ${y.status === 'verified' ? 'ok' : y.status === 'rejected' ? 'bad' : 'warn'}">${t(`payment.${y.status}`)}</span></div>
          <div class="hint">${fmtMoment(y.submittedAt, lang, city.timezone)}${y.note ? ` · ${esc(y.note)}` : ''}</div></li>`).join('')}</ul></div>` : ''}
      <div class="card no-print">
        <h2>${t('report.card')}</h2>
        <p class="hint">${t('report.card.hint')}</p>
        <a class="btn secondary" href="#/p/${encodeURIComponent(key)}/relatorio">${t('report.open')}</a>
      </div>
      <form class="card" id="offer">
        <h2>${t('partner.offer.title')}</h2>
        <p class="hint">${t('partner.offer.hint')}</p>
        <div class="field"><input name="offer" value="${esc(partner.offer || '')}" maxlength="120" placeholder="${t('partner.offer.none')}"></div>
        <button class="btn secondary">${t('common.save')}</button>
      </form>
      <div class="card" style="text-align:center">
        <h2>${t('partner.qr.title')}</h2>
        <p class="hint">${t('partner.qr.hint')}</p>
        <div class="qr">${qrSvg(appLink('partner', `p/${partner.token}`))}</div>
        <button class="btn ghost no-print" id="print">${t('partner.qr.print')}</button>
      </div>
      <p class="hint no-print">${t('partner.linked', { name: partner.name })} <a href="#" id="unlink">${t('partner.unlink')}</a></p>`,
    mount(root, ctx) {
      root.querySelector('#offer').onsubmit = async (e) => {
        e.preventDefault();
        await store.setPartnerOffer(key, new FormData(e.target).get('offer'));
        ctx.refresh(tRaw('common.saved'));
      };
      root.querySelector('#print').onclick = () => window.print();
      const out = root.querySelector('#logout');
      if (out) out.onclick = async () => { await store.signOut(); try { localStorage.removeItem(ME_KEY); } catch { /* rien */ } location.hash = ''; };
      root.querySelector('#unlink').onclick = (e) => {
        e.preventDefault();
        try { localStorage.removeItem(ME_KEY); } catch { /* rien */ }
        location.hash = '';
        notify(tRaw('partner.unlinked'));
      };
    },
  };
}

// Étape 1 : déclarer librement la commission de chaque passage (0 = aucune commission).
function declareManyView({ city, visits, key }) {
  const lang = getLang();
  const todo = visits.filter((v) => v.status === 'visited');
  const back = `#/p/${encodeURIComponent(key)}`;
  if (!todo.length) return { html: `<div class="notice">${t('partner.declare.nothing')}</div><a class="btn ghost" href="${back}">${t('partner.space')}</a>` };
  return {
    html: `
      <p><a href="${back}">← ${t('partner.space')}</a></p>
      <form class="card" id="declare">
        <h1>${t('partner.declare.title')}</h1>
        <p class="hint">${t('partner.declare.free')}</p>
        <ul class="list">${todo.map((v) => `<li>
          <div class="spread" style="align-items:center">
            <span><b>${esc(v.client || '?')}</b><br><span class="hint">${esc(store.txNum(v.num))} · ${fmtDay(v.at.slice(0, 10), lang)} · ${t('scan.people', { n: v.peopleServed })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</span></span>
            <span class="row" style="gap:6px;align-items:center">
              <input name="a-${esc(v.id)}" inputmode="decimal" placeholder="${esc(city.currency)}" style="width:110px" aria-label="${t('partner.declare.amount', { currency: city.currency })}">
              <label style="font-weight:400;margin:0;white-space:nowrap"><input type="checkbox" name="z-${esc(v.id)}" style="width:auto"> ${t('partner.declare.zero')}</label>
            </span>
          </div></li>`).join('')}</ul>
        <p class="hint">${t('partner.declare.engage')}</p>
        <button class="btn block">${t('partner.declare.confirm')}</button>
      </form>`,
    mount(root, ctx) {
      const form = root.querySelector('#declare');
      form.onsubmit = async (e) => {
        e.preventDefault();
        const items = [];
        for (const v of todo) {
          const zero = form[`z-${v.id}`].checked;
          const raw = form[`a-${v.id}`].value;
          if (zero) { items.push({ visit: v.id, cents: 0 }); continue; }
          if (raw.trim() === '') continue;
          const cts = parseCents(raw);
          if (cts == null) { notify(tRaw('partner.declare.badamount', { num: store.txNum(v.num) })); return; }
          items.push({ visit: v.id, cents: cts });
        }
        if (!items.length) { notify(tRaw('partner.declare.none')); return; }
        const button = form.querySelector('button.block');
        button.disabled = true;
        try {
          const n = await store.declareCommissions(key, items);
          ctx.go(`p/${key}`, tRaw('partner.declare.saved', { n }));
        } catch {
          button.disabled = false;
          notify(tRaw('err.generic'));
        }
      };
    },
  };
}

// Étape 2 : payer les commissions déclarées (un Pix peut en couvrir plusieurs), avec le comprovante.
function payView({ partner, city, visits, key }) {
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const todo = visits.filter((v) => v.status === 'declared');
  const pixKey = pixKeyOf(city);
  const back = `#/p/${encodeURIComponent(key)}`;
  if (!todo.length) return { html: `<div class="notice">${t('partner.pay.nothing')}</div><a class="btn ghost" href="${back}">${t('partner.space')}</a>` };
  return {
    html: `
      <p><a href="${back}">← ${t('partner.space')}</a></p>
      <form class="card" id="pay">
        <h1>${t('partner.pay.title')}</h1>
        <p class="hint">${t('partner.pay.hint')}</p>
        <ul class="list">${todo.map((v) => `<li>
          <label class="spread" style="font-weight:400;align-items:center">
            <span><input type="checkbox" name="sel" value="${esc(v.id)}" checked style="width:auto;margin-right:8px"><b>${esc(v.client || '?')}</b>
              <span class="hint"> · ${esc(store.txNum(v.num))} · ${fmtDay(v.at.slice(0, 10), lang)}</span></span>
            <b>${c(v.declaredCents)}</b>
          </label></li>`).join('')}</ul>
        <div class="stat" style="margin:12px 0"><span>${t('partner.pay.total')}</span><b id="total">${c(0)}</b></div>
        ${pixKey ? `<div style="text-align:center">
            <div class="qr" id="pixqr"></div>
            <p class="hint">${t('partner.pay.pixhint')}</p>
            <button type="button" class="btn secondary" id="copypix">${t('partner.pay.copy')}</button>
          </div>`
          : `<div class="notice">${t('partner.declare.payto')}<br><b>${t('partner.declare.payto.pending')}</b></div>`}
        <div class="field" style="margin-top:12px"><label for="p-method">${t('partner.declare.method')}</label>
          <select id="p-method" name="method">${city.methods.map((m) => `<option value="${esc(m)}">${t(`method.${m}`)}</option>`).join('')}</select></div>
        <div class="field"><label for="p-ref">${t('partner.pay.ref')}</label>
          <input id="p-ref" name="pixref" maxlength="64" placeholder="E2E…" autocapitalize="characters"></div>
        <div class="field"><label for="p-receipt">${t('partner.declare.receipt')}</label>
          <input id="p-receipt" name="receipt" type="file" accept="image/*,application/pdf" required></div>
        <button class="btn block">${t('partner.pay.submit')}</button>
      </form>`,
    mount(root, ctx) {
      const form = root.querySelector('#pay');
      const chosen = () => todo.filter((v) => form.querySelector(`[value="${v.id}"]`).checked);
      let payload = '';
      const update = () => {
        const total = chosen().reduce((s, v) => s + v.declaredCents, 0);
        root.querySelector('#total').textContent = c(total);
        if (pixKey) {
          payload = pixPayload({ key: pixKey, amount: total / 100, txid: `KBR${partner.id.replace(/-/g, '').slice(0, 10)}` });
          root.querySelector('#pixqr').innerHTML = total > 0 ? qrSvg(payload) : '';
        }
      };
      form.oninput = update;
      update();
      const copy = root.querySelector('#copypix');
      if (copy) {
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(payload); copy.textContent = tRaw('partner.pay.copied'); } catch { prompt('', payload); }
        };
      }
      form.onsubmit = async (e) => {
        e.preventDefault();
        const list = chosen();
        if (!list.length) { notify(tRaw('partner.pay.none')); return; }
        const file = form.receipt.files[0];
        if (!file) return;
        const button = form.querySelector('button.block');
        button.disabled = true;
        try {
          let receipt;
          if (file.type.startsWith('image/')) receipt = { name: file.name, type: 'image/jpeg', data: await photoToJpeg(file, 1400, 0.78) };
          else {
            if (file.size > MAX_RECEIPT) { notify(tRaw('partner.declare.toobig')); button.disabled = false; return; }
            receipt = { name: file.name, type: file.type, data: await readFileAsDataUrl(file) };
          }
          const r = await store.submitPayment(key, { visitIds: list.map((v) => v.id), method: form.method.value, pixRef: form.pixref.value.trim(), receipt });
          if (!r.ok) { button.disabled = false; notify(tRaw(`partner.pay.err.${r.reason}`)); return; }
          ctx.go(`p/${key}`, tRaw('partner.pay.sent', { num: r.num }));
        } catch {
          button.disabled = false;
          notify(tRaw('err.generic'));
        }
      };
    },
  };
}

/* ---------- Relevé mensuel (partenaire et comptable) ---------- */
const monthOf = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date(iso));
const monthLabel = (m, lang) => new Intl.DateTimeFormat(locale(lang), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-15T12:00:00Z`));
const PAID = ['received', 'payout_pending', 'paid'];
const shortMoment = (iso, lang, tz) => new Intl.DateTimeFormat(locale(lang), { dateStyle: 'short', timeStyle: 'short', timeZone: tz }).format(new Date(iso));

function reportBlock({ partner, city, visits }, month, base) {
  const lang = getLang();
  const months = [...new Set([monthOf(new Date().toISOString(), city.timezone), ...visits.map((v) => monthOf(v.at, city.timezone))])].sort().reverse();
  const m = months.includes(month) ? month : months[0];
  const rows = visits.filter((v) => monthOf(v.at, city.timezone) === m).sort((a, b) => a.at.localeCompare(b.at));
  const cur = (n) => cents(n, city.currency, lang);
  const counted = rows.filter((v) => v.status !== 'cancelled');
  const declared = counted.filter((v) => v.declaredCents != null).reduce((s, v) => s + v.declaredCents, 0);
  const paid = counted.filter((v) => PAID.includes(v.status)).reduce((s, v) => s + v.declaredCents, 0);
  const todo = counted.filter((v) => v.status === 'visited').length;
  const pLabel = (v) => tRaw(`pstatus.${{ received: 'paid', payout_pending: 'paid' }[v.status] || v.status}`);
  const html = `
    <div class="card">
      <div class="spread">
        <div><h1 style="margin-bottom:2px">${t('report.title')}</h1>
          <div class="hint">${esc(partner.name)}${partner.taxId ? ` · ${t('report.taxid')} ${esc(fmtTaxId(partner.taxId))}` : ''}${partner.area ? ` · ${esc(partner.area)}` : ''}</div></div>
        <select id="month" class="no-print" style="width:auto">${months.map((x) => `<option value="${x}" ${x === m ? 'selected' : ''}>${esc(monthLabel(x, lang))}</option>`).join('')}</select>
      </div>
      <p class="print-only"><b>${esc(monthLabel(m, lang))}</b></p>
      <div class="stats" style="margin-top:12px">
        <div class="stat"><b>${counted.length}</b><span>${t('report.visits')}</span></div>
        <div class="stat"><b>${cur(declared)}</b><span>${t('report.declared')}</span></div>
        <div class="stat"><b>${cur(paid)}</b><span>${t('report.paid')}</span></div>
      </div>
      ${todo ? `<div class="notice">${t('partner.nodeclared', { n: todo })}</div>` : ''}
      ${rows.length ? `<div class="table-wrap"><table>
        <tr><th>${t('report.col.id')}</th><th>${t('report.col.date')}</th><th>${t('report.col.client')}</th><th>${t('report.col.guide')}</th><th>${t('report.col.people')}</th><th>${t('report.col.amount')}</th><th>${t('report.col.status')}</th></tr>
        ${rows.map((v) => `<tr><td style="white-space:nowrap">${esc(store.txNum(v.num))}</td><td style="white-space:nowrap">${shortMoment(v.at, lang, city.timezone)}</td><td>${esc(v.client || '')}</td><td>${esc(v.guideName || '')}</td><td>${v.peopleServed}</td>
          <td>${v.declaredCents != null ? cur(v.declaredCents) : '—'}</td><td>${statusBadge(v, 'partner')}</td></tr>`).join('')}
        <tr><td colspan="5"><b>${t('report.total')}</b></td><td><b>${cur(declared)}</b></td><td></td></tr>
      </table></div>` : `<p class="hint">${t('report.none')}</p>`}
      <div class="row no-print" style="margin-top:12px">
        <button type="button" class="btn secondary" id="csv">${t('report.excel')}</button>
        <button type="button" class="btn ghost" id="pdf">${t('report.print')}</button>
      </div>
      <p class="hint" style="margin-top:10px">kombrio · ${t('report.generated', { date: fmtDay(new Date().toISOString().slice(0, 10), lang) })}</p>
    </div>`;
  const mount = (root, ctx) => {
    root.querySelector('#month').onchange = (e) => ctx.go(`${base}/${e.target.value}`);
    root.querySelector('#pdf').onclick = () => window.print();
    root.querySelector('#csv').onclick = () => {
      const num = (n) => (n == null ? '' : (n / 100).toFixed(2).replace('.', ','));
      const cell = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
      const head = ['report.col.id', 'report.col.date', 'report.col.client', 'report.col.guide', 'report.col.people', 'report.col.amount', 'report.col.status'].map((k) => cell(tRaw(k)));
      const lines = rows.map((v) => [store.txNum(v.num), shortMoment(v.at, lang, city.timezone), v.client, v.guideName, v.peopleServed,
        num(v.declaredCents), pLabel(v)].map(cell));
      lines.push([cell(tRaw('report.total')), '', '', '', '', cell(num(declared)), '']);
      const csv = '﻿' + [head, ...lines].map((r) => r.join(';')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `kombrio-${partner.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${m}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
  };
  return { html, mount };
}

// Relevé vu par le partenaire, avec le lien à donner au comptable.
function reportPage(space, month) {
  const { partner, key } = space;
  const base = `p/${key}/relatorio`;
  const block = reportBlock(space, month, base);
  const link = partner.reportToken ? appLink('partner', `r/${partner.reportToken}`) : '';
  return {
    html: `
      <p class="no-print"><a href="#/p/${encodeURIComponent(key)}">← ${t('partner.space')}</a></p>
      ${block.html}
      <div class="card no-print">
        <h2>${t('report.share.title')}</h2>
        <p class="hint">${t('report.share.hint')}</p>
        ${link ? `<input readonly value="${esc(link)}" id="replink" style="margin-bottom:10px">
          <div class="row">
            <button type="button" class="btn" id="copylink">${t('report.share.copy')}</button>
            <a class="btn secondary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(tRaw('report.share.text', { name: partner.name, link }))}">WhatsApp</a>
            <a class="btn secondary" href="mailto:?subject=${encodeURIComponent(tRaw('report.share.subject', { name: partner.name }))}&body=${encodeURIComponent(tRaw('report.share.text', { name: partner.name, link }))}">E-mail</a>
            <button type="button" class="btn ghost" id="renew">${t('report.share.renew')}</button>
          </div>`
        : `<button type="button" class="btn" id="create">${t('report.share.create')}</button>`}
      </div>`,
    mount(root, ctx) {
      block.mount(root, ctx);
      const create = root.querySelector('#create');
      if (create) create.onclick = async () => { try { await store.renewReportToken(key); ctx.refresh(); } catch { notify(tRaw('err.generic')); } };
      const copy = root.querySelector('#copylink');
      if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(link); copy.textContent = tRaw('common.copied'); } catch { prompt('', link); } };
      const renew = root.querySelector('#renew');
      if (renew) confirmTwice(renew, tRaw('report.share.renew.confirm'), async () => { await store.renewReportToken(key); ctx.refresh(); }, tRaw('err.generic'));
    },
  };
}

// Relevé vu par le comptable : lecture seule, à partir de son lien.
export async function reportView([reportToken, month]) {
  const data = reportToken && await store.partnerReport(reportToken);
  if (!data) return notFound('err.report');
  const block = reportBlock(data, month, `r/${reportToken}`);
  return { html: `<p class="hint no-print">${t('report.readonly')}</p>${block.html}`, mount: block.mount };
}

// Espace de la caisse (QR posé sur la caisse) : relier le téléphone, voir les passages des dernières 24 h et l'offre.
function counterView({ partner, city, visits, key }) {
  const lang = getLang();
  return {
    html: `
      <h1>${esc(partner.name)}</h1>
      <div class="notice ok">${t('counter.ready')}</div>
      ${partner.offer ? `<div class="card"><h2>${t('counter.offer')}</h2><div class="offer">${esc(partner.offer)}</div><p class="hint" style="margin-top:8px">${t('counter.offer.hint')}</p></div>` : ''}
      <div class="card">
        <h2>${t('counter.today')}</h2>
        ${visits.length ? `<ul class="list">${visits.map((v) => `<li><div class="spread"><b>${esc(v.client || '?')}</b><span class="hint">${fmtMoment(v.at, lang, city.timezone)}</span></div>
          <div class="hint">${esc(store.txNum(v.num))} · ${t('scan.people', { n: v.peopleServed })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</div></li>`).join('')}</ul>`
          : `<p class="hint">${t('partner.visits.none')}</p>`}
      </div>
      <p class="hint">${t('counter.manager')}</p>
      <p class="hint">${t('partner.linked', { name: partner.name })} <a href="#" id="unlink">${t('partner.unlink')}</a></p>`,
    mount() {
      root().querySelector('#unlink').onclick = (e) => {
        e.preventDefault();
        try { localStorage.removeItem(ME_KEY); } catch { /* rien */ }
        location.hash = '';
        notify(tRaw('partner.unlinked'));
      };
    },
  };
}
const root = () => document.getElementById('app');

// Conditions générales du partenaire (brouillon v1, à faire relire par un avocat avant le pilote).
export async function termsView() {
  return {
    html: `<article class="card terms">
      <h1>Termos de uso · Parceiro Kombrio</h1>
      <p class="hint">Versão ${esc(TERMS_VERSION)} · <b>rascunho, em revisão jurídica</b></p>
      <h3>1. O serviço</h3>
      <p>A Kombrio conecta guias de turismo cadastrados e estabelecimentos parceiros (restaurantes, lojas). O guia recomenda o parceiro ao seu cliente; o cliente apresenta o QR Kombrio no estabelecimento; a visita é registrada pelo parceiro.</p>
      <h3>2. Cadastro e acesso</h3>
      <p>O acesso do gerente é pessoal, com e-mail e senha. O responsável informado no primeiro acesso representa o estabelecimento perante a Kombrio. O QR da caixa serve apenas para registrar as visitas e não dá acesso aos pagamentos.</p>
      <h3>3. Registro das visitas</h3>
      <p>O parceiro se compromete a escanear o QR de cada cliente Kombrio atendido e a conceder, quando houver, a oferta anunciada, uma vez por grupo e por estadia.</p>
      <h3>4. Comissão</h3>
      <p>Para cada visita registrada, o parceiro declara livremente o valor da comissão que paga pela recomendação. A comissão é paga à Kombrio por Pix ou transferência, com o comprovante, de uma vez ou agrupada (por exemplo, mensalmente).</p>
      <h3>5. Prazo de pagamento</h3>
      <p>As comissões do mês devem ser declaradas e pagas até o dia 10 do mês seguinte. A Kombrio pode enviar lembretes ao responsável (WhatsApp ou e-mail).</p>
      <h3>6. Repasse ao guia</h3>
      <p>A Kombrio repassa 80 % de cada comissão recebida ao guia que fez a recomendação e conserva 20 % pelo serviço. O parceiro não paga nada ao guia diretamente.</p>
      <h3>7. Oferta</h3>
      <p>A oferta aos clientes Kombrio é opcional, definida e alterada pelo próprio parceiro no seu espaço.</p>
      <h3>8. Dados pessoais (LGPD)</h3>
      <p>A Kombrio trata apenas os dados necessários ao serviço (nome do cliente ou grupo, número de pessoas, data da visita, valores e comprovantes) e não os vende nem os cede a terceiros. O parceiro pode pedir acesso, correção ou exclusão dos seus dados.</p>
      <h3>9. Relatórios</h3>
      <p>O parceiro tem acesso aos relatórios mensais e pode compartilhar um link somente leitura com o seu contador.</p>
      <h3>10. Duração e encerramento</h3>
      <p>Prazo indeterminado. Qualquer uma das partes pode encerrar a parceria a qualquer momento, com as comissões das visitas já registradas devidas.</p>
      <h3>11. Alterações</h3>
      <p>A Kombrio pode atualizar estes termos; uma nova versão será apresentada ao parceiro para aceite.</p>
      <p class="hint" style="margin-top:16px">Kombrio · Rio de Janeiro · contato pelo WhatsApp do seu interlocutor Kombrio.</p>
    </article>`,
  };
}
