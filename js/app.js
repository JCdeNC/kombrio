// Point d'entrée : routeur, en-tête, langue, message de démo.
import { t, LANGS, chosenLang, chooseLang, useLang, getLang, browserLang } from './i18n.js';
import { esc } from './util.js';
import * as store from './store.js';
import { homeView } from './views/home.js';
import { guideView } from './views/guide.js';
import { clientView } from './views/client.js';
import { scanView } from './views/scan.js';
import { partnerView } from './views/partner.js';
import { adminView } from './views/admin.js';

const ROUTES = {
  '': { view: homeView, lang: 'fr' },
  guide: { view: guideView, lang: 'pt' },
  c: { view: clientView, lang: 'client' }, // page du client (son QR)
  s: { view: scanView, lang: 'pt' },       // ce que voit le partenaire après avoir scanné le QR du client
  p: { view: partnerView, lang: 'pt' },    // QR Partenaire et espace du partenaire
  admin: { view: adminView, lang: 'fr', langs: ['fr', 'pt'] },
};

let flash = null;

const ctx = {
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
  const name = parts[0] || '';
  const route = ROUTES[name] || ROUTES[''];
  const fallback = route.lang === 'client' ? browserLang() : route.lang;
  let lang = chosenLang() || fallback;
  if (route.langs && !route.langs.includes(lang)) lang = route.langs[0];
  useLang(lang);

  const app = document.getElementById('app');
  let out;
  try {
    out = await route.view(parts.slice(1), ctx);
  } catch (err) {
    console.error(err);
    out = { html: `<div class="notice bad">${t(err.message === 'storage-full' ? 'err.storage' : 'err.generic')}</div>` };
  }
  const message = flash ? `<div class="notice ok" role="status">${esc(flash)}</div>` : '';
  flash = null;
  const langs = route.langs ? LANGS.filter(([code]) => route.langs.includes(code)) : LANGS;

  app.innerHTML = `
    <header class="top">
      <a class="brand" href="#/">Komb<span>rio</span></a>
      <select id="lang" aria-label="${t('common.language')}">
        ${langs.map(([code, label]) => `<option value="${code}" ${code === getLang() ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </header>
    <main>${message}${out.html}</main>
    ${store.DEMO ? `<footer class="demo">
      <span>${t('demo.banner')}</span>
      <button class="btn ghost small" id="demo-reset">${t('demo.reset')}</button>
    </footer>` : ''}`;

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
  if (out.mount) out.mount(app.querySelector('main'), ctx);
}

window.addEventListener('hashchange', render);
render();
