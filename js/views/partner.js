// App Partenaire : son QR Partenaire enregistre le passage, puis il déclare et paie la commission.
// Sans passage en attente, le même QR ouvre son espace (historique, offre, QR à imprimer).
// Pas de compte : tout passe par le code secret du QR Partenaire, vérifié par la base.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, fmtMoment, fmtDay, qrSvg, appLink, readFileAsDataUrl, notify, pixPayload, pixKeyOf, photoToJpeg, confirmTwice, fmtTaxId, locale } from '../util.js';
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
  space.key = token;

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

  // La caisse n'a accès qu'aux passages qu'elle vient d'enregistrer.
  if (space.role !== 'manager' && action !== 'passage') return spaceView(space);
  if (action === 'pagar') return payView(space);
  if (action === 'relatorio') return reportPage(space, visitId);
  const visit = space.visits.find((v) => v.id === visitId);
  if (!visit) return notFound();
  return declareView(space, visit, action === 'passage');
}

function declareView({ partner, city, key, role }, visit, justScanned) {
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

  if (role !== 'manager') {
    return { html: `${head}<a class="btn ghost" href="#/p/${encodeURIComponent(key)}">${t('counter.back')}</a>` };
  }
  if (visit.status !== 'visited') {
    return {
      html: `${head}<div class="notice">${t('partner.declare.done', { amount: money(visit.amount, city.currency, lang) })}</div>
        <a class="btn ghost" href="#/p/${encodeURIComponent(key)}">${t('partner.space')}</a>`,
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
        <p class="hint" style="margin-top:8px">${t('partner.declare.later')} <a href="#/p/${encodeURIComponent(key)}">${t('partner.space')}</a></p>
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
          await store.declareVisit(key, visit.id, { amount: Number(form.get('amount')), method: form.get('method'), receipt });
          ctx.go(`p/${key}`, tRaw('partner.declare.thanks'));
        } catch {
          button.disabled = false;
          notify(tRaw('err.generic'));
        }
      };
    },
  };
}

