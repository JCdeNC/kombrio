// App Partenaire : son QR Partenaire enregistre le passage, puis il déclare et paie la commission.
// Sans passage en attente, le même QR ouvre son espace (historique, offre, QR à imprimer).
// Pas de compte : tout passe par le code secret du QR Partenaire, vérifié par la base.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, fmtMoment, fmtDay, qrSvg, appLink, readFileAsDataUrl, notify, pixPayload, pixKeyOf, photoToJpeg } from '../util.js';
import * as store from '../store.js';
import { statusBadge, notFound } from './shared.js';
import { readPendingStay, clearPendingStay } from './scan.js';

const MAX_RECEIPT = 1.5 * 1024 * 1024;
const ME_KEY = 'kombrio-partner';

// L'app ouverte sans lien (icône sur l'écran d'accueil) : on rouvre l'espace du partenaire de ce téléphone.
export async function partnerHome(params, ctx) {
  let me = null;
  try { me = localStorage.getItem(ME_KEY); } catch { /* rien */ }
  if (me) return { html: '', mount: () => ctx.replace(`p/${me}`) };
  return { html: `<div class="card"><h1>Kombrio</h1><p>${t('partner.home')}</p></div>` };
}

export async function partnerView([token, action, visitId], ctx) {
  let space = token && await store.partnerSpace(token);
  if (!space) {
    try { if (localStorage.getItem(ME_KEY) === token) localStorage.removeItem(ME_KEY); } catch { /* rien */ }
    return notFound('err.partner');
  }
  try { localStorage.setItem(ME_KEY, token); } catch { /* rien */ }

  if (!action) {
    const pending = readPendingStay();
    if (pending) {
      clearPendingStay();
      const res = await store.recordVisit(pending, token);
      if (res.ok) {
        // On change d'adresse pour qu'un rechargement n'enregistre pas un second passage.
        return { html: '', mount: () => ctx.replace(`p/${token}/passage/${res.visitId}`) };
      }
      const view = spaceView(space);
      return { ...view, html: `<div class="notice bad">${t(`visit.err.${res.reason}`)}</div>${view.html}` };
    }
    return spaceView(space);
  }

  if (action === 'pagar') return payView(space);
  const visit = space.visits.find((v) => v.id === visitId);
  if (!visit) return notFound();
  return declareView(space, visit, action === 'passage');
}

function declareView({ partner, city }, visit, justScanned) {
  const lang = getLang();
  // Rien à afficher si le partenaire ne propose pas d'offre.
  let offer = '';
  if (justScanned && partner.offer) {
    offer = visit.offerGiven
      ? `<div class="notice ok"><b>${t('partner.offer.give')}</b><div class="offer">${esc(partner.offer)}</div></div>`
      : `<div class="notice warn">${t('partner.offer.already')}</div>`;
  }
  const head = `
    ${justScanned ? `<div class="notice ok"><b>${t('partner.visit.saved')}</b></div>` : ''}
    ${offer}
    <div class="card">
      <h2>${esc(visit.client)}</h2>
      <p class="hint">${t('scan.people', { n: visit.people })} · ${t('partner.visit.guide', { guide: visit.guideName })} · ${fmtMoment(visit.at, lang, city.timezone)}</p>
    </div>`;

  if (visit.status !== 'visited') {
    return {
      html: `${head}<div class="notice">${t('partner.declare.done', { amount: money(visit.amount, city.currency, lang) })}</div>
        <a class="btn ghost" href="#/p/${encodeURIComponent(partner.token)}">${t('partner.space')}</a>`,
    };
  }

  return {
    html: `${head}
      <form class="card" id="declare">
        <h2>${t('partner.declare.title')}</h2>
        ${visit.rejected ? `<div class="notice bad">${t('partner.declare.rejected')}</div>` : ''}
        <p class="hint">${t('partner.declare.hint')}</p>
        <div class="grid2">
          <div class="field"><label for="d-amount">${t('partner.declare.amount', { currency: city.currency })}</label>
            <input id="d-amount" name="amount" type="number" min="1" step="0.01" inputmode="decimal" required></div>
          <div class="field"><label for="d-method">${t('partner.declare.method')}</label>
            <select id="d-method" name="method">${city.methods.map((m) => `<option value="${esc(m)}">${t(`method.${m}`)}</option>`).join('')}</select></div>
        </div>
        <div class="notice">${t('partner.declare.payto')}<br><b>${city.payTo && !/d[ée]finir/i.test(city.payTo) ? esc(city.payTo) : t('partner.declare.payto.pending')}</b></div>
        <div class="field"><label for="d-receipt">${t('partner.declare.receipt')}</label>
          <input id="d-receipt" name="receipt" type="file" accept="image/*,application/pdf" required></div>
        <button class="btn block">${t('partner.declare.submit')}</button>
        <p class="hint" style="margin-top:8px">${t('partner.declare.later')} <a href="#/p/${encodeURIComponent(partner.token)}">${t('partner.space')}</a></p>
      </form>`,
    mount(root, ctx) {
      root.querySelector('#declare').onsubmit = async (e) => {
        e.preventDefault();
        const form = new FormData(e.target);
        const file = form.get('receipt');
        if (!file || !file.size) return;
        if (file.size > MAX_RECEIPT) { notify(tRaw('partner.declare.toobig')); return; }
        const button = e.target.querySelector('button');
        button.disabled = true;
        const receipt = { name: file.name, type: file.type, data: await readFileAsDataUrl(file) };
        try {
          await store.declareVisit(partner.token, visit.id, { amount: Number(form.get('amount')), method: form.get('method'), receipt });
          ctx.go(`p/${partner.token}`, tRaw('partner.declare.thanks'));
        } catch {
          button.disabled = false;
          notify(tRaw('err.generic'));
        }
      };
    },
  };
}

