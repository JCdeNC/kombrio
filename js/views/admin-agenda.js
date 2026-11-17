// Admin › Agenda (v85, script 050) : toutes les échéances du mois dans un calendrier — Pix, INSS des guides,
// impôts et obligations de la LTDA, contrôles. Une obligation cochée « fait » garde sa référence (traçabilité).
import { t, tRaw, getLang } from '../i18n.js';
import { esc, cents, fmtDay, notify, fmtTaxId } from '../util.js';
import * as store from '../store.js';

const CATS = ['impots', 'inss', 'pix', 'controle', 'societe'];
const brl = (n) => cents(Number(n) || 0, 'BRL', getLang());
const pick = (x, k) => (getLang() === 'pt' ? x[`${k}_pt`] : x[`${k}_fr`]) || x[`${k}_fr`] || '';
const shiftMonth = (m, k) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + k, 1)); return d.toISOString().slice(0, 7); };
const monthName = (m, lang) => { const x = new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T12:00:00Z`)); return x.charAt(0).toUpperCase() + x.slice(1); };

// Libellé d'une échéance (obligation ou échéance vivante de l'app).
export function agendaLabel(x) {
  if (x.kind === 'obligation') return esc(pick(x, 'title'));
  return t(`ag.k.${x.kind}`, { n: x.count, name: x.name || '', comp: x.competence || '', amount: x.cents ? brl(x.cents) : '' });
}
const statusBadge = (s) => `<span class="badge ${s === 'done' ? 'ok' : s === 'late' ? 'bad' : s === 'soon' ? 'warn' : ''}">${t(`ag.st.${s}`)}</span>`;

function itemRow(x, lang) {
  const det = x.kind === 'obligation' ? pick(x, 'detail') : '';
  const markable = x.kind === 'obligation' && !['planned', 'past'].includes(x.status);
  return `<li class="ag-item ag-${esc(x.category)}${['planned', 'past'].includes(x.status) ? ' ag-planned' : ''}" data-day="${esc(x.due)}">
    <div class="spread"><span><span class="ag-dot"></span><b>${agendaLabel(x)}</b></span>${statusBadge(x.status)}</div>
    <div class="hint">${fmtDay(x.due, lang)} · ${t(`ag.cat.${x.category}`)}${det ? ` · ${esc(det)}` : ''}</div>
    ${x.status === 'done' && x.kind === 'obligation' ? `<div class="hint">✓ ${t('ag.done.on', { date: fmtDay(String(x.done_at).slice(0, 10), lang) })}${x.ref ? ` · ${esc(x.ref)}` : ''}${x.note ? ` · ${esc(x.note)}` : ''}</div>` : ''}
    <div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap;align-items:flex-end">
      ${markable && x.status !== 'done' ? `<form class="ag-mark row" data-id="${x.id}" data-due="${esc(x.due)}" style="gap:6px;align-items:flex-end;flex:1">
        <input name="ref" placeholder="${esc(tRaw('ag.ref.ph'))}" style="flex:1;min-width:140px"><button class="btn small">${t('ag.mark')}</button></form>` : ''}
      ${markable && x.status === 'done' ? `<button class="btn ghost small" data-unmark="${x.id}" data-due="${esc(x.due)}">${t('ag.unmark')}</button>` : ''}
      ${x.link ? `<a class="btn ghost small" href="#/${esc(x.link)}">${t('ag.open')}</a>` : ''}
    </div></li>`;
}

function calendar(month, items, holidays, today, lang) {
  const [y, mo] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1)); const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // lundi = 0
  const wd = [...Array(7)].map((_, i) => new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'fr-FR', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 16 + i))));
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="ag-cell ag-empty"></div>');
  for (let d = 1; d <= days; d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    const its = items.filter((x) => x.due === iso);
    const worst = its.some((x) => x.status === 'late') ? 'late' : its.some((x) => x.status === 'soon') ? 'soon' : its.some((x) => ['todo'].includes(x.status)) ? 'todo' : its.length ? 'done' : '';
    const wk = (lead + d - 1) % 7 >= 5;
    cells.push(`<button type="button" class="ag-cell${iso === today ? ' ag-today' : ''}${holidays.includes(iso) ? ' ag-holiday' : ''}${wk ? ' ag-weekend' : ''}${worst ? ` ag-w-${worst}` : ''}" data-pick="${iso}" title="${esc(its.map((x) => agendaLabel(x).replace(/<[^>]+>/g, '')).join(' · '))}">
      <span class="ag-n">${d}</span>
      <span class="ag-dots">${its.slice(0, 6).map((x) => `<i class="ag-${esc(x.category)}${x.status === 'done' ? ' ag-ok' : ''}"></i>`).join('')}</span>
      ${its.length ? `<span class="ag-c">${its.length}</span>` : ''}</button>`);
  }
  return `<div class="ag-cal"><div class="ag-head">${wd.map((w) => `<span>${esc(w)}</span>`).join('')}</div><div class="ag-grid">${cells.join('')}</div></div>
    <div class="ag-legend">${CATS.map((c) => `<span class="ag-${c}"><i></i>${t(`ag.cat.${c}`)}</span>`).join('')}<span class="ag-hol"><i></i>${t('ag.holiday')}</span></div>`;
}

function obligationForm(o = {}) {
  const v = (k) => esc(o[k] ?? '');
  const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([val, lbl]) => `<option value="${val}"${String(cur ?? '') === String(val) ? ' selected' : ''}>${lbl}</option>`).join('')}</select>`;
  return `<form class="ag-ob" data-id="${o.id || ''}">
    <div class="grid2">
      <div class="field"><label>${t('ag.f.title_fr')}</label><input name="title_fr" required value="${v('title_fr')}"></div>
      <div class="field"><label>${t('ag.f.title_pt')}</label><input name="title_pt" value="${v('title_pt')}"></div>
      <div class="field"><label>${t('ag.f.category')}</label>${sel('category', CATS.map((c) => [c, t(`ag.cat.${c}`)]), o.category || 'impots')}</div>
      <div class="field"><label>${t('ag.f.freq')}</label>${sel('freq', ['monthly', 'yearly', 'weekly', 'once'].map((f) => [f, t(`ag.freq.${f}`)]), o.freq || 'monthly')}</div>
      <div class="field"><label>${t('ag.f.day')}</label><input name="day" type="number" min="1" max="31" value="${v('day')}"></div>
      <div class="field"><label>${t('ag.f.business')}</label>${sel('business', [['', t('ag.bus.none')], ['prev', t('ag.bus.prev')], ['next', t('ag.bus.next')], ['last', t('ag.bus.last')]], o.business)}</div>
      <div class="field"><label>${t('ag.f.months')}</label><input name="months" placeholder="1,4,7,10" value="${esc((o.months || []).join(','))}"></div>
      <div class="field"><label>${t('ag.f.weekday')}</label>${sel('weekday', [['', '—'], ...[1, 2, 3, 4, 5, 6, 7].map((n) => [n, new Intl.DateTimeFormat(getLang() === 'pt' ? 'pt-BR' : 'fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 15 + n)))])], o.weekday)}</div>
      <div class="field"><label>${t('ag.f.once')}</label><input name="once_on" type="date" value="${v('once_on')}"></div>
      <div class="field"><label>${t('ag.f.regime')}</label>${sel('regime', ['all', 'simples', 'not_simples', 'presumido', 'real'].map((r) => [r, t(`ag.reg.${r}`)]), o.regime || 'all')}</div>
    </div>
    <div class="field"><label>${t('ag.f.detail_fr')}</label><input name="detail_fr" value="${v('detail_fr')}"></div>
    <div class="field"><label>${t('ag.f.detail_pt')}</label><input name="detail_pt" value="${v('detail_pt')}"></div>
    <div class="row" style="gap:14px;flex-wrap:wrap">
      <label style="font-weight:400"><input type="checkbox" name="active" style="width:auto"${o.active !== false ? ' checked' : ''}> ${t('ag.f.active')}</label>
      <label style="font-weight:400"><input type="checkbox" name="needs_cnpj" style="width:auto"${o.needs_cnpj ? ' checked' : ''}> ${t('ag.f.needs_cnpj')}</label>
    </div>
    <button class="btn small" style="margin-top:8px">${t('common.save')}</button></form>`;
}

