import { t } from '../i18n.js';
import { esc } from '../util.js';
import * as store from '../store.js';

export async function homeView() {
  const partners = await store.listPartners();
  return {
    html: `
      <section class="hero">
        <h1>Kombrio</h1>
        <p>${t('home.tagline')}</p>
      </section>
      <div class="cards">
        <a class="card" href="#/guide">
          <h2>${t('home.guide')}</h2>
          <p class="hint">${t('home.guide.desc')}</p>
        </a>
        <div class="card">
          <h2>${t('home.partner')}</h2>
          <p class="hint">${t('home.partner.desc')}</p>
          <ul class="list">
            ${partners.map((p) => `<li><a href="#/p/${encodeURIComponent(p.token)}">${esc(p.name)} <span class="hint">· ${esc(p.area || '')}</span></a></li>`).join('')}
          </ul>
        </div>
        <a class="card" href="#/admin">
          <h2>${t('home.admin')}</h2>
          <p class="hint">${t('home.admin.desc')}</p>
        </a>
      </div>`,
  };
}
