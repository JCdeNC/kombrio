// v123 (script 074) : règles de commission en plus, réglées par le gérant de chaque loja (Configurações).
//   - Carte « Regras da comissão » : part non commissionnable (ex. Bebidas), plafond et minimum par addition, palier du mois.
//   - Carte « Horários turbo » : un jour précis ou chaque semaine, taux (ou forfait) plus élevé sur une plage horaire.
//   Les guides connectés voient les turbos et paliers (jamais la page du client) ; le plus avantageux pour le guide l'emporte.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, notify, locale, parseCents, weekdayShort } from '../util.js';
import * as store from '../store.js';

const money = (cents) => (cents ? (cents / 100).toFixed(2).replace('.', ',') : '');
const pct = (rate) => (rate ? String(Math.round(rate * 10000) / 100).replace('.', ',') : '');
const parsePct = (v) => { const x = String(v || '').trim().replace(',', '.'); return x === '' ? null : Number(x); };
const parseMoney = (v) => (String(v || '').trim() === '' ? null : (parseCents(String(v).replace(/R\$/g, '')) ?? NaN));
const isoDay = (d) => d.toISOString().slice(0, 10);
const todayStr = () => isoDay(new Date(Date.now() - 3 * 36e5));   // Rio ≈ UTC−3
const dayShort = (day, lang) => new Intl.DateTimeFormat(locale(lang), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

// Texte d'un turbo : « ter., qui. · 12:00–15:00 » ou « sáb. 6 dez. · todo o dia ».
export function boostWhen(b, lang = getLang()) {
  const when = b.day ? dayShort(b.day, lang) : b.weekdays.map((d) => weekdayShort(d, lang)).join(', ');
  const h = b.from && b.to ? `${b.from}–${b.to}` : b.from ? tRaw('bo.from', { t: b.from }) : b.to ? tRaw('bo.until', { t: b.to }) : tRaw('bst.allday');
  return `${when} · ${h}`;
}
export const boostValue = (b, c) => (b.ppCents ? tRaw('rate.per_person', { amount: c(b.ppCents) }) : b.rate ? `${pct(b.rate)} %` : '');

// Carte des règles (gérant).
export function rulesCard(partner, c, base = '') {
  const pp = partner.commissionModel === 'per_person';
  return `<form class="card" id="rules">
    <h2>${t('rules.title')}</h2>
    <p class="hint">${t('rules.hint')}</p>
    ${base ? `<div class="notice ok rw-entry"><b>${t('rw.entry')}</b><span class="hint">${t('rw.entry.hint')}</span>
      <span class="row" style="gap:6px"><a class="btn small" href="${base}/regras">${t('rw.entry.btn')}</a><a class="btn secondary small" href="${base}/comissao">${t('sim.open')}</a><a class="btn ghost small" href="#/tuto/rules">${t('tu.see')}</a></span></div>` : ''}
    <div class="field"><label for="ru-ex">${t('rules.excluded')}</label>
      <input id="ru-ex" name="ex" maxlength="40" value="${esc(partner.excludedLabel)}" placeholder="${esc(tRaw('rules.excluded.ph'))}">
      <p class="hint" style="margin:4px 0 0">${t(pp ? 'rules.excluded.pp' : 'rules.excluded.hint')}</p></div>
    <div class="grid2 rs-keep2">
      <div class="field"><label for="ru-min">${t('rules.min')}</label><input id="ru-min" name="min" inputmode="decimal" placeholder="—" value="${money(partner.minCents)}"></div>
      <div class="field"><label for="ru-cap">${t('rules.cap')}</label><input id="ru-cap" name="cap" inputmode="decimal" placeholder="—" value="${money(partner.capCents)}"></div>
    </div>
    <p class="hint" style="margin:0 0 10px">${t('rules.capmin.hint')}</p>
    <h3 style="margin:6px 0 4px">${t('rules.tier')}</h3>
    <p class="hint" style="margin:0 0 6px">${t('rules.tier.hint')}</p>
    <div class="grid2 rs-keep2">
      <div class="field"><label for="ru-tc">${t('rules.tier.clients')}</label><input id="ru-tc" name="tc" type="number" min="0" max="1000" step="1" inputmode="numeric" placeholder="20" value="${partner.tierClients || ''}"></div>
      <div class="field"><label for="ru-tv">${t(pp ? 'rules.tier.pp' : 'rules.tier.rate')}</label><input id="ru-tv" name="tv" inputmode="decimal"
        placeholder="${pp ? '15,00' : '12'}" value="${pp ? money(partner.tierPpCents) : pct(partner.tierRate)}"></div>
    </div>
    <button class="btn secondary">${t('common.save')}</button>
  </form>`;
}

export function mountRulesCard(root, ctx, partner, key) {
  const f = root.querySelector('#rules');
  if (!f) return;
  const pp = partner.commissionModel === 'per_person';
  f.onsubmit = async (e) => {
    e.preventDefault();
    const minC = parseMoney(f.min.value); const capC = parseMoney(f.cap.value);
    const tc = Number(f.tc.value) || 0;
    const tv = pp ? parseMoney(f.tv.value) : parsePct(f.tv.value);
    if (Number.isNaN(minC) || Number.isNaN(capC) || (minC != null && minC < 100) || (capC != null && capC < 100)) { notify(tRaw('rules.err.money')); return; }
    if (minC != null && capC != null && minC > capC) { notify(tRaw('rules.err.minmax')); return; }
    if (tc && (!Number.isInteger(tc) || tc < 2 || tc > 1000)) { notify(tRaw('rules.err.tier')); f.tc.focus(); return; }
    if (tc && (tv == null || Number.isNaN(tv) || (pp ? tv < 100 || tv > 50000 : tv <= 0 || tv > 50))) { notify(tRaw('rules.err.tier')); f.tv.focus(); return; }
    const base = pp ? partner.perPersonCents : Math.round(partner.commissionRate * 10000) / 100;
    if (tc && tv <= base) { notify(tRaw('rules.err.tier.low')); f.tv.focus(); return; }
    const ok = await store.setCommissionRules(key, { excludedLabel: f.ex.value.trim(), capCents: capC, minCents: minC,
      tierClients: tc || null, tierRate: tc && !pp ? Math.round(tv * 100) / 10000 : null, tierPpCents: tc && pp ? tv : null }).catch(() => false);
    if (ok) ctx.refresh(tRaw('common.saved')); else notify(tRaw('err.generic'));
  };
}

// Carte des horaires turbo (gérant).
export function boostCard(space, c) {
  if (space.boosts == null) return '';
  const pp = space.partner.commissionModel === 'per_person';
  const lang = getLang();
  return `<div class="card" id="bst-card">
    <h2>${t('bst.p.title')}</h2>
    <p class="hint">${t('bst.p.hint')}</p>
    <div class="field" style="display:grid;gap:6px">
      <label style="font-weight:400;display:flex;gap:10px;align-items:center"><input type="radio" name="bst-kind" value="week" style="width:auto" checked> ${t('bst.p.week')}</label>
      <label style="font-weight:400;display:flex;gap:10px;align-items:center"><input type="radio" name="bst-kind" value="day" style="width:auto"> ${t('bst.p.day')}</label></div>
    <fieldset class="wdays" id="bst-wd"><legend>${t('bst.p.wdays')}</legend>
      ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<label class="wday"><input type="checkbox" name="bst-w" value="${d}"><span>${esc(weekdayShort(d, lang))}</span></label>`).join('')}
    </fieldset>
    <div class="field" id="bst-dayf" hidden><label for="bst-date">${t('bst.p.date')}</label><input id="bst-date" type="date" min="${todayStr()}"></div>
    <div class="row bo-hours"><div class="field"><label for="bst-from">${t('bo.p.from')}</label><input id="bst-from" type="time" step="900"></div>
      <div class="field"><label for="bst-to">${t('bo.p.to')}</label><input id="bst-to" type="time" step="900"></div></div>
    <div class="grid2 rs-keep2">
      <div class="field"><label for="bst-val">${t(pp ? 'bst.p.pp' : 'bst.p.rate')}</label><input id="bst-val" inputmode="decimal" placeholder="${pp ? money(space.partner.perPersonCents + 500) || '15,00' : String(Math.round(space.partner.commissionRate * 100) + 5)}"></div>
      <div class="field"><label for="bst-note">${t('bst.p.note')}</label><input id="bst-note" maxlength="120" placeholder="${esc(tRaw('bst.p.note.ph'))}"></div>
    </div>
    <p class="hint" style="margin:0 0 10px">${t('bst.p.base', { base: pp ? tRaw('rate.per_person', { amount: c(space.partner.perPersonCents) }) : `${Math.round(space.partner.commissionRate * 100)} %` })}</p>
    <button type="button" class="btn secondary" id="bst-save">${t('bst.p.save')}</button>
    <div id="bst-list"></div>
  </div>`;
}

export function mountBoostCard(root, ctx, space, c) {
  const card = root.querySelector('#bst-card');
  if (!card) return;
  const pp = space.partner.commissionModel === 'per_person';
  const lang = getLang();
  let list = [...(space.boosts || [])];
  const kind = () => card.querySelector('[name=bst-kind]:checked').value;
  card.querySelectorAll('[name=bst-kind]').forEach((r) => { r.onchange = () => {
    card.querySelector('#bst-wd').hidden = kind() !== 'week'; card.querySelector('#bst-dayf').hidden = kind() !== 'day';
  }; });
  const draw = () => {
    const today = todayStr();
    const rows = list.filter((b) => !b.day || b.day >= today);
    card.querySelector('#bst-list').innerHTML = rows.length ? `<h3 style="margin:14px 0 6px">${t('bst.p.list')}</h3><ul class="list">${rows.map((b) => `<li class="spread">
      <span><b>${esc(boostWhen(b, lang))}</b> · <span class="badge ok">${esc(boostValue(b, c))}</span>${b.note ? `<br><span class="hint">${esc(b.note)}</span>` : ''}</span>
      <button type="button" class="btn ghost small" data-bst-rm="${esc(b.id)}">${t('bo.p.remove')}</button></li>`).join('')}</ul>` : `<p class="hint" style="margin-top:10px">${t('bst.p.none')}</p>`;
    card.querySelectorAll('[data-bst-rm]').forEach((b) => { b.onclick = async () => {
      b.disabled = true;
      try { if (!(await store.removeBoost(space.key, b.dataset.bstRm))) throw new Error(); list = list.filter((x) => x.id !== b.dataset.bstRm); draw(); notify(tRaw('bo.p.removed')); }
      catch { b.disabled = false; notify(tRaw('err.generic')); }
    }; });
  };
  card.querySelector('#bst-save').onclick = async () => {
    const weekdays = kind() === 'week' ? [...card.querySelectorAll('[name=bst-w]:checked')].map((x) => Number(x.value)) : [];
    const day = kind() === 'day' ? card.querySelector('#bst-date').value : '';
    const from = card.querySelector('#bst-from').value; const to = card.querySelector('#bst-to').value;
    const raw = card.querySelector('#bst-val').value;
    const val = pp ? parseMoney(raw) : parsePct(raw);
    const note = card.querySelector('#bst-note').value.trim();
    if (kind() === 'week' && !weekdays.length) { notify(tRaw('bst.err.when')); return; }
    if (kind() === 'day' && !day) { notify(tRaw('bst.err.when')); card.querySelector('#bst-date').focus(); return; }
    if (from && to && to <= from) { notify(tRaw('bo.p.time.err')); card.querySelector('#bst-to').focus(); return; }
    const base = pp ? space.partner.perPersonCents : Math.round(space.partner.commissionRate * 10000) / 100;
    if (val == null || Number.isNaN(val) || (pp ? val < 100 || val > 50000 : val <= 0 || val > 50)) { notify(tRaw('bst.err.value')); card.querySelector('#bst-val').focus(); return; }
    if (val <= base) { notify(tRaw('bst.err.low')); card.querySelector('#bst-val').focus(); return; }
    const btn = card.querySelector('#bst-save'); btn.disabled = true;
    try {
      const r = await store.addBoosts(space.key, { days: day ? [day] : [], weekdays, from, to, rate: pp ? null : Math.round(val * 100) / 10000, ppCents: pp ? val : null, note });
      if (!r || !r.ok) { btn.disabled = false; notify(tRaw(r && r.reason === 'limit' ? 'bst.err.limit' : 'err.generic')); return; }
      ctx.refresh(tRaw('bst.p.saved'));
    } catch { btn.disabled = false; notify(tRaw('err.generic')); }
  };
  draw();
}
