// App Partenaire : son QR Partenaire enregistre le passage, puis il déclare et paie la commission.
// Sans passage en attente, le même QR ouvre son espace (historique, offre, QR à imprimer).
// Pas de compte : tout passe par le code secret du QR Partenaire, vérifié par la base.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, cents, parseCents, fmtMoment, fmtDay, qrSvg, appLink, readFileAsDataUrl, notify, pixPayload, pixKeyOf, photoToJpeg, confirmTwice, fmtTaxId, locale, phoneField, phoneValue } from '../util.js';
import * as store from '../store.js';
import { statusBadge, notFound, forgotLink, mountForgot, resetView, lastMonths, shortMonth, delta, barChart } from './shared.js';
import { readPendingStay, clearPendingStay } from './scan.js';
import { helpButton, problemLink, mountHelp, topicLabel, alertStatus } from './help.js';

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
        <div class="field"><label for="a-code">${t('pm.code')}</label><input id="a-code" name="code" required value="${esc(code)}" placeholder="RIO-KP-12345 / 12345" autocapitalize="characters" style="text-transform:uppercase"></div>
        <div class="grid2">
          <div class="field"><label for="a-name">${t('pm.name')}</label><input id="a-name" name="name" required autocomplete="name"></div>
          ${phoneField('a-phone', t('guide.signup.phone'), t('phone.other'))}
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
        const phone = phoneValue(e.target, 'a-phone');
        if (!phone) { notify(tRaw('phone.err')); return; }
        const button = e.target.querySelector('button');
        button.disabled = true;
        try {
          const ready = await store.signUpPartner({
            email: f.email.trim(), password: f.password, code: f.code, name: f.name.trim(), phone, terms: TERMS_VERSION,
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
  space.alerts = space.role === 'manager' ? await store.partnerAlerts(token) : [];
  space.closings = space.role === 'manager' ? await store.partnerClosings(token) : [];

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
  if (['visitas', 'pagamentos', 'config'].includes(action)) return spaceView(space, action);
  if (action === 'declarar') return declareManyView(space);
  if (action === 'pagar') return payView(space);
  if (action === 'relatorio') return reportPage(space, visitId);
  if (action === 'mes') return monthPage(space, visitId, space.closings);
  if (action === 'demonstrativo') return docPage(space, visitId, space.closings, `#/p/${encodeURIComponent(token)}/pagamentos`);
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
        <div class="spread"><h2>${esc(visit.client)}</h2><span class="hint">${esc(store.visitRef(visit))}</span></div>
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
    <div class="hint">${esc(store.visitRef(v))} · ${fmtMoment(v.at, lang, city.timezone)} · ${t('scan.people', { n: v.peopleServed })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</div>
    ${v.declaredCents != null ? `<div>${t('partner.visit.declared', { amount: c(v.declaredCents) })}</div>` : ''}
    ${v.statusNote && ['disputed', 'cancelled'].includes(v.status) ? `<div class="hint">${esc(v.statusNote)}</div>` : ''}
  </li>`;
}

// Espace du gérant (v32) : tableau de bord à onglets, visites traitées en groupe (cases à cocher), liste « À faire ».
const PD_TABS = ['painel', 'visitas', 'pagamentos', 'config'];
const ageDays = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 864e5) : 0);
const doneKey = (pid, month) => `kb-todo-${pid}-${month}`;
const readDone = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch { return new Set(); } };
const saveDone = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])); } catch { /* rien */ } };

export function spaceView(space, tab = 'painel') {
  const { partner, city, visits, payments, adjustments = [], alerts = [], closings = [], key, role, loggedIn } = space;
  if (role !== 'manager') return counterView({ partner, city, visits, key });
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const base = `#/p/${encodeURIComponent(key)}`;
  const month = monthOf(new Date().toISOString(), city.timezone);
  const rate = Math.round(partner.commissionRate * 100);
  const toDeclare = visits.filter((v) => v.status === 'visited');
  const toPay = visits.filter((v) => v.status === 'declared');
  const extraDue = adjustments.filter((a) => a.partnerStatus === 'extra_due');
  const payCents = toPay.reduce((s, v) => s + (v.declaredCents || 0), 0) + extraDue.reduce((s, a) => s + a.deltaCents, 0);
  const late = toPay.length ? Math.max(...toPay.map((v) => ageDays(v.declaredAt))) : 0;
  const lastPay = payments[0];
  const rejected = lastPay && lastPay.status === 'rejected' && toPay.length ? lastPay : null;
  const inMonth = visits.filter((v) => monthOf(v.at, city.timezone) === month && v.status !== 'cancelled');
  const paidMonth = payments.filter((y) => y.status === 'verified' && y.verifiedAt && monthOf(y.verifiedAt, city.timezone) === month).reduce((s, y) => s + y.cents, 0);
  const fresh = !visits.length && !payments.length;
  const dk = doneKey(partner.id, month);
  const done = readDone(dk);

  // Bandeaux : suspension, retards (J+7, J+15), paiement refusé, bienvenue.
  let banner = '';
  if (partner.status === 'paused') banner = `<div class="notice bad"><b>${t('pd.susp.title')}</b><br>${t('pd.susp.text', { amount: c(payCents) })}</div>`;
  else if (late >= 15) banner = `<div class="notice bad"><b>${t('pd.late15.title')}</b><br>${t('pd.late15.text', { amount: c(payCents) })}</div>`;
  else if (late >= 7) banner = `<div class="notice warn"><b>${t('pd.late7.title', { n: late })}</b><br>${t('pd.late7.text', { amount: c(payCents) })}</div>`;
  if (rejected) banner += `<div class="notice bad"><b>${t('pd.rejected.title', { num: rejected.num })}</b><br>${esc(rejected.note || '')} ${t('pd.rejected.text')}</div>`;
  if (fresh) banner += `<div class="notice">${t('pd.welcome')}</div>`;
  // Alertes envoyées à Kombrio : en cours, ou résolues depuis moins de 7 jours avec une réponse.
  alerts.filter((a) => a.status !== 'resolved' || (a.answer && ageDays(a.resolvedAt) < 7)).forEach((a) => {
    banner += `<div class="notice ${a.status === 'resolved' ? 'ok' : ''}"><b>${t('alert.line', { num: a.num, topic: topicLabel('partner', a.topic), status: alertStatus(a.status) })}</b><br>${a.answer ? t('alert.answer', { text: a.answer }) : t('alert.wait')}</div>`;
  });
  const alertOf = (vId) => alerts.find((a) => a.visitId === vId && a.status !== 'resolved');

  // Une ligne de visite : case à cocher si une action est possible, addition à saisir si elle n'est pas déclarée.
  const row = (v) => {
    const can = ['visited', 'declared'].includes(v.status) && partner.status !== 'paused';
    const inv = v.status === 'visited'
      ? `<input class="pd-inv" data-inv="${esc(v.id)}" inputmode="decimal" placeholder="${t('pd.col.bill')}" aria-label="${esc(tRaw('pd.col.bill'))} ${esc(v.client || '')}">`
      : `<span class="pd-num">${v.invoiceCents == null ? '—' : c(v.invoiceCents)}</span>`;
    return `<label class="pd-row" data-v="${v.status}">
      <span class="pd-c">${can ? `<input type="checkbox" data-sel="${esc(v.id)}" data-st="${v.status}" aria-label="${esc(v.client || '')}">` : ''}</span>
      <span class="pd-d">${fmtDay(v.at.slice(0, 10), lang)}</span>
      <span class="pd-who"><b>${esc(v.client || '?')}</b><small>${esc(v.guideName || '?')} · ${t('scan.people', { n: v.peopleServed })} · ${esc(store.visitRef(v))}${v.statusNote && ['disputed', 'cancelled'].includes(v.status) ? ` · ${esc(v.statusNote)}` : ''}</small>${alertOf(v.id) ? `<span class="badge">${t('alert.short', { num: alertOf(v.id).num, status: alertStatus(alertOf(v.id).status) })}</span>` : problemLink(v.id)}</span>
      <span class="pd-st">${statusBadge(v, 'partner')}</span>
      <span class="pd-i">${inv}</span>
      <span class="pd-num pd-com" data-com="${esc(v.id)}">${v.declaredCents == null ? '—' : c(v.declaredCents)}</span>
    </label>`;
  };
  const visitsCard = (title, list, filters) => `<div class="card pd-card">
      <div class="spread" style="padding:12px 14px 6px"><h2 style="margin:0">${title}</h2>
        ${filters ? `<select id="pd-filter" style="width:auto">${['all', 'visited', 'declared', 'verifying', 'paid'].map((f) => `<option value="${f}">${t(`pd.f.${f}`)}</option>`).join('')}</select>` : ''}</div>
      ${list.some((v) => v.status === 'visited') ? `<p class="hint" style="padding:0 14px;margin:0 0 6px">${t('bill.rule')}</p>` : ''}
      ${list.length ? `<div class="pd-rows"><div class="pd-row pd-head"><span></span><span>${t('pd.col.date')}</span><span>${t('pd.col.who')}</span><span>${t('pd.col.status')}</span><span class="pd-r">${t('pd.col.bill')}</span><span class="pd-r">${t('pd.col.com', { rate })}</span></div>
        ${list.map(row).join('')}</div>
        <div class="pd-bar"><span id="pd-sel">${t('pd.sel.none')}</span>
          <span class="row" style="gap:6px"><button class="btn secondary small" id="pd-declare" disabled>${t('pd.declare')}</button><button class="btn small" id="pd-pay" disabled>${t('pd.pay')}</button></span></div>`
      : `<p class="hint" style="padding:0 14px 14px">${t('pd.empty')}</p>`}
    </div>`;

  const todo = [];
  if (fresh || !partner.offer) todo.push(['offer', t('pd.todo.offer')]);
  if (fresh) todo.push(['qr', t('pd.todo.qr')], ['rate', t('pd.todo.rate', { rate })]);
  if (toDeclare.length) todo.push([`decl-${toDeclare.length}`, t('pd.todo.declare', { n: toDeclare.length })]);
  if (payCents > 0) todo.push([`pay-${payCents}`, t('pd.todo.pay', { amount: c(payCents) })]);
  adjustments.filter((a) => a.partnerStatus === 'refund_due').forEach((a) => todo.push([`ref-${a.num}`, t('pd.todo.refund', { amount: c(-a.deltaCents), num: store.adjNum(a.num) })]));
  if (rejected) todo.push([`resend-${rejected.num}`, t('pd.todo.resend')]);
  if (!fresh) todo.push(['report', t('pd.todo.report')]);
  const left = todo.filter(([k]) => !done.has(k)).length;
  const todoCard = `<div class="card"><div class="spread"><h2 style="margin:0">${t('pd.todo.title')}</h2><span class="hint">${t('pd.todo.left', { n: left })}</span></div>
    <div class="pd-todo">${todo.length ? todo.map(([k, l]) => `<label class="${done.has(k) ? 'pd-done' : ''}"><input type="checkbox" data-todo="${esc(k)}"${done.has(k) ? ' checked' : ''}> ${l}</label>`).join('') : `<p class="hint">${t('pd.todo.none')}</p>`}</div></div>`;
  const payBadge = (y) => `<span class="badge ${y.status === 'verified' ? 'ok' : y.status === 'rejected' ? 'bad' : 'warn'}">${t(`payment.${y.status}`)}</span>`;
  const lastCard = `<div class="card"><h2>${t('pd.last')}</h2>${lastPay ? `<div class="spread"><span>${t('partner.payment.line', { num: lastPay.num, amount: c(lastPay.cents) })}<br><span class="hint">${fmtMoment(lastPay.submittedAt, lang, city.timezone)}</span></span>${payBadge(lastPay)}</div>` : `<p class="hint">${t('pd.last.none')}</p>`}</div>`;
  const shortcuts = `<div class="card"><h2>${t('pd.shortcuts')}</h2><div class="pd-links">
      <a href="${base}/config">${t('partner.qr.title')}</a><a href="${base}/config">${t('partner.offer.title')}</a>
      <a href="${base}/pagamentos">${t('dash.docs')}</a><a href="${base}/config">${t('partner.rate.title')}</a></div></div>`;

  // v58 : tableau de bord — le mois en cours comparé au précédent, 6 mois en barres, les 3 gestes.
  const months6 = lastMonths(6, city.timezone);
  const prevMonth = months6[4];
  const stat = (m) => { const l = visits.filter((v) => monthOf(v.at, city.timezone) === m && v.status !== 'cancelled');
    return { n: l.length, people: l.reduce((s, v) => s + (v.peopleServed || 0), 0), bills: l.reduce((s, v) => s + (v.invoiceCents || 0), 0), com: l.reduce((s, v) => s + (v.declaredCents || 0), 0) }; };
  const now = stat(month); const before = stat(prevMonth);
  const kpis = `<div class="pd-kpis">
      <div class="pd-kpi"><span>${t('pd.k.visits')}</span><b>${now.n}${delta(now.n, before.n)}</b><em>${t('pd.k.people', { n: now.people })}</em></div>
      <div class="pd-kpi"><span>${t('pd.k.bills')}</span><b>${c(now.bills)}${delta(now.bills, before.bills)}</b><em>${t('dash.vs', { month: esc(monthLabel(prevMonth, lang)) })}</em></div>
      <div class="pd-kpi"><span>${t('dash.k.com')}</span><b>${c(now.com)}${delta(now.com, before.com)}</b><em>${t('pd.k.rate', { rate })}</em></div>
      <div class="pd-kpi ${late >= 15 || partner.status === 'paused' ? 'bad' : payCents > 0 ? 'warn' : ''}"><span>${t('pd.k.topay')}</span><b>${c(payCents)}</b><em>${payCents > 0 ? (late >= 7 ? t('pd.k.late', { n: late }) : t('pd.k.due')) : t('pd.k.nothing')}</em></div>
    </div>`;
  const chartCard = `<div class="card"><h2 style="margin:0">${t('dash.6m')}</h2>
      ${barChart(months6.map((m) => { const x = stat(m); return { label: shortMonth(m, lang), value: x.com, text: `${c(x.com)} · ${t('dash.visits', { n: x.n })}` }; }))}</div>`;
  const prevDoc = closings.find((k) => String(k.month).slice(0, 7) === prevMonth && k.latest);
  const steps = `<div class="kb-steps">
      <a class="kb-step ${toDeclare.length ? 'warn' : 'ok'}" href="${base}/visitas"><b>1. ${t('mes.s1')}</b><span>${toDeclare.length ? t('mes.s1.todo', { n: toDeclare.length }) : t('mes.s1.done')}</span></a>
      <a class="kb-step ${payCents > 0 ? 'warn' : 'ok'}" href="${base}/pagamentos"><b>2. ${t('mes.s2')}</b><span>${payCents > 0 ? `${t('mes.s2.total')} : ${c(payCents)}` : t('mes.s2.nothing')}</span></a>
      <a class="kb-step ${prevDoc ? 'ok' : 'warn'}" href="${base}/pagamentos"><b>3. ${t('mes.s3')}</b><span>${prevDoc ? `${esc(prevDoc.doc_code)}` : t('dash.doc.prev', { month: esc(monthLabel(prevMonth, lang)) })}</span></a>
    </div>`;
  // Documents : le relevé figé de chaque mois (Document A), la NFS-e (Document B) et le lien du comptable.
  const docMonths = [...new Set([month, prevMonth, ...closings.map((k) => String(k.month).slice(0, 7))])].sort().reverse().slice(0, 6);
  const docsCard = `<div class="card"><h2>${t('dash.docs')}</h2>
      <ul class="list">${docMonths.map((m) => { const k = closings.find((x) => String(x.month).slice(0, 7) === m && x.latest);
        return `<li><div class="spread"><span><b>${esc(monthLabel(m, lang))}</b><br><span class="hint">${k ? t('mes.s3.doc', { code: k.doc_code, version: k.version, date: fmtMoment(k.created_at, lang, city.timezone) }) : t('mes.s3.nodoc')}</span></span>
          <span class="row" style="gap:6px">${k ? `<a class="btn secondary small" href="${base}/demonstrativo/${m}">${t('doc.open')}</a>` : ''}<button class="btn ghost small" data-close-month="${m}">${t(k ? 'dash.doc.update' : 'dash.doc.make')}</button></span></div></li>`; }).join('')}</ul>
      <div class="spread" style="margin-top:10px"><span><b>${t('doc.b')}</b><br><span class="hint">${t('doc.b.soon')}</span></span><span class="badge">${t('doc.b.badge')}</span></div>
      <p class="hint" style="margin-top:10px">${t('mes.s3.accountant')} <a href="${base}/relatorio">${t('report.share.title')}</a></p></div>`;

  const payHistory = `<div class="card"><h2>${t('partner.payments')}</h2>${payments.length ? `<ul class="list">${payments.map((y) => `<li>
      <div class="spread"><b>${t('partner.payment.line', { num: y.num, amount: c(y.cents) })}</b>${payBadge(y)}</div>
      <div class="hint">${fmtMoment(y.submittedAt, lang, city.timezone)}${y.note ? ` · ${esc(y.note)}` : ''}</div></li>`).join('')}</ul>` : `<p class="hint">${t('pd.last.none')}</p>`}</div>`;

  const settings = `<form class="card" id="rate">
        <h2>${t('partner.rate.title')}</h2>
        <p class="hint">${t('partner.rate.hint')}</p>
        <div class="field"><select name="rate">${[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20].map((n) => `<option value="${n / 100}"${rate === n ? ' selected' : ''}>${n} %${n === 10 ? ` (${t('partner.rate.suggested')})` : ''}</option>`).join('')}</select></div>
        <button class="btn secondary">${t('common.save')}</button>
      </form>
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
      <div class="card no-print"><h2>${t('report.card')}</h2><p class="hint">${t('report.card.hint')}</p>
        <a class="btn secondary" href="${base}/relatorio">${t('report.open')}</a></div>
      <p class="hint no-print">${t('partner.linked', { name: partner.name })} <a href="#" id="unlink">${t('partner.unlink')}</a></p>`;

  const open = visits.filter((v) => ['visited', 'declared', 'verifying', 'disputed'].includes(v.status));
  const body = {
    painel: `${steps}${kpis}<div class="pd-cols">${visitsCard(t('pd.totreat'), open, false)}<div class="pd-side">${chartCard}${todoCard}${adjustmentsCard(adjustments, city, lang)}${lastCard}${shortcuts}</div></div>`,
    visitas: visitsCard(t('pd.all'), visits, true),
    pagamentos: `<div class="pd-cols"><div class="pd-side">${visitsCard(t('pd.topay'), toPay, false)}${payHistory}</div><div class="pd-side">${docsCard}${adjustmentsCard(adjustments, city, lang)}</div></div>`,
    config: settings,
  }[tab];
  const counts = { painel: toDeclare.length + toPay.length + extraDue.length, visitas: toDeclare.length, pagamentos: toPay.length + extraDue.length, config: 0 };
  const tabsNav = `<nav class="tabs no-print">${PD_TABS.map((k) => `<a href="${base}${k === 'painel' ? '' : `/${k}`}" class="${k === tab ? 'on' : ''}">${t(`pd.tab.${k}`)}${counts[k] ? `<span class="todo">${counts[k]}</span>` : ''}</a>`).join('')}</nav>`;

  return {
    html: `<div class="dash-wide">
      <div class="spread"><div><h1 style="margin-bottom:2px">${esc(partner.name)}</h1>
        <p class="hint" style="margin:0">${t(`ptype.${partner.type}`)}${partner.area ? ` · ${esc(partner.area)}` : ''} · ${t('pd.k.rate', { rate })}${partner.managerName ? ` · ${t('pm.hello', { name: partner.managerName })}` : ''}</p></div>
        <div class="row" style="gap:6px">${helpButton()}${loggedIn ? `<button class="btn ghost small no-print" id="logout">${t('common.logout')}</button>` : ''}</div></div>
      ${tabsNav}${banner}${body}</div>`,
    mount(root, ctx) {
      mountHelp(root, { kind: 'partner', send: (topic, msg, vId) => store.partnerCreateAlert(key, topic, msg, vId),
        findCode: (c) => visits.find((x) => x.code === c)?.id || null,
        label: (vId) => { const v = visits.find((x) => x.id === vId); return v ? `${v.client || ''} · ${fmtDay(v.at.slice(0, 10), getLang())} · ${store.visitRef(v)}` : ''; },
        onSent: () => ctx.refresh() });
      const out = root.querySelector('#logout');
      if (out) out.onclick = async () => { await store.signOut(); try { localStorage.removeItem(ME_KEY); } catch { /* rien */ } location.hash = ''; };
      root.querySelectorAll('[data-close-month]').forEach((b) => { b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await store.partnerCloseMonth(key, b.dataset.closeMonth);
          if (!r || !r.ok) { b.disabled = false; notify(tRaw('err.generic')); return; }
          ctx.go(`p/${key}/demonstrativo/${b.dataset.closeMonth}`, tRaw('mes.s3.saved', { code: r.doc_code }));
        } catch { b.disabled = false; notify(tRaw('err.generic')); }
      }; });
      root.querySelectorAll('[data-todo]').forEach((b) => { b.onchange = () => { b.checked ? done.add(b.dataset.todo) : done.delete(b.dataset.todo); saveDone(dk, done); b.parentElement.classList.toggle('pd-done', b.checked); }; });
      const filter = root.querySelector('#pd-filter');
      const PAIDS = ['received', 'payout_pending', 'paid'];
      if (filter) filter.onchange = () => root.querySelectorAll('.pd-row[data-v]').forEach((r) => {
        r.hidden = filter.value !== 'all' && r.dataset.v !== filter.value && !(filter.value === 'paid' && PAIDS.includes(r.dataset.v));
      });
      // Sélection : total de la commission, déclaration groupée, paiement des visites cochées.
      const byId = (id) => visits.find((v) => v.id === id);
      const sel = () => [...root.querySelectorAll('[data-sel]:checked')].map((b) => byId(b.dataset.sel));
      const billOf = (v) => { const el = root.querySelector(`[data-inv="${v.id}"]`); return el && el.value.trim() !== '' ? parseCents(el.value) : null; };
      const refresh = () => {
        const list = sel(); const decl = list.filter((v) => v.status === 'visited'); const pay = list.filter((v) => v.status === 'declared');
        const missing = decl.filter((v) => billOf(v) == null).length;
        const total = pay.reduce((s, v) => s + v.declaredCents, 0) + decl.reduce((s, v) => s + (billOf(v) != null ? Math.round(billOf(v) * (v.rate ?? partner.commissionRate)) : 0), 0);
        const info = root.querySelector('#pd-sel');
        if (info) info.textContent = list.length ? tRaw('pd.sel.n', { n: list.length, amount: c(total) }) + (missing ? ` · ${tRaw('pd.sel.missing', { n: missing })}` : '') : tRaw('pd.sel.none');
        const bd = root.querySelector('#pd-declare'); if (bd) bd.disabled = !decl.length || missing > 0 || pay.length > 0;
        const bp = root.querySelector('#pd-pay'); if (bp) bp.disabled = !pay.length || decl.length > 0;
      };
      root.querySelectorAll('[data-sel]').forEach((b) => { b.onchange = refresh; });
      root.querySelectorAll('[data-inv]').forEach((inp) => {
        inp.oninput = () => {
          const v = byId(inp.dataset.inv); const cts = billOf(v);
          const box = root.querySelector(`[data-sel="${v.id}"]`); if (box && cts != null) box.checked = true;
          const com = root.querySelector(`[data-com="${v.id}"]`); if (com) com.textContent = cts == null ? '—' : c(Math.round(cts * (v.rate ?? partner.commissionRate)));
          refresh();
        };
      });
      const bd = root.querySelector('#pd-declare');
      if (bd) bd.onclick = async (e) => {
        e.preventDefault();
        const items = sel().filter((v) => v.status === 'visited').map((v) => ({ visit: v.id, cents: billOf(v) }));
        if (!items.length || items.some((i) => i.cents == null)) { notify(tRaw('pd.sel.missing', { n: 1 })); return; }
        bd.disabled = true;
        try { const n = await store.declareCommissions(key, items); ctx.refresh(tRaw('partner.declare.saved', { n })); } catch { bd.disabled = false; notify(tRaw('err.generic')); }
      };
      const bp = root.querySelector('#pd-pay');
      if (bp) bp.onclick = (e) => {
        e.preventDefault();
        try { sessionStorage.setItem('kb-pay-sel', JSON.stringify(sel().filter((v) => v.status === 'declared').map((v) => v.id))); } catch { /* rien */ }
        ctx.go(`p/${key}/pagar`);
      };
      const rateForm = root.querySelector('#rate');
      if (rateForm) rateForm.onsubmit = async (e) => {
        e.preventDefault();
        await store.setCommissionRate(key, Number(new FormData(e.target).get('rate')));
        ctx.refresh(tRaw('common.saved'));
      };
      const offerForm = root.querySelector('#offer');
      if (offerForm) offerForm.onsubmit = async (e) => {
        e.preventDefault();
        await store.setPartnerOffer(key, new FormData(e.target).get('offer'));
        ctx.refresh(tRaw('common.saved'));
      };
      const pr = root.querySelector('#print'); if (pr) pr.onclick = () => window.print();
      const un = root.querySelector('#unlink');
      if (un) un.onclick = (e) => {
        e.preventDefault();
        try { localStorage.removeItem(ME_KEY); } catch { /* rien */ }
        location.hash = '';
        notify(tRaw('partner.unlinked'));
      };
    },
  };
}

// Étape 1 : déclarer librement la commission de chaque passage (0 = aucune commission).
function declareManyView({ partner, city, visits, key }) {
  const lang = getLang();
  const todo = visits.filter((v) => v.status === 'visited');
  const back = `#/p/${encodeURIComponent(key)}`;
  if (!todo.length) return { html: `<div class="notice">${t('partner.declare.nothing')}</div><a class="btn ghost" href="${back}">${t('partner.space')}</a>` };
  return {
    html: `
      <p><a href="${back}">← ${t('partner.space')}</a></p>
      <form class="card" id="declare">
        <h1>${t('partner.declare.title')}</h1>
        <p class="hint">${t('partner.declare.free', { rate: Math.round(partner.commissionRate * 100) })}</p>
        <p class="hint">${t('bill.rule')}</p>
        <ul class="list">${todo.map((v) => `<li>
          <div class="spread" style="align-items:center">
            <span><b>${esc(v.client || '?')}</b><br><span class="hint">${esc(store.visitRef(v))} · ${fmtDay(v.at.slice(0, 10), lang)} · ${t('scan.people', { n: v.peopleServed })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</span></span>
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
          if (cts == null) { notify(tRaw('partner.declare.badamount', { num: store.visitRef(v) })); return; }
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
  // Visites cochées dans le tableau de bord (sinon : toutes).
  let pre = null;
  try { pre = JSON.parse(sessionStorage.getItem('kb-pay-sel') || 'null'); sessionStorage.removeItem('kb-pay-sel'); } catch { pre = null; }
  if (pre && !pre.length) pre = null;
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
            <span><input type="checkbox" name="sel" value="${esc(v.id)}"${!pre || pre.includes(v.id) ? ' checked' : ''} style="width:auto;margin-right:8px"><b>${esc(v.client || '?')}</b>
              <span class="hint"> · ${esc(store.visitRef(v))} · ${fmtDay(v.at.slice(0, 10), lang)}</span></span>
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

// Corrections après encaissement (contre-écritures) vues par le partenaire.
function adjustmentsCard(adjustments, city, lang, month) {
  const list = month ? adjustments.filter((a) => monthOf(a.createdAt, city.timezone) === month) : adjustments;
  if (!list.length) return '';
  return `<div class="card"><h2>${t('pm.adj.title')}</h2><ul class="list">${list.map((a) => `<li>
      <div class="spread"><b>${esc(store.adjNum(a.num))} · ${esc(store.txNum(a.visitNum))} · ${cents(a.deltaCents, city.currency, lang)}</b>
        <span class="badge ${a.partnerStatus === 'settled' ? 'ok' : 'warn'}">${t(`pm.adj.${a.partnerStatus}`)}</span></div>
      <div class="hint">${fmtMoment(a.createdAt, lang, city.timezone)} · ${esc(a.reason)}</div></li>`).join('')}</ul></div>`;
}

function reportBlock({ partner, city, visits, adjustments = [] }, month, base) {
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
      <p class="no-print"><a href="#/${base}/../demonstrativo/${m}" data-doc="${m}">${t('doc.open.short')}</a></p>
    </div>
    ${adjustmentsCard(adjustments, city, lang, m)}`;
  const mount = (root, ctx) => {
    const docLink = root.querySelector('[data-doc]');
    // base = « p/<code>/relatorio » (gérant) ou « r/<lien> » (comptable).
    if (docLink) docLink.href = base.startsWith('r/') ? `#/${base}/demonstrativo/${m}` : `#/${base.replace(/\/relatorio$/, '')}/demonstrativo/${m}`;
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
export async function reportView([reportToken, month, sub]) {
  const data = reportToken && await store.partnerReport(reportToken);
  if (!data) return notFound('err.report');
  // Document A vu par le comptable : #/r/<lien>/demonstrativo/<AAAA-MM>[.v<n>]
  if (month === 'demonstrativo') return docPage(data, sub, await store.partnerClosings(reportToken), `#/r/${encodeURIComponent(reportToken)}`);
  const block = reportBlock(data, month, `r/${reportToken}`);
  return { html: `<p class="hint no-print">${t('report.readonly')}</p>${block.html}`, mount: block.mount };
}

/* ---------- Étape 2 du plan : « Mon mois » en 3 gestes + Document A (v54) ---------- */
const nextMonth10 = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 10)); return d.toISOString().slice(0, 10); };
const latestOf = (closings, m) => closings.find((k) => String(k.month).slice(0, 7) === m && k.latest);

function monthPage(space, month, closings) {
  const { partner, city, visits, adjustments = [], key } = space;
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const base = `#/p/${encodeURIComponent(key)}`;
  const now = monthOf(new Date().toISOString(), city.timezone);
  const months = [...new Set([now, ...visits.map((v) => monthOf(v.at, city.timezone))])].sort().reverse();
  const m = months.includes(month) ? month : months[0];
  const inM = visits.filter((v) => monthOf(v.at, city.timezone) === m && v.status !== 'cancelled');
  const toDeclare = inM.filter((v) => v.status === 'visited');
  const disputed = inM.filter((v) => v.status === 'disputed');
  // Le Pix unique couvre tout ce qui est déclaré et pas encore payé (tous mois confondus), plus les compléments dus.
  const toPay = visits.filter((v) => v.status === 'declared');
  const extra = adjustments.filter((a) => a.partnerStatus === 'extra_due').reduce((s, a) => s + a.deltaCents, 0);
  const payCents = toPay.reduce((s, v) => s + (v.declaredCents || 0), 0) + extra;
  const verifying = visits.filter((v) => v.status === 'verifying').reduce((s, v) => s + (v.declaredCents || 0), 0);
  const doc = latestOf(closings, m);
  const step = (n, title, ok, body) => `<div class="card"><div class="spread"><h2 style="margin:0">${n}. ${title}</h2>
      <span class="badge ${ok ? 'ok' : 'warn'}">${t(ok ? 'mes.ok' : 'mes.todo')}</span></div>${body}</div>`;
  const html = `<div class="dash-wide">
      <p><a href="${base}">← ${t('partner.space')}</a></p>
      <div class="spread"><div><h1 style="margin-bottom:2px">${t('mes.title')}</h1><p class="hint" style="margin:0">${t('mes.hint')}</p></div>
        <select id="mes-month" style="width:auto">${months.map((x) => `<option value="${x}" ${x === m ? 'selected' : ''}>${esc(monthLabel(x, lang))}</option>`).join('')}</select></div>
      ${step(1, t('mes.s1'), !toDeclare.length && !disputed.length, `
        <p>${t('mes.s1.count', { n: inM.length, people: inM.reduce((s, v) => s + v.peopleServed, 0) })}</p>
        ${toDeclare.length ? `<div class="notice warn">${t('mes.s1.todo', { n: toDeclare.length })}</div><a class="btn" href="${base}">${t('mes.s1.go')}</a>` : `<p class="hint">${t('mes.s1.done')}</p>`}
        ${disputed.length ? `<div class="notice bad">${t('mes.s1.disputed', { n: disputed.length })}</div>` : ''}`)}
      ${step(2, t('mes.s2'), payCents <= 0, `
        ${payCents > 0 ? `<div class="stat" style="margin:8px 0"><span>${t('mes.s2.total')}</span><b>${c(payCents)}</b></div>
          <p class="hint">${t('mes.s2.due', { date: fmtDay(nextMonth10(m), lang) })}</p>
          <button class="btn" id="mes-pay">${t('mes.s2.go')}</button>`
        : `<p class="hint">${t('mes.s2.nothing')}</p>`}
        ${verifying > 0 ? `<div class="notice">${t('mes.s2.verifying', { amount: c(verifying) })}</div>` : ''}`)}
      ${step(3, t('mes.s3'), !!doc, `
        <div class="spread" style="margin-top:8px"><span><b>${t('doc.a')}</b><br><span class="hint">${doc ? t('mes.s3.doc', { code: doc.doc_code, version: doc.version, date: fmtMoment(doc.created_at, lang, city.timezone) }) : t('mes.s3.nodoc')}</span></span>
          ${doc ? `<a class="btn secondary small" href="${base}/demonstrativo/${m}">${t('doc.open')}</a>` : ''}</div>
        <button class="btn ${doc ? 'ghost' : ''} small" id="mes-close" style="margin-top:8px">${t(doc ? 'mes.s3.update' : 'mes.s3.make')}</button>
        <div class="spread" style="margin-top:14px"><span><b>${t('doc.b')}</b><br><span class="hint">${t('doc.b.soon')}</span></span><span class="badge">${t('doc.b.badge')}</span></div>
        <p class="hint" style="margin-top:12px">${t('mes.s3.accountant')} <a href="${base}/relatorio">${t('report.share.title')}</a></p>`)}
    </div>`;
  return {
    html,
    mount(root, ctx) {
      root.querySelector('#mes-month').onchange = (e) => ctx.go(`p/${key}/mes/${e.target.value}`);
      const pay = root.querySelector('#mes-pay');
      if (pay) pay.onclick = () => {
        try { sessionStorage.setItem('kb-pay-sel', JSON.stringify(toPay.map((v) => v.id))); } catch { /* rien */ }
        ctx.go(`p/${key}/pagar`);
      };
      const close = root.querySelector('#mes-close');
      if (close) close.onclick = async () => {
        close.disabled = true;
        try {
          const r = await store.partnerCloseMonth(key, m);
          if (!r || !r.ok) { close.disabled = false; notify(tRaw('err.generic')); return; }
          ctx.go(`p/${key}/demonstrativo/${m}`, tRaw('mes.s3.saved', { code: r.doc_code }));
        } catch { close.disabled = false; notify(tRaw('err.generic')); }
      };
    },
  };
}

// Document A : « Demonstrativo Consolidado de Comissões e Repasses », lu dans la clôture figée (jamais recalculé à l'écran).
// sel = « AAAA-MM » (dernière version) ou « AAAA-MM.v2 » (une version précise).
function docPage(space, sel, closings, back) {
  const { partner, city } = space;
  const lang = getLang();
  const c = (n) => cents(n ?? 0, city.currency, lang);
  const [m, vtxt] = String(sel || '').split('.v');
  const versions = closings.filter((k) => String(k.month).slice(0, 7) === m);
  const doc = vtxt ? versions.find((k) => String(k.version) === vtxt) : versions.find((k) => k.latest);
  if (!doc) return { html: `<p class="no-print"><a href="${back}">← ${t('common.back')}</a></p><div class="notice">${t('doc.none')}</div>` };
  const T = doc.totals || {};
  const prev = doc.supersedes ? versions.find((k) => k.id === doc.supersedes) : null;
  const pLabel = (st) => tRaw(`pstatus.${{ received: 'paid', payout_pending: 'paid' }[st] || st}`);
  const lines = doc.lines || [];
  const row = (label, val, strong) => `<tr><td>${label}</td><td style="text-align:right">${strong ? `<b>${val}</b>` : val}</td></tr>`;
  const html = `
    <p class="no-print"><a href="${back}">← ${t('common.back')}</a></p>
    <div class="card doc-a">
      <div class="spread"><div><div class="hint">KOMBRIO · ${t('doc.issuer')}</div>
        <h1 style="margin:2px 0">${t('doc.a.title')}</h1>
        <div><b>${esc(doc.doc_code)}</b> · ${t('doc.version', { v: doc.version })}${prev ? ` · ${t('doc.replaces', { code: prev.doc_code })}` : ''}${doc.latest ? '' : ` · <span class="badge bad">${t('doc.superseded')}</span>`}</div></div>
        ${versions.length > 1 ? `<select id="doc-v" class="no-print" style="width:auto">${versions.map((k) => `<option value="${m}.v${k.version}" ${k.id === doc.id ? 'selected' : ''}>${t('doc.version', { v: k.version })}</option>`).join('')}</select>` : ''}</div>
      <div class="table-wrap" style="margin-top:12px"><table>
        ${row(t('doc.period'), esc(monthLabel(m, lang)))}
        ${row(t('doc.partner'), `${esc(partner.name)}${partner.taxId ? ` · ${t('report.taxid')} ${esc(fmtTaxId(partner.taxId))}` : ''}`)}
        ${row(t('doc.issued'), esc(fmtMoment(doc.created_at, lang, city.timezone)))}
      </table></div>
      <h2 style="margin-top:16px">${t('doc.summary')}</h2>
      <div class="table-wrap"><table>
        ${row(t('doc.t.visits'), `${T.visits ?? 0} · ${t('pd.k.people', { n: T.people ?? 0 })}`)}
        ${row(t('doc.t.bills'), c(T.invoice_cents))}
        ${row(t('doc.t.commission'), c(T.commission_cents), true)}
        ${row(t('doc.t.received'), c(T.received_cents))}
        ${row(t('doc.t.guides'), c(T.guide_cents))}
        ${row(t('doc.t.kombrio'), c(T.kombrio_cents))}
        ${T.inss_cents ? row(t('doc.t.inss'), c(T.inss_cents)) : ''}
        ${row(t('doc.t.verifying'), c(T.verifying_cents))}
        ${row(t('doc.t.topay'), c(T.to_pay_cents), true)}
        ${T.adjustments_cents ? row(t('doc.t.adj'), c(T.adjustments_cents)) : ''}
      </table></div>
      ${T.pending_count ? `<div class="notice warn">${t('doc.reserve', { n: T.pending_count })}</div>` : ''}
      <h2 style="margin-top:16px">${t('doc.lines')}</h2>
      ${lines.length ? `<div class="table-wrap"><table>
        <tr><th>${t('report.col.id')}</th><th>${t('report.col.date')}</th><th>${t('report.col.client')}</th><th>${t('report.col.guide')}</th><th>${t('report.col.people')}</th><th>${t('pd.col.bill')}</th><th>${t('doc.col.rate')}</th><th>${t('report.col.amount')}</th><th>${t('report.col.status')}</th></tr>
        ${lines.map((l) => `<tr><td style="white-space:nowrap">${esc(store.visitRef(l))}</td><td style="white-space:nowrap">${esc(fmtDay(String(l.day).slice(0, 10), lang))}</td><td>${esc(l.client || '')}</td><td>${esc(l.guide || '')}</td><td>${l.people ?? ''}</td>
          <td>${l.invoice_cents != null ? c(l.invoice_cents) : '—'}</td><td>${l.rate != null ? `${Math.round(Number(l.rate) * 100)} %` : '—'}</td><td>${l.commission_cents != null ? c(l.commission_cents) : '—'}</td><td>${esc(pLabel(l.status))}</td></tr>`).join('')}
      </table></div>` : `<p class="hint">${t('report.none')}</p>`}
      ${(doc.payments || []).length ? `<h2 style="margin-top:16px">${t('doc.payments')}</h2><div class="table-wrap"><table>
        <tr><th>N°</th><th>${t('common.date')}</th><th>${t('common.amount')}</th><th>Pix</th><th>${t('report.col.status')}</th></tr>
        ${doc.payments.map((y) => `<tr><td>${y.num}</td><td>${esc(fmtMoment(y.submitted_at, lang, city.timezone))}</td><td>${c(y.amount_cents)}</td><td>${esc(y.pix_ref || '')}</td><td>${t(`payment.${y.status}`)}</td></tr>`).join('')}
      </table></div>` : ''}
      ${(doc.adjustments || []).length ? `<h2 style="margin-top:16px">${t('pm.adj.title')}</h2><div class="table-wrap"><table>
        ${doc.adjustments.map((a) => `<tr><td>${esc(store.adjNum(a.num))}</td><td>${esc(store.txNum(a.visit_num))}</td><td>${c(a.delta_cents)}</td><td>${esc(a.reason || '')}</td></tr>`).join('')}
      </table></div>` : ''}
      <p class="hint" style="margin-top:14px"><b>${t('doc.mention')}</b></p>
      <p class="hint">${t('doc.mandate')}</p>
      <p class="hint" style="word-break:break-all">${t('doc.seal')} ${esc(doc.sha256)}</p>
      <div class="row no-print" style="margin-top:12px">
        <button type="button" class="btn" id="doc-pdf">${t('report.print')}</button>
        <button type="button" class="btn secondary" id="doc-csv">${t('report.excel')}</button>
      </div>
    </div>`;
  return {
    html,
    mount(root, ctx) {
      const vs = root.querySelector('#doc-v');
      if (vs) vs.onchange = (e) => { location.hash = `${location.hash.replace(/\/demonstrativo\/.*$/, '')}/demonstrativo/${e.target.value}`; };
      root.querySelector('#doc-pdf').onclick = () => window.print();
      root.querySelector('#doc-csv').onclick = () => {
        const num = (n) => (n == null ? '' : (n / 100).toFixed(2).replace('.', ','));
        const cell = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
        const head = [tRaw('report.col.id'), tRaw('report.col.date'), tRaw('report.col.client'), tRaw('report.col.guide'), tRaw('report.col.people'),
          tRaw('pd.col.bill'), tRaw('doc.col.rate'), tRaw('report.col.amount'), tRaw('report.col.status')].map(cell);
        const body = lines.map((l) => [store.visitRef(l), String(l.day).slice(0, 10), l.client, l.guide, l.people, num(l.invoice_cents),
          l.rate != null ? `${Math.round(Number(l.rate) * 100)}%` : '', num(l.commission_cents), pLabel(l.status)].map(cell));
        const sum = [[tRaw('doc.t.commission'), num(T.commission_cents)], [tRaw('doc.t.received'), num(T.received_cents)], [tRaw('doc.t.guides'), num(T.guide_cents)],
          [tRaw('doc.t.kombrio'), num(T.kombrio_cents)], [tRaw('doc.t.inss'), num(T.inss_cents)], [tRaw('doc.t.topay'), num(T.to_pay_cents)]].map(([a, b]) => [cell(a), cell(b)]);
        const csv = '﻿' + [[cell(tRaw('doc.a.title')), cell(doc.doc_code), cell(tRaw('doc.version', { v: doc.version }))], [], head, ...body, [], ...sum, [], [cell(tRaw('doc.mention'))], [cell(`SHA-256 ${doc.sha256}`)]]
          .map((r) => r.join(';')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = `${doc.doc_code}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      };
    },
  };
}

// Espace de la caisse (QR posé sur la caisse) : relier le téléphone, voir les passages des dernières 24 h et l'offre.
function counterView({ partner, city, visits, key }) {
  const lang = getLang();
  return {
    html: `
      <div class="spread"><h1>${esc(partner.name)}</h1>${helpButton()}</div>
      <div class="notice ok">${t('counter.ready')}</div>
      ${partner.offer ? `<div class="card"><h2>${t('counter.offer')}</h2><div class="offer">${esc(partner.offer)}</div><p class="hint" style="margin-top:8px">${t('counter.offer.hint')}</p></div>` : ''}
      <div class="card">
        <h2>${t('counter.today')}</h2>
        ${visits.length ? `<ul class="list">${visits.map((v) => `<li><div class="spread"><b>${esc(v.client || '?')}</b><span class="hint">${fmtMoment(v.at, lang, city.timezone)}</span></div>
          <div class="hint">${esc(store.visitRef(v))} · ${t('scan.people', { n: v.peopleServed })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</div></li>`).join('')}</ul>`
          : `<p class="hint">${t('partner.visits.none')}</p>`}
      </div>
      <p class="hint">${t('counter.manager')}</p>
      <p class="hint">${t('partner.linked', { name: partner.name })} <a href="#" id="unlink">${t('partner.unlink')}</a></p>`,
    mount() {
      mountHelp(root(), { kind: 'partner', send: (topic, msg, vId) => store.partnerCreateAlert(key, topic, msg, vId),
        findCode: (c) => visits.find((x) => x.code === c)?.id || null });
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
  // Le texte vient de la base (v41) : c'est exactement celui dont l'empreinte est gardée à l'acceptation.
  const tx = await store.termsText('partner', TERMS_VERSION).catch(() => null);
  return {
    html: `<article class="card terms">
      <h1>Termos de uso · Parceiro Kombrio</h1>
      <p class="hint">Versão ${esc(TERMS_VERSION)} · <b>rascunho, em revisão jurídica</b></p>
      ${tx && tx.body ? tx.body : `<div class="notice bad">${t('err.generic')}</div>`}
      <p class="hint" style="margin-top:16px">Kombrio · Rio de Janeiro · contato pelo WhatsApp do seu interlocutor Kombrio.</p>
      ${tx && tx.sha256 ? `<p class="hint" style="word-break:break-all">${t('terms.sha', { sha: tx.sha256 })}</p>` : ''}
    </article>`,
  };
}
