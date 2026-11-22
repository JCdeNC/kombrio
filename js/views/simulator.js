// v125 : simulateur des règles de commission, pour que le partenaire teste et valide ses choix.
//   - #/p/<clé>/simulador : le gérant part de ses règles actuelles (et de ses horaires turbo), change, compare, puis « Validar e salvar ».
//   - #/simulador : page ouverte sans compte (prospects, démo commerciale) : mêmes calculs, puis « Quero ser parceiro ».
// Calculs identiques à la base (store.commissionFor via simulate) : le plus avantageux de normal / palier / turbo,
// puis part non commissionnée, minimum, maximum. Rien n'est enregistré avant le bouton du gérant.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, cents, notify, parseCents, weekdayShort } from '../util.js';
import { rulesSentence, simulate, saveRules } from './rules-wizard.js';
import { boostWhen, boostValue } from './boosts.js';

const RATES = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20];
const money = (x) => (x ? (x / 100).toFixed(2).replace('.', ',') : '');
const pctIn = (r) => (r ? String(Math.round(r * 10000) / 100).replace('.', ',') : '');
const parsePct = (v) => { const x = String(v || '').trim().replace(',', '.'); return x === '' ? null : Number(x); };
const parseMoney = (v) => (String(v || '').trim() === '' ? null : (parseCents(String(v).replace(/R\$/g, '')) ?? NaN));
const num = (v, d = 0) => { const n = Number(String(v || '').replace(',', '.')); return Number.isFinite(n) ? n : d; };

export const simulatorRoute = (params, ctx) => simulatorView(null, ctx);

