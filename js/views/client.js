// App Client : son QR à montrer, son guide, et les partenaires (avec leur offre s'ils en ont une).
import { stayBlackoutCard } from './blackouts.js';
import { t, tRaw, getLang } from '../i18n.js';
import { esc, fmtDay, stayIsValid, qrSvg, appLink, qrCardBlob, shareOrDownload } from '../util.js';
import * as store from '../store.js';
import { faqList } from '../faq.js';
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

// v74 : politique de confidentialité (texte de la base, en portugais), ouverte depuis toutes les applications.
export async function privacyView() {
  const tx = await store.termsText('privacy').catch(() => null);
  return {
    html: `<article class="card terms">
      <h1>Política de privacidade · Kombrio</h1>
      ${getLang() !== 'pt' ? `<p class="hint">${t('privacy.ptonly')}</p>` : ''}
      ${tx ? `<p class="hint">Versão ${esc(tx.version)}</p>${tx.body}` : `<div class="notice bad">${t('err.generic')}</div>`}
    </article>`,
  };
}

export async function clientView([token]) {
  const data = token && await store.stayPublic(token);
  if (!data) {
    try { localStorage.removeItem(LAST_KEY); } catch { /* rien */ }
    return notFound('err.qr');
  }
  try { localStorage.setItem(LAST_KEY, token); } catch { /* rien */ }
  const { stay, guide, city } = data;
  const [partners, picks] = await Promise.all([store.publicPartners(city.id), store.stayGuidePicks(token)]);
  const lang = getLang();
  const valid = stayIsValid(stay, city);
  // v140 (lot F) : les lieux que le guide recommande passent en tête, avec son petit mot.
  const notes = {}; picks.forEach((x) => { notes[x.partner_id] = x.note || ''; });
  const picked = picks.map((x) => partners.find((p) => p.id === x.partner_id)).filter(Boolean);
  const others = partners.filter((p) => !(p.id in notes));

  return {
    html: `
      <div class="card" style="text-align:center">
        <h1>${t('client.title', { client: stay.client })}</h1>
        <p>${validity(stay, valid, lang)}</p>
        ${valid ? `<button type="button" class="qr qr-tap" id="qrbig" aria-label="${esc(tRaw('client.qr.tap'))}">${qrSvg(appLink('partner', `s/${stay.token}`))}</button>
          <p class="hint qr-tap-hint">${t('client.qr.tap')}</p>
          <p><b>${t('client.show')}</b></p>
          ${stay.code ? `<p class="client-code">${t('client.code', { code: stay.code })}</p>` : ''}
          <p class="hint">${t('client.people', { n: stay.people, end: fmtDay(stay.end, lang) })}</p>
          <button type="button" class="btn block" id="saveqr">${t('client.saveqr')}</button>
          <p class="hint" style="margin-top:8px">${t('client.saveqr.hint')}</p>
          ${showGoogleWallet() ? `<button type="button" class="btn block wallet-google" id="gwallet">${t('client.wallet.google')}</button>` : ''}
          ${showIosHome() ? iosHomeHtml() : ''}`
          : `<p>${t('client.expired')}</p>`}
      </div>
      ${valid ? stayBlackoutCard(partners, stay.start, stay.end) : ''}
      <div class="card">
        <p class="hint">${t('client.yourguide')}</p>
        ${guideCard(guide, city)}
      </div>
      ${picked.length ? `<div class="card pick-card"><h2>${t('pick.client.title', { guide: guide.name.split(/\s+/)[0] })}</h2>${partnerShowcase(picked, city, notes)}</div>` : ''}
      <div class="card">
        <h2>${t(picked.length ? 'pick.client.others' : 'client.partners')}</h2>
        <p class="hint">${t('client.partners.hint')} ${t('client.onlylist')}</p>
        ${partnerShowcase(picked.length ? others : partners, city)}
        <p class="hint" style="margin:12px 0 0;padding:10px 12px;background:var(--bg);border-radius:10px">${t('client.disclosure')}
          ${t('client.data')} <a href="#/privacidade">${t('privacy.link')}</a></p>
      </div>
      <div class="card"><h2>${t('help.faq.title')}</h2>${faqList('client', lang)}</div>`,
    mount(root) {
      mountShowcase(root);
      // v130 (lot 5) : QR en plein écran au toucher (comme une carte d'embarquement), fond blanc, toucher pour fermer.
      const big = root.querySelector('#qrbig');
      if (big) big.onclick = () => {
        const box = document.createElement('div'); box.className = 'qr-full'; box.setAttribute('role', 'dialog');
        box.innerHTML = `<div class="qr-full-in">${big.innerHTML}<b>${esc(stay.client)}</b>${stay.code ? `<span>${esc(tRaw('client.code', { code: stay.code }).replace(/<[^>]+>/g, ''))}</span>` : ''}<small>${esc(tRaw('client.qr.close'))}</small></div>`;
        box.onclick = () => box.remove();
        document.body.appendChild(box);
      };
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

// v140 (lot F) : page publique du guide (#/l/<L-…>) : sa carte et les lieux qu'il recommande, à envoyer avant le voyage.
// N'enregistre rien : pour que l'établissement compte la visite, le client montre le QR de séjour créé par son guide.
export async function catalogView([token]) {
  const data = token && await store.guideCatalog(token);
  if (!data) return notFound('err.qr');
  const city = { id: data.city.id, name: data.city.name, currency: data.city.currency, timezone: data.city.timezone };
  const partners = await store.publicPartners(city.id);
  const notes = {}; (data.picks || []).forEach((x) => { notes[x.partner_id] = x.note || ''; });
  const picked = (data.picks || []).map((x) => partners.find((p) => p.id === x.partner_id)).filter(Boolean);
  const g = data.guide; const shown = g.badge_name || g.name;
  const ph = g.photo ? `<img src="${esc(g.photo)}" alt="">` : esc(String(shown || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase());
  return {
    html: `<div class="card"><div class="person"><div class="avatar">${ph}</div><div>
        <h1 style="margin:0">${esc(shown)}</h1><div class="hint">${t('pick.pub.role', { city: city.name })} · ${esc(g.code || '')}</div></div></div>
        <p style="margin-top:12px">${t('pick.pub.intro')}</p></div>
      <div class="card pick-card"><h2>${t('pick.pub.title')}</h2>${picked.length ? partnerShowcase(picked, city, notes) : `<p class="hint">${t('pick.pub.none')}</p>`}</div>
      <div class="card"><p class="hint" style="margin:0">${t('pick.pub.qr')}</p></div>`,
    mount(root) { mountShowcase(root); },
  };
}
