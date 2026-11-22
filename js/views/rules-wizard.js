// v124 : « Assistente da comissão » du gérant (#/p/<clé>/regras). Une question par écran, avec exemple et « Pular » :
//   1. % de l'addition OU montant par client (seul choix obligatoire) · 2. ce qui n'est pas commissionné (si %) ·
//   3. minimum / maximum · 4. palier du mois · 5. horaire turbo · puis « Sua regra em uma frase », simulateur,
//   tableau « o que dá para combinar » et un seul bouton Enregistrer (règles du script 074, rien de nouveau en base).
import { t, tRaw, getLang } from '../i18n.js';
import { esc, cents, notify, parseCents, weekdayShort, weekdayList } from '../util.js';
import * as store from '../store.js';

const RATES = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20];
const money = (x) => (x ? (x / 100).toFixed(2).replace('.', ',') : '');
const pctTxt = (r) => `${String(Math.round(r * 10000) / 100).replace('.', ',')} %`;
const parsePct = (v) => { const x = String(v || '').trim().replace(',', '.'); return x === '' ? null : Number(x); };
const parseMoney = (v) => (String(v || '').trim() === '' ? null : (parseCents(String(v).replace(/R\$/g, '')) ?? NaN));

// La règle en une phrase (récapitulatif de l'assistant).
export function rulesSentence(s, c, lang = getLang()) {
  const pp = s.model === 'per_person';
  const val = (r, p) => (pp ? tRaw('rate.per_person', { amount: c(p) }) : pctTxt(r));
  const parts = [pp ? tRaw('rw.s.pp', { amount: c(s.pp) }) : tRaw('rw.s.pct', { rate: pctTxt(s.rate) })];
  if (!pp && s.exLabel) parts[0] += tRaw('rw.s.ex', { label: s.exLabel });
  if (s.min && s.cap) parts.push(tRaw('rw.s.minmax', { min: c(s.min), max: c(s.cap) }));
  else if (s.min) parts.push(tRaw('rw.s.min', { min: c(s.min) }));
  else if (s.cap) parts.push(tRaw('rw.s.max', { max: c(s.cap) }));
  if (s.tierClients) parts.push(tRaw('rw.s.tier', { value: val(s.tierRate, s.tierPp), n: s.tierClients }));
  if (s.boost.on) {
    const h = s.boost.from && s.boost.to ? tRaw('bo.range', { a: s.boost.from, b: s.boost.to }) : s.boost.from ? tRaw('bo.from', { t: s.boost.from }) : s.boost.to ? tRaw('bo.until', { t: s.boost.to }) : tRaw('bst.allday');
    parts.push(tRaw('rw.s.boost', { value: val(s.boost.rate, s.boost.pp), days: weekdayList(s.boost.weekdays, lang), hours: h }));
  }
  return `${parts.join(' ; ')}.`;
}

// Commission simulée : le plus avantageux de normal / palier / turbo, puis part exclue, minimum, maximum.
export function simulate(s, partner, { bill, people, ex, wd, hm, tierOn }) {
  const pp = s.model === 'per_person';
  const cands = [{ k: 'normal', r: s.rate, p: s.pp }];
  if (s.tierClients && tierOn) cands.push({ k: 'tier', r: s.tierRate, p: s.tierPp });
  const inTime = (b) => (!b.from || hm >= b.from) && (!b.to || hm < b.to);
  if (s.boost.on && s.boost.weekdays.includes(wd) && inTime(s.boost)) cands.push({ k: 'boost', r: s.boost.rate, p: s.boost.pp });
  (s.existing || []).filter((b) => !b.day && b.weekdays.includes(wd) && inTime(b)).forEach((b) => cands.push({ k: 'boost', r: b.rate, p: b.ppCents }));
  const best = cands.reduce((a, b) => ((pp ? (b.p || 0) > (a.p || 0) : (b.r || 0) > (a.r || 0)) ? b : a));
  const fakeP = { excludedLabel: pp ? '' : s.exLabel, commissionRate: s.rate, commissionModel: s.model, perPersonCents: s.pp };
  const visit = { perPersonCents: pp ? best.p : null, rate: pp ? null : best.r, capCents: s.cap, minCents: s.min, childCents: null,
    bonusEvery: partner.bonusEvery, bonusCents: partner.bonusCents, excludedCents: pp || !s.exLabel ? 0 : Math.min(ex || 0, bill) };
  const res = store.commissionFor(fakeP, visit, bill, people, 0, visit.excludedCents);
  const raw = store.commissionFor(fakeP, { ...visit, capCents: null, minCents: null }, bill, people, 0, visit.excludedCents);
  const why = res !== raw ? (res > raw ? 'min' : 'max') : best.k;
  return { cents: res, why };
}

