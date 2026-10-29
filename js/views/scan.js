// Ce que voit le partenaire quand il scanne le QR du client avec l'appareil photo de son téléphone.
// Le séjour scanné est gardé quelques minutes dans ce téléphone, le temps de scanner le QR Partenaire.
import { t, getLang } from '../i18n.js';
import { esc, fmtDay, stayIsValid } from '../util.js';
import * as store from '../store.js';
import { guideCard, validity, notFound } from './shared.js';

const PENDING_KEY = 'kombrio-pending-stay';
export const PENDING_MINUTES = 15;

export function readPendingStay() {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY));
    if (p && Date.now() - p.at < PENDING_MINUTES * 60e3) return p.token;
  } catch { /* rien */ }
  return null;
}
export function clearPendingStay() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* rien */ }
}

export async function scanView([token]) {
  const data = token && await store.stayPublic(token);
  if (!data) return notFound('err.qr');
  const { stay, guide, city } = data;
  const lang = getLang();
  const valid = stayIsValid(stay, city) && guide.status === 'validated';
  if (valid) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ token: stay.token, at: Date.now() })); } catch { /* rien */ }
  }

  return {
    html: `
      <div class="card">
        ${guideCard(guide, city)}
      </div>
      <div class="card">
        <div class="spread"><h1>${esc(stay.client)}</h1>${validity(stay, stayIsValid(stay, city), lang)}</div>
        <p>${t('scan.people', { n: stay.people })} · ${fmtDay(stay.start, lang)} → ${fmtDay(stay.end, lang)}</p>
      </div>
      ${valid
        ? `<div class="notice ok"><b>${t('scan.next')}</b><br>${t('scan.next.hint', { min: PENDING_MINUTES })}</div>`
        : `<div class="notice bad">${t('scan.invalid')}</div>`}`,
  };
}
