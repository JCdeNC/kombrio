// v141 (demande de JC, 25/11) : onglet admin « Commissions » — évolution mois par mois des pourcentages de commission
// par groupe d'apporteurs (guide, Tour Company, agence ; plus tard concierges) et par type d'établissement, établissements
// dont le taux des guides a changé, taux réglés aujourd'hui. Taux réel = commissions / (ventes − part non commissionnée).
import { t, tRaw, getLang } from '../i18n.js';
import { esc, cents } from '../util.js';
import * as store from '../store.js';

const pct = (r) => (r == null || !Number.isFinite(r) ? '—' : `${String(Math.round(r * 1000) / 10).replace('.', ',')} %`);
const rateOf = (x) => (x.base_cents > 0 ? x.commission_cents / x.base_cents : null);
const monthLabel = (ym, lang) => new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'fr-FR', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${ym}-15T12:00:00Z`));

function arrow(cur, prev) {
  if (cur == null || prev == null) return '';
  const d = cur - prev;
  if (Math.abs(d) < 0.0005) return '<span class="hint">=</span>';
  return d > 0 ? `<b style="color:#1E7F4F">↑ ${pct(d).replace(' %', ' pt')}</b>` : `<b style="color:#B3261E">↓ ${pct(-d).replace(' %', ' pt')}</b>`;
}

export async function trendsAdmin() {
  const lang = getLang();
  const c = (n) => cents(n, 'BRL', lang);
  const data = await store.adminCommissionTrends(12);
  if (!data) return { html: `<div class="notice warn">${t('ct.unavailable')}</div>` };
  const table = (rows, label) => {
    const keys = [...new Set(rows.map((x) => x.key))];
    if (!keys.length) return `<p class="hint">${t('ct.none')}</p>`;
    return keys.map((k) => {
      const list = rows.filter((x) => x.key === k).sort((a, b) => b.month.localeCompare(a.month));
      return `<h3 style="margin:14px 0 6px">${esc(label(k))}</h3><div class="table-wrap"><table><tr><th>${t('ct.col.month')}</th><th>${t('ct.col.visits')}</th><th>${t('ct.col.base')}</th><th>${t('ct.col.com')}</th><th>${t('ct.col.rate')}</th><th>${t('ct.col.trend')}</th></tr>
        ${list.map((x, i) => `<tr><td>${esc(monthLabel(x.month, lang))}</td><td>${x.visits || 0}</td><td>${c(x.base_cents || 0)}</td><td>${c(x.commission_cents || 0)}</td>
          <td><b>${pct(rateOf(x))}</b></td><td>${list[i + 1] ? arrow(rateOf(x), rateOf(list[i + 1])) : ''}</td></tr>`).join('')}</table></div>`;
    }).join('');
  };
  const groupLabel = (k) => tRaw(`ct.group.${k}`) !== `ct.group.${k}` ? tRaw(`ct.group.${k}`) : k;
  const typeLabel = (k) => tRaw(`ptype.${k}`);
  const html = `
    <div class="card"><div class="spread"><h2 style="margin:0">${t('ct.title')}</h2><button type="button" class="btn secondary small" id="ct-csv">${t('ct.csv')}</button></div>
      <p class="hint">${t('ct.hint')}</p></div>
    <div class="card"><h2>${t('ct.by.group')}</h2>${table(data.groups || [], groupLabel)}</div>
    <div class="card"><h2>${t('ct.by.type')}</h2>${table(data.types || [], typeLabel)}</div>
    <div class="card"><h2>${t('ct.changes')}</h2>${(data.changes || []).length ? `<div class="table-wrap"><table><tr><th>${t('ct.col.month')}</th><th>${t('ct.col.partner')}</th><th>${t('ct.col.from')}</th><th>${t('ct.col.to')}</th><th></th></tr>
      ${data.changes.map((x) => `<tr><td>${esc(monthLabel(x.month, lang))}</td><td>${esc(x.partner)} <span class="hint">${esc(typeLabel(x.type))}</span></td><td>${pct(Number(x.from))}</td><td><b>${pct(Number(x.to))}</b></td><td>${arrow(Number(x.to), Number(x.from))}</td></tr>`).join('')}</table></div>` : `<p class="hint">${t('ct.changes.none')}</p>`}</div>
    <div class="card"><h2>${t('ct.current')}</h2>${(data.current || []).length ? `<div class="table-wrap"><table><tr><th>${t('ct.col.partner')}</th><th>${t('ct.group.guide')}</th><th>${t('ct.group.tc')}</th><th>${t('ct.group.agency')}</th></tr>
      ${data.current.map((x) => `<tr><td>${esc(x.partner)} <span class="hint">${esc(typeLabel(x.type))}</span></td><td>${x.model === 'per_person' && x.pp_cents != null ? `${c(Number(x.pp_cents))} ${t('ct.pp')}` : pct(Number(x.rate))}</td>
        <td>${Number(x.rate_tc) > 0 ? pct(Number(x.rate_tc)) : '—'}</td><td>${Number(x.rate_agency) > 0 ? pct(Number(x.rate_agency)) : '—'}</td></tr>`).join('')}</table></div>` : `<p class="hint">${t('ct.none')}</p>`}</div>`;
  return {
    html,
    mount(root) {
      root.querySelector('#ct-csv').onclick = () => {
        const cell = (x) => `"${String(x == null ? '' : x).replace(/"/g, '""')}"`;
        const num = (n) => ((n || 0) / 100).toFixed(2).replace('.', ',');
        const head = [tRaw('ct.col.kind'), tRaw('ct.col.key'), tRaw('ct.col.month'), tRaw('ct.col.visits'), tRaw('ct.col.base'), tRaw('ct.col.com'), tRaw('ct.col.rate')].map(cell);
        const line = (kind, lbl) => (x) => [kind, lbl(x.key), x.month, x.visits || 0, num(x.base_cents), num(x.commission_cents), pct(rateOf(x))].map(cell);
        const lines = [...(data.groups || []).map(line(tRaw('ct.by.group'), groupLabel)), ...(data.types || []).map(line(tRaw('ct.by.type'), typeLabel))];
        const csv = '﻿' + [head, ...lines].map((r) => r.join(';')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = 'kombrio-commissions-par-groupe.csv';
        a.click();
      };
    },
  };
}
