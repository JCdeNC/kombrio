// v139 (lot E des idées de l'audit) : « Quanto custa a sua planilha de comissões ? » — page ouverte sans compte (#/calculadora).
// Le gérant (ou un prospect) indique combien de guides et de vendas com guia il a par mois et le temps passé à chaque étape ;
// la page montre le temps et le coût de la gestion à la main (noter, conferir, fazer cada Pix, guardar comprovantes, fechar o mês)
// et les risques (erreurs, double paiement, oublis). Aucun prix Kombrio n'est calculé ici : seulement le coût de la gestion manuelle.
// Rien n'est enregistré. Compatible iOS 13.4 / Chrome 80.
import { t, getLang } from '../i18n.js';
import { esc, cents } from '../util.js';

const num = (v, d = 0) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : d; };
// Valeurs de départ (modifiables) : un commerce moyen qui reçoit des guides.
const DEF = { guides: 15, sales: 120, minSale: 3, minPix: 5, hoursClose: 3, hourCost: 35, errPct: 2, avgCom: 40 };
const FIELDS = [
  ['guides', 'calc.f.guides', 1], ['sales', 'calc.f.sales', 1], ['avgCom', 'calc.f.avgcom', 1],
  ['minSale', 'calc.f.minsale', 0.5], ['minPix', 'calc.f.minpix', 0.5], ['hoursClose', 'calc.f.hoursclose', 0.5],
  ['hourCost', 'calc.f.hourcost', 1], ['errPct', 'calc.f.errpct', 0.5],
];

export function compute(x) {
  const mins = x.sales * x.minSale + x.guides * x.minPix + x.hoursClose * 60;
  const hours = mins / 60;
  const labour = Math.round(hours * x.hourCost * 100);
  const commissions = Math.round(x.sales * x.avgCom * 100);
  const errors = Math.round(commissions * (x.errPct / 100));
  return { hours, labour, commissions, errors, pix: Math.round(x.guides), total: labour + errors, year: (labour + errors) * 12 };
}

export const calculatorRoute = () => calculatorView();

export function calculatorView() {
  const lang = getLang();
  const c = (n) => cents(n, 'BRL', lang);
  const h1 = (h) => (Math.round(h * 10) / 10).toLocaleString(lang === 'fr' ? 'fr-FR' : 'pt-BR');
  const field = ([k, label, step]) => `<label for="calc-${k}">${t(label)}</label><input id="calc-${k}" data-k="${k}" type="number" inputmode="decimal" min="0" step="${step}" value="${DEF[k]}">`;
  const result = (x) => {
    const r = compute(x);
    return `<div class="pd-kpis ios-kpis">
        <div class="pd-kpi"><span>${t('calc.r.hours')}</span><b>${esc(h1(r.hours))} h</b><em>${t('calc.r.hours.em')}</em></div>
        <div class="pd-kpi"><span>${t('calc.r.cost')}</span><b>${c(r.total)}</b><em>${t('calc.r.cost.em', { year: c(r.year) })}</em></div>
        <div class="pd-kpi"><span>${t('calc.r.pix')}</span><b>${r.pix}</b><em>${t('calc.r.pix.em')}</em></div></div>
      <ul class="list">
        <li class="spread"><span>${t('calc.l.labour')}</span><b>${c(r.labour)}</b></li>
        <li class="spread"><span>${t('calc.l.errors', { pct: String(x.errPct).replace('.', ',') })}</span><b>${c(r.errors)}</b></li>
        <li class="spread"><span>${t('calc.l.commissions')}</span><b>${c(r.commissions)}</b></li></ul>
      <p class="hint">${t('calc.risks')}</p>`;
  };
  const html = `<div class="dash-wide sim">
      <h1>${t('calc.title')}</h1><p class="hint">${t('calc.intro')}</p>
      <div class="card" id="calc-out">${result(DEF)}</div>
      <div class="pd-cols">
        <div class="card"><h2>${t('calc.yours')}</h2>${FIELDS.map(field).join('')}<p class="hint">${t('calc.defaults')}</p></div>
        <div><div class="card"><h2>${t('calc.k.title')}</h2><ul class="list">${['calc.k.1', 'calc.k.2', 'calc.k.3', 'calc.k.4', 'calc.k.5'].map((k) => `<li>✓ ${t(k)}</li>`).join('')}</ul>
            <a class="btn block" href="#/parceria" style="margin-top:12px">${t('sim.public.cta')}</a>
            <a class="btn ghost block" href="#/simulador" style="margin-top:8px">${t('calc.to.sim')}</a></div></div>
      </div></div>`;
  return {
    html,
    mount(root) {
      const read = () => { const x = {}; Object.keys(DEF).forEach((k) => { const el = root.querySelector(`#calc-${k}`); x[k] = num(el && el.value, 0); }); return x; };
      const upd = () => { root.querySelector('#calc-out').innerHTML = result(read()); };
      root.querySelectorAll('[data-k]').forEach((el) => { el.addEventListener('input', upd); });
    },
  };
}
