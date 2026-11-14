// App Partenaire : son QR Partenaire enregistre le passage, puis il déclare et paie la commission.
// Sans passage en attente, le même QR ouvre son espace (historique, offre, QR à imprimer).
// Pas de compte : tout passe par le code secret du QR Partenaire, vérifié par la base.
import { t, tRaw, getLang } from '../i18n.js';
import { todayIn, esc, money, cents, parseCents, fmtMoment, fmtDay, qrSvg, appLink, readFileAsDataUrl, notify, pixPayload, pixKeyOf, photoToJpeg, confirmTwice, fmtTaxId, locale, phoneField, phoneValue } from '../util.js';
import * as store from '../store.js';
import { statusBadge, notFound, forgotLink, mountForgot, resetView, lastMonths, shortMonth, delta, barChart } from './shared.js';
import { readPendingStay, clearPendingStay } from './scan.js';
import { helpButton, problemLink, mountHelp, topicLabel, alertStatus } from './help.js';

const MAX_RECEIPT = 1.5 * 1024 * 1024;
export const TERMS_VERSION = 'v1 · 30/10/2026';
const ME_KEY = 'kombrio-partner';
// v68 : libellé de la commission — « 10 % » ou « R$ 10,00 / cliente » (forfait figé sur le passage, sinon celui du partenaire).
const rateText = (partner, visit, c) => {
  const pp = visit ? (visit.perPersonCents ?? null) : (partner.commissionModel === 'per_person' ? partner.perPersonCents : null);
  const base = pp != null ? tRaw('rate.per_person', { amount: c(pp) }) : `${Math.round(((visit && visit.rate) ?? partner.commissionRate) * 100)} %`;
  const every = visit ? visit.bonusEvery : partner.bonusEvery;
  return every > 0 ? base + tRaw('rate.bonus', { amount: c((visit ? visit.bonusCents : partner.bonusCents) || 0), n: every }) : base;
};
// v70 : offre valable aujourd'hui ? ligne « prix Kombrio » (prix normal → prix Kombrio).
const offerOn = (partner, city) => store.offerActive(partner, todayIn(city.timezone));
const priceLine = (partner, c) => (partner.offerPromoCents ? tRaw('offer.price', { promo: c(partner.offerPromoCents), price: c(partner.offerPriceCents) }) : '');
// v69 : repas offerts au guide présent sur ce passage.
const mealsOf = (visit) => (visit.guidePresent ? (visit.meals || store.mealsFor(visit.mealEvery, visit.peopleServed)) : 0);

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
      <div class="card">
        <h2>${t('team.home.title')}</h2>
        <p class="hint">${t('team.home.hint')}</p>
        <a class="btn secondary block" href="#/equipe">${t('team.home.button')}</a>
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
  if (space.role === 'manager' && action === 'equipe') space.team = await store.staffList(token).catch(() => []);

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
  if (action === 'venda' || action === 'conta') return billView(space, visitId || '');
  if (space.role !== 'manager' && !['passage', 'deja', 'lancar', 'corrigir'].includes(action)) return spaceView(space);
  if (['visitas', 'pagamentos', 'equipe', 'config'].includes(action)) return spaceView(space, action);
  if (action === 'declarar') return declareManyView(space);
  if (action === 'pagar') return payView(space);
  if (action === 'relatorio') return reportPage(space, visitId);
  if (action === 'mes') return monthPage(space, visitId, space.closings);
  if (action === 'demonstrativo') return docPage(space, visitId, space.closings, `#/p/${encodeURIComponent(token)}/pagamentos`);
  const visit = space.visits.find((v) => v.id === visitId);
  if (!visit) return notFound();
  return scannedView(space, visit, action);
}

