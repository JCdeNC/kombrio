// Admin › INSS (v84, script 049) : déclarations mensuelles au nom de chaque partenaire, taux datés, procurations,
// traçabilité de chaque virement jusqu'au DARF payé. Tout ce qui est fait ici est visible par le partenaire et son comptable.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, cents, parseCents, fmtMoment, fmtDay, notify, confirmTwice, fmtTaxId, readFileAsDataUrl } from '../util.js';
import * as store from '../store.js';

export const INSS_STEPS = ['draft', 'esocial', 'dctfweb', 'darf', 'paid'];
const brl = (n) => cents(Number(n) || 0, 'BRL', getLang());
const ym = (d) => String(d || '').slice(0, 7);
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
const MAX_FILE = 2.5e6;
// « 8.157,41 » ou « 8157.41 » → centavos.
const toCents = (v) => parseCents(String(v || '').includes(',') ? String(v).replace(/\./g, '') : v);

// Statut lisible + couleur (partagé avec l'espace partenaire).
export function inssBadge(status, gap) {
  if (gap) return `<span class="badge bad">${t('inss.st.gap')}</span>`;
  const cls = status === 'paid' ? 'ok' : status === 'none' ? 'bad' : 'warn';
  return `<span class="badge ${cls}">${t(`inss.st.${status}`)}</span>`;
}

// Frise des 5 étapes avec les preuves de chacune (partagée avec l'espace partenaire).
export function inssTimeline(d, lang, tz) {
  const at = (v) => (v ? fmtMoment(v, lang, tz) : '');
  const rows = [
    ['draft', true, t('inss.tl.draft', { date: at(d.created_at) })],
    ['esocial', !!d.esocial_at, d.esocial_at ? t('inss.tl.esocial', { receipt: d.esocial_receipt, date: at(d.esocial_at) }) : ''],
    ['dctfweb', !!d.dctfweb_at, d.dctfweb_at ? t('inss.tl.dctfweb', { receipt: d.dctfweb_receipt, date: at(d.dctfweb_at) }) : ''],
    ['darf', !!d.darf_at, d.darf_at ? t('inss.tl.darf', { number: d.darf_number, total: brl(d.darf_total_cents), extra: brl(d.darf_extra_cents) }) : ''],
    ['paid', !!d.paid_at, d.paid_at ? t(d.paid_how === 'to_partner' ? 'inss.tl.paid.partner' : 'inss.tl.paid', { date: fmtDay(d.paid_on, lang), ref: d.paid_ref }) : ''],
  ];
  return `<ol class="inss-tl">${rows.map(([k, done, txt]) => `<li class="${done ? 'done' : ''}"><b>${t(`inss.step.${k}`)}</b>${txt ? `<span class="hint">${txt}</span>` : ''}</li>`).join('')}</ol>`;
}

// Lignes par guide, avec chaque virement (n°, date, réf. bancaire, taux).
export function inssLinesTable(d, lang) {
  const lines = d.lines || [];
  if (!lines.length) return `<p class="hint">${t('inss.lines.none')}</p>`;
  return `<div class="table-wrap"><table>
    <tr><th>${t('common.guide')}</th><th>CPF</th><th>${t('inss.col.gross')}</th><th>INSS</th><th>${t('inss.col.payouts')}</th></tr>
    ${lines.map((g) => `<tr><td>${esc(g.guide_name)}</td><td>${esc(g.guide_cpf && g.guide_cpf.length === 11 ? fmtTaxId(g.guide_cpf) : g.guide_cpf || '—')}</td>
      <td>${brl(g.gross_cents)}</td><td>${brl(g.inss_cents)}</td>
      <td>${(g.payouts || []).map((p) => `<div class="hint">n° ${esc(String(p.payout_num))} · ${esc(fmtDay(String(p.paid_at).slice(0, 10), lang))} · ${brl(p.inss_cents)} (${Math.round(Number(p.rate) * 1000) / 10} %)${p.reference ? ` · ${esc(p.reference)}` : ''}</div>`).join('')}</td></tr>`).join('')}
    <tr><th colspan="2">${t('inss.total')}</th><th>${brl(d.gross_cents)}</th><th>${brl(d.inss_cents)}</th><th></th></tr>
  </table></div>`;
}