function spaceView({ partner, city, visits, key, role }) {
  if (role !== 'manager') return counterView({ partner, city, visits, key });
  const lang = getLang();
  const owed = visits.filter((v) => v.status === 'visited').length;

  const item = (v) => `<li>
    <div class="spread"><b>${esc(v.client || '?')}</b>${statusBadge(v)}</div>
    <div class="hint">${fmtMoment(v.at, lang, city.timezone)} · ${t('scan.people', { n: v.people })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</div>
    ${v.amount != null && v.status !== 'visited' ? `<div>${t('partner.visit.amount', { amount: money(v.amount, city.currency, lang) })}</div>` : ''}
    ${v.status === 'visited' ? `<a class="btn small" href="#/p/${encodeURIComponent(key)}/declarer/${encodeURIComponent(v.id)}">${t('partner.declare.button')}</a>` : ''}
  </li>`;

  return {
    html: `
      <h1>${esc(partner.name)}</h1>
      <p class="hint">${t('manager.badge')}</p>
      ${owed ? `<div class="notice warn">${t('partner.todeclare', { n: owed })}
        <a class="btn block" style="margin-top:10px" href="#/p/${encodeURIComponent(key)}/pagar">${t('partner.pay.button')}</a></div>` : ''}
      <div class="card">
        <h2>${t('partner.visits')}</h2>
        ${visits.length ? `<ul class="list">${visits.map(item).join('')}</ul>` : `<p class="hint">${t('partner.visits.none')}</p>`}
      </div>
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
function payView({ partner, city, visits, key }) {
  const lang = getLang();
  const todo = visits.filter((v) => v.status === 'visited');
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
              <span class="hint"> · ${fmtDay(v.at.slice(0, 10), lang)} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</span></span>
            <input name="a-${esc(v.id)}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="${esc(city.currency)}" style="width:120px">
          </label></li>`).join('')}</ul>
        <div class="stat" style="margin:12px 0"><span>${t('partner.pay.total')}</span><b id="total">${money(0, city.currency, lang)}</b></div>
        ${pixKey ? `<div style="text-align:center">
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
        if (pixKey) {
          payload = pixPayload({ key: pixKey, amount: total, txid: `KBR${partner.id.replace(/-/g, '').slice(0, 10)}` });
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
          await store.declareVisit(key, first.v.id, { amount: first.amount, method, receipt });
          for (const x of rest) {
            await store.declareVisit(key, x.v.id, { amount: x.amount, method, receipt: { name: receipt.name, type: 'same', ref: first.v.id } });
          }
          ctx.go(`p/${key}`, tRaw('partner.declare.thanks'));
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
const PAID = ['received', 'paid'];
const shortMoment = (iso, lang, tz) => new Intl.DateTimeFormat(locale(lang), { dateStyle: 'short', timeStyle: 'short', timeZone: tz }).format(new Date(iso));

function reportBlock({ partner, city, visits }, month, base) {
  const lang = getLang();
  const months = [...new Set([monthOf(new Date().toISOString(), city.timezone), ...visits.map((v) => monthOf(v.at, city.timezone))])].sort().reverse();
  const m = months.includes(month) ? month : months[0];
  const rows = visits.filter((v) => monthOf(v.at, city.timezone) === m).sort((a, b) => a.at.localeCompare(b.at));
  const cur = (n) => money(n, city.currency, lang);
  const declared = rows.filter((v) => v.status !== 'visited').reduce((s, v) => s + (v.amount || 0), 0);
  const paid = rows.filter((v) => PAID.includes(v.status)).reduce((s, v) => s + (v.amount || 0), 0);
  const todo = rows.filter((v) => v.status === 'visited').length;
  const html = `
    <div class="card">
      <div class="spread">
        <div><h1 style="margin-bottom:2px">${t('report.title')}</h1>
          <div class="hint">${esc(partner.name)}${partner.taxId ? ` · ${t('report.taxid')} ${esc(fmtTaxId(partner.taxId))}` : ''}${partner.area ? ` · ${esc(partner.area)}` : ''}</div></div>
        <select id="month" class="no-print" style="width:auto">${months.map((x) => `<option value="${x}" ${x === m ? 'selected' : ''}>${esc(monthLabel(x, lang))}</option>`).join('')}</select>
      </div>
      <p class="print-only"><b>${esc(monthLabel(m, lang))}</b></p>
      <div class="stats" style="margin-top:12px">
        <div class="stat"><b>${rows.length}</b><span>${t('report.visits')}</span></div>
        <div class="stat"><b>${cur(declared)}</b><span>${t('report.declared')}</span></div>
        <div class="stat"><b>${cur(paid)}</b><span>${t('report.paid')}</span></div>
      </div>
      ${todo ? `<div class="notice warn">${t('partner.todeclare', { n: todo })}</div>` : ''}
      ${rows.length ? `<div class="table-wrap"><table>
        <tr><th>${t('report.col.date')}</th><th>${t('report.col.client')}</th><th>${t('report.col.guide')}</th><th>${t('report.col.people')}</th><th>${t('report.col.amount')}</th><th>${t('report.col.method')}</th><th>${t('report.col.status')}</th></tr>
        ${rows.map((v) => `<tr><td style="white-space:nowrap">${shortMoment(v.at, lang, city.timezone)}</td><td>${esc(v.client || '')}</td><td>${esc(v.guideName || '')}</td><td>${v.people}</td>
          <td>${v.amount != null && v.status !== 'visited' ? cur(v.amount) : '—'}</td><td>${v.method && v.status !== 'visited' ? t(`method.${v.method}`) : '—'}</td><td>${statusBadge(v)}</td></tr>`).join('')}
        <tr><td colspan="4"><b>${t('report.total')}</b></td><td><b>${cur(declared)}</b></td><td colspan="2"></td></tr>
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
      const num = (n) => (n == null ? '' : String(n.toFixed(2)).replace('.', ','));
      const cell = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
      const head = ['report.col.date', 'report.col.client', 'report.col.guide', 'report.col.people', 'report.col.amount', 'report.col.method', 'report.col.status'].map((k) => cell(tRaw(k)));
      const lines = rows.map((v) => [shortMoment(v.at, lang, city.timezone), v.client, v.guideName, v.people,
        v.status !== 'visited' ? num(v.amount) : '', v.method && v.status !== 'visited' ? tRaw(`method.${v.method}`) : '',
        tRaw(v.status === 'visited' && v.rejected ? 'status.rejected' : `status.${v.status}`)].map(cell));
      lines.push([cell(tRaw('report.total')), '', '', '', cell(num(declared)), '', '']);
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
          <div class="hint">${t('scan.people', { n: v.people })} · ${t('partner.visit.guide', { guide: v.guideName || '?' })}</div></li>`).join('')}</ul>`
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