// Après le scan (caisse ou gérant) : passage enregistré, offre à accorder, puis saisie de l'addition (v59).
// La caisse peut saisir tout de suite (scan à l'addition) ou plus tard (« Lançar depois », avec le n° de table).
export function scannedView({ partner, city, key, role, visits }, visit, action) {
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const fresh = action === 'passage';
  const rate = visit.rate ?? partner.commissionRate;
  // v66 : le personnel ne voit jamais la commission ; il corrige son montant 15 min ; photo obligatoire dès 300 R$.
  const staff = role === 'staff';
  const fixing = staff && action === 'corrigir' && visit.canFix;
  const photoMin = 0;
  const photoNeeded = staff && partner.staffPhotoRequired;
  // v67 : groupe enregistré par son QR client seul → question obligatoire « O guia está com o grupo ? ».
  const ask = visit.status === 'visited' && visit.mode === 1 && !visit.guidePresent && !visit.direct;
  const back = `#/p/${encodeURIComponent(key)}`;
  let offer = '';
  const on = offerOn(partner, city);
  if (on && partner.offerPromoCents) offer += `<div class="notice ok"><b>${esc(priceLine(partner, c))}</b></div>`;
  if (on && partner.offer && fresh) {
    offer += visit.offerGiven
      ? `<div class="notice ok"><b>${t('partner.offer.give')}</b><div class="offer">${esc(partner.offer)}</div></div>`
      : `<div class="notice warn">${t('partner.offer.already')}</div>`;
  }
  const head = action === 'lancar' || action === 'corrigir' ? '' : `<div class="notice ${fresh ? 'ok' : 'warn'}"><b>${t(fresh ? 'partner.visit.saved' : 'partner.visit.duplicate')}</b></div>`;
  const info = `<div class="spread"><h2>${esc(visit.client)}</h2><span class="hint">${esc(store.visitRef(visit))}</span></div>
        <p class="hint">${t('partner.visit.guide', { guide: visit.guideName })} · ${sinceLabel(visit.at, lang, city.timezone)}${visit.guidePresent ? ` · <span class="badge ok">${t('rs.present')}</span>` : ''}</p>`;
  if (visit.status !== 'visited' && !fixing) {
    return {
      html: `${head}${offer}<div class="card">${info}
        <p>${t('scan.people', { n: visit.peopleServed })}${visit.tableLabel ? ` · ${t('rs.table.short', { n: visit.tableLabel })}` : ''}</p>
        ${visit.invoiceCents != null ? `<p>${staff ? t('staff.bill.done', { bill: c(visit.invoiceCents) }) : t('rs.bill.done', { bill: c(visit.invoiceCents), com: c(visit.declaredCents || 0) })}</p>` : ''}
        ${staff && visit.canFix ? `<a class="btn secondary small" href="${back}/corrigir/${esc(visit.id)}">${t('staff.fix')}</a>` : ''}
        ${mealsOf(visit) ? `<p><b>${t('meal.due', { n: mealsOf(visit) })}</b></p>` : ''}
        ${visit.guideMeal ? `<p class="hint">${t('rs.meal.done')}</p>` : ''}</div>
        <a class="btn ghost" href="${back}">${t(role === 'manager' ? 'partner.space' : 'counter.back')}</a>`,
    };
  }
  // Autres groupes en attente (16 dernières heures) : même addition partagée.
  const others = fixing ? [] : (visits || []).filter((v) => v.id !== visit.id && v.status === 'visited' && Date.now() - new Date(v.at) < 16 * 36e5);
  const photoField = `<label class="btn ghost small rs-photo-btn" for="rs-ph">${t('rs.photo.btn')}</label>
          <input id="rs-ph" name="photo" type="file" accept="image/*" capture="environment" hidden>
          <span class="hint" id="rs-ph-name">${staff ? (visit.hasPhoto ? t('rs.photo.ok') : t(photoNeeded ? 'staff.photo.hint' : 'staff.photo.opt')) : t('rs.photo.hint')}</span>`;
  const amount0 = fixing && visit.invoiceCents != null ? (visit.invoiceCents / 100).toFixed(2).replace('.', ',') : '';
  return {
    html: `${head}${offer}
      <form class="card" id="rs">
        ${info}
        ${mealsOf(visit) ? `<div class="notice ok"><b>${t('meal.due', { n: mealsOf(visit) })}</b></div>` : ''}
        ${ask ? `<div class="notice warn" id="rs-ask"><div id="rs-ask-card" class="bill-card"></div><b>${t('bill.ask')}</b>
          <div class="row" style="gap:8px;margin-top:8px"><button type="button" class="btn small" data-ask="yes">${t('bill.ask.yes')}</button>
            <button type="button" class="btn ghost small" data-ask="no">${t('bill.ask.no')}</button></div>
          <div id="rs-gp" hidden style="margin-top:10px"><label for="rs-g">${t('bill.guide')}</label>
            <div class="row" style="gap:6px;flex-wrap:nowrap"><button type="button" class="btn secondary" id="rs-gscan">📷</button>
              <input id="rs-g" autocomplete="off" placeholder="${esc(tRaw('bill.guide.code.ph'))}" autocapitalize="characters"></div>
            <p class="hint" style="margin:4px 0 0">${t('bill.ask.yes.hint')}</p></div></div>` : ''}
        <div class="field"><label for="rs-b1">${t('rs.bill')}</label>
          <div id="rs-bills"><input id="rs-b1" class="rs-bill rs-big" inputmode="decimal" placeholder="${esc(city.currency)} 0,00" aria-label="${esc(tRaw('rs.bill'))}" value="${amount0}"></div>
          <button type="button" class="btn ghost small" id="rs-add">${t('rs.bill.add')}</button></div>
        ${staff ? `<div class="field">${photoField}</div>` : ''}
        <div class="field"${staff ? ' hidden' : ''}><label for="rs-c">${t('rs.com', { rate: rateText(partner, visit, c) })}</label>
          <input id="rs-c" name="com" inputmode="decimal" placeholder="—">
          <p class="hint" style="margin:4px 0 0" id="rs-c-hint">${t('rs.com.hint')}</p></div>
        <div class="field" id="rs-note-f" hidden><label for="rs-note">${t('rs.note')}</label><input id="rs-note" name="note" maxlength="200"></div>
        <div class="grid2 rs-keep2">
          <div class="field"><label for="rs-n">${t('rs.people')}</label>
            <input id="rs-n" name="n" type="number" min="1" max="500" step="1" inputmode="numeric" value="${visit.peopleServed}"></div>
          <div class="field"><label for="rs-t">${t('rs.table')}</label>
            <input id="rs-t" name="table" maxlength="20" value="${esc(visit.tableLabel)}" placeholder="${t('rs.table.ph')}"></div>
        </div>
        <details class="rs-more"><summary>${t('rs.more')}</summary>
          <label style="font-weight:400;display:flex;gap:10px;align-items:center;margin:10px 0">
            <input type="checkbox" name="meal" style="width:auto"${mealsOf(visit) ? ' checked' : ''}> ${t('rs.meal')}</label>
          ${visit.mealEvery > 0 ? `<p class="hint" style="margin:-4px 0 8px">${t('meal.rule', { n: visit.mealEvery })}</p>` : ''}
          ${staff ? '' : photoField}
          ${others.length ? `<div class="field" style="margin-top:12px"><b>${t('rs.split')}</b>
            <p class="hint" style="margin:2px 0 6px">${t('rs.split.hint')}</p>
            ${others.map((v) => `<label style="font-weight:400;display:flex;gap:8px"><input type="checkbox" name="with" value="${esc(v.id)}" style="width:auto">
              ${esc(v.client || '?')} · ${t('scan.people', { n: v.peopleServed })}${v.tableLabel ? ` · ${t('rs.table.short', { n: v.tableLabel })}` : ''}</label>`).join('')}
          </div>` : ''}
          <p class="hint" style="margin:12px 0 0">${t('bill.rule')}</p>
        </details>
        <button class="btn block" id="rs-save">${t('rs.save')}</button>
        <div class="row" style="gap:8px;margin-top:8px">
          <button type="button" class="btn secondary" id="rs-later" style="flex:1"${fixing ? ' hidden' : ''}>${t('rs.later')}</button>
          <button type="button" class="btn ghost" id="rs-zero" style="flex:1">${t('rs.zero')}</button>
        </div>
      </form>
      <a class="btn ghost" href="${back}">${t(role === 'manager' ? 'partner.space' : 'counter.back')}</a>`,
    mount(root, ctx) {
      const f = root.querySelector('#rs');
      const b1 = root.querySelector('#rs-b1'); if (b1 && !visit.tableLabel) b1.focus();
      f.photo.onchange = () => { root.querySelector('#rs-ph-name').textContent = f.photo.files[0] ? tRaw('rs.photo.ok') : staff ? tRaw(photoNeeded ? 'staff.photo.hint' : 'staff.photo.opt') : tRaw('rs.photo.hint'); };
      // v67 : réponse à « O guia está com o grupo ? » (obligatoire avant d'enregistrer).
      let answer = ask ? null : 'no';
      if (ask) {
        store.visitGuideCard(key, visit.id).then((g) => { const el = root.querySelector('#rs-ask-card'); if (el && g) el.innerHTML = guideCardHtml(g); }).catch(() => {});
        root.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = () => {
          answer = b.dataset.ask;
          root.querySelectorAll('[data-ask]').forEach((x) => x.classList.toggle('ghost', x !== b));
          root.querySelector('#rs-gp').hidden = answer !== 'yes';
          if (answer === 'yes') root.querySelector('#rs-g').focus();
        }; });
        root.querySelector('#rs-gscan').onclick = async () => { const txt = await scanQr(); const ref = refOf(txt); if (ref) root.querySelector('#rs-g').value = ref; else if (txt) notify(tRaw('bill.err.qr')); };
      }
      // Avant d'enregistrer : la question est répondue ; « Sim » → le guide est identifié (mode 2).
      const guideStep = async () => {
        if (answer == null) { notify(tRaw('bill.ask.err')); root.querySelector('#rs-ask').scrollIntoView({ block: 'center' }); return false; }
        if (answer !== 'yes') return true;
        const ref = root.querySelector('#rs-g').value.trim();
        if (!ref) { notify(tRaw('bill.ask.guide')); root.querySelector('#rs-g').focus(); return false; }
        const r = await store.setVisitGuide(key, visit.id, ref).catch(() => null);
        if (!r || !r.ok) { notify(saveError(r, c, 0)); return false; }
        answer = 'done';
        return true;
      };
      const total = () => { const list = [...f.querySelectorAll('.rs-bill')].map((i) => i.value.trim()).filter(Boolean).map(parseCents);
        return list.some((x) => x == null) ? null : list.length ? list.reduce((a, b) => a + b, 0) : null; };
      const withIds = () => [...f.querySelectorAll('[name=with]:checked')].map((b) => b.value);
      const peopleOf = (id) => (id === visit.id ? Number(f.n.value) || visit.peopleServed : (visits.find((v) => v.id === id) || {}).peopleServed || 1);
      // Part de cette visite si l'addition est partagée (au prorata des personnes ; le reste des centavos va à cette visite).
      const shares = (sum) => {
        const ids = [visit.id, ...withIds()];
        const ppl = ids.reduce((a, id) => a + peopleOf(id), 0);
        const out = ids.map((id) => ({ id, cents: Math.floor((sum * peopleOf(id)) / ppl) }));
        out[0].cents += sum - out.reduce((a, x) => a + x.cents, 0);
        return out;
      };
      let comTouched = false;
      const upd = () => {
        const sum = total();
        const mine = sum == null ? null : shares(sum)[0].cents;
        const calc = mine == null ? null : store.commissionFor(partner, visit, mine, Number(f.n.value) || visit.peopleServed);
        if (!comTouched) f.com.value = calc == null ? '' : (calc / 100).toFixed(2).replace('.', ',');
        const hint = root.querySelector('#rs-c-hint');
        hint.textContent = calc == null ? tRaw('rs.com.hint') : tRaw('rs.com.calc', { bill: c(mine), com: c(calc) });
        const typed = parseCents(f.com.value);
        root.querySelector('#rs-note-f').hidden = !(calc != null && typed != null && typed < calc);
      };
      f.addEventListener('input', (e) => { if (e.target === f.com) comTouched = f.com.value.trim() !== ''; upd(); });
      f.addEventListener('change', upd);
      root.querySelector('#rs-add').onclick = () => {
        const i = document.createElement('input'); i.className = 'rs-bill rs-big'; i.inputMode = 'decimal'; i.placeholder = `${city.currency} 0,00`; i.style.marginTop = '6px';
        root.querySelector('#rs-bills').appendChild(i); i.focus();
      };
      const people = async () => {
        const n = Number(f.n.value);
        if (!Number.isInteger(n) || n < 1 || n > 500) { notify(tRaw('partner.people.err')); return false; }
        if (n !== visit.peopleServed) await store.setPeopleServed(key, visit.id, n).catch(() => false);
        return true;
      };
      const busy = (on) => f.querySelectorAll('button').forEach((b) => { b.disabled = on; });
      f.onsubmit = async (e) => {
        e.preventDefault();
        const sum = total();
        if (sum == null) { notify(tRaw('rs.err.bill')); return; }
        const parts = shares(sum);
        const calc = store.commissionFor(partner, visit, parts[0].cents, Number(f.n.value) || visit.peopleServed);
        let com = f.com.value.trim() === '' ? calc : parseCents(f.com.value);
        if (com == null || com > calc) { notify(tRaw('rs.err.com', { max: c(calc) })); return; }
        const file = f.photo.files && f.photo.files[0];
        if (photoNeeded && !file && !visit.hasPhoto && parts[0].cents > 0) {
          notify(tRaw('staff.photo.required')); f.photo.click(); return; }
        busy(true);
        try {
          if (!(await guideStep())) { busy(false); return; }
          if (!(await people())) { busy(false); return; }
          let photo = null;
          if (file) photo = await photoToJpeg(file, 1000, 0.7).catch(() => null);
          const r = await store.declareVisit(key, visit.id, { invoiceCents: parts[0].cents, commissionCents: staff || com === calc ? null : com,
            guideMeal: f.meal.checked, table: f.table.value, photo, note: f.note.value });
          if (!r || !r.ok) { busy(false); notify(saveError(r, c, photoMin)); return; }
          for (const x of parts.slice(1)) await store.declareVisit(key, x.id, { invoiceCents: x.cents, table: f.table.value, note: tRaw('rs.split.note'), photo: staff ? photo : null }).catch(() => null);
          ctx.go(`p/${key}`, staff ? tRaw('staff.saved', { bill: c(r.invoice_cents) }) : tRaw('rs.saved', { com: c(r.declared_cents) }));
        } catch { busy(false); notify(tRaw('err.generic')); }
      };
      root.querySelector('#rs-later').onclick = async () => {
        busy(true);
        try {
          if (!(await guideStep())) { busy(false); return; }
          if (!(await people())) { busy(false); return; }
          if (f.table.value.trim() !== visit.tableLabel) await store.setVisitTable(key, visit.id, f.table.value);
          ctx.go(`p/${key}`, tRaw('rs.later.saved'));
        } catch { busy(false); notify(tRaw('err.generic')); }
      };
      root.querySelector('#rs-zero').onclick = async () => {
        if (!confirm(tRaw('rs.zero.confirm'))) return;
        busy(true);
        try { await store.visitNoConsumption(key, visit.id); ctx.go(`p/${key}`, tRaw('rs.zero.saved')); }
        catch { busy(false); notify(tRaw('err.generic')); }
      };
    },
  };
}