// Fichier CSV (séparateur ;) : une ligne par virement, avec ce que demande le S-1200.
export function inssCsv(decls) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['competencia', 'declaracao', 'tomador', 'cnpj_cpf_tomador', 'quem_declara', 'guia', 'cpf_guia', 'categoria', 'cbo',
    'repasse_n', 'data_pagamento', 'referencia_pix', 'bruto', 'aliquota', 'inss_retido', 'status', 'recibo_esocial', 'recibo_dctfweb', 'darf', 'pago_em'];
  const rows = [];
  decls.forEach((d) => (d.lines || []).forEach((g) => (g.payouts || []).forEach((p) => rows.push([
    ym(d.month), d.doc_code, d.declarant_name, d.declarant_tax_id || '', d.filing, g.guide_name, g.guide_cpf || '', '701', '5114-05',
    p.payout_num, String(p.paid_at).slice(0, 10), p.reference || '', (Number(p.gross_cents) / 100).toFixed(2).replace('.', ','),
    String(p.rate).replace('.', ','), (Number(p.inss_cents) / 100).toFixed(2).replace('.', ','), d.status,
    d.esocial_receipt || '', d.dctfweb_receipt || '', d.darf_number || '', d.paid_on || '']))));
  return '﻿' + [head, ...rows].map((r) => r.map(q).join(';')).join('\r\n');
}
export function downloadText(text, filename, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
// Ouvre une pièce jointe (data URL) dans un nouvel onglet.
export function openDataUrl(src) {
  const w = window.open();
  if (!w) return;
  w.document.title = 'Kombrio';
  if (/^data:application\/pdf/.test(src)) { const f = w.document.createElement('iframe'); f.src = src; f.style.cssText = 'border:0;width:100%;height:100vh'; w.document.body.style.margin = '0'; w.document.body.appendChild(f); }
  else { const i = w.document.createElement('img'); i.src = src; i.style.maxWidth = '100%'; w.document.body.appendChild(i); }
}

// Formulaire de l'étape suivante.
function stepForm(d) {
  const today = new Date().toISOString().slice(0, 10);
  const f = (inner, step) => `<form class="inss-step" data-id="${esc(d.id)}" data-step="${step}" style="margin-top:10px">${inner}
    <button class="btn small">${t(`inss.do.${step}`)}</button></form>`;
  if (d.status === 'draft') return f(`<div class="field"><label>${t('inss.f.esocial')}</label><input name="receipt" required minlength="5" placeholder="1.1.0000000000000000000"></div>
    <p class="hint">${t('inss.f.esocial.hint')}</p>`, 'esocial');
  if (d.status === 'esocial') return f(`<div class="field"><label>${t('inss.f.dctfweb')}</label><input name="receipt" required minlength="5"></div>`, 'dctfweb');
  if (d.status === 'dctfweb') return f(`<div class="grid2">
      <div class="field"><label>${t('inss.f.darf.number')}</label><input name="number" required minlength="5" placeholder="07.18.…"></div>
      <div class="field"><label>${t('inss.f.darf.total')}</label><input name="total" required inputmode="decimal" value="${(Number(d.inss_cents) / 100).toFixed(2).replace('.', ',')}"></div>
      <div class="field"><label>${t('inss.f.darf.extra')}</label><input name="extra" inputmode="decimal" value="0,00"></div>
      <div class="field"><label>${t('inss.f.darf.pdf')}</label><input name="file" type="file" accept="application/pdf,image/*"></div>
    </div><p class="hint">${t('inss.f.darf.hint', { amount: brl(d.inss_cents) })}</p>`, 'darf');
  if (d.status === 'darf') return f(`<div class="grid2">
      <div class="field"><label>${t('inss.f.paid.how')}</label><select name="how">
        <option value="darf">${t('inss.how.darf')}</option><option value="to_partner"${d.filing === 'accountant' ? ' selected' : ''}>${t('inss.how.to_partner')}</option></select></div>
      <div class="field"><label>${t('inss.f.paid.on')}</label><input name="on" type="date" required value="${today}"></div>
      <div class="field"><label>${t('inss.f.paid.ref')}</label><input name="ref" required minlength="5"></div>
      <div class="field"><label>${t('inss.f.paid.proof')}</label><input name="file" type="file" accept="application/pdf,image/*"></div>
    </div>`, 'paid');
  return '';
}

function declCard(d, lang) {
  const procOk = d.filing !== 'kombrio' || d.procuracao_at;
  const late = d.status !== 'paid' && new Date().toISOString().slice(0, 10) > d.darf_due;
  return `<li class="inss-decl">
    <div class="spread"><b>${esc(d.declarant_name)}</b><span>${inssBadge(d.status, d.gap)} <b>${brl(d.inss_cents)}</b></span></div>
    <div class="hint">${esc(d.doc_code)} · ${d.declarant_tax_id ? esc(fmtTaxId(d.declarant_tax_id)) : `<b>${t('inss.no.taxid')}</b>`} · ${t('inss.guides', { n: d.guides })} · ${t(`inss.filing.${d.filing}`)}
      ${d.filing === 'kombrio' ? ` · ${d.procuracao_at ? t('inss.proc.on', { date: fmtDay(d.procuracao_at, lang) }) : `<b>${t('inss.proc.missing')}</b>`}` : ''}</div>
    <div class="hint">${t('inss.dues', { dctf: fmtDay(d.dctf_due, lang), darf: fmtDay(d.darf_due, lang) })}${late ? ` · <b>${t('inss.late')}</b>` : ''}</div>
    ${d.gap ? `<div class="notice bad" style="margin:8px 0 0">${t('inss.gap.hint', { live: brl(d.live_inss_cents), decl: brl(d.inss_cents) })}</div>` : ''}
    ${!procOk && d.status === 'draft' ? `<div class="notice warn" style="margin:8px 0 0">${t('inss.proc.needed')}</div>` : ''}
    ${inssTimeline(d, lang)}
    <div class="row" style="gap:6px">
      ${d.has_pdf ? `<button class="btn ghost small" data-file="${esc(d.id)}" data-kind="darf">${t('inss.file.darf')}</button>` : ''}
      ${d.has_proof ? `<button class="btn ghost small" data-file="${esc(d.id)}" data-kind="proof">${t('inss.file.proof')}</button>` : ''}
      ${!['draft', 'paid'].includes(d.status) ? `<button class="btn ghost small" data-undo="${esc(d.id)}">${t('inss.undo')}</button>` : ''}
    </div>
    ${stepForm(d)}
    <details style="margin-top:8px"><summary>${t('inss.lines.title')}</summary>${inssLinesTable(d, lang)}</details>
  </li>`;
}

export async function inssAdmin({ cityList, partnerList }) {
  const lang = getLang();
  const month = (location.hash.match(/inss\/(\d{4}-\d{2})/) || [])[1] || prevMonth();
  const [ov, todo, rules] = await Promise.all([
    store.adminInssOverview(month).catch(() => null), store.adminInssTodo(), store.listTaxRules(),
  ]);
  if (!ov) return { html: `<div class="notice warn">${t('inss.notinstalled')}</div>` };
  const decls = ov.declarations || [];
  const city = (id) => cityList.find((c) => c.id === id);
  const active = partnerList.filter((p) => p.status !== 'archived');

  const todoCard = `<div class="card"><h2>${t('inss.todo.title')}</h2><p class="hint">${t('inss.todo.hint')}</p>
    ${todo && todo.length ? `<ul class="list">${todo.map((x) => `<li><a href="#/inss/${esc(x.month)}" class="spread" style="text-decoration:none;color:inherit">
      <span><b>${esc(x.name)}</b> · ${esc(x.month)}<br><span class="hint">${t('inss.dues', { dctf: fmtDay(x.dctf_due, lang), darf: fmtDay(x.darf_due, lang) })}</span></span>
      <span>${inssBadge(x.status, x.gap)} <b>${brl(x.inss_cents)}</b></span></a></li>`).join('')}</ul>` : `<p class="hint">${t('inss.todo.none')}</p>`}</div>`;

  const monthCard = `<div class="card"><h2>${t('inss.month.title')}</h2><p class="hint">${t('inss.month.hint')}</p>
    <div class="row" style="align-items:flex-end;gap:8px;flex-wrap:wrap">
      <div class="field" style="margin:0"><label>${t('admin.inss.month')}</label><input type="month" id="inss-m" value="${esc(month)}"></div>
      <button class="btn small" id="inss-prepare">${t('inss.prepare')}</button>
      <button class="btn small secondary" id="inss-csv"${decls.length ? '' : ' disabled'}>${t('inss.csv')}</button>
    </div>
    <div class="pd-kpis" style="margin-top:12px">
      <div class="pd-kpi"><span>${t('inss.k.total')}</span><b>${brl(ov.inss_total_cents)}</b><em>${esc(ov.month)}</em></div>
      <div class="pd-kpi"><span>${t('inss.k.paid')}</span><b>${brl(ov.paid_total_cents)}</b><em>${t('inss.k.decls', { n: decls.length })}</em></div>
      <div class="pd-kpi"><span>${t('inss.k.dctf')}</span><b>${fmtDay(ov.dctf_due, lang)}</b><em>eSocial + DCTFWeb</em></div>
      <div class="pd-kpi"><span>${t('inss.k.darf')}</span><b>${fmtDay(ov.darf_due, lang)}</b><em>DARF</em></div>
    </div>
    ${(ov.missing || []).length ? `<div class="notice warn">${t('inss.missing', { n: ov.missing.length, names: ov.missing.map((m) => m.name).join(', ') })}</div>` : ''}
    ${decls.length ? `<ul class="list">${decls.map((d) => declCard(d, lang)).join('')}</ul>` : `<p class="hint">${t('inss.month.none')}</p>`}
  </div>`;

  const filingCard = `<div class="card"><h2>${t('inss.filing.title')}</h2><p class="hint">${t('inss.filing.hint')}</p>
    <ul class="list">${active.map((p) => `<li><form class="inss-filing" data-id="${esc(p.id)}">
      <div class="spread"><b>${esc(p.name)}</b><span class="hint">${p.taxId ? esc(fmtTaxId(p.taxId)) : t('inss.no.taxid')}</span></div>
      <div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:6px">
        <div class="field" style="margin:0"><label>${t('inss.filing.who')}</label><select name="mode">
          <option value="kombrio"${p.inssFiling === 'kombrio' ? ' selected' : ''}>${t('inss.filing.kombrio')}</option>
          <option value="accountant"${p.inssFiling === 'accountant' ? ' selected' : ''}>${t('inss.filing.accountant')}</option></select></div>
        <div class="field" style="margin:0"><label>${t('inss.proc.date')}</label><input type="date" name="proc" value="${esc(p.inssProcuracaoAt || '')}"></div>
        <div class="field" style="margin:0;flex:1;min-width:160px"><label>${t('inss.proc.note')}</label><input name="note" value="${esc(p.inssProcuracaoNote || '')}" placeholder="e-CAC · eSocial"></div>
        <button class="btn small secondary">${t('common.save')}</button>
      </div></form></li>`).join('')}</ul></div>`;

  const today = new Date().toISOString().slice(0, 10);
  const rulesCard = `<div class="card"><h2>${t('inss.rules.title')}</h2><p class="hint">${t('inss.rules.hint')}</p>
    <div class="table-wrap"><table>
      <tr><th>${t('admin.city.name')}</th><th>${t('inss.rules.rate')}</th><th>${t('inss.rules.ceiling')}</th><th>${t('inss.rules.from')}</th><th>${t('inss.rules.to')}</th><th>${t('inss.rules.source')}</th></tr>
      ${rules.filter((r) => r.kind === 'inss_ci').map((r) => { const on = r.valid_from <= today && (!r.valid_to || r.valid_to >= today);
        return `<tr><td>${esc(city(r.city_id)?.name || r.city_id)}${on ? ` <span class="badge ok">${t('inss.rules.current')}</span>` : ''}</td>
        <td>${Math.round(Number(r.rate) * 10000) / 100} %</td><td>${r.ceiling_cents ? brl(r.ceiling_cents) : `<b>${t('inss.rules.noceiling')}</b>`}</td>
        <td>${fmtDay(r.valid_from, lang)}</td><td>${r.valid_to ? fmtDay(r.valid_to, lang) : '—'}</td>
        <td>${esc(r.source || '—')}${r.note ? `<div class="hint">${esc(r.note)}</div>` : ''}</td></tr>`; }).join('')}
    </table></div>
    <form id="inss-rule" style="margin-top:12px"><h3>${t('inss.rules.new')}</h3>
      <div class="grid2">
        <div class="field"><label>${t('admin.city.name')}</label><select name="city">${cityList.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>${t('inss.rules.from')}</label><input type="date" name="from" required value="${today}"></div>
        <div class="field"><label>${t('inss.rules.rate')} (%)</label><input name="rate" required inputmode="decimal" value="11"></div>
        <div class="field"><label>${t('inss.rules.ceiling')} (R$)</label><input name="ceiling" inputmode="decimal" placeholder="8.000,00"></div>
      </div>
      <div class="field"><label>${t('inss.rules.source')}</label><input name="source" required placeholder="Portaria Interministerial MPS/MF nº …/2026"></div>
      <div class="field"><label>${t('inss.rules.note')}</label><input name="note"></div>
      <p class="hint">${t('inss.rules.form.hint')}</p>
      <button class="btn small">${t('inss.rules.save')}</button>
    </form></div>`;

  const reportCard = `<div class="card"><h2>${t('admin.inss.title')}</h2><p class="hint">${t('admin.inss.hint')}</p>
    <button class="btn small ghost" id="inss-show">${t('admin.inss.show')} · ${esc(month)}</button><div id="inss-out" style="margin-top:10px"></div></div>`;

  return {
    html: `${todoCard}${monthCard}${filingCard}${rulesCard}${reportCard}`,
    mount(root, ctx) {
      const m = root.querySelector('#inss-m');
      m.onchange = () => { if (m.value) ctx.go(`inss/${m.value}`); };
      confirmTwice(root.querySelector('#inss-prepare'), tRaw('inss.prepare.confirm', { month }), async () => {
        const r = await store.adminInssPrepare(month);
        if (!r || !r.ok) { notify(tRaw(`inss.err.${r?.reason || 'generic'}`)); return; }
        ctx.refresh(tRaw('inss.prepared', { c: r.created, u: r.updated, g: r.gaps }));
      }, tRaw('err.generic'));
      const csv = root.querySelector('#inss-csv');
      if (csv) csv.onclick = () => downloadText(inssCsv(decls), `kombrio-inss-${month}.csv`);

      root.querySelectorAll('.inss-step').forEach((f) => { f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector('button'); btn.disabled = true;
        try {
          const step = f.dataset.step; const v = (n) => (f.elements[n] ? f.elements[n].value.trim() : '');
          const file = f.elements.file && f.elements.file.files[0];
          if (file && file.size > MAX_FILE) { notify(tRaw('inss.err.file')); btn.disabled = false; return; }
          const data = file ? await readFileAsDataUrl(file) : '';
          const payload = step === 'esocial' || step === 'dctfweb' ? { receipt: v('receipt') }
            : step === 'darf' ? { number: v('number'), total_cents: toCents(v('total')), extra_cents: toCents(v('extra') || '0') || 0, pdf: data }
            : { how: v('how'), on: v('on'), ref: v('ref'), proof: data };
          const r = await store.adminInssStep(f.dataset.id, step, payload);
          if (!r || !r.ok) { notify(tRaw(`inss.err.${r?.reason || 'generic'}`)); btn.disabled = false; return; }
          ctx.refresh(tRaw('inss.step.done'));
        } catch { notify(tRaw('err.generic')); btn.disabled = false; }
      }; });
      root.querySelectorAll('[data-undo]').forEach((b) => { b.onclick = async () => {
        const reason = prompt(tRaw('inss.undo.reason'));
        if (!reason || reason.trim().length < 5) return;
        const r = await store.adminInssStep(b.dataset.undo, 'undo', { reason: reason.trim() }).catch(() => null);
        if (!r || !r.ok) { notify(tRaw(`inss.err.${r?.reason || 'generic'}`)); return; }
        ctx.refresh(tRaw('inss.step.done'));
      }; });
      root.querySelectorAll('[data-file]').forEach((b) => { b.onclick = async () => {
        const src = await store.inssFile(null, b.dataset.file, b.dataset.kind).catch(() => null);
        if (src) openDataUrl(src); else notify(tRaw('err.generic'));
      }; });
      root.querySelectorAll('.inss-filing').forEach((f) => { f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await store.adminSetInssFiling(f.dataset.id, f.mode.value, f.proc.value, f.note.value);
          if (!r || !r.ok) { notify(tRaw('err.generic')); return; }
          ctx.refresh(tRaw('common.saved'));
        } catch { notify(tRaw('err.generic')); }
      }; });
      root.querySelector('#inss-rule').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const rate = Number(f.rate.value.replace(',', '.')) / 100;
        const ceiling = f.ceiling.value.trim() ? toCents(f.ceiling.value) : null;
        if (!(rate >= 0 && rate < 1) || (ceiling !== null && !(ceiling > 0))) { notify(tRaw('inss.err.values')); return; }
        try {
          const r = await store.setTaxRule({ city: f.city.value, rate, ceilingCents: ceiling, from: f.from.value, note: f.note.value, source: f.source.value });
          if (!r || !r.ok) { notify(tRaw(`inss.err.${r?.reason || 'generic'}`, { date: r?.last_use ? fmtDay(r.last_use, lang) : '' })); return; }
          ctx.refresh(tRaw('common.saved'));
        } catch { notify(tRaw('err.generic')); }
      };
      root.querySelector('#inss-show').onclick = async () => {
        const out = root.querySelector('#inss-out');
        out.innerHTML = '<p class="hint">…</p>';
        const r = await store.adminInssReport(month).catch(() => null);
        if (!r) { out.innerHTML = `<div class="notice warn">${t('admin.inss.notinstalled')}</div>`; return; }
        const lines = r.lines || [];
        out.innerHTML = lines.length ? `<div class="table-wrap"><table>
          <tr><th>${t('common.partner')}</th><th>CNPJ / CPF</th><th>${t('common.guide')}</th><th>CPF</th><th>${t('admin.out.gross')}</th><th>INSS</th><th>${t('admin.out.net')}</th></tr>
          ${lines.map((l) => `<tr><td>${esc(l.partner_name)}</td><td>${esc(l.partner_tax_id ? fmtTaxId(l.partner_tax_id) : tRaw('admin.missing'))}</td><td>${esc(l.guide_name)}</td><td>${esc(l.guide_cpf ? fmtTaxId(l.guide_cpf) : tRaw('admin.missing'))}</td><td>${brl(l.gross_cents)}</td><td>${brl(l.inss_cents)}</td><td>${brl(l.net_cents)}</td></tr>`).join('')}
          <tr><th colspan="5">${t('admin.inss.total')}</th><th>${brl(r.inss_total_cents)}</th><th></th></tr>
        </table></div>` : `<p class="hint">${t('admin.inss.none')}</p>`;
      };
    },
  };
}
