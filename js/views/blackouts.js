// v118 (script 070) : jours sans commission (ex. jours de match).
//   Gérant : calendrier dans Configurações › dates à cocher + message pour les clients ; option « toutes les lojas propres du groupe ».
//   Client et guide : le message s'affiche pour les jours à venir.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, fmtDay, notify, locale } from '../util.js';
import * as store from '../store.js';

const iso = (d) => d.toISOString().slice(0, 10);
const todayStr = () => iso(new Date(Date.now() - 3 * 36e5));   // Rio ≈ UTC−3
const shiftMonth = (m, k) => { const [y, mo] = m.split('-').map(Number); return iso(new Date(Date.UTC(y, mo - 1 + k, 1))).slice(0, 7); };
const monthTitle = (m, lang) => { const s = new Intl.DateTimeFormat(locale(lang), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T12:00:00Z`)); return s.charAt(0).toUpperCase() + s.slice(1); };
// v120 : horaire facultatif (ex. soir de match à partir de 17:00). Vide = toute la journée.
export const boTime = (b) => b.from && b.to ? tRaw('bo.range', { a: b.from, b: b.to }) : b.from ? tRaw('bo.from', { t: b.from }) : b.to ? tRaw('bo.until', { t: b.to }) : '';
const boWhen = (b, today, lang) => { const h = boTime(b); return `${b.day === today ? t('bo.today') : esc(dayShort(b.day, lang))}${h ? ` · ${esc(h)}` : ''}`; };
const dayShort = (day, lang) => new Intl.DateTimeFormat(locale(lang), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

// Lignes « jour sans commission » sous une fiche partenaire (page du client, app du guide).
export function blackoutLines(p, max = 3, forGuide = false) {
  const list = (p.blackouts || []).slice(0, max);
  if (!list.length) return '';
  const lang = getLang(); const today = todayStr();
  return `<div class="bo-lines">${list.map((b) => `<div class="bo-line${b.day === today ? ' bo-today' : ''}"><span class="bo-ico" aria-hidden="true">!</span>
    <span><b>${boWhen(b, today, lang)}</b> · ${esc(b.note || tRaw(forGuide ? 'bo.default.guide' : 'bo.default'))}${forGuide && b.note ? ` <span class="hint">· ${t('bo.guide.nocom')}</span>` : ''}</span></div>`).join('')}
    ${(p.blackouts || []).length > max ? `<div class="hint">${t('bo.more', { n: p.blackouts.length - max })}</div>` : ''}</div>`;
}

// Carte du gérant (onglet Configurações).
export function blackoutCard(space) {
  if (space.blackouts == null) return '';
  const inGroup = !!(space.group && space.partner.ownership !== 'franchise');
  return `<div class="card" id="bo-card">
    <h2>${t('bo.p.title')}</h2>
    <p class="hint">${t('bo.p.hint')}</p>
    <div class="bo-cal" id="bo-cal"></div>
    <div class="field"><label for="bo-note">${t('bo.p.note')}</label>
      <input id="bo-note" maxlength="160" required placeholder="${esc(tRaw('bo.p.note.ph'))}"></div>
    <div class="row bo-hours"><div class="field"><label for="bo-from">${t('bo.p.from')}</label><input id="bo-from" type="time" step="900"></div>
      <div class="field"><label for="bo-to">${t('bo.p.to')}</label><input id="bo-to" type="time" step="900"></div></div>
    <p class="hint" style="margin:-4px 0 10px">${t('bo.p.hours.hint')}</p>
    ${inGroup ? `<label class="bo-all"><input type="checkbox" id="bo-all"><span>${t('bo.p.all', { name: space.group.group.name })}</span></label>` : ''}
    <button type="button" class="btn secondary" id="bo-save" disabled>${t('bo.p.save0')}</button>
    <div id="bo-list"></div>
  </div>`;
}

export function mountBlackoutCard(root, ctx, space) {
  const card = root.querySelector('#bo-card');
  if (!card) return;
  const lang = getLang(); const today = todayStr();
  const have = new Map((space.blackouts || []).map((b) => [b.day, b]));
  const sel = new Set();
  let month = today.slice(0, 7);
  const cal = card.querySelector('#bo-cal'); const save = card.querySelector('#bo-save');
  const draw = () => {
    const [y, mo] = month.split('-').map(Number);
    const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const wd = [...Array(7)].map((_, i) => new Intl.DateTimeFormat(locale(lang), { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 16 + i))));
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span></span>';
    for (let d = 1; d <= days; d++) {
      const day = `${month}-${String(d).padStart(2, '0')}`;
      const past = day < today;
      cells += `<button type="button" class="bo-d${have.has(day) ? ' bo-on' : ''}${sel.has(day) ? ' bo-sel' : ''}${day === today ? ' bo-now' : ''}" data-day="${day}"${past ? ' disabled' : ''}
        title="${esc(have.has(day) ? [boTime(have.get(day)), have.get(day).note || tRaw('bo.default')].filter(Boolean).join(' · ') : '')}">${d}</button>`;
    }
    cal.innerHTML = `<div class="bo-head"><button type="button" class="btn ghost small" data-m="-1"${month <= today.slice(0, 7) ? ' disabled' : ''} aria-label="‹">‹</button>
      <b>${esc(monthTitle(month, lang))}</b><button type="button" class="btn ghost small" data-m="1" aria-label="›">›</button></div>
      <div class="bo-grid">${wd.map((w) => `<i>${esc(w)}</i>`).join('')}${cells}</div>
      <p class="hint bo-legend"><span class="bo-k bo-on"></span>${t('bo.p.leg.on')} <span class="bo-k bo-sel"></span>${t('bo.p.leg.sel')}</p>`;
    cal.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { month = shiftMonth(month, Number(b.dataset.m)); draw(); }; });
    cal.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => {
      const d = b.dataset.day;
      if (have.has(d)) { const li = card.querySelector(`[data-bo-day="${d}"]`); if (li) { li.scrollIntoView({ block: 'center' }); li.classList.add('bo-flash'); setTimeout(() => li.classList.remove('bo-flash'), 1200); } return; }
      if (sel.has(d)) sel.delete(d); else sel.add(d);
      b.classList.toggle('bo-sel', sel.has(d));
      save.disabled = !sel.size;
      save.textContent = sel.size ? tRaw('bo.p.save', { n: sel.size }) : tRaw('bo.p.save0');
    }; });
  };
  const list = () => {
    const rows = [...have.entries()].filter(([d]) => d >= today).sort((x, y) => x[0].localeCompare(y[0]));
    card.querySelector('#bo-list').innerHTML = rows.length ? `<h3 style="margin:14px 0 6px">${t('bo.p.next')}</h3><ul class="list">${rows.map(([d, n]) => `<li class="spread" data-bo-day="${d}">
      <span><b>${esc(dayShort(d, lang))}${boTime(n) ? ` · ${esc(boTime(n))}` : ''}</b><br><span class="hint">${esc(n.note || tRaw('bo.default'))}</span></span>
      <button type="button" class="btn ghost small" data-rm="${d}">${t('bo.p.remove')}</button></li>`).join('')}</ul>` : `<p class="hint" style="margin-top:10px">${t('bo.p.none')}</p>`;
    card.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => {
      const all = !!(card.querySelector('#bo-all') || {}).checked;
      b.disabled = true;
      try { const r = await store.removeBlackout(space.key, b.dataset.rm, all); if (!r || !r.ok) throw new Error(); have.delete(b.dataset.rm); draw(); list(); notify(tRaw('bo.p.removed')); }
      catch { b.disabled = false; notify(tRaw('err.generic')); }
    }; });
  };
  save.onclick = async () => {
    const days = [...sel].sort(); const note = card.querySelector('#bo-note').value.trim();
    const all = !!(card.querySelector('#bo-all') || {}).checked;
    const from = card.querySelector('#bo-from').value; const to = card.querySelector('#bo-to').value;
    if (!days.length) return;
    if (!note) { notify(tRaw('bo.p.note.req')); card.querySelector('#bo-note').focus(); return; }   // motif obligatoire
    if (from && to && to <= from) { notify(tRaw('bo.p.time.err')); card.querySelector('#bo-to').focus(); return; }
    save.disabled = true;
    try {
      const r = await store.addBlackouts(space.key, days, note, all, from, to);
      if (!r || !r.ok) throw new Error();
      days.forEach((d) => have.set(d, { day: d, note, from, to })); sel.clear();
      draw(); list(); save.textContent = tRaw('bo.p.save0');
      // v120 : « toutes les lojas » est réservé au responsável du groupe ; sinon seulement cette loja.
      notify(tRaw(all && r.all_group === false ? 'bo.p.all.denied' : all ? 'bo.p.saved.all' : 'bo.p.saved', { n: days.length }));
    } catch { save.disabled = false; notify(tRaw('err.generic')); }
  };
  draw(); list();
}

// Bandeau « aujourd'hui sans commission » pour l'équipe et le gérant au moment du scan : motif à dire au client.
export function blackoutToday(blackouts, today, nowHm = '') {
  const b = (blackouts || []).find((x) => x.day === today);
  if (!b) return '';
  if (b.to && nowHm && nowHm >= b.to) return '';   // plage terminée
  const later = b.from && nowHm && nowHm < b.from;   // pas encore commencée : avertissement en orange
  return `<div class="notice ${later ? 'warn' : 'bad'} bo-scan no-print"><b>${t(later ? 'bo.scan.later' : 'bo.scan.title', { h: boTime(b) })}</b>${boTime(b) && !later ? ` <span>(${esc(boTime(b))})</span>` : ''}<br>${t('bo.scan.reason', { note: b.note || tRaw('bo.default') })}<br><span class="hint">${t(later ? 'bo.scan.later.text' : 'bo.scan.text')}</span></div>`;
}

// Jours sans commission pendant un séjour (du jour même à la fin) : page du client et fiche du séjour dans l'app du guide.
export function stayBlackoutCard(partners, from, to, forGuide = false) {
  const today = todayStr(); const start = from && from > today ? from : today;
  const rows = [];
  (partners || []).forEach((p) => (p.blackouts || []).forEach((b) => { if (b.day >= start && (!to || b.day <= to)) rows.push({ p, b }); }));
  if (!rows.length) return '';
  rows.sort((x, y) => x.b.day.localeCompare(y.b.day) || x.p.name.localeCompare(y.p.name));
  const lang = getLang();
  return `<div class="card bo-stay"><h2 style="margin:0 0 4px">${t(forGuide ? 'bo.s.title' : 'bo.c.title')}</h2>
    <p class="hint">${t(forGuide ? 'bo.s.hint' : 'bo.c.hint')}</p>
    <div class="bo-lines">${rows.map(({ p, b }) => `<div class="bo-line${b.day === today ? ' bo-today' : ''}"><span class="bo-ico" aria-hidden="true">!</span>
      <span><b>${esc(p.name)}</b> · <b>${boWhen(b, today, lang)}</b><br>${esc(b.note || tRaw(forGuide ? 'bo.default.guide' : 'bo.default'))}</span></div>`).join('')}</div></div>`;
}