// v63 : « Venda sem QR do cliente » — comme la planilha : le guide et le montant de la vente, pour CETTE boutique.
function saleButton(key) {
  return `<div class="card vd-card"><div class="spread" style="align-items:center"><span><b>${t('bill.button')}</b><br><span class="hint">${t('bill.button.hint')}</span></span>
    <a class="btn" href="#/p/${encodeURIComponent(key)}/conta">${t('bill.new')}</a></div></div>`;
}
// v66 : message d'erreur d'une saisie (addition ou vente directe).
function saveError(r, c, photoMin) {
  const reason = r && r.reason;
  if (reason === 'photo_required') return tRaw('staff.photo.required');
  if (['quota', 'fix_late'].includes(reason)) return tRaw(`staff.err.${reason}`);
  if (['gg_expired', 'guide', 'guide_status', 'client', 'other_guide', 'mismatch', 'empty', 'expired', 'notyet', 'people'].includes(reason)) return tRaw(`bill.err.${reason}`);
  return tRaw(['amount', 'commission', 'already', 'counter_late', 'photo'].includes(reason) ? `rs.err.${reason}` : 'err.generic');
}
// v67 : scanner de QR dans l'app (caméra arrière) : BarcodeDetector si le téléphone le permet, sinon jsQR.
const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
export const refOf = (text) => { const m = String(text || '').match(/(GG-[a-f0-9]{64}|B-[a-f0-9]{32}|C-[a-f0-9]{32})/); return m ? m[1] : null; };
const loadScript = (src) => new Promise((resolve, reject) => {
  if (window.jsQR) { resolve(); return; }
  const el = document.createElement('script'); el.src = src; el.onload = resolve; el.onerror = reject; document.head.appendChild(el);
});
export function scanQr() {
  const box = document.createElement('div'); box.className = 'qr-scan';
  box.innerHTML = `<video playsinline muted></video><p>${esc(tRaw('bill.scan.hint'))}</p><button type="button" class="btn secondary">${esc(tRaw('bill.scan.cancel'))}</button>`;
  document.body.appendChild(box);
  const video = box.querySelector('video'); let stream = null; let done = false;
  const stop = () => { done = true; if (stream) stream.getTracks().forEach((x) => x.stop()); box.remove(); };
  return new Promise((resolve) => {
    box.querySelector('button').onclick = () => { stop(); resolve(null); };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (done) { stream.getTracks().forEach((x) => x.stop()); return; }
        video.srcObject = stream; await video.play();
        let detector = null;
        if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
        if (!detector) await loadScript(JSQR);
        const canvas = document.createElement('canvas'); const g = canvas.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
          if (done) return;
          try {
            let text = null;
            if (video.readyState >= 2) {
              if (detector) { const codes = await detector.detect(video); text = codes[0] && codes[0].rawValue; }
              else {
                canvas.width = video.videoWidth; canvas.height = video.videoHeight; g.drawImage(video, 0, 0);
                const img = g.getImageData(0, 0, canvas.width, canvas.height); const res = window.jsQR(img.data, img.width, img.height); text = res && res.data;
              }
            }
            if (text) { stop(); resolve(text); return; }
          } catch { /* image suivante */ }
          setTimeout(tick, 200);
        };
        tick();
      } catch { stop(); notify(tRaw('bill.scan.err')); resolve(null); }
    })();
  });
}

// Petite carte : photo, nom et code du guide (pour voir tout de suite s'il est là).
function guideCardHtml(g) {
  if (!g) return '';
  const shown = g.badge_name || g.name || '?';
  const ini = String(shown).split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const ph = g.photo && String(g.photo).startsWith('data:image/') ? `<img src="${esc(g.photo)}" alt="">` : `<span class="bill-ini">${esc(ini)}</span>`;
  return `<div class="bill-guide">${ph}<span><b>${esc(shown)}</b><br><span class="hint">${t('bill.guide.of', { code: g.code || '—' })}</span></span></div>`;
}

