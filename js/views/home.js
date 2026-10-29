// Page d'entrée du site : les liens vers les 4 applications.
import { t } from '../i18n.js';
import { esc, appLink } from '../util.js';

const APPS = ['client', 'partner', 'guide', 'admin'];

export async function homeView() {
  return {
    html: `
      <section class="hero">
        <h1>Kombrio</h1>
        <p>${t('home.tagline')}</p>
      </section>
      <div class="cards">
        ${APPS.map((app) => `<a class="card" href="${esc(appLink(app))}">
          <h2>${t(`app.${app}`)}</h2>
          <p class="hint">${t(`home.${app}.desc`)}</p>
        </a>`).join('')}
      </div>
      <p class="hint" style="margin-top:12px">${t('home.install')}</p>`,
  };
}
