// Page du client : son QR à montrer, et les partenaires (avec leur offre s'ils en ont une).
import { t, getLang } from '../i18n.js';
import { esc, fmtDay, stayIsValid, qrSvg, appLink } from '../util.js';
import * as store from '../store.js';
import { guideCard, validity, notFound } from './shared.js';

const LAST_KEY = 'kombrio-client-stay';

// L'app Client ouverte sans lien : on rouvre le dernier séjour reçu sur ce téléphone.
export async function clientHome(params, ctx) {
  let last = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* rien */ }
  if (!store.DEMO && last && await store.stayByToken(last)) return { html: '', mount: () => ctx.replace(`c/${last}`) };
  const demo = [];
  if (store.DEMO) {
    for (const g of await store.listGuides('validated')) demo.push(...await store.listStays(g.id));
  }
  return {
    html: `<div class="card"><h1>Kombrio</h1><p>${t('client.home')}</p></div>
      ${demo.length ? `<div class="card no-print"><p class="hint">${t('demo.clients')}</p><ul class="list">
        ${demo.map((s) => `<li><a href="#/c/${encodeURIComponent(s.token)}">${esc(s.client)}</a></li>`).join('')}</ul></div>` : ''}`,
  };
}

export async function clientView([token]) {
  const stay = token && await store.stayByToken(token);
  if (!stay) return notFound('err.qr');
  try { localStorage.setItem(LAST_KEY, stay.token); } catch { /* rien */ }
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
      </div>
      ${store.DEMO ? `<div class="notice no-print">${t('demo.client')} <a target="_blank" rel="noopener" href="${esc(appLink('partner', `s/${stay.token}`))}">${t('demo.client.link')}</a></div>` : ''}`,
  };
}