export function simulatorView(space, ctx, opts = {}) {
  const lang = getLang();
  const partner = space ? space.partner : { commissionModel: 'percent', commissionRate: 0.1, perPersonCents: 1000, bonusEvery: 0, bonusCents: 0, excludedLabel: '', minCents: null, capCents: null, tierClients: 0 };
  const currency = space ? space.city.currency : 'BRL';
  const c = (n) => cents(n, currency, lang);
  const key = space ? space.key : '';
  const existing = space ? (space.boosts || []).filter((b) => !b.day) : [];
  const pp0 = partner.commissionModel === 'per_person';
  const rate0 = RATES.includes(Math.round(partner.commissionRate * 100)) ? partner.commissionRate : 0.1;
  const wd = (name) => [1, 2, 3, 4, 5, 6, 7].map((d) => `<label class="wday"><input type="checkbox" name="${name}" value="${d}"><span>${esc(weekdayShort(d, lang))}</span></label>`).join('');
  const back = space && !opts.embedded ? `<a class="ios-back no-print" href="#/p/${encodeURIComponent(key)}/comissao"><span aria-hidden="true">‹</span> ${t('pd.tab.comissao')}</a>` : '';
  // Trois contas types pour comparer d'un coup d'œil (petit groupe, famille au déjeuner, grand groupe le samedi soir).
  const CASES = [
    { label: 'sim.case1', bill: 12000, people: 2, ex: 2000, wd: 1, hm: '20:00' },
    { label: 'sim.case2', bill: 30000, people: 4, ex: 6000, wd: 2, hm: '13:00' },
    { label: 'sim.case3', bill: 240000, people: 12, ex: 40000, wd: 6, hm: '21:00' },
  ];

  const html = `<div class="${opts.embedded ? '' : 'dash-wide '}sim">${back}
    ${opts.embedded ? `<h2 class="sim-title">${t('sim.title')}</h2>` : `<h1>${t('sim.title')}</h1>`}<p class="hint">${t(space ? 'sim.intro' : 'sim.intro.public')}</p>
    <div class="pd-cols">
      <form class="card sim-rules" id="sim-f" novalidate>
        <h2>${t('sim.rules')}</h2>
        <div class="rw-choices">
          <label class="rw-choice"><input type="radio" name="model" value="percent"${pp0 ? '' : ' checked'}><span><b>${t('partner.model.percent')}</b></span></label>
          <label class="rw-choice"><input type="radio" name="model" value="per_person"${pp0 ? ' checked' : ''}><span><b>${t('partner.model.per_person')}</b></span></label></div>
        <div class="field" id="sf-rate"${pp0 ? ' hidden' : ''}><label for="sf-r">${t('rw.q1.rate')}</label><select id="sf-r" name="rate">${RATES.map((n) => `<option value="${n / 100}"${Math.round(rate0 * 100) === n ? ' selected' : ''}>${n} %</option>`).join('')}</select></div>
        <div class="field" id="sf-pp"${pp0 ? '' : ' hidden'}><label for="sf-p">${t('partner.model.amount')}</label><input id="sf-p" name="pp" inputmode="decimal" value="${money(partner.perPersonCents || 1000)}"></div>
        <div class="field" id="sf-exf"><label for="sf-ex">${t('rules.excluded')}</label><input id="sf-ex" name="ex" maxlength="40" value="${esc(partner.excludedLabel || '')}" placeholder="${esc(tRaw('rules.excluded.ph'))}"></div>
        <div class="grid2 rs-keep2">
          <div class="field"><label for="sf-min">${t('rules.min')}</label><input id="sf-min" name="min" inputmode="decimal" placeholder="—" value="${money(partner.minCents)}"></div>
          <div class="field"><label for="sf-cap">${t('rules.cap')}</label><input id="sf-cap" name="cap" inputmode="decimal" placeholder="—" value="${money(partner.capCents)}"></div></div>
        <h3 class="sim-h3">${t('rules.tier')}</h3>
        <div class="grid2 rs-keep2">
          <div class="field"><label for="sf-tc">${t('rules.tier.clients')}</label><input id="sf-tc" name="tc" type="number" min="0" max="1000" inputmode="numeric" placeholder="20" value="${partner.tierClients || ''}"></div>
          <div class="field"><label for="sf-tv" id="sf-tv-l">${t(pp0 ? 'rules.tier.pp' : 'rules.tier.rate')}</label><input id="sf-tv" name="tv" inputmode="decimal" placeholder="${pp0 ? '15,00' : '12'}" value="${pp0 ? money(partner.tierPpCents) : pctIn(partner.tierRate)}"></div></div>
        <h3 class="sim-h3">${t('sim.turbo')}</h3>
        ${existing.length ? `<p class="hint">${t('sim.turbo.have', { n: existing.length })}</p>` : ''}
        <fieldset class="wdays"><legend>${t('bst.p.wdays')}</legend>${wd('bw')}</fieldset>
        <div class="row bo-hours"><div class="field"><label for="sf-bf">${t('bo.p.from')}</label><input id="sf-bf" name="bf" type="time" step="900"></div>
          <div class="field"><label for="sf-bt">${t('bo.p.to')}</label><input id="sf-bt" name="bt" type="time" step="900"></div></div>
        <div class="field"><label for="sf-bv" id="sf-bv-l">${t(pp0 ? 'bst.p.pp' : 'bst.p.rate')}</label><input id="sf-bv" name="bv" inputmode="decimal" placeholder="${pp0 ? '15,00' : '15'}" style="max-width:160px"></div>
        <p class="notice bad" id="sim-err" hidden></p>
      </form>
      <div class="pd-side">
        <div class="card"><h2>${t('rw.sum')}</h2><blockquote class="rw-sentence" id="sim-sentence"></blockquote></div>
        <div class="card"><h2>${t('sim.test')}</h2>
          <div class="grid2 rs-keep2">
            <div class="field"><label for="st-b">${t('rs.bill')}</label><input id="st-b" inputmode="decimal" value="300,00"></div>
            <div class="field"><label for="st-n">${t('rs.people')}</label><input id="st-n" type="number" min="1" max="99" value="4"></div>
            <div class="field" id="st-exf"><label for="st-x" id="st-x-l"></label><input id="st-x" inputmode="decimal" value="60,00"></div>
            <div class="field"><label for="st-d">${t('rw.sim.when')}</label><div class="row" style="gap:6px;flex-wrap:nowrap"><select id="st-d">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}"${d === 2 ? ' selected' : ''}>${esc(weekdayShort(d, lang))}</option>`).join('')}</select><input id="st-h" type="time" value="13:00"></div></div></div>
          <label class="bo-all" id="st-tierf"><input type="checkbox" id="st-t"><span id="st-t-l"></span></label>
          <p class="sim-big" id="st-res"></p></div>
        <div class="card"><h2>${t('sim.compare')}</h2><p class="hint">${t('sim.compare.hint')}</p>
          <div class="table-wrap"><table id="sim-cases"></table></div></div>
        <div class="card"><h2>${t('sim.month')}</h2><p class="hint">${t('sim.month.hint')}</p>
          <div class="grid2 rs-keep2">
            <div class="field"><label for="sm-g">${t('sim.m.groups')}</label><input id="sm-g" type="number" min="0" max="5000" value="40"></div>
            <div class="field"><label for="sm-a">${t('sim.m.bill')}</label><input id="sm-a" inputmode="decimal" value="300,00"></div>
            <div class="field"><label for="sm-p">${t('sim.m.people')}</label><input id="sm-p" type="number" min="1" max="99" value="4"></div>
            <div class="field" id="sm-exf"><label for="sm-e">${t('sim.m.ex')}</label><input id="sm-e" type="number" min="0" max="100" value="20"></div>
            <div class="field" id="sm-tf"><label for="sm-t">${t('sim.m.turbo')}</label><input id="sm-t" type="number" min="0" max="100" value="25"></div>
            <div class="field" id="sm-pf"><label for="sm-q">${t('sim.m.tier')}</label><input id="sm-q" type="number" min="0" max="100" value="30"></div></div>
          <div class="sim-month" id="sm-res"></div></div>
        <div class="card sim-go">${space
          ? `<p class="hint">${t('sim.save.hint')}</p><button type="button" class="btn block" id="sim-save">${t('sim.save')}</button>`
          : `<p class="hint">${t('sim.public.note')}</p><a class="btn block" href="#/parceria">${t('sim.public.cta')}</a>`}</div>
      </div>
    </div></div>`;

  return {
    html,
    mount(root, ctx2) {
      if (ctx2) ctx = ctx2;
      const f = root.querySelector('#sim-f');
      const $ = (sel) => root.querySelector(sel);
      let s = null; let err = '';
      const read = () => {
        const pp = f.model.value === 'per_person';
        const st = { model: pp ? 'per_person' : 'percent', rate: Number(f.rate.value), pp: parseMoney(f.pp.value), exLabel: pp ? '' : f.ex.value.trim(),
          min: parseMoney(f.min.value), cap: parseMoney(f.cap.value), tierClients: Number(f.tc.value) || 0, tierRate: null, tierPp: null,
          boost: { on: false, weekdays: [], from: '', to: '', rate: null, pp: null, note: '' }, existing };
        let e = '';
        if (pp && (st.pp == null || Number.isNaN(st.pp) || st.pp < 100 || st.pp > 50000)) e = 'partner.model.err';
        if (!e && (Number.isNaN(st.min) || Number.isNaN(st.cap) || (st.min != null && st.min < 100) || (st.cap != null && st.cap < 100))) e = 'rules.err.money';
        if (!e && st.min != null && st.cap != null && st.min > st.cap) e = 'rules.err.minmax';
        if (!e && st.tierClients) {
          const tv = pp ? parseMoney(f.tv.value) : parsePct(f.tv.value);
          if (!Number.isInteger(st.tierClients) || st.tierClients < 2 || st.tierClients > 1000 || tv == null || Number.isNaN(tv) || (pp ? tv < 100 || tv > 50000 : tv <= 0 || tv > 50)) e = 'rules.err.tier';
          else if (pp ? tv <= st.pp : tv <= st.rate * 100) e = 'rules.err.tier.low';
          else { st.tierRate = pp ? null : Math.round(tv * 100) / 10000; st.tierPp = pp ? tv : null; }
        }
        const days = [...f.querySelectorAll('[name=bw]:checked')].map((x) => Number(x.value));
        if (!e && (days.length || f.bv.value.trim())) {
          const v = pp ? parseMoney(f.bv.value) : parsePct(f.bv.value);
          if (!days.length) e = 'bst.err.when';
          else if (f.bf.value && f.bt.value && f.bt.value <= f.bf.value) e = 'bo.p.time.err';
          else if (v == null || Number.isNaN(v) || (pp ? v < 100 || v > 50000 : v <= 0 || v > 50)) e = 'bst.err.value';
          else if (pp ? v <= st.pp : v <= st.rate * 100) e = 'bst.err.low';
          else st.boost = { on: true, weekdays: days, from: f.bf.value, to: f.bt.value, rate: pp ? null : Math.round(v * 100) / 10000, pp: pp ? v : null, note: '' };
        }
        return { st, e };
      };
      // Un créneau turbo pour l'estimation du mois (nouveau turbo, sinon un turbo hebdomadaire existant).
      const turboSlot = (st) => {
        const b = st.boost.on ? st.boost : (existing.find((x) => (st.model === 'per_person' ? x.ppCents : x.rate)) || null);
        return b ? { wd: b.weekdays[0], hm: b.from || '12:00' } : null;
      };
      const quiet = (st) => { for (const d of [1, 2, 3, 4, 5, 6, 7]) { const r = simulate(st, partner, { bill: 100000, people: 1, ex: 0, wd: d, hm: '04:00', tierOn: false }); if (r.why !== 'boost') return { wd: d, hm: '04:00' }; } return { wd: 1, hm: '04:00' }; };
      const draw = () => {
        const r = read(); err = r.e;
        $('#sim-err').hidden = !err; $('#sim-err').textContent = err ? tRaw(err) : '';
        if (err) return;
        s = r.st;
        const pp = s.model === 'per_person';
        $('#sf-rate').hidden = pp; $('#sf-pp').hidden = !pp; $('#sf-exf').hidden = pp;
        $('#sf-tv-l').textContent = tRaw(pp ? 'rules.tier.pp' : 'rules.tier.rate'); $('#sf-bv-l').textContent = tRaw(pp ? 'bst.p.pp' : 'bst.p.rate');
        $('#sim-sentence').textContent = rulesSentence(s, c, lang);
        // Une conta.
        $('#st-exf').hidden = pp || !s.exLabel; $('#st-x-l').textContent = tRaw('rs.excluded', { label: s.exLabel || '' });
        $('#st-tierf').hidden = !s.tierClients; $('#st-t-l').textContent = tRaw('rw.sim.tier', { n: s.tierClients || 0 });
        const one = simulate(s, partner, { bill: parseCents($('#st-b').value) || 0, people: Number($('#st-n').value) || 1, ex: parseCents($('#st-x').value) || 0,
          wd: Number($('#st-d').value), hm: $('#st-h').value || '12:00', tierOn: $('#st-t').checked });
        $('#st-res').innerHTML = t('rw.sim.res', { com: c(one.cents), why: tRaw(`rw.why.${one.why}`) });
        // Trois contas types.
        $('#sim-cases').innerHTML = `<tr><th>${t('sim.col.case')}</th><th>${t('rs.bill')}</th><th>${t('sim.col.com')}</th><th>${t('sim.col.rule')}</th></tr>${CASES.map((k) => {
          const x = simulate(s, partner, { ...k, tierOn: false });
          return `<tr><td>${t(k.label)}<br><span class="hint">${t('scan.people', { n: k.people })} · ${esc(weekdayShort(k.wd, lang))} ${k.hm}</span></td><td>${c(k.bill)}${!pp && s.exLabel ? `<br><span class="hint">${esc(s.exLabel)} ${c(k.ex)}</span>` : ''}</td><td><b>${c(x.cents)}</b></td><td>${esc(tRaw(`rw.why.${x.why}`))}</td></tr>`;
        }).join('')}`;
        // Estimation du mois : moyenne pondérée des 4 cas (turbo oui/non × palier oui/non).
        const g = Math.max(0, num($('#sm-g').value)); const bill = parseCents($('#sm-a').value) || 0; const ppl = Math.max(1, num($('#sm-p').value, 1));
        const ex = pp || !s.exLabel ? 0 : Math.round((bill * Math.min(100, Math.max(0, num($('#sm-e').value)))) / 100);
        const slot = turboSlot(s); const calm = quiet(s);
        const pt = slot ? Math.min(100, Math.max(0, num($('#sm-t').value))) / 100 : 0;
        const pq = s.tierClients ? Math.min(100, Math.max(0, num($('#sm-q').value))) / 100 : 0;
        $('#sm-exf').hidden = pp || !s.exLabel; $('#sm-tf').hidden = !slot; $('#sm-pf').hidden = !s.tierClients;
        const val = (turbo, tier) => simulate(s, partner, { bill, people: ppl, ex, ...(turbo && slot ? slot : calm), tierOn: tier }).cents;
        const avg = (1 - pt) * ((1 - pq) * val(false, false) + pq * val(false, true)) + pt * ((1 - pq) * val(true, false) + pq * val(true, true));
        const total = Math.round(avg * g); const sales = bill * g;
        $('#sm-res').innerHTML = `<div class="spread"><span>${t('sim.m.avg')}</span><b>${c(Math.round(avg))}</b></div>
          <div class="spread"><span>${t('sim.m.total')}</span><b class="sim-big">${c(total)}</b></div>
          <div class="spread"><span>${t('sim.m.sales')}</span><span>${c(sales)}${sales ? ` · ${t('sim.m.share', { pct: (Math.round((total / sales) * 1000) / 10).toString().replace('.', ',') })}` : ''}</span></div>`;
      };
      root.querySelectorAll('input, select').forEach((x) => { x.addEventListener('input', draw); x.addEventListener('change', draw); });
      draw();
      const save = $('#sim-save');
      if (save) save.onclick = async () => {
        draw();
        if (err) { notify(tRaw(err)); $('#sim-err').scrollIntoView({ block: 'center' }); return; }
        save.disabled = true;
        try { await saveRules(key, partner, s); ctx.go(`p/${key}/comissao`, tRaw('sim.saved')); }
        catch { save.disabled = false; notify(tRaw('err.generic')); }
      };
    },
  };
}

// v126 : « Sua regra hoje » en tête de l'espace Comissão (règles enregistrées + horaires turbo à venir).
export function currentRulesHtml(space, c) {
  const p = space.partner;
  const st = { model: p.commissionModel, rate: p.commissionRate, pp: p.perPersonCents, exLabel: p.excludedLabel, min: p.minCents, cap: p.capCents,
    tierClients: p.tierClients, tierRate: p.tierRate, tierPp: p.tierPpCents, boost: { on: false } };
  const today = new Date(Date.now() - 3 * 36e5).toISOString().slice(0, 10);
  const bs = (space.boosts || []).filter((b) => !b.day || b.day >= today);
  return `<div class="card cm-now"><h2 style="margin:0 0 6px">${t('cm.now')}</h2><blockquote class="rw-sentence">${esc(rulesSentence(st, c))}</blockquote>
    ${bs.length ? `<div class="hint"><b>${t('bst.p.list')}</b> · ${bs.map((b) => `${esc(boostWhen(b))} (${esc(boostValue(b, c))})`).join(' · ')}</div>` : ''}</div>`;
}
