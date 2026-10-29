// App Client : son QR à montrer, son guide, et les partenaires (avec leur offre s'ils en ont une).
import { t, getLang } from '../i18n.js';
import { esc, fmtDay, stayIsValid, qrSvg, appLink } from '../util.js';
import * as store from '../store.js';
import { guideCard, validity, notFound } from './shared.js';

const LAST_KEY = 'kombrio-client-stay';

// L'app ouverte sans lien (icône sur l'écran d'accueil) : on rouvre le dernier séjour reçu sur ce téléphone.
export async function clientHome(params, ctx) {
  let last = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* rien */ }
  if (last) return { html: '', mount: () => ctx.replace(`c/${last}`) };
  return { html: `<div class="card"><h1>Kombrio</h1><p>${t('client.home')}</p></div>` };
}

export async function clientView([token]) {
  const data = token && await store.stayPublic(token);
  if (!data) {
    try { localStorage.removeItem(LAST_KEY); } catch { /* rien */ }
    return notFound('err.qr');
  }
  try { localStorage.setItem(LAST_KEY, token); } catch { /* rien */ }
  const { stay, guide, city } = data;
  const partners = await store.publicPartners(city.id);
  const lang = getLang();
  const valid = stayIsValid(stay, city);

  return {
    html: `
      <div class="card" style="text-align:center">
        <h1>${t('client.title', { client: stay.client })}</h1>
        <p>${validity(stay, valid, lang)}</p>
        ${valid ? `<div class="qr">${qrSvg(appLink('partner', `s/${stay.token}`))}</div>
          <p><b>${t('client.show')}</b></p>
          <p class="hint">${t('client.people', { n: stay.people, end: fmtDay(stay.end, lang) })}</p>`
          : `<p>${t('client.expired')}</p>`}
      </div>
      <div class="card">
        <p class="hint">${t('client.yourguide')}</p>
        ${guideCard(guide, city)}
      </div>
      <div class="card">
        <h2>${t('client.partners')}</h2>
        <p class="hint">${t('client.partners.hint')}</p>
        <ul class="list">
          ${partners.map((p) => `<li>
            <b>${esc(p.name)}</b> <span class="hint">· ${t(`ptype.${p.type}`)} · ${esc(p.area || '')}</span>
            ${p.offer ? `<div class="offer">${esc(p.offer)}</div>` : ''}
          </li>`).join('')}
        </ul>
      </div>`,
  };
}
