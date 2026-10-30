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
import { scanView } from './views/scan.js';
import { partnerView, partnerHome, reportView } from './views/partner.js';
import { adminView } from './views/admin.js';

const APP = window.KOMBRIO_APP || 'hub';
const ICON = new URL('../icon.svg', import.meta.url).href;

// routes : premier mot de l'adresse (#/c/…, #/p/…) → écran. "all" : l'écran reçoit toute l'adresse.
const APPS = {
  hub: { routes: { '': homeView }, lang: 'fr' },
  client: { routes: { '': clientHome, c: clientView }, lang: 'client' },
  partner: { routes: { '': partnerHome, s: scanView, p: partnerView, r: reportView }, lang: 'pt' },
  guide: { routes: { '': guideView }, lang: 'pt', all: true },
  admin: { routes: { '': adminView }, lang: 'fr', langs: ['fr', 'pt'], all: true },
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
    out = await view(params, ctx);
  } catch (err) {
    console.error(err);
    out = { html: `<div class="notice bad">${t(err.message === 'storage-full' ? 'err.storage' : 'err.generic')}</div>` };
  }
  const message = flash ? `<div class="notice ok" role="status">${esc(flash)}</div>` : '';
  flash = null;
  const langs = conf.langs ? LANGS.filter(([code]) => conf.langs.includes(code)) : LANGS;
  document.title = APP === 'hub' ? 'Kombrio' : `Kombrio · ${t(`app.${APP}`)}`;

  root.innerHTML = `
    <header class="top">
      <a class="brand" href="#/"><img src="${ICON}" alt="">kombrio<i></i>${APP === 'hub' ? '' : ` <small>${t(`app.${APP}`)}</small>`}</a>
      <select id="lang" aria-label="${t('common.language')}">
        ${langs.map(([code, label]) => `<option value="${code}" ${code === getLang() ? 'selected' : ''}>${label}</option>`).join('')}
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
  window.scrollTo(0, 0);
  if (out.mount) out.mount(root.querySelector('main'), ctx);
}

window.addEventListener('hashchange', render);
render();