// v67 : la fiche du serveur. Deux cas : « Guia presente » (mode 2) ou « Só clientes » (mode 1). Scan ou code, puis le montant.
export function billView({ partner, city, key, role }, preset = '') {
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const staff = role === 'staff';
  const photoNeeded = staff && partner.staffPhotoRequired;
  const back = `#/p/${encodeURIComponent(key)}`;
  const scanBtn = (what) => `<button type="button" class="btn secondary" data-scan="${what}">📷 ${t('bill.scan')}</button>`;
  return {
    html: `<form class="card" id="bill" autocomplete="off">
        <div class="spread"><h1 style="margin:0">${t('bill.title')}</h1><span class="hint">${esc(partner.name)}</span></div>
        <p class="hint">${t('bill.hint')}</p>
        <div class="bill-cases">
          <label class="bill-case"><input type="radio" name="case" value="guide"><span><b>${t('bill.case.guide')}</b><br><small>${t('bill.case.guide.hint')}</small></span></label>
          <label class="bill-case"><input type="radio" name="case" value="clients"><span><b>${t('bill.case.clients')}</b><br><small>${t('bill.case.clients.hint')}</small></span></label>
        </div>
        <div id="b-guide" hidden>
          <div class="field"><label for="b-g">${t('bill.guide')}</label>
            <div class="row bill-in">${scanBtn('guide')}<input id="b-g" placeholder="${esc(tRaw('bill.guide.ph'))}"></div>
            <div id="b-g-list" class="vd-list"></div></div>
          <div id="b-g-card"></div>
        </div>
        <div id="b-client" hidden>
          <div class="field"><label for="b-c">${t('bill.client')} <span class="hint" id="b-c-opt">${t('bill.optional')}</span></label>
            <div class="row bill-in">${scanBtn('client')}<input id="b-c" maxlength="6" autocapitalize="characters" placeholder="${esc(tRaw('bill.client.ph'))}" style="text-transform:uppercase"></div></div>
          <div id="b-c-card"></div>
          <div id="b-ask" class="notice warn" hidden><b>${t('bill.ask')}</b>
            <div class="row" style="gap:8px;margin-top:8px"><button type="button" class="btn small" data-ask="yes">${t('bill.ask.yes')}</button>
              <button type="button" class="btn ghost small" data-ask="no">${t('bill.ask.no')}</button></div></div>
        </div>
        <div id="b-rest" hidden>
          <div class="field"><label for="b-v">${t('bill.amount')}</label>
            <input id="b-v" name="amount" class="rs-big" inputmode="decimal" placeholder="${esc(city.currency)} 0,00"></div>
          <div class="grid2 rs-keep2">
            <div class="field"><label for="b-n">${t('rs.people')}</label><input id="b-n" name="n" type="number" min="1" max="500" step="1" inputmode="numeric" value="1"></div>
            <div class="field"><label for="b-t">${t('rs.table')}</label><input id="b-t" name="table" maxlength="20" placeholder="${t('rs.table.ph')}"></div>
          </div>
          <div class="field"><label class="btn ghost small rs-photo-btn" for="b-ph">${t('bill.photo')}</label>
            <input id="b-ph" name="photo" type="file" accept="image/*" capture="environment" hidden>
            <span class="hint" id="b-ph-name">${t(photoNeeded ? 'staff.photo.hint' : 'staff.photo.opt')}</span></div>
          ${staff ? '' : `<details class="rs-more"><summary>${t('bill.com.more')}</summary>
            <div class="field" style="margin-top:8px"><label for="b-com">${t('bill.com', { rate: rateText(partner, null, c) })}</label>
              <input id="b-com" name="com" inputmode="decimal" placeholder="—"><p class="hint" style="margin:4px 0 0">${t('bill.com.hint')}</p></div>
            <div class="field"><label for="b-note">${t('rs.note')}</label><input id="b-note" name="note" maxlength="200"></div></details>`}
          <button class="btn block" id="b-save">${t('bill.save')}</button>
          <button type="button" class="btn secondary block" id="b-arrive" style="margin-top:8px" hidden>${t('bill.arrive')}</button>
        </div>
      </form>
      <a class="btn ghost" href="${back}">${t(role === 'manager' ? 'partner.space' : 'counter.back')}</a>`,
    mount(root, ctx) {
      const f = root.querySelector('#bill');
      const $ = (sel) => root.querySelector(sel);
      // État de la fiche : le cas, le guide (QR « Guia + grupo », crachá ou code), le client (QR ou code), la réponse à la question.
      const st = { mode: null, guide: null, client: null, group: null, answer: null };
      const show = () => {
        const guideCase = st.mode === 'guide';
        $('#b-guide').hidden = !guideCase;
        $('#b-client').hidden = !st.mode || (guideCase && !!st.group);
        $('#b-c-opt').hidden = !guideCase;
        $('#b-ask').hidden = !(st.mode === 'clients' && st.client && !st.answer);
        const ready = guideCase ? !!st.guide : (!!st.client && st.answer === 'no');
        $('#b-rest').hidden = !ready;
        $('#b-arrive').hidden = !(ready && (st.client || st.group));
        f.querySelectorAll('[name=case]').forEach((r) => { r.checked = r.value === st.mode; r.closest('label').classList.toggle('on', r.checked); });
      };
      const setMode = (m) => { st.mode = m; if (m === 'guide' && st.answer !== 'yes') st.answer = null; show(); };
      f.querySelectorAll('[name=case]').forEach((r) => { r.onchange = () => setMode(r.value); });
      const card = (el, html) => { $(el).innerHTML = html; };
      const setGuide = async (ref, label) => {
        const r = await store.identifyRef(key, ref).catch(() => null);
        if (!r || !r.ok || r.kind === 'client') { notify(saveError(r && r.ok ? { reason: 'guide' } : r, c, 0)); return; }
        st.guide = ref; st.group = r.kind === 'guide_group' ? r.client : null;
        if (st.mode !== 'guide') setMode('guide');
        $('#b-g').value = label || (r.guide.badge_name || r.guide.name);
        card('#b-g-card', `${guideCardHtml(r.guide)}${st.group ? `<p class="bill-client">✓ ${t('bill.group', { client: st.group.client, n: st.group.people })}</p>` : ''}`);
        if (st.group) { f.n.value = st.group.people; st.client = null; card('#b-c-card', ''); }
        show(); if (!$('#b-rest').hidden) f.amount.focus();
      };
      const setClient = async (ref) => {
        const r = await store.identifyRef(key, ref).catch(() => null);
        if (!r || !r.ok || r.kind !== 'client') { notify(tRaw('bill.err.client')); return; }
        if (!r.client.valid) { notify(tRaw('bill.err.expired')); return; }
        if (st.mode === 'guide' && st.group) { notify(tRaw('bill.err.mismatch')); return; }
        st.client = ref; if (!st.mode) st.mode = 'clients';
        $('#b-c').value = r.client.code || '';
        f.n.value = r.client.people;
        card('#b-c-card', `<p class="bill-client">✓ ${t('bill.group', { client: r.client.client, n: r.client.people })}</p>${st.mode === 'clients' ? guideCardHtml(r.guide) : ''}`);
        show();
      };
      // Scanner : le type du QR décide (crachá ou « Guia + grupo » → guide ; QR client → client).
      root.querySelectorAll('[data-scan]').forEach((b) => { b.onclick = async () => {
        const txt = await scanQr(); if (!txt) return;
        const ref = refOf(txt);
        if (!ref) { notify(tRaw('bill.err.qr')); return; }
        if (ref.startsWith('C-')) await setClient(ref); else await setGuide(ref);
      }; });
      // Code ou nom du guide tapé : suggestions (guides validés de la ville).
      let timer = null; const q = $('#b-g'); const list = $('#b-g-list');
      q.addEventListener('input', () => {
        st.guide = null; st.group = null; card('#b-g-card', ''); show(); clearTimeout(timer);
        const v = q.value.trim(); if (v.length < 2) { list.innerHTML = ''; return; }
        timer = setTimeout(async () => {
          const found = await store.findGuides(key, v).catch(() => []);
          list.innerHTML = found.length ? found.map((g) => `<button type="button" class="vd-opt" data-code="${esc(g.code)}" data-label="${esc(`${g.badge_name || g.name} · ${g.code}`)}"><b>${esc(g.badge_name || g.name)}</b> <span class="hint">${esc(g.name)} · ${esc(g.code)}</span></button>`).join('')
            : `<p class="hint" style="margin:6px 0">${t('vd.guide.none')}</p>`;
          list.querySelectorAll('[data-code]').forEach((b) => { b.onclick = () => { list.innerHTML = ''; setGuide(b.dataset.code, b.dataset.label); }; });
        }, 250);
      });
      // Code client tapé (6 lettres).
      $('#b-c').addEventListener('input', (e) => {
        const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
        st.client = null; st.answer = st.mode === 'guide' ? st.answer : null; card('#b-c-card', ''); show();
        if (v.length === 6) setClient(v);
      });
      root.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = () => {
        if (b.dataset.ask === 'yes') { st.answer = 'yes'; setMode('guide'); notify(tRaw('bill.ask.yes.hint')); q.focus(); }
        else { st.answer = 'no'; show(); f.amount.focus(); }
      }; });
      f.photo.onchange = () => { $('#b-ph-name').textContent = f.photo.files[0] ? tRaw('rs.photo.ok') : tRaw(photoNeeded ? 'staff.photo.hint' : 'staff.photo.opt'); };
      const send = async (withAmount) => {
        const sum = withAmount ? parseCents(f.amount.value) : null;
        if (withAmount && (sum == null || sum <= 0)) { notify(tRaw('vd.err.amount')); f.amount.focus(); return; }
        const file = f.photo.files && f.photo.files[0];
        if (withAmount && photoNeeded && !file) { notify(tRaw('staff.photo.required')); f.photo.click(); return; }
        let com = null;
        if (withAmount && f.com && f.com.value.trim()) {
          const calc = store.commissionFor(partner, null, sum, Number(f.n.value) || 1);
          com = parseCents(f.com.value);
          if (com == null || com > calc) { notify(tRaw('rs.err.com', { max: c(calc) })); return; }
        }
        const n = Number(f.n.value) || 1;
        f.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try {
          const photo = withAmount && file ? await photoToJpeg(file, 1000, 0.7).catch(() => null) : null;
          const r = await store.recordBill(key, { guide: st.mode === 'guide' ? st.guide : null, client: st.client, invoiceCents: sum, people: n,
            table: f.table.value || null, photo, note: f.note ? f.note.value || null : null, commissionCents: com });
          if (!r || !r.ok) { f.querySelectorAll('button').forEach((x) => { x.disabled = false; }); notify(saveError(r, c, 0)); return; }
          const msg = tRaw(r.mode === 2 ? 'bill.saved.2' : 'bill.saved.1', { guide: r.guide || '', bill: sum == null ? '' : c(sum) })
            + (r.meals ? ` · ${tRaw('meal.due', { n: r.meals })}` : '');
          if (!r.client) ctx.go(`p/${key}`, msg);
          else ctx.go(`p/${key}/${r.duplicate ? 'deja' : 'passage'}/${r.visit_id}`, msg);
        } catch { f.querySelectorAll('button').forEach((x) => { x.disabled = false; }); notify(tRaw('err.generic')); }
      };
      f.onsubmit = (e) => { e.preventDefault(); send(true); };
      $('#b-arrive').onclick = () => send(false);
      // Arrivée avec un QR déjà lu (crachá depuis la page du guide, QR « Guia + grupo » ouvert par l'appareil photo).
      const pre = refOf(preset);
      if (pre) { if (pre.startsWith('C-')) setClient(pre); else setGuide(pre); }
      show();
    },
  };
}

// v60 : « há 20 min », « há 2 h », sinon la date et l'heure.
function sinceLabel(iso, lang, tz) {
  const min = Math.round((Date.now() - new Date(iso)) / 6e4);
  if (min < 1) return tRaw('rs.ago.now');
  if (min < 60) return tRaw('rs.ago.min', { n: min });
  if (min < 12 * 60) return tRaw('rs.ago.h', { n: Math.floor(min / 60) });
  return fmtMoment(iso, lang, tz);
}

