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
  wa: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7z"/><path d="M9 9.5c.3 2.2 2.3 4.2 4.5 4.6l1.2-1.2 1.8.9"/>',
};
const ico = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICO[k]}</svg>`;
// Barre du bas de l'app : 5 places, bouton central rond. `on` = place mise en avant (pulsation).
const tabbar = (kind, on) => {
  const items = kind === 'guide' ? ['home', 'users', 'qr', 'wallet', 'user'] : ['grid', 'list', 'scan', 'card', 'team'];
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
  'g-home': () => `${head('Kombrio')}<div class="tu-body"><div class="tu-kpi"><small>${tRaw('tu.s.available')}</small><b>R$ 186,40</b></div>${lines(4)}</div>${tabbar('guide', 2)}`,
  'g-qrmenu': () => `${head('Kombrio')}<div class="tu-body">${lines(3)}</div><div class="tu-sheet tu-up">
      ${hl(`<div class="tu-li strong">＋ ${esc(tRaw('g.qr.new'))}</div>`, 'row')}<div class="tu-li">${esc(tRaw('tu.s.instay'))}</div><div class="tu-li">${esc(tRaw('bdg.card.title'))}</div></div>`,
  'g-form': () => `${head(tRaw('guide.stay.new'))}<div class="tu-body">${field(tRaw('guide.stay.client'), 'Família Martin', true)}
      <div class="tu-row2">${field(tRaw('guide.stay.people'), '4')}${field(tRaw('guide.stay.start'), '21/11')}</div>${hl(btn(tRaw('guide.stay.create')), 'row')}</div>`,
  'g-share': () => `${head('Família Martin')}<div class="tu-body tu-center-col">${qrBox('tu-pop')}${hl(btn(tRaw('guide.stay.whatsapp'), 'wa'), 'row')}</div>`,
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
  'p-paytab': () => `${head('Restaurante')}<div class="tu-body"><div class="tu-kpi warn"><small>${esc(tRaw('pd.k.topay'))}</small><b>R$ 310,00</b></div>${lines(3)}</div>${tabbar('partner', 3)}`,
  'p-select': () => `${head(tRaw('pd.tab.pagamentos'))}<div class="tu-body">${['Família Martin · R$ 24,00', 'Grupo Silva · R$ 96,00', 'Mr. Brown · R$ 190,00'].map((x, i) => `<div class="tu-chk" style="animation-delay:${0.3 + i * 0.35}s"><i></i>${esc(x)}</div>`).join('')}
      <div class="tu-com">Total <b>R$ 310,00</b></div>${hl(btn(tRaw('pd.pay')), 'row')}</div>`,
  'p-pix': () => `${head('Pix')}<div class="tu-body tu-center-col">${qrBox()}<span class="tu-code">00020126…6304</span>${btn(tRaw('tu.s.copy'), 'sec')}<small class="tu-cap">${esc(tRaw('tu.s.onepix'))}</small></div>`,
  'p-receipt': () => `${head('Pix')}<div class="tu-body">${hl(`<div class="tu-drop-zone">${ico('photo')}<small>${esc(tRaw('partner.declare.receipt'))}</small></div>`, 'row')}<div class="tu-thumb tu-late"></div></div>${'<div class="tu-ok tu-late2"><span class="tu-check"></span><b>' + esc(tRaw('tu.s.sent')) + '</b></div>'}`,
  'p-team': () => `${head('Restaurante')}<div class="tu-body">${lines(4)}</div>${tabbar('partner', 4)}`,
  'p-add': () => `${head(tRaw('pd.tab.equipe'))}<div class="tu-body"><small class="tu-cap dark">${esc(tRaw('team.add'))}</small>${field(tRaw('tu.s.name'), 'Lucas', true)}${hl(btn(tRaw('team.add.button')), 'row')}</div>`,
  'p-wa': () => `${head('Lucas')}<div class="tu-body tu-center-col">${qrBox('tu-pop')}<small class="tu-cap dark">24 h</small>${hl(btn(tRaw('team.invite.wa'), 'wa'), 'row')}</div>`,
  'p-staff': () => `${head('Lucas')}<div class="tu-body tu-center-col"><span class="tu-bigscan tu-pop">${ico('scan')}<b>${esc(tRaw('pd.tab.scan'))}</b></span>${lines(2)}</div>`,
};

// Les tutoriels de chaque app : [scène, texte]. Le texte d'étape peut reprendre une clé existante de l'app.
export const TUTOS = {
  guide: {
    client: { title: 'tu.g.client', steps: [['g-home', 'tu.g.client.1'], ['g-qrmenu', 'tu.g.client.2'], ['g-form', 'tu.g.client.3'], ['g-share', 'tu.g.client.4'], ['g-show', 'tu.g.client.5']] },
    pix: { title: 'tu.g.pix', steps: [['pix-bank', 'tu.g.pix.1'], ['pix-confirm', 'tu.g.pix.2'], ['pix-ok', 'tu.g.pix.3']] },
    track: { title: 'tu.g.track', steps: ['visit', 'declared', 'paid', 'cashed', 'repaid'].map((k, i) => [`trk-${i + 1}`, `g.trk.${k}.hint`]) },
  },
  partner: {
    scan: { title: 'tu.p.scan', steps: [['p-home', 'tu.p.scan.1'], ['p-cam', 'tu.p.scan.2'], ['p-bill', 'tu.p.scan.3'], ['p-ok', 'tu.p.scan.4']] },
    pay: { title: 'tu.p.pay', steps: [['p-paytab', 'tu.p.pay.1'], ['p-select', 'tu.p.pay.2'], ['p-pix', 'tu.p.pay.3'], ['p-receipt', 'tu.p.pay.4']] },
    team: { title: 'tu.p.team', steps: [['p-team', 'tu.p.team.1'], ['p-add', 'tu.p.team.2'], ['p-wa', 'tu.p.team.3'], ['p-staff', 'tu.p.team.4']] },
  },
};
const STEP_MS = 4200;

// Liens vers les tutoriels (aide, liste « Para começar »).
export function tutoLinks(kind) {
  return `<div class="tu-links">${Object.entries(TUTOS[kind] || {}).map(([id, x]) => `<a href="#/tuto/${id}" data-tuto><span class="tu-play" aria-hidden="true"></span>${t(x.title)}</a>`).join('')}</div>`;
}

export function tutoView(params, ctx, kind = window.KOMBRIO_APP || 'partner') {
  const all = TUTOS[kind] || {};
  const id = params[0] === 'tuto' ? params[1] : params[0];   // guide : #/tuto/<id> complet ; partenaire : route déjà retirée
  const tu = all[id];
  if (!tu) {
    return { html: `<div class="ia-wrap"><p class="no-print"><a href="#/">← ${t('ia.back')}</a></p>
      <h1>${t('tu.index')}</h1><p class="hint">${t('tu.index.hint')}</p>${tutoLinks(kind)}</div>` };
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
