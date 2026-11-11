// Point d'entrée commun aux 4 applications : Client, Partenaire, Guide, Administrateur.
// Chaque application a son dossier (client/, partner/, guide/, admin/) et sa page index.html
// qui indique laquelle elle est (window.KOMBRIO_APP). Elle n'ouvre que ses propres écrans.
import { t, LANGS, chosenLang, chooseLang, useLang, getLang, browserLang, setLangScope } from './i18n.js';
import { esc } from './util.js';
import * as store from './store.js';
import { VERSION, VERSION_DATE } from './version.js';
import { homeView } from './views/home.js';
import { guideView } from './views/guide.js';
import { clientView, clientHome } from './views/client.js';
import { scanView, leadView } from './views/scan.js';
import { partnerView, partnerHome, reportView, activateView, termsView } from './views/partner.js';
import { adminView } from './views/admin.js';
import { verifyView } from './views/verify.js';

const APP = window.KOMBRIO_APP || 'hub';
const ICON = new URL('../icon.svg', import.meta.url).href;

// routes : premier mot de l'adresse (#/c/…, #/p/…) → écran. "all" : l'écran reçoit toute l'adresse.
const APPS = {
  hub: { routes: { '': homeView }, lang: 'fr' },
  client: { routes: { '': clientHome, c: clientView }, lang: 'client' },
  partner: { routes: { '': partnerHome, s: scanView, p: partnerView, r: reportView, ativar: activateView, termos: termsView, parceria: leadView }, lang: 'pt' },
  guide: { routes: { '': guideView }, lang: 'pt', all: true },
  admin: { routes: { '': adminView }, lang: 'fr', langs: ['fr', 'pt'], all: true },
  verify: { routes: { '': verifyView }, lang: 'pt', all: true },
};
const conf = APPS[APP] || APPS.hub;
setLangScope(APP);

let flash = null;

const ctx = {
  app: APP,
  go(path, message) {
    flash = message || null;
    if (location.hash === `#/${path}`) render(); else location.hash = `/${path}`;
  },
  replace(path, message) {
    flash = message || null;
    history.replaceState(null, '', `#/${path}`);
    render();
  },
  refresh(message) { flash = message || null; render(); },
};

async function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  let view = conf.routes[''];
  let params = parts;
  if (!conf.all && conf.routes[parts[0]]) {
    view = conf.routes[parts[0]];
    params = parts.slice(1);
  }
  const fallback = conf.lang === 'client' ? browserLang() : conf.lang;
  let lang = chosenLang() || fallback;
  if (conf.langs && !conf.langs.includes(lang)) lang = conf.langs[0];
  useLang(lang);

  const root = document.getElementById('app');
  let out;
  try {
    out = store.pendingOtp() ? otpView() : await view(params, ctx);
  } catch (err) {
    console.error(err);
    out = { html: `<div class="notice bad">${t(err.message === 'storage-full' ? 'err.storage' : 'err.generic')}</div>` };
  }
  const linkError = store.takeLinkError();
  const message = (linkError ? `<div class="notice bad" role="alert">${t(linkError === 'otp_expired' ? 'err.link.expired' : 'err.link')}</div>` : '')
    + (flash ? `<div class="notice ok" role="status">${esc(flash)}</div>` : '');
  flash = null;
  const langs = conf.langs ? LANGS.filter(([code]) => conf.langs.includes(code)) : LANGS;
  // v60 : sur téléphone, la langue en 2 lettres (« PT ») pour ne pas déborder de l'en-tête.
  const narrow = window.matchMedia('(max-width: 480px)').matches;
  document.title = APP === 'hub' ? 'Kombrio' : `Kombrio · ${t(`app.${APP}`)}`;

  root.innerHTML = `
    <header class="top">
      <a class="brand" href="#/"><img src="${ICON}" alt=""><span class="brand-word">kombrio<i></i></span>${APP === 'hub' ? '' : `<span class="brand-app">${t(`app.${APP}`)}</span>`}</a>
      <select id="lang" aria-label="${t('common.language')}">
        ${langs.map(([code, label]) => `<option value="${code}" ${code === getLang() ? 'selected' : ''}>${narrow ? code.toUpperCase() : label}</option>`).join('')}
      </select>
    </header>
    <main>${message}${out.html}</main>
    <footer class="demo">
      <span>Kombrio ${VERSION} · ${VERSION_DATE}${store.DEMO ? ` · ${t('demo.banner')}` : ''}</span>
      ${store.DEMO ? `<button class="btn ghost small" id="demo-reset">${t('demo.reset')}</button>` : ''}
    </footer>`;

  document.getElementById('lang').onchange = (e) => { chooseLang(e.target.value); render(); };
  const reset = document.getElementById('demo-reset');
  if (reset) {
    reset.onclick = async () => {
      if (!confirm(t('demo.reset.confirm'))) return;
      await store.resetDemo();
      ctx.go('', t('demo.reset.done'));
    };
  }
  root.querySelectorAll('input[type=password]').forEach(addEye);
  window.scrollTo(0, 0);
  if (out.mount) out.mount(root.querySelector('main'), ctx);
}

// Lien reçu par e-mail : un bouton pour le valider (voir store.confirmOtp).
function otpView() {
  const recovery = store.pendingOtp().type === 'recovery';
  return {
    html: `<div class="card" style="text-align:center">
        <h1>${t('auth.link.title')}</h1>
        <p>${t(recovery ? 'auth.link.text.reset' : 'auth.link.text.confirm')}</p>
        <button type="button" class="btn block" id="otp-go">${t('auth.link.button')}</button>
      </div>`,
    mount(root) {
      const b = root.querySelector('#otp-go');
      b.onclick = async () => {
        b.disabled = true;
        try {
          const type = await store.confirmOtp();
          ctx.replace('', type === 'recovery' ? null : t('auth.link.confirmed'));
        } catch (err) {
          ctx.replace('', t(err.message === 'otp_expired' ? 'err.link.expired' : 'err.link'));
        }
      };
    },
  };
}

// Œil dans les champs mot de passe : afficher / masquer ce qu'on tape.
const EYE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
function addEye(input) {
  const wrap = document.createElement('div');
  wrap.className = 'pw';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pw-eye';
  b.innerHTML = EYE;
  b.setAttribute('aria-label', t('auth.show'));
  b.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.innerHTML = show ? EYE_OFF : EYE;
    b.setAttribute('aria-label', t(show ? 'auth.hide' : 'auth.show'));
  };
  wrap.appendChild(b);
}

window.addEventListener('hashchange', render);
render();

// v15 : service worker (installation propre sur Android, page « sem conexão » hors ligne).
// Toujours le réseau d'abord ; les données Supabase ne passent jamais par le cache.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname }).catch(() => {});
  });
}