// v59 : « Pendentes agora » — les groupes scannés sans addition (16 dernières heures), pour la caisse et le gérant.
function pendingCard({ city, visits, key }) {
  const lang = getLang();
  const list = visits.filter((v) => v.status === 'visited' && Date.now() - new Date(v.at) < 16 * 36e5)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  if (!list.length) return '';
  return `<div class="card rs-pend"><div class="spread"><h2 style="margin:0">${t('rs.pending')}</h2><span class="badge warn">${list.length}</span></div>
    <ul class="list">${list.map((v) => `<li><div class="spread" style="align-items:center">
      <span>${v.tableLabel ? `<b class="rs-table">${t('rs.table.short', { n: v.tableLabel })}</b> · ` : ''}<b>${esc(v.client || '?')}</b>
        <br><span class="hint">${t('scan.people', { n: v.peopleServed })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })} · ${t('rs.arrived', { at: sinceLabel(v.at, lang, city.timezone) })}${v.guidePresent ? ` · ${t('rs.present')}` : ''}</span></span>
      <span class="row" style="gap:6px"><a class="btn small" href="#/p/${encodeURIComponent(key)}/lancar/${esc(v.id)}">${t('rs.launch')}</a>
        <button type="button" class="btn ghost small" data-zero="${esc(v.id)}">${t('rs.zero')}</button></span></div></li>`).join('')}</ul></div>`;
}
function mountPending(root, ctx, key) {
  root.querySelectorAll('[data-zero]').forEach((b) => { b.onclick = async () => {
    if (!confirm(tRaw('rs.zero.confirm'))) return;
    b.disabled = true;
    try { await store.visitNoConsumption(key, b.dataset.zero); ctx.refresh(tRaw('rs.zero.saved')); } catch { b.disabled = false; notify(tRaw('err.generic')); }
  }; });
  // Mise à jour automatique toutes les 30 s (sauf pendant une saisie).
  clearInterval(window.kbPendTimer);
  const here = location.hash;
  window.kbPendTimer = setInterval(() => {
    if (location.hash !== here) { clearInterval(window.kbPendTimer); return; }
    const a = document.activeElement;
    if (!a || !a.matches('input, textarea, select')) ctx.refresh();
  }, 30000);
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
const PD_TABS = ['painel', 'visitas', 'pagamentos', 'equipe', 'config'];
const ageDays = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 864e5) : 0);
const doneKey = (pid, month) => `kb-todo-${pid}-${month}`;
const readDone = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch { return new Set(); } };
const saveDone = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])); } catch { /* rien */ } };