export async function agendaAdmin() {
  const lang = getLang();
  const month = (location.hash.match(/agenda\/(\d{4}-\d{2})/) || [])[1] || new Date().toISOString().slice(0, 7);
  const [ag, obs] = await Promise.all([store.adminAgenda(month), store.listObligations()]);
  if (!ag) return { html: `<div class="notice warn">${t('ag.notinstalled')}</div>` };
  const items = [...(ag.items || [])].sort((a, b) => a.due.localeCompare(b.due));
  const overdue = ag.overdue || [];
  const s = ag.settings || {};
  const today = ag.today;
  const in7 = new Date(`${today}T12:00:00Z`); in7.setUTCDate(in7.getUTCDate() + 7); const in7s = in7.toISOString().slice(0, 10);
  const open = (x) => ['late', 'soon', 'todo'].includes(x.status);
  const lateNow = items.filter((x) => x.status === 'late').length + overdue.length;
  const week = items.filter((x) => open(x) && x.due >= today && x.due <= in7s).length;
  const done = items.filter((x) => x.status === 'done').length;
  const planned = items.filter((x) => x.status === 'planned').length;

  const head = `<div class="card"><div class="spread" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">${esc(monthName(month, lang))}</h2>
      <span class="row" style="gap:6px"><a class="btn ghost small" href="#/agenda/${shiftMonth(month, -1)}">←</a>
        <a class="btn ghost small" href="#/agenda">${t('ag.today')}</a><a class="btn ghost small" href="#/agenda/${shiftMonth(month, 1)}">→</a></span></div>
      <p class="hint">${t('ag.hint')}</p>
      ${!s.cnpj_opened_on ? `<div class="notice warn">${t('ag.nocnpj')}</div>` : ''}
      <div class="pd-kpis">
        <div class="pd-kpi ${lateNow ? 'bad' : ''}"><span>${t('ag.k.late')}</span><b>${lateNow}</b><em>${t('ag.k.late.em')}</em></div>
        <div class="pd-kpi ${week ? 'warn' : ''}"><span>${t('ag.k.week')}</span><b>${week}</b><em>${t('ag.k.week.em')}</em></div>
        <div class="pd-kpi"><span>${t('ag.k.done')}</span><b>${done}</b><em>${t('ag.k.done.em')}</em></div>
        <div class="pd-kpi"><span>${t('ag.k.planned')}</span><b>${planned}</b><em>${t('ag.k.planned.em')}</em></div>
      </div>
      ${calendar(month, items, ag.holidays || [], today, lang)}</div>`;

  const overdueCard = overdue.length ? `<div class="card"><h2>${t('ag.overdue')}</h2><ul class="list">${overdue.map((x) => itemRow(x, lang)).join('')}</ul></div>` : '';
  const listCard = `<div class="card" id="ag-list"><div class="spread"><h2 style="margin:0">${t('ag.list')}</h2>
      <button class="btn ghost small" id="ag-all" hidden>${t('ag.showall')}</button></div>
      ${items.length ? `<ul class="list">${items.map((x) => itemRow(x, lang)).join('')}</ul>` : `<p class="hint">${t('ag.none')}</p>`}</div>`;

  const settingsCard = `<form class="card" id="ag-settings"><h2>${t('ag.set.title')}</h2><p class="hint">${t('ag.set.hint')}</p>
      <div class="grid2">
        <div class="field"><label>${t('ag.set.name')}</label><input name="name" value="${esc(s.company_name || '')}" placeholder="Kombrio … LTDA"></div>
        <div class="field"><label>CNPJ</label><input name="cnpj" inputmode="numeric" value="${esc(s.cnpj ? fmtTaxId(s.cnpj) : '')}" placeholder="00.000.000/0001-00"></div>
        <div class="field"><label>${t('ag.set.opened')}</label><input name="opened" type="date" value="${esc(s.cnpj_opened_on || '')}"></div>
        <div class="field"><label>${t('ag.set.regime')}</label><select name="regime">${['simples', 'presumido', 'real'].map((r) => `<option value="${r}"${(s.tax_regime || 'simples') === r ? ' selected' : ''}>${t(`ag.reg.${r}`)}</option>`).join('')}</select></div>
      </div>
      <button class="btn small">${t('common.save')}</button></form>`;

  const obsCard = `<div class="card"><h2>${t('ag.obs.title')}</h2><p class="hint">${t('ag.obs.hint')}</p>
      <ul class="list">${obs.map((o) => `<li><details><summary class="spread" style="cursor:pointer">
        <span><span class="ag-dot ag-${esc(o.category)}"></span><b>${esc(pick(o, 'title'))}</b><br><span class="hint">${t(`ag.freq.${o.freq}`)}${o.day ? ` · ${t('ag.day', { d: o.day })}` : ''}${o.business ? ` · ${t(`ag.bus.${o.business}`)}` : ''}${o.months ? ` · ${t('ag.months', { m: o.months.join(', ') })}` : ''}${o.once_on ? ` · ${fmtDay(o.once_on, lang)}` : ''} · ${t(`ag.reg.${o.regime}`)}</span></span>
        <span class="badge ${o.active ? 'ok' : ''}">${t(o.active ? 'ag.on' : 'ag.off')}</span></summary>${obligationForm(o)}</details></li>`).join('')}</ul>
      <details style="margin-top:10px"><summary class="btn secondary small">${t('ag.obs.add')}</summary>${obligationForm({ category: 'impots', freq: 'monthly', active: true, needs_cnpj: false })}</details></div>`;

  return {
    html: `${head}${overdueCard}${listCard}${settingsCard}${obsCard}`,
    mount(root, ctx) {
      const list = root.querySelector('#ag-list'); const all = root.querySelector('#ag-all');
      root.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => {
        const day = b.dataset.pick;
        list.querySelectorAll('.ag-item').forEach((li) => { li.hidden = li.dataset.day !== day; });
        root.querySelectorAll('.ag-cell').forEach((c) => c.classList.toggle('ag-sel', c === b));
        all.hidden = false; list.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }; });
      all.onclick = () => { list.querySelectorAll('.ag-item').forEach((li) => { li.hidden = false; }); all.hidden = true; root.querySelectorAll('.ag-cell').forEach((c) => c.classList.remove('ag-sel')); };
      root.querySelectorAll('.ag-mark').forEach((f) => { f.onsubmit = async (e) => {
        e.preventDefault(); const b = f.querySelector('button'); b.disabled = true;
        try {
          const r = await store.markObligation(Number(f.dataset.id), f.dataset.due, true, f.ref.value, null);
          if (!r || !r.ok) throw new Error('x');
          ctx.refresh(tRaw('ag.marked'));
        } catch { b.disabled = false; notify(tRaw('err.generic')); }
      }; });
      root.querySelectorAll('[data-unmark]').forEach((b) => { b.onclick = async () => {
        const reason = prompt(tRaw('ag.unmark.reason'));
        if (!reason || reason.trim().length < 3) return;
        try { const r = await store.markObligation(Number(b.dataset.unmark), b.dataset.due, false, null, reason.trim()); if (!r || !r.ok) throw new Error('x'); ctx.refresh(); }
        catch { notify(tRaw('err.generic')); }
      }; });
      root.querySelector('#ag-settings').onsubmit = async (e) => {
        e.preventDefault(); const f = e.target;
        try {
          const r = await store.saveAdminSettings({ name: f.elements.name.value, cnpj: f.cnpj.value, opened: f.opened.value, regime: f.regime.value });
          if (!r || !r.ok) { notify(tRaw('ag.err.values')); return; }
          ctx.refresh(tRaw('common.saved'));
        } catch { notify(tRaw('err.generic')); }
      };
      root.querySelectorAll('.ag-ob').forEach((f) => { f.onsubmit = async (e) => {
        e.preventDefault();
        const months = f.months.value.split(/[ ,;]+/).map(Number).filter((n) => n >= 1 && n <= 12);
        const o = { id: f.dataset.id || null, title_fr: f.title_fr.value, title_pt: f.title_pt.value, category: f.category.value, freq: f.freq.value,
          day: f.day.value, business: f.business.value, months, weekday: f.weekday.value, once_on: f.once_on.value, regime: f.regime.value,
          detail_fr: f.detail_fr.value, detail_pt: f.detail_pt.value, active: f.active.checked, needs_cnpj: f.needs_cnpj.checked };
        try {
          const r = await store.saveObligation(o);
          if (!r || !r.ok) { notify(tRaw('ag.err.values')); return; }
          ctx.refresh(tRaw('common.saved'));
        } catch { notify(tRaw('err.generic')); }
      }; });
    },
  };
}

// Pastille de l'onglet : en retard + à faire dans les 3 jours.
export function agendaTodo(ag) {
  if (!ag) return 0;
  return (ag.items || []).filter((x) => ['late', 'soon'].includes(x.status)).length + (ag.overdue || []).length;
}
