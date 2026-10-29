// Page du client : son QR à montrer, et les partenaires (avec leur offre s'ils en ont une).
import { t, getLang } from '../i18n.js';
import { esc, fmtDay, stayIsValid, qrSvg, appLink } from '../util.js';
import * as store from '../store.js';
import { guideCard, validity, notFound } from './shared.js';

export async function clientView([token]) {
  const stay = token && await store.stayByToken(token);
  if (!stay) return notFound('err.qr');
  const guide = await store.getGuide(stay.guideId);
  const city = await store.getCity(guide.cityId);
  const partners = (await store.listPartners(city.id)).filter((p) => p.status === 'active');
  const lang = getLang();
  const valid = stayIsValid(stay, city);

  return {
    html: `
      <div class="card" style="text-align:center">
        <h1>${t('client.title', { client: stay.client })}</h1>
        <p>${validity(stay, valid, lang)}</p>
        ${valid ? `<div class="qr">${qrSvg(appLink(`s/${stay.token}`))}</div>
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
      </div>
      ${store.DEMO ? `<div class="notice no-print">${t('demo.client')} <a href="#/s/${encodeURIComponent(stay.token)}">${t('demo.client.link')}</a></div>` : ''}`,
  };
}