export function spaceView(space, tab = 'painel') {
  const { partner, city, visits, payments, adjustments = [], alerts = [], closings = [], key, role, loggedIn } = space;
  if (role === 'staff') return staffView(space);
  if (role !== 'manager') return counterView({ partner, city, visits, key });
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const base = `#/p/${encodeURIComponent(key)}`;
  const month = monthOf(new Date().toISOString(), city.timezone);
  const rate = Math.round(partner.commissionRate * 100);
  const rateLbl = rateText(partner, null, c);
  const toDeclare = visits.filter((v) => v.status === 'visited');
  const toPay = visits.filter((v) => v.status === 'declared');
  const extraDue = adjustments.filter((a) => a.partnerStatus === 'extra_due');
  const payCents = toPay.reduce((s, v) => s + (v.dueCents || 0), 0) + extraDue.reduce((s, a) => s + a.deltaCents, 0);
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
      <span class="pd-who"><b>${esc(v.client || '?')}</b><small>${esc(v.guideName || '?')} · ${t('scan.people', { n: v.peopleServed })} · ${esc(store.visitRef(v))}${v.tableLabel ? ` · ${t('rs.table.short', { n: v.tableLabel })}` : ''}${v.statusNote && ['disputed', 'cancelled'].includes(v.status) ? ` · ${esc(v.statusNote)}` : ''}</small>${rowTags(v)}${alertOf(v.id) ? `<span class="badge">${t('alert.short', { num: alertOf(v.id).num, status: alertStatus(alertOf(v.id).status) })}</span>` : problemLink(v.id)}</span>
      <span class="pd-st">${statusBadge(v, 'partner')}</span>
      <span class="pd-i">${inv}</span>
      <span class="pd-num pd-com" data-com="${esc(v.id)}">${v.declaredCents == null ? '—' : c(v.declaredCents)}</span>
    </label>`;
  };
  const rowTags = (v) => {
    const tags = [];
    if (v.direct) tags.push(t('vd.tag'));
    if (v.mode === 2) tags.push(v.feeCents ? t('mode2.tag.fee', { fee: c(v.feeCents) }) : t('mode2.tag'));
    if (v.guidePresent && v.mode !== 2) tags.push(t('rs.present'));
    if (v.guideMeal) tags.push(t('rs.meal.tag'));
    if (v.computedCents != null && v.declaredCents != null && v.declaredCents < v.computedCents) tags.push(t('rs.reduced', { from: c(v.computedCents) }));
    if (v.declaredBy === 'counter') tags.push(t('rs.by.counter'));
    if (v.billStaff) tags.push(t('staff.tag.bill', { name: v.billStaff }));
    else if (v.scanStaff) tags.push(t('staff.tag.scan', { name: v.scanStaff }));
    const ph = v.hasPhoto ? ` <a href="#" data-photo="${esc(v.id)}">${t('rs.photo.see')}</a>` : '';
    return tags.length || ph ? `<small class="rs-tags">${tags.join(' · ')}${ph}</small>` : '';
  };
  const visitsCard = (title, list, filters) => `<div class="card pd-card">
      <div class="spread" style="padding:12px 14px 6px"><h2 style="margin:0">${title}</h2>
        ${filters ? `<select id="pd-filter" style="width:auto">${['all', 'visited', 'declared', 'verifying', 'paid'].map((f) => `<option value="${f}">${t(`pd.f.${f}`)}</option>`).join('')}</select>` : ''}</div>
      ${list.some((v) => v.status === 'visited') ? `<p class="hint" style="padding:0 14px;margin:0 0 6px">${t('bill.rule')}</p>` : ''}
      ${list.length ? `<div class="pd-rows"><div class="pd-row pd-head"><span></span><span>${t('pd.col.date')}</span><span>${t('pd.col.who')}</span><span>${t('pd.col.status')}</span><span class="pd-r">${t('pd.col.bill')}</span><span class="pd-r">${t('pd.col.com', { rate: rateLbl })}</span></div>
        ${list.map(row).join('')}</div>
        <div class="pd-bar"><span id="pd-sel">${t('pd.sel.none')}</span>
          <span class="row" style="gap:6px"><button class="btn secondary small" id="pd-declare" disabled>${t('pd.declare')}</button><button class="btn small" id="pd-pay" disabled>${t('pd.pay')}</button></span></div>`
      : `<p class="hint" style="padding:0 14px 14px">${t('pd.empty')}</p>`}
    </div>`;

  const todo = [];
  if (fresh || !partner.offer) todo.push(['offer', t('pd.todo.offer')]);
  if (fresh) todo.push(['qr', t('pd.todo.qr')], ['rate', t('pd.todo.rate', { rate: rateLbl })]);
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
      <div class="pd-kpi"><span>${t('dash.k.com')}</span><b>${c(now.com)}${delta(now.com, before.com)}</b><em>${t('pd.k.rate', { rate: rateLbl })}</em></div>
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
        <div class="field" style="display:grid;gap:6px">
          <label style="font-weight:400;display:flex;gap:10px;align-items:center"><input type="radio" name="model" value="percent" style="width:auto"${partner.commissionModel !== 'per_person' ? ' checked' : ''}> ${t('partner.model.percent')}</label>
          <label style="font-weight:400;display:flex;gap:10px;align-items:center"><input type="radio" name="model" value="per_person" style="width:auto"${partner.commissionModel === 'per_person' ? ' checked' : ''}> ${t('partner.model.per_person')}</label></div>
        <div id="m-percent"${partner.commissionModel === 'per_person' ? ' hidden' : ''}>
        <p class="hint">${t('partner.rate.hint')}</p>
        <div class="field"><select name="rate">${[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20].map((n) => `<option value="${n / 100}"${rate === n ? ' selected' : ''}>${n} %${n === 10 ? ` (${t('partner.rate.suggested')})` : ''}</option>`).join('')}</select></div></div>
        <div id="m-pp"${partner.commissionModel === 'per_person' ? '' : ' hidden'}>
          <div class="field"><label for="m-amount">${t('partner.model.amount')}</label>
            <input id="m-amount" name="pp" inputmode="decimal" placeholder="${esc(city.currency)} 10,00" value="${partner.perPersonCents ? (partner.perPersonCents / 100).toFixed(2).replace('.', ',') : ''}"></div>
          <p class="hint">${t('partner.model.hint')}</p></div>
        <button class="btn secondary">${t('common.save')}</button>
      </form>
      <form class="card" id="extras">
        <h2>${t('partner.extras.title')}</h2>
        <p class="hint">${t('partner.extras.hint')}</p>
        <div class="grid2 rs-keep2">
          <div class="field"><label for="x-bc">${t('partner.extras.bonus')}</label>
            <input id="x-bc" name="bc" inputmode="decimal" placeholder="0,00" value="${partner.bonusCents ? (partner.bonusCents / 100).toFixed(2).replace('.', ',') : ''}"></div>
          <div class="field"><label for="x-be">${t('partner.extras.every')}</label>
            <input id="x-be" name="be" type="number" min="0" max="50" step="1" inputmode="numeric" value="${partner.bonusEvery || ''}" placeholder="3"></div>
        </div>
        <div class="field"><label for="x-me">${t('partner.extras.meal')}</label>
          <input id="x-me" name="me" type="number" min="0" max="50" step="1" inputmode="numeric" value="${partner.mealEvery || ''}" placeholder="0" style="max-width:120px">
          <p class="hint" style="margin:4px 0 0">${t('partner.extras.meal.hint')}</p></div>
        <button class="btn secondary">${t('common.save')}</button>
      </form>
      <form class="card" id="offer">
        <h2>${t('partner.offer.title')}</h2>
        <p class="hint">${t('partner.offer.hint')}</p>
        <div class="field"><input name="offer" value="${esc(partner.offer || '')}" maxlength="120" placeholder="${t('partner.offer.none')}"></div>
        <p class="hint" style="margin:8px 0 4px"><b>${t('offer.price.title')}</b> ${t('offer.price.hint')}</p>
        <div class="grid2 rs-keep2">
          <div class="field"><label for="o-pr">${t('offer.price.normal')}</label><input id="o-pr" name="price" inputmode="decimal" placeholder="75,00" value="${partner.offerPriceCents ? (partner.offerPriceCents / 100).toFixed(2).replace('.', ',') : ''}"></div>
          <div class="field"><label for="o-pm">${t('offer.price.kombrio')}</label><input id="o-pm" name="promo" inputmode="decimal" placeholder="60,00" value="${partner.offerPromoCents ? (partner.offerPromoCents / 100).toFixed(2).replace('.', ',') : ''}"></div>
        </div>
        <div class="grid2 rs-keep2">
          <div class="field"><label for="o-st">${t('offer.start')}</label><input id="o-st" name="start" type="date" value="${esc(partner.offerStart)}"></div>
          <div class="field"><label for="o-en">${t('offer.end')}</label><input id="o-en" name="end" type="date" value="${esc(partner.offerEnd)}"></div>
        </div>
        <p class="hint" style="margin:0 0 8px">${t('offer.dates.hint')}</p>
        <button class="btn secondary">${t('common.save')}</button>
      </form>
      <div class="card" style="text-align:center">
        <h2>${t('partner.qr.title')}</h2>
        ${partner.counterEnabled ? '' : `<div class="notice warn">${t('team.counter.off')}</div>`}
        <p class="hint">${t('partner.qr.hint')} ${t('team.counter.see')} <a href="${base}/equipe">${t('pd.tab.equipe')}</a></p>
        <div class="qr">${qrSvg(appLink('partner', `p/${partner.token}`))}</div>
        <button class="btn ghost no-print" id="print">${t('partner.qr.print')}</button>
      </div>
      <div class="card no-print"><h2>${t('report.card')}</h2><p class="hint">${t('report.card.hint')}</p>
        <a class="btn secondary" href="${base}/relatorio">${t('report.open')}</a></div>
      <p class="hint no-print">${t('partner.linked', { name: partner.name })} <a href="#" id="unlink">${t('partner.unlink')}</a></p>`;

  // Les groupes de « Pendentes agora » (moins de 16 h) ne sont pas répétés dans « Visitas a tratar ».
  const inPending = (v) => v.status === 'visited' && Date.now() - new Date(v.at) < 16 * 36e5;
  const open = visits.filter((v) => ['visited', 'declared', 'verifying', 'disputed'].includes(v.status) && !inPending(v));
  const body = {
    painel: `${saleButton(key)}${pendingCard({ city, visits, key })}${steps}${kpis}<div class="pd-cols">${visitsCard(t('pd.totreat'), open, false)}<div class="pd-side">${chartCard}${todoCard}${adjustmentsCard(adjustments, city, lang)}${lastCard}${shortcuts}</div></div>`,
    visitas: visitsCard(t('pd.all'), visits, true),
    pagamentos: `<div class="pd-cols"><div class="pd-side">${visitsCard(t('pd.topay'), toPay, false)}${payHistory}</div><div class="pd-side">${docsCard}${adjustmentsCard(adjustments, city, lang)}</div></div>`,
    equipe: teamHtml(space),
    config: settings,
  }[tab];
  const counts = { painel: 0, visitas: toDeclare.length, pagamentos: toPay.length + extraDue.length, equipe: 0, config: 0 };
  const tabsNav = `<nav class="tabs no-print">${PD_TABS.map((k) => `<a href="${base}${k === 'painel' ? '' : `/${k}`}" class="${k === tab ? 'on' : ''}">${t(`pd.tab.${k}`)}${counts[k] ? `<span class="todo">${counts[k]}</span>` : ''}</a>`).join('')}</nav>`;

  return {
    html: `<div class="dash-wide">
      <div class="spread"><div><h1 style="margin-bottom:2px">${esc(partner.name)}</h1>
        <p class="hint" style="margin:0">${t(`ptype.${partner.type}`)}${partner.area ? ` · ${esc(partner.area)}` : ''} · ${t('pd.k.rate', { rate: rateLbl })}${partner.managerName ? ` · ${t('pm.hello', { name: partner.managerName })}` : ''}</p></div>
        <div class="row" style="gap:6px">${helpButton()}${loggedIn ? `<button class="btn ghost small no-print" id="logout">${t('common.logout')}</button>` : ''}</div></div>
      ${tabsNav}${banner}${body}</div>`,
    mount(root, ctx) {
      if (tab === 'painel') mountPending(root, ctx, key);
      if (tab === 'equipe') mountTeam(root, ctx, key);
      mountHelp(root, { kind: 'partner', send: (topic, msg, vId) => store.partnerCreateAlert(key, topic, msg, vId),
        findCode: (c) => visits.find((x) => x.code === c)?.id || null,
        label: (vId) => { const v = visits.find((x) => x.id === vId); return v ? `${v.client || ''} · ${fmtDay(v.at.slice(0, 10), getLang())} · ${store.visitRef(v)}` : ''; },
        onSent: () => ctx.refresh() });
      root.querySelectorAll('[data-photo]').forEach((a) => { a.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        const src = await store.visitBillPhoto(key, a.dataset.photo).catch(() => null);
        if (!src) { notify(tRaw('err.generic')); return; }
        const w = window.open(); if (w) { w.document.title = 'Kombrio'; const img = w.document.createElement('img'); img.src = src; img.style.maxWidth = '100%'; w.document.body.appendChild(img); }
      }; });
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
        const total = pay.reduce((s, v) => s + v.dueCents, 0) + decl.reduce((s, v) => s + (billOf(v) != null ? store.commissionFor(partner, v, billOf(v), v.peopleServed) : 0), 0);
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
          const com = root.querySelector(`[data-com="${v.id}"]`); if (com) com.textContent = cts == null ? '—' : c(store.commissionFor(partner, v, cts, v.peopleServed));
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
      if (rateForm) rateForm.querySelectorAll('[name=model]').forEach((r) => { r.onchange = () => {
        const pp = rateForm.model.value === 'per_person';
        rateForm.querySelector('#m-percent').hidden = pp; rateForm.querySelector('#m-pp').hidden = !pp;
        if (pp) rateForm.querySelector('#m-amount').focus();
      }; });
      if (rateForm) rateForm.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        if (fd.get('model') === 'per_person') {
          const pp = parseCents(String(fd.get('pp') || ''));
          if (pp == null || pp < 100 || pp > 50000) { notify(tRaw('partner.model.err')); return; }
          if (!(await store.setCommissionModel(key, 'per_person', pp))) { notify(tRaw('err.generic')); return; }
        } else {
          await store.setCommissionRate(key, Number(fd.get('rate')));
          if (partner.commissionModel === 'per_person') await store.setCommissionModel(key, 'percent');
        }
        ctx.refresh(tRaw('common.saved'));
      };
      const extrasForm = root.querySelector('#extras');
      if (extrasForm) extrasForm.onsubmit = async (e) => {
        e.preventDefault();
        const be = Number(extrasForm.be.value) || 0; const me = Number(extrasForm.me.value) || 0;
        const bc = extrasForm.bc.value.trim() ? parseCents(extrasForm.bc.value) : 0;
        const okB = (be === 0 && !bc) || (Number.isInteger(be) && be >= 1 && be <= 50 && bc != null && bc >= 100 && bc <= 50000);
        if (!okB || !Number.isInteger(me) || me < 0 || me > 50) { notify(tRaw('partner.extras.err')); return; }
        if (!(await store.setPartnerExtras(key, be && bc ? be : 0, be && bc ? bc : 0, me))) { notify(tRaw('err.generic')); return; }
        ctx.refresh(tRaw('common.saved'));
      };
      const offerForm = root.querySelector('#offer');
      if (offerForm) offerForm.onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const price = f.price.value.trim() ? parseCents(f.price.value) : null;
        const promo = f.promo.value.trim() ? parseCents(f.promo.value) : null;
        if ((price == null) !== (promo == null) || (promo != null && (promo <= 0 || promo >= price))) { notify(tRaw('offer.price.err')); return; }
        if (f.start.value && f.end.value && f.end.value < f.start.value) { notify(tRaw('offer.dates.err')); return; }
        const ok = await store.setPartnerOfferFull(key, { offer: f.offer.value, priceCents: price, promoCents: promo, start: f.start.value, end: f.end.value }).catch(() => false);
        if (!ok) { notify(tRaw('err.generic')); return; }
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
        <p class="hint">${t('partner.declare.free', { rate: rateText(partner, null, (n) => cents(n, city.currency, lang)) })}</p>
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
            <b>${c(v.dueCents)}${v.feeCents ? `<br><small class="hint">${t('mode2.pay.line', { com: c(v.declaredCents), fee: c(v.feeCents) })}</small>` : ''}</b>
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
        const total = chosen().reduce((s, v) => s + v.dueCents, 0);
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
  const payCents = toPay.reduce((s, v) => s + (v.dueCents || 0), 0) + extra;
  const verifying = visits.filter((v) => v.status === 'verifying').reduce((s, v) => s + (v.dueCents || 0), 0);
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
        ${T.fee_cents ? row(t('doc.t.fee'), c(T.fee_cents), true) : ''}
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
          <td>${l.invoice_cents != null ? c(l.invoice_cents) : '—'}</td><td>${l.per_person_cents != null ? esc(tRaw('rate.per_person', { amount: c(Number(l.per_person_cents)) })) : l.rate != null ? `${Math.round(Number(l.rate) * 100)} %` : '—'}</td><td>${l.commission_cents != null ? c(l.commission_cents) : '—'}${l.fee_cents ? `<br><small>${t('mode2.doc.fee', { fee: c(l.fee_cents) })}</small>` : ''}</td><td>${esc(pLabel(l.status))}</td></tr>`).join('')}
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
          l.per_person_cents != null ? tRaw('rate.per_person', { amount: (Number(l.per_person_cents) / 100).toFixed(2) }) : l.rate != null ? `${Math.round(Number(l.rate) * 100)}%` : '', num(l.commission_cents), pLabel(l.status)].map(cell));
        const sum = [[tRaw('doc.t.commission'), num(T.commission_cents)], [tRaw('doc.t.fee'), num(T.fee_cents || 0)], [tRaw('doc.t.received'), num(T.received_cents)], [tRaw('doc.t.guides'), num(T.guide_cents)],
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
  // Les groupes en attente sont déjà dans « Pendentes agora » : ici, seulement ceux déjà lancés.
  const done = visits.filter((v) => !(v.status === 'visited' && Date.now() - new Date(v.at) < 16 * 36e5));
  return {
    html: `
      <div class="spread"><h1>${esc(partner.name)}</h1>${helpButton()}</div>
      <div class="notice ok">${t('counter.ready')}</div>
      ${saleButton(key)}
      ${pendingCard({ city, visits, key })}
      ${offerOn(partner, city) && partner.offerPromoCents ? `<div class="card"><h2>${t('counter.offer')}</h2><div class="offer">${esc(priceLine(partner, (n) => cents(n, city.currency, getLang())))}</div></div>` : ''}
      ${offerOn(partner, city) && partner.offer ? `<div class="card"><h2>${t('counter.offer')}</h2><div class="offer">${esc(partner.offer)}</div><p class="hint" style="margin-top:8px">${t('counter.offer.hint')}</p></div>` : ''}
      <div class="card">
        <h2>${t('counter.today')}</h2>
        ${done.length ? `<ul class="list">${done.map((v) => `<li><div class="spread"><b>${esc(v.client || '?')}</b><span class="hint">${sinceLabel(v.at, lang, city.timezone)}</span></div>
          <div class="hint">${esc(store.visitRef(v))} · ${t('scan.people', { n: v.peopleServed })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}${v.tableLabel ? ` · ${t('rs.table.short', { n: v.tableLabel })}` : ''}</div>
          ${v.invoiceCents != null ? `<div>${t('rs.bill.done', { bill: cents(v.invoiceCents, city.currency, lang), com: cents(v.declaredCents || 0, city.currency, lang) })}</div>` : ''}</li>`).join('')}</ul>`
          : `<p class="hint">${t('partner.visits.none')}</p>`}
      </div>
      <p class="hint">${t('counter.manager')}</p>
      <p class="hint">${t('partner.linked', { name: partner.name })} <a href="#" id="unlink">${t('partner.unlink')}</a></p>`,
    mount(r, ctx) {
      mountPending(root(), ctx, key);
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

// v66 : téléphone d'une personne de l'équipe — scan, vente sans QR et passages du jour ; jamais de commission ni de gestion.
function staffView({ partner, city, visits, key, staff }) {
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const done = visits.filter((v) => !(v.status === 'visited' && Date.now() - new Date(v.at) < 16 * 36e5));
  const me = staff || { name: '', post: 'other' };
  return {
    html: `
      <div class="spread"><div><h1 style="margin-bottom:2px">${esc(partner.name)}</h1>
        <p class="hint" style="margin:0">${t('staff.hello', { name: me.name, post: tRaw(`staff.post.${me.post}`) })}</p></div>${helpButton()}</div>
      <div class="notice ok">${t('counter.ready')}</div>
      ${saleButton(key)}
      ${pendingCard({ city, visits, key })}
      ${offerOn(partner, city) && partner.offerPromoCents ? `<div class="card"><h2>${t('counter.offer')}</h2><div class="offer">${esc(priceLine(partner, (n) => cents(n, city.currency, getLang())))}</div></div>` : ''}
      ${offerOn(partner, city) && partner.offer ? `<div class="card"><h2>${t('counter.offer')}</h2><div class="offer">${esc(partner.offer)}</div><p class="hint" style="margin-top:8px">${t('counter.offer.hint')}</p></div>` : ''}
      <div class="card">
        <h2>${t('staff.today')}</h2>
        ${done.length ? `<ul class="list">${done.map((v) => `<li><div class="spread"><b>${esc(v.client || '?')}</b><span class="hint">${sinceLabel(v.at, lang, city.timezone)}</span></div>
          <div class="hint">${esc(store.visitRef(v))} · ${t('scan.people', { n: v.peopleServed })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}${v.tableLabel ? ` · ${t('rs.table.short', { n: v.tableLabel })}` : ''}</div>
          ${v.invoiceCents != null ? `<div class="spread" style="align-items:center"><span>${t('staff.bill.done', { bill: c(v.invoiceCents) })}${v.billStaff ? ` <span class="hint">· ${t('staff.by', { name: v.billStaff })}</span>` : ''}${v.hasPhoto ? ' 📷' : ''}</span>
            ${v.canFix ? `<a class="btn ghost small" href="#/p/${encodeURIComponent(key)}/corrigir/${esc(v.id)}">${t('staff.fix')}</a>` : ''}</div>` : ''}</li>`).join('')}</ul>`
          : `<p class="hint">${t('partner.visits.none')}</p>`}
      </div>
      <p class="hint">${t('staff.manager')}</p>
      <p class="hint">${t('partner.linked', { name: partner.name })} <a href="#" id="unlink">${t('partner.unlink')}</a></p>`,
    mount(r, ctx) {
      mountPending(root(), ctx, key);
      mountHelp(root(), { kind: 'partner', send: (topic, msg, vId) => store.partnerCreateAlert(key, topic, msg, vId),
        findCode: (code) => visits.find((x) => x.code === code)?.id || null });
      root().querySelector('#unlink').onclick = (e) => {
        e.preventDefault();
        if (!confirm(tRaw('staff.unlink.confirm'))) return;
        try { localStorage.removeItem(ME_KEY); } catch { /* rien */ }
        location.hash = '';
        notify(tRaw('partner.unlinked'));
      };
    },
  };
}

// v66 : onglet « Equipe » du gérant — ajouter une personne (lien + QR + code, 24 h), renvoyer un lien, retirer ; ancien QR caisse.
const TEAM_POSTS = ['reception', 'waiter', 'cashier', 'other'];
function teamHtml({ partner, city, team = [] }) {
  const lang = getLang();
  const invite = (m) => {
    const link = appLink('partner', `equipe/${m.invite.enroll_token}`);
    const msg = tRaw('team.wa', { name: m.name, partner: partner.name, link, code: m.invite.code });
    return `<div class="team-invite">
      <div class="qr">${qrSvg(link)}</div>
      <div><p style="margin:0 0 4px">${t('team.invite.scan')}</p>
        <p style="margin:0 0 4px">${t('team.invite.code', { code: m.invite.code })}</p>
        <p class="hint" style="margin:0 0 8px">${t('team.invite.until', { at: fmtMoment(m.invite.expires, lang, city.timezone) })}</p>
        <div class="row" style="gap:6px"><a class="btn small" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">${t('team.invite.wa')}</a>
          <button type="button" class="btn ghost small" data-copy="${esc(link)}">${t('team.invite.copy')}</button></div></div></div>`;
  };
  const state = (m) => (m.revoked_at ? `<span class="badge">${t('team.st.revoked')}</span>`
    : m.active ? `<span class="badge ok">${t('team.st.active')}</span>` : `<span class="badge warn">${t('team.st.waiting')}</span>`);
  const line = (m) => `<li${m.revoked_at ? ' style="opacity:.6"' : ''}>
      <div class="spread"><span><b>${esc(m.name)}</b> <span class="hint">· ${t(`staff.post.${m.post}`)}</span></span>${state(m)}</div>
      <div class="hint">${m.revoked_at ? t('team.revoked.at', { at: fmtMoment(m.revoked_at, lang, city.timezone) })
        : `${m.last_seen ? t('team.seen', { at: fmtMoment(m.last_seen, lang, city.timezone) }) : t('team.seen.never')} · ${t('team.today', { scans: m.scans_today, bills: m.bills_today })}`}</div>
      ${!m.revoked_at && m.invite ? invite(m) : ''}
      ${m.revoked_at ? '' : `<div class="row" style="gap:6px;margin-top:6px">
        <button type="button" class="btn ghost small" data-reinvite="${esc(m.id)}">${t(m.active ? 'team.newphone' : 'team.newlink')}</button>
        <button type="button" class="btn ghost small" data-revoke="${esc(m.id)}" data-name="${esc(m.name)}">${t('team.revoke')}</button></div>`}
    </li>`;
  return `<div class="pd-cols"><div class="pd-side">
      <form class="card" id="team-add">
        <h2>${t('team.add')}</h2>
        <p class="hint">${t('team.add.hint')}</p>
        <div class="grid2">
          <div class="field"><label for="tm-name">${t('team.name')}</label><input id="tm-name" name="name" required maxlength="60" autocomplete="off"></div>
          <div class="field"><label for="tm-post">${t('team.post')}</label><select id="tm-post" name="post">${TEAM_POSTS.map((k) => `<option value="${k}">${t(`staff.post.${k}`)}</option>`).join('')}</select></div>
        </div>
        <button class="btn">${t('team.add.button')}</button>
      </form>
      <div class="card"><h2>${t('team.list')}</h2>
        ${team.length ? `<ul class="list">${team.map(line).join('')}</ul>` : `<p class="hint">${t('team.none')}</p>`}</div>
    </div><div class="pd-side">
      <div class="card"><h2>${t('team.sees.title')}</h2>
        <ul class="team-rules"><li>✓ ${t('team.sees.1')}</li><li>✓ ${t('team.sees.2')}</li><li>✓ ${t('team.sees.3')}</li>
          <li>✗ ${t('team.sees.4')}</li><li>✗ ${t('team.sees.5')}</li></ul>
        <p class="hint">${t('team.sees.rules')}</p></div>
      <div class="card"><h2>${t('team.photo.title')}</h2>
        <p>${partner.staffPhotoRequired ? t('team.photo.on') : t('team.photo.off')}</p>
        <p class="hint">${t('team.photo.hint')}</p>
        <button type="button" class="btn ${partner.staffPhotoRequired ? 'ghost' : 'secondary'} small" id="team-photo" data-on="${partner.staffPhotoRequired ? '1' : ''}">${t(partner.staffPhotoRequired ? 'team.photo.cut' : 'team.photo.restore')}</button></div>
      <div class="card"><h2>${t('team.counter.title')}</h2>
        <p>${partner.counterEnabled ? t('team.counter.on') : t('team.counter.off')}</p>
        <p class="hint">${t('team.counter.hint')}</p>
        <button type="button" class="btn ${partner.counterEnabled ? 'ghost' : 'secondary'} small" id="team-counter" data-on="${partner.counterEnabled ? '1' : ''}">${t(partner.counterEnabled ? 'team.counter.cut' : 'team.counter.restore')}</button></div>
    </div></div>`;
}
function mountTeam(r, ctx, key) {
  const rt = root();
  const f = rt.querySelector('#team-add');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const b = f.querySelector('button'); b.disabled = true;
    try {
      const res = await store.staffInvite(key, f.name.value.trim(), f.post.value);
      if (!res || !res.ok) { b.disabled = false; notify(tRaw(['name', 'full'].includes(res && res.reason) ? `team.err.${res.reason}` : 'err.generic')); return; }
      ctx.refresh(tRaw('team.added', { name: f.name.value.trim() }));
    } catch { b.disabled = false; notify(tRaw('err.generic')); }
  };
  rt.querySelectorAll('[data-reinvite]').forEach((b) => { b.onclick = async () => {
    b.disabled = true;
    try { const res = await store.staffReinvite(key, b.dataset.reinvite); if (!res || !res.ok) throw new Error(); ctx.refresh(tRaw('team.link.new')); }
    catch { b.disabled = false; notify(tRaw('err.generic')); }
  }; });
  rt.querySelectorAll('[data-revoke]').forEach((b) => { b.onclick = async () => {
    if (!confirm(tRaw('team.revoke.confirm', { name: b.dataset.name }))) return;
    b.disabled = true;
    try { const res = await store.staffRevoke(key, b.dataset.revoke); if (!res || !res.ok) throw new Error(); ctx.refresh(tRaw('team.revoked', { name: b.dataset.name })); }
    catch { b.disabled = false; notify(tRaw('err.generic')); }
  }; });
  rt.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); notify(tRaw('team.copied')); } catch { prompt('', b.dataset.copy); }
  }; });
  const pb = rt.querySelector('#team-photo');
  if (pb) pb.onclick = async () => {
    const on = !!pb.dataset.on;
    pb.disabled = true;
    try { if (!(await store.partnerSetStaffPhoto(key, !on))) throw new Error(); ctx.refresh(tRaw(on ? 'team.photo.cut.done' : 'team.photo.restore.done')); }
    catch { pb.disabled = false; notify(tRaw('err.generic')); }
  };
  const cb = rt.querySelector('#team-counter');
  if (cb) cb.onclick = async () => {
    const on = !!cb.dataset.on;
    if (on && !confirm(tRaw('team.counter.confirm'))) return;
    cb.disabled = true;
    try { if (!(await store.partnerSetCounter(key, !on))) throw new Error(); ctx.refresh(tRaw(on ? 'team.counter.cut.done' : 'team.counter.restore.done')); }
    catch { cb.disabled = false; notify(tRaw('err.generic')); }
  };
}

// v67 : QR « Guia + grupo » lu par l'appareil photo du téléphone : la fiche s'ouvre avec le guide et le groupe.
export async function groupQrView([tok = ''], ctx) {
  let me = null;
  try { me = localStorage.getItem(ME_KEY); } catch { /* rien */ }
  if (me && tok) return { html: '', mount: () => ctx.replace(`p/${me}/conta/${tok}`) };
  return { html: `<div class="notice warn">${t('bill.gg.nophone')}</div><p><a class="btn" href="#/">${t('pm.title')}</a></p>` };
}

// v66 : inscription du téléphone d'une personne de l'équipe — par le lien (#/equipe/E-…) ou avec le code à 6 chiffres.
export async function staffEnrollView([ref = ''], ctx) {
  let failed = false;
  if (ref) {
    const r = await store.staffEnroll(ref).catch(() => null);
    if (r && r.ok) {
      try { localStorage.setItem(ME_KEY, r.token); } catch { /* rien */ }
      return { html: '', mount: () => ctx.replace(`p/${r.token}`, tRaw('team.enroll.ok', { name: r.name, partner: r.partner })) };
    }
    failed = r && r.reason === 'busy' ? 'busy' : 'invalid';
  }
  return {
    html: `<p><a href="#/">← ${t('pm.title')}</a></p>
      ${failed ? `<div class="notice bad">${t(`team.enroll.${failed}`)}</div>` : ''}
      <form class="card" id="enroll">
        <h1>${t('team.enroll.title')}</h1>
        <p class="hint">${t('team.enroll.hint')}</p>
        <div class="field"><label for="en-code">${t('team.enroll.code')}</label>
          <input id="en-code" name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" class="rs-big" placeholder="000000"></div>
        <button class="btn block">${t('team.enroll.button')}</button>
      </form>`,
    mount(rt) {
      const f = rt.querySelector('#enroll');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const code = f.code.value.replace(/\D/g, '');
        if (code.length !== 6) { notify(tRaw('team.enroll.invalid')); return; }
        const b = f.querySelector('button'); b.disabled = true;
        const r = await store.staffEnroll(code).catch(() => null);
        if (!r || !r.ok) { b.disabled = false; notify(tRaw(r && r.reason === 'busy' ? 'team.enroll.busy' : 'team.enroll.invalid')); return; }
        try { localStorage.setItem(ME_KEY, r.token); } catch { /* rien */ }
        ctx.replace(`p/${r.token}`, tRaw('team.enroll.ok', { name: r.name, partner: r.partner }));
      };
    },
  };
}

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
