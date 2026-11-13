// App Client : son QR à montrer, son guide, et les partenaires (avec leur offre s'ils en ont une).
import { t, tRaw, getLang } from '../i18n.js';
import { esc, fmtDay, stayIsValid, qrSvg, appLink, qrCardBlob, shareOrDownload } from '../util.js';
import * as store from '../store.js';
import { SUPABASE_URL, SUPABASE_KEY, WALLET_GOOGLE } from '../config.js';
import { guideCard, validity, notFound, partnerShowcase, mountShowcase } from './shared.js';

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
          ${stay.code ? `<p class="client-code">${t('client.code', { code: stay.code })}</p>` : ''}
          <p class="hint">${t('client.people', { n: stay.people, end: fmtDay(stay.end, lang) })}</p>
          <button type="button" class="btn block" id="saveqr">${t('client.saveqr')}</button>
          <p class="hint" style="margin-top:8px">${t('client.saveqr.hint')}</p>
          ${showGoogleWallet() ? `<button type="button" class="btn block wallet-google" id="gwallet">${t('client.wallet.google')}</button>` : ''}
          ${showIosHome() ? iosHomeHtml() : ''}`
          : `<p>${t('client.expired')}</p>`}
      </div>
      <div class="card">
        <p class="hint">${t('client.yourguide')}</p>
        ${guideCard(guide, city)}
      </div>
      <div class="card">
        <h2>${t('client.partners')}</h2>
        <p class="hint">${t('client.partners.hint')} ${t('client.onlylist')}</p>
        ${partnerShowcase(partners, city)}
        <p class="hint" style="margin:12px 0 0;padding:10px 12px;background:var(--bg);border-radius:10px">${t('client.disclosure')}</p>
      </div>`,
    mount(root) {
      mountShowcase(root);
      const b = root.querySelector('#saveqr');
      if (b) {
        b.onclick = async () => {
          const blob = await qrCardBlob(appLink('partner', `s/${stay.token}`), {
            title: stay.client, line1: tRaw('client.valid.until', { end: fmtDay(stay.end, lang) }), line2: tRaw('client.show'),
          });
          await shareOrDownload(blob, 'kombrio-qr.png', tRaw('client.show'));
        };
      }
      const gw = root.querySelector('#gwallet');
      if (gw) gw.onclick = () => openGoogleWallet(gw, stay.token, lang);
      const ih = root.querySelector('#ioshome');
      if (ih) {
        // L'icône rouvre CE séjour : client/index.html ne charge pas le manifeste sur iPhone.
        ih.onclick = () => {
          const steps = root.querySelector('#ioshome-steps');
          steps.hidden = !steps.hidden;
          ih.setAttribute('aria-expanded', String(!steps.hidden));
        };
      }
    },
  };
}

// iPhone/iPad dans Safari (pas déjà ouvert depuis l'icône) : Apple ne permet pas d'ajouter
// l'icône pour le client, on lui montre les deux gestes.
function showIosHome() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && !navigator.standalone;
}

const SHARE_ICON = `<svg class="ios-share" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function iosHomeHtml() {
  return `<button type="button" class="btn block secondary" id="ioshome" aria-expanded="false" aria-controls="ioshome-steps" style="margin-top:12px">${t('client.ioshome')}</button>
    <ol class="ios-steps" id="ioshome-steps" hidden>
      <li>${t('client.ioshome.step0')}</li>
      <li>${t('client.ioshome.step1')} ${SHARE_ICON}</li>
      <li>${t('client.ioshome.step2')}</li>
    </ol>`;
}

// Carteira do Google : pas sur iPhone/iPad (la Carteira da Apple viendra à sa place).
function showGoogleWallet() {
  return WALLET_GOOGLE && !/iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// La fonction Supabase signe le pass, puis on ouvre la page Google qui l'ajoute à la carteira.
async function openGoogleWallet(button, token, lang) {
  button.disabled = true;
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/carteira-google?token=${encodeURIComponent(token)}&lang=${lang}`, {
      headers: { apikey: SUPABASE_KEY },
    });
    const d = await r.json();
    if (!d.url) throw new Error(d.error || 'wallet');
    window.location.href = d.url;
  } catch {
    alert(tRaw('client.wallet.error'));
  } finally {
    button.disabled = false;
  }
}
