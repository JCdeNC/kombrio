// Page d'entrée app.kombrio.com.br (bouton « Entrar » du site) — v145 : refaite au style de l'app.
// Deux entrées (établissement ; guide, Tour Company ou agence) ; le touriste ouvre le lien de son guide.
// L'administration garde son adresse à elle (/admin/) et n'est plus affichée ici.
import { t } from '../i18n.js';
import { esc, appLink } from '../util.js';

const row = (href, title, desc) => `<a class="card ios-row" href="${esc(href)}" style="text-decoration:none;color:inherit">
  <span style="flex:1;min-width:0"><b>${title}</b><br><small class="hint">${desc}</small></span><span class="ios-chev" aria-hidden="true">›</span></a>`;

export async function homeView() {
  return {
    html: `
      <section class="hero">
        <h1 class="logo-big"><img src="${new URL('../../icon.svg', import.meta.url).href}" alt="">kombrio<i></i></h1>
        <p>${t('home2.tagline')}</p>
      </section>
      <h2 class="ios-sec">${t('home2.enter')}</h2>
      ${row(appLink('partner'), t('home2.partner'), t('home2.partner.d'))}
      ${row(appLink('guide'), t('home2.guide'), t('home2.guide.d'))}
      <p class="hint card" style="margin-top:12px">${t('home2.client')}</p>
      <p class="hint" style="text-align:center;margin-top:16px"><a href="https://kombrio.com.br/">${t('home2.site')}</a></p>`,
  };
}
