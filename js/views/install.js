// v110 : assistant d'installation (« Instalar o app »), d'abord pour l'app Partenaire.
// Il reconnaît le téléphone (iPhone, Android, ordinateur) et le navigateur, puis montre seulement les gestes utiles,
// chacun avec un petit écran animé. Sur Android / Chrome / Edge, un bouton installe l'app en un toucher.
// iPhone : l'icône installée a sa propre mémoire (pas celle de Safari) : on prévient qu'il faudra se reconnecter.
import { t, tRaw } from '../i18n.js';
import { esc } from '../util.js';

// Chrome / Edge / Samsung proposent l'installation par programme : on garde l'événement pour le bouton.
let deferred = null;
const waiters = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; waiters.forEach((f) => f()); });
  window.addEventListener('appinstalled', () => { deferred = null; try { localStorage.setItem('kombrio-installed', '1'); } catch { /* rien */ } waiters.forEach((f) => f()); });
}

const APP_NAME = { partner: 'Kombrio Parceiro', guide: 'Kombrio Guia' };
const HIDE_KEY = (kind) => `kombrio-install-hide-${kind}`;

export function installEnv() {
  const ua = navigator.userAgent || '';
  const android = /Android/i.test(ua);
  const ios = !android && (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const inapp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|\bwv\b|GSA\//i.test(ua);
  let browser = 'other';
  if (/SamsungBrowser/i.test(ua)) browser = 'samsung';
  else if (/EdgiOS|EdgA|Edg\//i.test(ua)) browser = 'edge';
  else if (/FxiOS|Firefox/i.test(ua)) browser = 'firefox';
  else if (/CriOS|Chrome/i.test(ua)) browser = 'chrome';
  else if (/Safari/i.test(ua)) browser = 'safari';
  const os = ios ? 'ios' : android ? 'android' : 'desktop';
  const mac = !ios && /Macintosh/i.test(ua);
  return { os, browser, standalone, inapp, mac, canPrompt: !!deferred };
}

const isPhone = (env) => env.os === 'ios' || env.os === 'android';

// ---------- petits écrans animés : le point qui pulse montre où toucher ----------
const SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5v10h14V11h-1"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
const DOTS_V = '<b class="ia-dots">⋮</b>';
const DOTS_H = '<b class="ia-dots">⋯</b>';
const INSTALL_ICO = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 8v5M9.5 10.5 12 13l2.5-2.5M8 21h8"/></svg>';
const hl = (inner, cls = '') => `<span class="ia-hl ${cls}">${inner}</span>`;
const page = '<div class="ia-page"><span class="ia-logo"><img src="../icon.svg" alt=""></span><i></i><i></i><i class="s"></i></div>';
const url = (host = 'app.kombrio.com.br') => `<span class="ia-url">${host}</span>`;

const SCENES = {
  // iPhone · Safari : barre du bas, Compartilhar (ou ⋯ puis Compartilhar)
  'ios-bar': () => `${page}<div class="ia-bar ia-bottom"><span>‹</span><span>›</span>${hl(SHARE)}<span>${DOTS_H}</span><span>⧉</span></div>`,
  // iPhone · Chrome / Edge / Firefox : bouton Compartilhar dans la barre d'adresse
  'ios-top': () => `<div class="ia-bar ia-top">${url()}${hl(SHARE)}</div>${page}`,
  'ios-sheet': (name) => `<div class="ia-sheet"><div class="ia-sh-h"><img src="../icon.svg" alt=""><span>${esc(name)}<small>app.kombrio.com.br</small></span></div>
      <div class="ia-li">${tRaw('ia.ios.copy')}</div><div class="ia-li">${tRaw('ia.ios.fav')}</div>
      ${hl(`<div class="ia-li strong">${tRaw('ia.ios.home')} ${PLUS}</div>`, 'row')}</div>`,
  'ios-add': (name) => `<div class="ia-bar ia-top"><span class="ia-muted">${tRaw('ia.cancel')}</span>${hl(`<b class="ia-blue">${tRaw('ia.add')}</b>`)}</div>
      <div class="ia-addcard"><img src="../icon.svg" alt=""><div><b>${esc(name)}</b><small>app.kombrio.com.br</small></div></div>
      <div class="ia-li">${tRaw('ia.ios.webapp')} <span class="ia-tog"></span></div>`,
  // Android · Chrome / Edge / Firefox : ⋮ en haut à droite
  'and-menu': () => `<div class="ia-bar ia-top">${url()}${hl(DOTS_V)}</div>${page}`,
  'and-item': () => `<div class="ia-bar ia-top">${url()}<span>${DOTS_V}</span></div><div class="ia-menu"><div class="ia-li">${tRaw('ia.and.newtab')}</div><div class="ia-li">${tRaw('ia.and.fav')}</div>
      ${hl(`<div class="ia-li strong">${INSTALL_ICO} ${tRaw('ia.and.install')}</div>`, 'row')}</div>`,
  'and-ok': (name) => `${page}<div class="ia-dialog"><b>${tRaw('ia.and.dialog')}</b><div class="ia-addcard"><img src="../icon.svg" alt=""><div><b>${esc(name)}</b><small>app.kombrio.com.br</small></div></div>
      <div class="ia-dlg-b"><span class="ia-muted">${tRaw('ia.cancel')}</span>${hl(`<b class="ia-blue">${tRaw('ia.install')}</b>`)}</div></div>`,
  // Android · Samsung Internet : ≡ en bas à droite
  'sam-menu': () => `<div class="ia-bar ia-top">${url()}</div>${page}<div class="ia-bar ia-bottom"><span>‹</span><span>›</span><span>⌂</span><span>⧉</span>${hl('<b class="ia-dots">≡</b>')}</div>`,
  'sam-item': () => `${page}<div class="ia-menu ia-menu-b"><div class="ia-li">${tRaw('ia.and.fav')}</div>${hl(`<div class="ia-li strong">${PLUS} ${tRaw('ia.sam.add')}</div>`, 'row')}</div>`,
  // Écran d'accueil : l'icône Kombrio
  home: (name) => `<div class="ia-home">${'<i></i>'.repeat(6)}${hl(`<span class="ia-app"><img src="../icon.svg" alt=""><small>${esc(name.replace('Kombrio ', ''))}</small></span>`, 'app')}${'<i></i>'.repeat(5)}</div>`,
  // Ordinateur · Chrome / Edge : icône d'installation au bout de la barre d'adresse
  'desk-bar': () => `<div class="ia-bar ia-top ia-desk">${url()}${hl(INSTALL_ICO)}</div>${page}`,
  'mac-safari': () => `<div class="ia-menu ia-mac"><div class="ia-li strong">${tRaw('ia.mac.file')}</div><div class="ia-li">${tRaw('ia.mac.share')}</div>${hl(`<div class="ia-li strong">${tRaw('ia.mac.dock')}</div>`, 'row')}</div>`,
  // Ouvert dans WhatsApp / Instagram : d'abord ouvrir dans le navigateur
  inapp: () => `<div class="ia-bar ia-top"><span class="ia-muted">✕</span>${url()}${hl(DOTS_H)}</div>${page}`,
};

// Étapes selon l'appareil choisi : [scène, clé du texte]
function stepsFor(env) {
  const s = [];
  if (env.inapp) s.push(['inapp', 'ia.s.inapp']);
  if (env.os === 'ios') {
    if (env.browser === 'safari' || env.browser === 'other') s.push(['ios-bar', 'ia.s.ios.share']);
    else s.push(['ios-top', 'ia.s.ios.share.top']);
    s.push(['ios-sheet', 'ia.s.ios.home'], ['ios-add', 'ia.s.ios.add'], ['home', 'ia.s.open']);
  } else if (env.os === 'android') {
    if (env.browser === 'samsung') s.push(['sam-menu', 'ia.s.sam.menu'], ['sam-item', 'ia.s.sam.add']);
    else s.push(['and-menu', 'ia.s.and.menu'], ['and-item', 'ia.s.and.install']);
    s.push(['and-ok', 'ia.s.and.ok'], ['home', 'ia.s.open']);
  } else if (env.mac && env.browser === 'safari') {
    s.push(['mac-safari', 'ia.s.mac']);
  } else if (env.browser === 'firefox') {
    s.push(['desk-bar', 'ia.s.desk.firefox']);
  } else {
    s.push(['desk-bar', 'ia.s.desk.bar'], ['and-ok', 'ia.s.desk.ok']);
  }
  return s;
}

const DEVICES = [['ios', 'ia.dev.ios'], ['android', 'ia.dev.android'], ['desktop', 'ia.dev.desktop']];
const BROWSER_NAME = { safari: 'Safari', chrome: 'Chrome', edge: 'Edge', samsung: 'Samsung Internet', firefox: 'Firefox', other: '' };

// ---------- carte « Instale o app » (tableau de bord, écran de l'équipe, page d'accueil) ----------
export function installCard(kind, href = '#/instalar') {
  const env = installEnv();
  if (env.standalone || !isPhone(env)) return '';
  try { if (localStorage.getItem(HIDE_KEY(kind)) || localStorage.getItem('kombrio-installed')) return ''; } catch { /* rien */ }
  return `<div class="card ia-card no-print" data-ia-card="${kind}">
      <span class="ia-card-ico"><img src="../icon.svg" alt=""></span>
      <div><b>${t('ia.card.title')}</b><small>${t('ia.card.hint')}</small>
        <div class="row" style="gap:8px;margin-top:10px"><a class="btn small" href="${href}">${t('ia.card.go')}</a>
        <button type="button" class="btn ghost small" data-ia-hide="${kind}">${t('ia.card.later')}</button></div></div></div>`;
}
export function mountInstallCard(root) {
  root.querySelectorAll('[data-ia-hide]').forEach((b) => { b.onclick = () => {
    try { localStorage.setItem(HIDE_KEY(b.dataset.iaHide), '1'); } catch { /* rien */ }
    const c = b.closest('[data-ia-card]'); if (c) c.remove();
  }; });
}

// ---------- page « Instalar o app » (#/instalar) ----------
export function installView(params, ctx, kind = window.KOMBRIO_APP || 'partner') {
  const name = APP_NAME[kind] || 'Kombrio';
  const env = installEnv();
  const st = { os: env.os };
  const back = '#/';
  return {
    html: `<div class="ia-wrap"><a class="ios-back no-print" href="${back}"><span aria-hidden="true">‹</span> ${t('ia.back')}</a>
      <div class="ia-head"><img src="../icon.svg" alt=""><div><h1>${t('ia.title')}</h1><p class="hint">${t('ia.sub', { app: name })}</p></div></div>
      <div id="ia-body"></div></div>`,
    mount(root) {
      const body = root.querySelector('#ia-body');
      const draw = () => {
        const e = { ...env, os: st.os, browser: st.os === env.os ? env.browser : (st.os === 'ios' ? 'safari' : 'chrome'), mac: st.os === env.os ? env.mac : false, inapp: st.os === env.os && env.inapp };
        if (env.standalone) {
          body.innerHTML = `<div class="notice ok">${t('ia.done')}</div>`;
          return;
        }
        const steps = stepsFor(e);
        const detected = st.os === env.os ? `${t(`ia.dev.${env.os}`)}${BROWSER_NAME[env.browser] ? ` · ${BROWSER_NAME[env.browser]}` : ''}` : t(`ia.dev.${st.os}`);
        const oneTap = st.os === env.os && deferred
          ? `<div class="card ia-quick"><b>${t('ia.quick.title')}</b><p class="hint">${t('ia.quick.hint')}</p><button type="button" class="btn block" id="ia-go">${INSTALL_ICO} ${t('ia.quick.go', { app: name })}</button></div>
             <p class="hint ia-or">${t('ia.quick.or')}</p>` : '';
        body.innerHTML = `
          <div class="ia-dev"><span>${t('ia.detected')} <b>${esc(detected)}</b></span>
            <div class="ia-chips" role="group" aria-label="${esc(tRaw('ia.other'))}">${DEVICES.map(([k, l]) => `<button type="button" data-os="${k}" class="${k === st.os ? 'on' : ''}" aria-pressed="${k === st.os}">${t(l)}</button>`).join('')}</div></div>
          ${oneTap}
          <ol class="ia-steps">${steps.map(([scene, key], i) => `<li class="ia-step">
              <div class="ia-ph ia-${st.os === 'desktop' ? 'pc' : 'mob'}" aria-hidden="true"><div class="ia-scr">${SCENES[scene](name)}</div></div>
              <div class="ia-txt"><span class="ia-n">${i + 1}</span><p>${t(key, { app: name })}</p></div></li>`).join('')}</ol>
          ${st.os === 'ios' ? `<div class="notice warn ia-note"><b>${t('ia.ios.warn.title')}</b><br>${t(`ia.ios.warn.${kind}`)}</div>` : ''}
          ${st.os === 'android' ? `<p class="hint ia-note">${t('ia.and.note')}</p>` : ''}
          <p class="hint ia-note">${t('ia.help')}</p>`;
        body.querySelectorAll('[data-os]').forEach((b) => { b.onclick = () => { st.os = b.dataset.os; draw(); }; });
        const go = body.querySelector('#ia-go');
        if (go) go.onclick = async () => {
          if (!deferred) { draw(); return; }
          deferred.prompt();
          try { await deferred.userChoice; } catch { /* rien */ }
          deferred = null; draw();
        };
      };
      const redraw = () => { if (document.body.contains(body)) draw(); else waiters.delete(redraw); };
      waiters.add(redraw);
      draw();
    },
  };
}