export function rulesWizardView(space, ctx) {
  const { partner, city, key } = space;
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const back = `#/p/${encodeURIComponent(key)}/config`;
  const pp0 = partner.commissionModel === 'per_person';
  const rate0 = RATES.includes(Math.round(partner.commissionRate * 100)) ? partner.commissionRate : 0.1;
  const s = {
    model: partner.commissionModel, rate: rate0, pp: partner.perPersonCents || 1000,
    exLabel: partner.excludedLabel, min: partner.minCents, cap: partner.capCents,
    tierClients: partner.tierClients, tierRate: partner.tierRate, tierPp: partner.tierPpCents,
    boost: { on: false, weekdays: [], from: '', to: '', rate: null, pp: null, note: '' },
    existing: space.boosts || [],
  };
  const N = 6;
  const wdBoxes = (name, on) => [1, 2, 3, 4, 5, 6, 7].map((d) => `<label class="wday"><input type="checkbox" name="${name}" value="${d}"${on.includes(d) ? ' checked' : ''}><span>${esc(weekdayShort(d, lang))}</span></label>`).join('');
  const step = (i, title, ex, body, skip = true) => `<section class="rw-step" data-step="${i}"${i ? ' hidden' : ''}>
      <p class="hint rw-count">${t('rw.count', { n: i + 1, total: N })}</p>
      <h2>${title}</h2>${ex ? `<p class="rw-ex">${ex}</p>` : ''}${body}
      <div class="row rw-nav">${i ? `<button type="button" class="btn ghost" data-rw-back>${t('rw.back')}</button>` : ''}
        ${skip ? `<button type="button" class="btn ghost" data-rw-skip>${t('rw.skip')}</button>` : ''}
        <button type="button" class="btn" data-rw-next>${t('rw.next')}</button></div></section>`;
  const yes = (k) => `<span class="rw-yes">✓</span>`;
  const mix = `<details class="rw-mix"><summary>${t('rw.mix')}</summary>
      <div class="table-wrap"><table><tr><th></th><th>${t('rw.mix.pct')}</th><th>${t('rw.mix.pp')}</th></tr>
        ${[['rw.mix.ex', yes(), `<span class="hint">${t('rw.mix.ex.pp')}</span>`], ['rw.mix.minmax', yes(), yes()], ['rw.mix.bonus', yes(), yes()],
          ['rw.mix.tier', `${yes()} %`, `${yes()} R$`], ['rw.mix.boost', `${yes()} %`, `${yes()} R$`], ['rw.mix.offer', yes(), yes()]]
          .map(([k, a, b]) => `<tr><td>${t(k)}</td><td>${a}</td><td>${b}</td></tr>`).join('')}</table></div>
      <ul class="rw-rules"><li>${t('rw.mix.r1')}</li><li>${t('rw.mix.r2')}</li><li>${t('rw.mix.r3')}</li><li class="hint">${t('rw.mix.r4')}</li></ul></details>`;

  const html = `<div class="rw">
    <p class="no-print"><a href="${back}">← ${t('pd.tab.config')}</a></p>
    <h1>${t('rw.title')}</h1><p class="hint">${t('rw.intro')} <a href="#/tuto/rules">${t('rw.tuto')}</a> · <a href="#/p/${encodeURIComponent(key)}/simulador">${t('sim.open')}</a></p>
    <div class="st-bar rw-bar"><i id="rw-bar" style="width:${Math.round(100 / N)}%"></i></div>
    <form class="card rw-card" id="rw" novalidate>
    ${step(0, t('rw.q1'), t('rw.q1.ex'), `<div class="rw-choices">
        <label class="rw-choice"><input type="radio" name="model" value="percent"${pp0 ? '' : ' checked'}><span><b>${t('partner.model.percent')}</b><small>${t('rw.q1.pct')}</small></span></label>
        <label class="rw-choice"><input type="radio" name="model" value="per_person"${pp0 ? ' checked' : ''}><span><b>${t('partner.model.per_person')}</b><small>${t('rw.q1.pp')}</small></span></label></div>
      <div class="field" id="rw-rate"${pp0 ? ' hidden' : ''}><label for="rw-r">${t('rw.q1.rate')}</label><select id="rw-r" name="rate">${RATES.map((n) => `<option value="${n / 100}"${Math.round(rate0 * 100) === n ? ' selected' : ''}>${n} %${n === 10 ? ` (${t('partner.rate.suggested')})` : ''}</option>`).join('')}</select></div>
      <div class="field" id="rw-pp"${pp0 ? '' : ' hidden'}><label for="rw-p">${t('partner.model.amount')}</label><input id="rw-p" name="pp" inputmode="decimal" placeholder="10,00" value="${money(s.pp)}"></div>`, false)}
    ${step(1, t('rw.q2'), t('rw.q2.ex'), `<div class="field"><label for="rw-ex">${t('rules.excluded')}</label><input id="rw-ex" name="ex" maxlength="40" value="${esc(s.exLabel)}" placeholder="${esc(tRaw('rules.excluded.ph'))}">
      <p class="hint" style="margin:4px 0 0">${t('rw.q2.hint')}</p></div>`)}
    ${step(2, t('rw.q3'), t('rw.q3.ex'), `<div class="grid2 rs-keep2">
        <div class="field"><label for="rw-min">${t('rules.min')}</label><input id="rw-min" name="min" inputmode="decimal" placeholder="—" value="${money(s.min)}"></div>
        <div class="field"><label for="rw-cap">${t('rules.cap')}</label><input id="rw-cap" name="cap" inputmode="decimal" placeholder="—" value="${money(s.cap)}"></div></div>
      <p class="hint">${t('rules.capmin.hint')}</p>`)}
    ${step(3, t('rw.q4'), t('rw.q4.ex'), `<div class="grid2 rs-keep2">
        <div class="field"><label for="rw-tc">${t('rules.tier.clients')}</label><input id="rw-tc" name="tc" type="number" min="2" max="1000" inputmode="numeric" placeholder="20" value="${s.tierClients || ''}"></div>
        <div class="field"><label for="rw-tv" id="rw-tv-l">${t('rules.tier.rate')}</label><input id="rw-tv" name="tv" inputmode="decimal" placeholder="12"></div></div>
      <p class="hint">${t('rules.tier.hint')}</p>`)}
    ${step(4, t('rw.q5'), t('rw.q5.ex'), `${s.existing.length ? `<p class="notice">${t('rw.q5.have', { n: s.existing.length })}</p>` : ''}
      <fieldset class="wdays"><legend>${t('bst.p.wdays')}</legend>${wdBoxes('bw', [])}</fieldset>
      <div class="row bo-hours"><div class="field"><label for="rw-bf">${t('bo.p.from')}</label><input id="rw-bf" name="bf" type="time" step="900"></div>
        <div class="field"><label for="rw-bt">${t('bo.p.to')}</label><input id="rw-bt" name="bt" type="time" step="900"></div></div>
      <div class="grid2 rs-keep2"><div class="field"><label for="rw-bv" id="rw-bv-l">${t('bst.p.rate')}</label><input id="rw-bv" name="bv" inputmode="decimal" placeholder="15"></div>
        <div class="field"><label for="rw-bn">${t('bst.p.note')}</label><input id="rw-bn" name="bn" maxlength="120" placeholder="${esc(tRaw('bst.p.note.ph'))}"></div></div>
      <p class="hint">${t('rw.q5.hint')}</p>`)}
    <section class="rw-step" data-step="5" hidden>
      <p class="hint rw-count">${t('rw.count', { n: N, total: N })}</p>
      <h2>${t('rw.sum')}</h2>
      <blockquote class="rw-sentence" id="rw-sentence"></blockquote>
      <div class="rw-sim"><h3 style="margin:0 0 6px">${t('rw.sim')}</h3>
        <div class="grid2 rs-keep2">
          <div class="field"><label for="sm-b">${t('rs.bill')}</label><input id="sm-b" inputmode="decimal" value="300,00"></div>
          <div class="field"><label for="sm-n">${t('rs.people')}</label><input id="sm-n" type="number" min="1" max="99" value="4"></div>
          <div class="field" id="sm-exf"><label for="sm-x" id="sm-x-l"></label><input id="sm-x" inputmode="decimal" value="60,00"></div>
          <div class="field"><label for="sm-d">${t('rw.sim.when')}</label><div class="row" style="gap:6px;flex-wrap:nowrap"><select id="sm-d">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}"${d === 2 ? ' selected' : ''}>${esc(weekdayShort(d, lang))}</option>`).join('')}</select><input id="sm-h" type="time" value="13:00"></div></div>
        </div>
        <label class="bo-all" id="sm-tierf"><input type="checkbox" id="sm-t"><span id="sm-t-l"></span></label>
        <p class="rw-res" id="sm-res"></p></div>
      ${mix}
      <div class="row rw-nav"><button type="button" class="btn ghost" data-rw-back>${t('rw.back')}</button>
        <button type="submit" class="btn" id="rw-save">${t('rw.save')}</button></div>
    </section>
    </form></div>`;

  return {
    html,
    mount(root) {
      const f = root.querySelector('#rw');
      let cur = 0;
      const isPp = () => f.model.value === 'per_person';
      const show = (i) => {
        cur = i;
        f.querySelectorAll('.rw-step').forEach((x) => { x.hidden = Number(x.dataset.step) !== i; });
        root.querySelector('#rw-bar').style.width = `${Math.round(((i + 1) / N) * 100)}%`;
        if (i === 5) recap();
        const first = f.querySelector(`.rw-step[data-step="${i}"] input:not([type=radio]):not([type=checkbox]), .rw-step[data-step="${i}"] select`);
        root.querySelector('.rw').scrollIntoView({ block: 'start' });
        if (first && i) first.focus({ preventScroll: true });
      };
      const syncModel = () => {
        const pp = isPp();
        f.querySelector('#rw-rate').hidden = pp; f.querySelector('#rw-pp').hidden = !pp;
        f.querySelector('#rw-tv-l').textContent = tRaw(pp ? 'rules.tier.pp' : 'rules.tier.rate');
        f.querySelector('#rw-bv-l').textContent = tRaw(pp ? 'bst.p.pp' : 'bst.p.rate');
        f.tv.placeholder = pp ? '15,00' : '12'; f.bv.placeholder = pp ? '15,00' : '15';
        if (s.tierClients && !f.tv.value) f.tv.value = pp ? money(s.tierPp) : (s.tierRate ? String(Math.round(s.tierRate * 10000) / 100).replace('.', ',') : '');
      };
      f.querySelectorAll('[name=model]').forEach((r) => { r.onchange = syncModel; });
      syncModel();
      // Lecture + contrôle de l'étape i ; renvoie un message d'erreur ou ''.
      const read = (i) => {
        const pp = isPp();
        if (i === 0) {
          s.model = pp ? 'per_person' : 'percent'; s.rate = Number(f.rate.value);
          if (pp) { const v = parseMoney(f.pp.value); if (v == null || Number.isNaN(v) || v < 100 || v > 50000) return 'partner.model.err'; s.pp = v; }
        }
        if (i === 1) s.exLabel = f.ex.value.trim();
        if (i === 2) {
          const mn = parseMoney(f.min.value); const cp = parseMoney(f.cap.value);
          if (Number.isNaN(mn) || Number.isNaN(cp) || (mn != null && mn < 100) || (cp != null && cp < 100)) return 'rules.err.money';
          if (mn != null && cp != null && mn > cp) return 'rules.err.minmax';
          s.min = mn; s.cap = cp;
        }
        if (i === 3) {
          const tc = Number(f.tc.value) || 0;
          if (!tc) { s.tierClients = 0; s.tierRate = null; s.tierPp = null; return ''; }
          const tv = pp ? parseMoney(f.tv.value) : parsePct(f.tv.value);
          if (!Number.isInteger(tc) || tc < 2 || tc > 1000 || tv == null || Number.isNaN(tv) || (pp ? tv < 100 || tv > 50000 : tv <= 0 || tv > 50)) return 'rules.err.tier';
          if (pp ? tv <= s.pp : tv <= s.rate * 100) return 'rules.err.tier.low';
          s.tierClients = tc; s.tierRate = pp ? null : Math.round(tv * 100) / 10000; s.tierPp = pp ? tv : null;
        }
        if (i === 4) {
          const wd = [...f.querySelectorAll('[name=bw]:checked')].map((x) => Number(x.value));
          const raw = f.bv.value.trim();
          if (!wd.length && !raw) { s.boost.on = false; return ''; }
          if (!wd.length) return 'bst.err.when';
          if (f.bf.value && f.bt.value && f.bt.value <= f.bf.value) return 'bo.p.time.err';
          const v = pp ? parseMoney(raw) : parsePct(raw);
          if (v == null || Number.isNaN(v) || (pp ? v < 100 || v > 50000 : v <= 0 || v > 50)) return 'bst.err.value';
          if (pp ? v <= s.pp : v <= s.rate * 100) return 'bst.err.low';
          s.boost = { on: true, weekdays: wd, from: f.bf.value, to: f.bt.value, rate: pp ? null : Math.round(v * 100) / 10000, pp: pp ? v : null, note: f.bn.value.trim() };
        }
        return '';
      };
      const clear = (i) => {
        if (i === 1) f.ex.value = '';
        if (i === 2) { f.min.value = ''; f.cap.value = ''; }
        if (i === 3) { f.tc.value = ''; f.tv.value = ''; }
        if (i === 4) { f.querySelectorAll('[name=bw]').forEach((x) => { x.checked = false; }); f.bv.value = ''; f.bf.value = ''; f.bt.value = ''; }
      };
      const nextOf = (i) => (i === 0 && isPp() ? 2 : i + 1);   // forfait : la part non commissionnée ne sert à rien
      const prevOf = (i) => (i === 2 && isPp() ? 0 : i - 1);
      f.querySelectorAll('[data-rw-next]').forEach((b) => { b.onclick = () => { const e = read(cur); if (e) { notify(tRaw(e)); return; } show(nextOf(cur)); }; });
      f.querySelectorAll('[data-rw-skip]').forEach((b) => { b.onclick = () => { clear(cur); read(cur); show(nextOf(cur)); }; });
      f.querySelectorAll('[data-rw-back]').forEach((b) => { b.onclick = () => show(prevOf(cur)); });
      const sim = () => {
        const bill = parseCents(root.querySelector('#sm-b').value) || 0;
        const r = simulate(s, partner, { bill, people: Number(root.querySelector('#sm-n').value) || 1, ex: parseCents(root.querySelector('#sm-x').value) || 0,
          wd: Number(root.querySelector('#sm-d').value), hm: root.querySelector('#sm-h').value || '12:00', tierOn: root.querySelector('#sm-t').checked });
        root.querySelector('#sm-res').innerHTML = t('rw.sim.res', { com: c(r.cents), why: tRaw(`rw.why.${r.why}`) });
      };
      const recap = () => {
        root.querySelector('#rw-sentence').textContent = rulesSentence(s, c, lang);
        const pp = s.model === 'per_person';
        root.querySelector('#sm-exf').hidden = pp || !s.exLabel;
        root.querySelector('#sm-x-l').textContent = tRaw('rs.excluded', { label: s.exLabel || '' });
        root.querySelector('#sm-tierf').hidden = !s.tierClients;
        root.querySelector('#sm-t-l').textContent = tRaw('rw.sim.tier', { n: s.tierClients || 0 });
        sim();
      };
      root.querySelectorAll('.rw-sim input, .rw-sim select').forEach((x) => { x.oninput = sim; x.onchange = sim; });
      f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = root.querySelector('#rw-save'); btn.disabled = true;
        try {
          await saveRules(key, partner, s);
          ctx.go(`p/${key}/config`, tRaw('rw.saved'));
        } catch { btn.disabled = false; notify(tRaw('err.generic')); }
      };
    },
  };
}

// Enregistre une règle complète (assistant et simulateur) : modèle, règles, et le nouvel horaire turbo s'il y en a un.
export async function saveRules(key, partner, s) {
  if (s.model === 'per_person') { if (!(await store.setCommissionModel(key, 'per_person', s.pp))) throw new Error(); }
  else {
    if (!(await store.setCommissionRate(key, s.rate))) throw new Error();
    if (partner.commissionModel === 'per_person' && !(await store.setCommissionModel(key, 'percent'))) throw new Error();
  }
  const ok = await store.setCommissionRules(key, { excludedLabel: s.model === 'per_person' ? '' : s.exLabel, capCents: s.cap, minCents: s.min,
    tierClients: s.tierClients || null, tierRate: s.tierRate, tierPpCents: s.tierPp });
  if (!ok) throw new Error();
  if (s.boost.on) {
    const r = await store.addBoosts(key, { weekdays: s.boost.weekdays, from: s.boost.from, to: s.boost.to, rate: s.boost.rate, ppCents: s.boost.pp, note: s.boost.note });
    if (!r || !r.ok) throw new Error();
  }
}
