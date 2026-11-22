// v114 : mini-tutoriels animés (#/tuto, #/tuto/<id>). Un petit téléphone joue les étapes tout seul, comme un dessin animé :
// le point qui pulse montre où toucher. Pause, retour, étape suivante ; le texte de chaque étape reste lisible dessous.
// Pas de vidéo : du HTML/CSS léger, traduit, qui suit l'app. Guide : 5 langues ; partenaire : pt + fr.
import { t, tRaw } from '../i18n.js';
import { esc } from '../util.js';

const hl = (inner, cls = '') => `<span class="ia-hl ${cls}">${inner}</span>`;
const ICO = {
  home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>', users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.7-3.4 3-5.2 6-5.2s5.3 1.8 6 5.2M16 5.5a3 3 0 0 1 0 5.6M18 14.6c1.6.7 2.6 2.4 3 4.4"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12.5h2"/>', user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', card: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18"/>',
  team: '<circle cx="8" cy="9" r="3"/><circle cx="16.5" cy="9" r="2.5"/><path d="M2.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M14 15.2c2.6-.5 5 1 5.6 4.8"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 12h16"/>',
  photo: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><circle cx="12" cy="13" r="3.5"/><path d="M8.5 6 10 3.5h4L15.5 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  wa: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7z"/><path d="M9 9.5c.3 2.2 2.3 4.2 4.5 4.6l1.2-1.2 1.8.9"/>',
};
const ico = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICO[k]}</svg>`;
// Barre du bas de l'app : 5 places, bouton central rond. `on` = place mise en avant (pulsation).
const tabbar = (kind, on) => {
  // v127 : partenaire = Hoje · Visitas · [Escanear] · Pagar · Ajustes.
  const items = kind === 'guide' ? ['home', 'users', 'qr', 'wallet', 'user'] : ['home', 'list', 'scan', 'card', 'gear'];
  return `<div class="tu-tabs">${items.map((k, i) => { const c = i === 2 ? `<span class="tu-center">${ico(k)}</span>` : ico(k);
    return `<span class="tu-tab${i === 0 ? ' cur' : ''}">${on === i ? hl(c) : c}</span>`; }).join('')}</div>`;
};
const head = (title) => `<div class="tu-head"><img src="../icon.svg" alt=""><b>${esc(title)}</b></div>`;
const lines = (n = 3) => `<div class="tu-lines">${'<i></i>'.repeat(n)}</div>`;
const qrBox = (cls = '') => `<div class="tu-qr ${cls}">${'<i></i>'.repeat(9)}</div>`;
const btn = (label, cls = '') => `<span class="tu-btn ${cls}">${esc(label)}</span>`;
const okMark = (label) => `<div class="tu-ok"><span class="tu-check"></span><b>${esc(label)}</b></div>`;
const field = (label, value, typing) => `<div class="tu-field"><small>${esc(label)}</small><span class="${typing ? 'tu-type' : ''}">${esc(value)}</span></div>`;

const SCENES = {
  // ---- guide ----
  'g-home': () => `${head('Kombrio')}<div class="tu-body"><div class="tu-kpi"><small>${esc(tRaw('g.next.title'))}</small><b>R$ 186,40</b></div>${lines(4)}</div>${tabbar('guide', 2)}`,
  'g-qrmenu': () => `${head('Kombrio')}<div class="tu-body">${lines(3)}</div><div class="tu-sheet tu-up">
      ${hl(`<div class="tu-li strong">＋ ${esc(tRaw('g.qr.new'))}</div>`, 'row')}<div class="tu-li">${esc(tRaw('tu.s.instay'))}</div><div class="tu-li">${esc(tRaw('bdg.card.title'))}</div></div>`,
  'g-form': () => `${head(tRaw('guide.stay.new'))}<div class="tu-body">${field(tRaw('guide.stay.client'), 'Família Martin', true)}
      <div class="tu-row2">${field(tRaw('guide.stay.people'), '4')}${field(tRaw('guide.stay.start'), '21/11')}</div>${hl(btn(tRaw('guide.stay.create')), 'row')}</div>`,
  'g-share': () => `${head('Família Martin')}<div class="tu-body tu-center-col">${qrBox('tu-pop')}${hl(btn(tRaw('gh.send')), 'row')}</div>`,
  'g-show': () => `<div class="tu-body tu-center-col tu-dark"><small class="tu-cap">${esc(tRaw('tu.s.partner'))}</small>${qrBox('tu-scanned')}<span class="tu-beam"></span></div>${okMark(tRaw('tu.s.visit.ok'))}`,
  'pix-bank': () => `<div class="tu-lock"><b class="tu-time">10:42</b><div class="tu-notif tu-drop"><span class="tu-bank"></span><div><b>Pix ${esc(tRaw('tu.s.received'))}</b><small>R$ 1,00 · Kombrio</small></div></div></div>`,
  'pix-confirm': () => `${head('Kombrio')}<div class="tu-body"><div class="tu-notice">${esc(tRaw('tu.s.pix.sent'))}${hl(btn(tRaw('pix.confirm')), 'row')}<span class="tu-link">${esc(tRaw('pix.notreceived'))}</span></div>${lines(2)}</div>${tabbar('guide')}`,
  'pix-ok': () => `${head('Kombrio')}<div class="tu-body">${lines(3)}</div>${okMark(tRaw('tu.s.pix.ok'))}`,
  ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`trk-${n}`, () => `${head(tRaw('g.tab.ganhos'))}<div class="tu-body"><div class="tu-tx"><b>Família Martin</b><small>R$ 24,00</small></div>
      <div class="tu-trk">${['visit', 'declared', 'paid', 'cashed', 'repaid'].map((k, i) => `<span class="${i < n ? 'on' : ''}${i === n - 1 ? ' now' : ''}"><i></i><small>${esc(tRaw(`g.trk.${k}`))}</small></span>`).join('')}</div>${lines(2)}</div>${tabbar('guide')}`])),
  // ---- partenaire ----
  'p-home': () => `${head('Restaurante')}<div class="tu-body"><div class="tu-kpi"><small>${esc(tRaw('pd.k.visits'))}</small><b>12</b></div>${lines(4)}</div>${tabbar('partner', 2)}`,
  'p-cam': () => `<div class="tu-body tu-center-col tu-dark"><div class="tu-frame">${qrBox()}<span class="tu-beam"></span></div><small class="tu-cap">${esc(tRaw('tu.s.aim'))}</small></div>`,
  'p-bill': () => `${head('Família Martin · 4')}<div class="tu-body">${field(tRaw('rs.bill'), 'R$ 240,00', true)}<div class="tu-com tu-late">${esc(tRaw('tu.s.com'))} <b>R$ 24,00</b></div>${hl(btn(tRaw('rs.save')), 'row')}</div>`,
  'p-ok': () => `${head('Restaurante')}<div class="tu-body">${lines(3)}</div>${okMark(tRaw('tu.s.visit.ok'))}`,
  'p-paytab': () => `${head('Restaurante')}<div class="tu-body"><div class="tu-kpi warn"><small>${esc(tRaw('hero.topay'))}</small><b>R$ 310,00</b></div>${hl(btn(tRaw('hero.pay')), 'row')}${lines(2)}</div>${tabbar('partner')}`,
  'p-select': () => `${head(tRaw('pay.title', { amount: 'R$ 310,00' }))}<div class="tu-body">${['Família Martin · R$ 24,00', 'Grupo Silva · R$ 96,00', 'Mr. Brown · R$ 190,00'].map((x, i) => `<div class="tu-chk" style="animation-delay:${0.3 + i * 0.35}s"><i></i>${esc(x)}</div>`).join('')}
      <div class="tu-com">Total <b>R$ 310,00</b></div></div>`,
  'p-pix': () => `${head('Pix')}<div class="tu-body tu-center-col">${qrBox()}<span class="tu-code">00020126…6304</span>${hl(btn(tRaw('tu.s.copy')), 'row')}<small class="tu-cap">${esc(tRaw('tu.s.onepix'))}</small></div>`,
  'p-receipt': () => `${head('Pix')}<div class="tu-body">${hl(`<div class="tu-drop-zone">${ico('photo')}<small>${esc(tRaw('pay.receipt.btn'))}</small></div>`, 'row')}<div class="tu-thumb tu-late"></div></div>${'<div class="tu-ok tu-late2"><span class="tu-check"></span><b>' + esc(tRaw('tu.s.sent')) + '</b></div>'}`,
  'p-team': () => `${head(tRaw('pd.tab.config'))}<div class="tu-body"><div class="tu-li">${esc(tRaw('aj.comissao'))}</div>${hl(`<div class="tu-li strong">${esc(tRaw('aj.equipe'))} ›</div>`, 'row')}<div class="tu-li">${esc(tRaw('aj.empresa'))}</div></div>${tabbar('partner', 4)}`,
  'p-add': () => `${head(tRaw('pd.tab.equipe'))}<div class="tu-body"><small class="tu-cap dark">${esc(tRaw('team.add'))}</small>${field(tRaw('tu.s.name'), 'Lucas', true)}${hl(btn(tRaw('team.add.button')), 'row')}</div>`,
  'p-wa': () => `${head('Lucas')}<div class="tu-body tu-center-col">${qrBox('tu-pop')}<small class="tu-cap dark">24 h</small>${hl(btn(tRaw('team.invite.wa'), 'wa'), 'row')}</div>`,
  'p-staff': () => `${head('Lucas')}<div class="tu-body tu-center-col"><span class="tu-bigscan tu-pop">${ico('scan')}<b>${esc(tRaw('pd.tab.scan'))}</b></span>${lines(2)}</div>`,
  // ---- encaissement (v115) : « Nova conta », les deux cas, chegada / valor depois, contas, equipe ----
  'p-cam-g': () => `<div class="tu-body tu-center-col tu-dark"><div class="tu-frame"><div class="tu-badge"><span class="tu-av"></span><b>MARCOS</b><small>Guia · Cadastur</small>${'<i></i>'.repeat(1)}</div><span class="tu-beam"></span></div><small class="tu-cap">${esc(tRaw('bill.guide.code.ph'))}</small></div>`,
  'p-ask': () => `${head(tRaw('bill.title'))}<div class="tu-body"><div class="tu-ok-line">✓ Família Martin · 4</div><div class="tu-notice"><b>${esc(tRaw('bill.ask'))}</b>
      <div class="tu-row2">${btn(tRaw('bill.ask.yes'), 'sec')}${hl(btn(tRaw('bill.ask.no'), 'sec'), 'row')}</div></div></div>`,
  'p-amount': () => `${head(tRaw('bill.title'))}<div class="tu-body">${field(tRaw('bill.amount'), 'R$ 240,00', true)}<div class="tu-row2">${field(tRaw('rs.people'), '4')}${field(tRaw('rs.table'), '12')}</div>
      <div class="tu-com tu-late">${esc(tRaw('tu.s.com'))} <b>R$ 24,00</b></div>${hl(btn(tRaw('bill.save')), 'row')}</div>`,
  'p-amount-g': () => `${head(tRaw('bill.title'))}<div class="tu-body"><div class="tu-ok-line">✓ MARCOS · ${esc(tRaw('rs.present'))}</div>${field(tRaw('bill.amount'), 'R$ 380,00', true)}
      ${hl(btn(tRaw('bill.save')), 'row')}</div>`,
  'p-ok-g': () => `${head('Restaurante')}<div class="tu-body">${lines(3)}</div>${okMark(tRaw('mode2.tag'))}`,
  'p-arrive': () => `${head(tRaw('bill.title'))}<div class="tu-body"><div class="tu-ok-line">✓ Família Martin · 4</div>${field(tRaw('rs.table'), '12', true)}
      ${btn(tRaw('bill.save'), 'sec')}${hl(btn(tRaw('bill.arrive')), 'row')}</div>`,
  'p-pending': () => `${head('Restaurante')}<div class="tu-body"><div class="tu-pend"><div class="tu-pend-h"><b>${esc(tRaw('rs.pending'))}</b><span>1</span></div>
      <div class="tu-pend-r"><div><b>${esc(tRaw('rs.table.short', { n: 12 }))} · Família Martin</b><small>4 · ${esc(tRaw('rs.arrived', { at: '19:40' }))}</small></div></div>
      <div class="tu-row2">${hl(btn(tRaw('rs.launch')), 'row')}${btn(tRaw('rs.zero'), 'sec')}</div></div>${lines(2)}</div>${tabbar('partner')}`,
  'p-launch': () => `${head(`${tRaw('rs.table.short', { n: 12 })} · Família Martin`)}<div class="tu-body">${field(tRaw('rs.bill'), 'R$ 312,50', true)}<div class="tu-com tu-late">${esc(tRaw('tu.s.com'))} <b>R$ 31,25</b></div>${hl(btn(tRaw('rs.save')), 'row')}</div>`,
  'p-zero': () => `${head('Restaurante')}<div class="tu-body"><div class="tu-pend"><div class="tu-pend-h"><b>${esc(tRaw('rs.pending'))}</b><span>1</span></div>
      <div class="tu-pend-r"><div><b>Grupo Silva</b><small>6 · ${esc(tRaw('rs.arrived', { at: '20:05' }))}</small></div></div>
      <div class="tu-row2">${btn(tRaw('rs.launch'), 'sec')}${hl(btn(tRaw('rs.zero'), 'sec'), 'row')}</div></div></div>${tabbar('partner')}`,
  'p-split1': () => `${head('Família Martin · 4')}<div class="tu-body"><div class="tu-field"><small>${esc(tRaw('rs.bill'))}</small><span>R$ 180,00</span></div>
      <div class="tu-field tu-late"><span class="tu-type">R$ 95,00</span></div>${hl(`<span class="tu-link strong">${esc(tRaw('rs.bill.add'))}</span>`, 'row')}<div class="tu-com tu-late2">Total <b>R$ 275,00</b></div></div>`,
  'p-split2': () => `${head('Família Martin · 4')}<div class="tu-body"><div class="tu-field"><small>${esc(tRaw('rs.bill'))}</small><span>R$ 420,00</span></div>
      <div class="tu-more"><b>${esc(tRaw('rs.split'))}</b>${hl('<div class="tu-chk"><i></i>Grupo Silva · 6</div>', 'row')}<small>${esc(tRaw('tu.s.split'))}</small></div>${btn(tRaw('rs.save'))}</div>`,
  'p-staff-bill': () => `${head('Lucas · ' + tRaw('staff.post.waiter'))}<div class="tu-body">${field(tRaw('bill.amount'), 'R$ 240,00', true)}${hl(`<div class="tu-drop-zone tu-small">${ico('photo')}<small>${esc(tRaw('bill.photo').replace(/^📷\s*/u, ''))}</small></div>`, 'row')}${btn(tRaw('bill.save'))}<small class="tu-cap dark">${esc(tRaw('tu.s.nocom'))}</small></div>`,
  'p-staff-fix': () => `${head('Lucas')}<div class="tu-body"><b>${esc(tRaw('staff.today'))}</b><div class="tu-pend-r"><div><b>Família Martin</b><small>${esc(tRaw('staff.bill.done', { bill: 'R$ 240,00' }))}</small></div>${hl(`<span class="tu-btn sec tu-xs">${esc(tRaw('staff.fix'))}</span>`)}</div>${lines(2)}</div>`,
  // ---- v124 : règles de commission (assistant) ----
  'p-rw1': () => `${head(tRaw('rw.title'))}<div class="tu-body"><small class="tu-cap dark">${esc(tRaw('rw.q1'))}</small>
      ${hl(`<div class="tu-case on"><b>${esc(tRaw('partner.model.percent'))}</b><small>10 %</small></div>`, 'row')}<div class="tu-case"><b>${esc(tRaw('partner.model.per_person'))}</b><small>R$ 10,00</small></div></div>`,
  'p-rw2': () => `${head(tRaw('rw.title'))}<div class="tu-body"><small class="tu-cap dark">${esc(tRaw('rw.q2'))}</small>${field(tRaw('rules.excluded'), 'Bebidas', true)}${hl(btn(tRaw('rw.next')), 'row')}</div>`,
  'p-rw3': () => `${head(tRaw('rw.title'))}<div class="tu-body"><small class="tu-cap dark">${esc(tRaw('rw.q5'))}</small>
      <div class="tu-row2">${field(tRaw('bst.p.wdays'), tRaw('tu.s.rw.days'))}${field(tRaw('bst.p.rate'), '15 %', true)}</div>${field(tRaw('tu.s.rw.hours'), '12:00 – 15:00')}${hl(btn(tRaw('rw.next')), 'row')}</div>`,
  'p-rw4': () => `${head(tRaw('rw.sum'))}<div class="tu-body"><div class="tu-notice"><small>${esc(tRaw('tu.s.rw.sentence'))}</small></div>
      <div class="tu-com tu-late">${esc(tRaw('tu.s.com'))} <b>R$ 36,00</b> · turbo</div>${hl(btn(tRaw('rw.save')), 'row')}</div>`,
  'p-rw5': () => `${head(`${tRaw('rs.table.short', { n: 12 })} · Família Martin`)}<div class="tu-body">${field(tRaw('rs.bill'), 'R$ 300,00')}${field(tRaw('rs.excluded', { label: 'Bebidas' }), 'R$ 60,00', true)}
      <div class="tu-com tu-late">${esc(tRaw('tu.s.com'))} <b>R$ 24,00</b></div>${hl(btn(tRaw('rs.save')), 'row')}</div>`,
  'p-mgr': () => `${head('Restaurante')}<div class="tu-body"><div class="tu-pend-r"><div><b>Família Martin</b><small>R$ 240,00 · ${esc(tRaw('staff.tag.bill', { name: 'Lucas' }))} 📷</small></div><b class="tu-green">R$ 24,00</b></div>${lines(3)}</div>${tabbar('partner', 1)}`,
};

// Les tutoriels de chaque app : [scène, texte]. Le texte d'étape peut reprendre une clé existante de l'app.
export const TUTOS = {
  guide: {
    client: { title: 'tu.g.client', steps: [['g-home', 'tu.g.client.1'], ['g-qrmenu', 'tu.g.client.2'], ['g-form', 'tu.g.client.3'], ['g-share', 'tu.g.client.4'], ['g-show', 'tu.g.client.5']] },
    pix: { title: 'tu.g.pix', steps: [['pix-bank', 'tu.g.pix.1'], ['pix-confirm', 'tu.g.pix.2'], ['pix-ok', 'tu.g.pix.3']] },
    track: { title: 'tu.g.track', steps: ['visit', 'declared', 'paid', 'cashed', 'repaid'].map((k, i) => [`trk-${i + 1}`, `g.trk.${k}.hint`]) },
  },
  partner: {
    present: { title: 'tu.p.present', steps: [['p-home', 'tu.p.c.1'], ['p-cam-g', 'tu.p.present.3'], ['p-amount-g', 'tu.p.present.4'], ['p-ok-g', 'tu.p.present.5']] },
    scan: { title: 'tu.p.scan', steps: [['p-home', 'tu.p.c.1'], ['p-cam', 'tu.p.scan.3'], ['p-ask', 'tu.p.scan.4'], ['p-amount', 'tu.p.scan.5'], ['p-ok', 'tu.p.scan.6']] },
    later: { title: 'tu.p.later', steps: [['p-cam', 'tu.p.later.1'], ['p-arrive', 'tu.p.later.2'], ['p-pending', 'tu.p.later.3'], ['p-launch', 'tu.p.later.4'], ['p-zero', 'tu.p.later.5']] },
    split: { title: 'tu.p.split', steps: [['p-split1', 'tu.p.split.1'], ['p-split2', 'tu.p.split.2']] },
    staff: { title: 'tu.p.staff', steps: [['p-staff', 'tu.p.staff.1'], ['p-staff-bill', 'tu.p.staff.2'], ['p-staff-fix', 'tu.p.staff.3'], ['p-mgr', 'tu.p.staff.4']] },
    pay: { title: 'tu.p.pay', steps: [['p-paytab', 'tu.p.pay.1'], ['p-select', 'tu.p.pay.2'], ['p-pix', 'tu.p.pay.3'], ['p-receipt', 'tu.p.pay.4']] },
    team: { title: 'tu.p.team', steps: [['p-team', 'tu.p.team.1'], ['p-add', 'tu.p.team.2'], ['p-wa', 'tu.p.team.3'], ['p-staff', 'tu.p.team.4']] },
    rules: { title: 'tu.p.rules', steps: [['p-rw1', 'tu.p.rules.1'], ['p-rw2', 'tu.p.rules.2'], ['p-rw3', 'tu.p.rules.3'], ['p-rw4', 'tu.p.rules.4'], ['p-rw5', 'tu.p.rules.5']] },
  },
};
const STEP_MS = 4200;

// Liens vers les tutoriels (aide, liste « Para começar »).
export function tutoLinks(kind) {
  return `<div class="tu-links">${Object.entries(TUTOS[kind] || {}).map(([id, x]) => `<a href="#/tuto/${id}" data-tuto><span class="tu-play" aria-hidden="true"></span>${t(x.title)}</a>`).join('')}</div>`;
}

// v115 : « Qual caso? » — le modèle d'encaissement du partenaire en un coup d'œil.
function whichCase() {
  return `<div class="card tu-which"><h2 style="margin:0 0 8px">${t('tu.which')}</h2><ul class="list">${[['present', 'tu.which.present'], ['scan', 'tu.which.scan'], ['later', 'tu.which.later'], ['split', 'tu.which.split'], ['staff', 'tu.which.staff']]
    .map(([id, k]) => `<li><a href="#/tuto/${id}"><span>${t(k)}</span><b>${t(TUTOS.partner[id].title)} ›</b></a></li>`).join('')}</ul>
    <p class="hint" style="margin:8px 0 0">${t('tu.which.rule')}</p></div>`;
}

export function tutoView(params, ctx, kind = window.KOMBRIO_APP || 'partner') {
  const all = TUTOS[kind] || {};
  const id = params[0] === 'tuto' ? params[1] : params[0];   // guide : #/tuto/<id> complet ; partenaire : route déjà retirée
  const tu = all[id];
  if (!tu) {
    return { html: `<div class="ia-wrap"><p class="no-print"><a href="#/">← ${t('ia.back')}</a></p>
      <h1>${t('tu.index')}</h1><p class="hint">${t('tu.index.hint')}</p>${kind === 'partner' ? whichCase() : ''}${tutoLinks(kind)}</div>` };
  }
  const others = Object.keys(all).filter((k) => k !== id);
  return {
    html: `<div class="ia-wrap tu-wrap"><p class="no-print"><a href="#/">← ${t('ia.back')}</a></p>
      <h1>${t(tu.title)}</h1>
      <div class="tu-player">
        <div class="ia-ph tu-ph" aria-hidden="true"><div class="ia-scr tu-scr" id="tu-scr"></div></div>
        <div class="tu-side">
          <div class="tu-dots" role="tablist">${tu.steps.map((_, i) => `<button type="button" data-i="${i}" aria-label="${i + 1}"><i></i></button>`).join('')}</div>
          <p class="tu-cap-big" id="tu-cap" aria-live="polite"></p>
          <div class="row tu-ctrl"><button type="button" class="btn ghost small" id="tu-prev" aria-label="${esc(tRaw('tu.prev'))}">‹</button>
            <button type="button" class="btn secondary small" id="tu-play"></button>
            <button type="button" class="btn ghost small" id="tu-next" aria-label="${esc(tRaw('tu.next'))}">›</button></div>
        </div>
      </div>
      <ol class="tu-steps">${tu.steps.map(([, k], i) => `<li data-li="${i}">${t(k)}</li>`).join('')}</ol>
      ${others.length ? `<h3 style="margin:22px 0 6px">${t('tu.more')}</h3><div class="tu-links">${others.map((k) => `<a href="#/tuto/${k}"><span class="tu-play" aria-hidden="true"></span>${t(all[k].title)}</a>`).join('')}</div>` : ''}</div>`,
    mount(root) {
      const scr = root.querySelector('#tu-scr'); const cap = root.querySelector('#tu-cap');
      const play = root.querySelector('#tu-play');
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const st = { i: 0, on: !reduce, timer: null, start: 0 };
      const show = (i) => {
        st.i = Math.max(0, Math.min(tu.steps.length - 1, i));
        const [scene, key] = tu.steps[st.i];
        scr.innerHTML = `<div class="tu-scene">${SCENES[scene]()}</div>`;
        cap.innerHTML = `<b>${st.i + 1}/${tu.steps.length}</b> ${t(key)}`;
        root.querySelectorAll('.tu-dots button').forEach((b, k) => { b.classList.toggle('on', k === st.i); b.classList.toggle('past', k < st.i); b.setAttribute('aria-selected', String(k === st.i)); });
        root.querySelectorAll('[data-li]').forEach((li, k) => li.classList.toggle('on', k === st.i));
        const bar = root.querySelector('.tu-dots button.on i');
        if (bar) { bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = st.on ? `tu-fill ${STEP_MS}ms linear forwards` : ''; }
        schedule();
      };
      const last = () => st.i >= tu.steps.length - 1;
      const label = () => { play.textContent = st.on ? tRaw('tu.pause') : last() ? tRaw('tu.replay') : tRaw('tu.play'); };
      const schedule = () => {
        clearTimeout(st.timer);
        if (!st.on) { label(); return; }
        st.timer = setTimeout(() => {
          if (!document.body.contains(scr)) return;
          if (last()) { st.on = false; label(); return; }
          show(st.i + 1);
        }, STEP_MS);
        label();
      };
      play.onclick = () => { if (!st.on && last()) { st.on = true; show(0); return; } st.on = !st.on; show(st.i); };
      root.querySelector('#tu-prev').onclick = () => { show(st.i - 1); };
      root.querySelector('#tu-next').onclick = () => { show(st.i + 1); };
      root.querySelectorAll('.tu-dots button').forEach((b) => { b.onclick = () => show(+b.dataset.i); });
      show(0);
    },
  };
}