function spaceView({ partner, city, visits }) {
  const lang = getLang();
  const owed = visits.filter((v) => v.status === 'visited').length;

  const item = (v) => `<li>
    <div class="spread"><b>${esc(v.client || '?')}</b>${statusBadge(v)}</div>
    <div class="hint">${fmtMoment(v.at, lang, city.timezone)} · ${t('scan.people', { n: v.people })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</div>
    ${v.amount != null && v.status !== 'visited' ? `<div>${t('partner.visit.amount', { amount: money(v.amount, city.currency, lang) })}</div>` : ''}
    ${v.status === 'visited' ? `<a class="btn small" href="#/p/${encodeURIComponent(partner.token)}/declarer/${encodeURIComponent(v.id)}">${t('partner.declare.button')}</a>` : ''}
  </li>`;

  return {
    html: `
      <h1>${esc(partner.name)}</h1>
      ${owed ? `<div class="notice warn">${t('partner.todeclare', { n: owed })}
        <a class="btn block" style="margin-top:10px" href="#/p/${encodeURIComponent(partner.token)}/pagar">${t('partner.pay.button')}</a></div>` : ''}
      <div class="card">
        <h2>${t('partner.visits')}</h2>
        ${visits.length ? `<ul class="list">${visits.map(item).join('')}</ul>` : `<p class="hint">${t('partner.visits.none')}</p>`}
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
        await store.setPartnerOffer(partner.token, new FormData(e.target).get('offer'));
        ctx.refresh(tRaw('common.saved'));
      };
      root.querySelector('#print').onclick = () => window.print();
      root.querySelector('#unlink').onclick = (e) => {
        e.preventDefault();
        try { localStorage.removeItem(ME_KEY); } catch { /* rien */ }
        location.hash = '';
        notify(tRaw('partner.unlinked'));
      };
    },
  };
}

// Déclarer plusieurs passages et les payer en un seul Pix (comprovante unique).
function payView({ partner, city, visits }) {
  const lang = getLang();
  const todo = visits.filter((v) => v.status === 'visited');
  const key = pixKeyOf(city);
  const back = `#/p/${encodeURIComponent(partner.token)}`;
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
              <span class="hint"> · ${fmtDay(v.at.slice(0, 10), lang)} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</span></span>
            <input name="a-${esc(v.id)}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="${esc(city.currency)}" style="width:120px">
          </label></li>`).join('')}</ul>
        <div class="stat" style="margin:12px 0"><span>${t('partner.pay.total')}</span><b id="total">${money(0, city.currency, lang)}</b></div>
        ${key ? `<div style="text-align:center">
            <div class="qr" id="pixqr"></div>
            <p class="hint">${t('partner.pay.pixhint')}</p>
            <button type="button" class="btn secondary" id="copypix">${t('partner.pay.copy')}</button>
          </div>`
          : `<div class="notice">${t('partner.declare.payto')}<br><b>${t('partner.declare.payto.pending')}</b></div>`}
        <div class="field" style="margin-top:12px"><label for="p-method">${t('partner.declare.method')}</label>
          <select id="p-method" name="method">${city.methods.map((m) => `<option value="${esc(m)}">${t(`method.${m}`)}</option>`).join('')}</select></div>
        <div class="field"><label for="p-receipt">${t('partner.declare.receipt')}</label>
          <input id="p-receipt" name="receipt" type="file" accept="image/*,application/pdf" required></div>
        <button class="btn block">${t('partner.declare.submit')}</button>
      </form>`,
    mount(root, ctx) {
      const form = root.querySelector('#pay');
      const chosen = () => todo.map((v) => ({ v, on: form.querySelector(`[value="${v.id}"]`).checked, amount: Number(form[`a-${v.id}`].value) || 0 }))
        .filter((x) => x.on && x.amount > 0);
      let payload = '';
      const update = () => {
        const total = Math.round(chosen().reduce((s, x) => s + x.amount, 0) * 100) / 100;
        root.querySelector('#total').textContent = money(total, city.currency, lang);
        if (key) {
          payload = pixPayload({ key, amount: total, txid: `KBR${partner.id.replace(/-/g, '').slice(0, 10)}` });
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
          const method = form.method.value;
          const [first, ...rest] = list;
          await store.declareVisit(partner.token, first.v.id, { amount: first.amount, method, receipt });
          for (const x of rest) {
            await store.declareVisit(partner.token, x.v.id, { amount: x.amount, method, receipt: { name: receipt.name, type: 'same', ref: first.v.id } });
          }
          ctx.go(`p/${partner.token}`, tRaw('partner.declare.thanks'));
        } catch {
          button.disabled = false;
          notify(tRaw('err.generic'));
        }
      };
    },
  };
}
