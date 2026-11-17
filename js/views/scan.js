// Ce que voit le partenaire quand il scanne le QR du client avec l'appareil photo de son téléphone.
// Le séjour scanné est gardé quelques minutes dans ce téléphone, le temps de scanner le QR Partenaire.
import { t, tRaw, getLang } from '../i18n.js';
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

export async function scanView([token], ctx) {
  const data = token && await store.stayPublic(token);
  if (!data) return notFound('err.qr');
  const { stay, guide, city } = data;
  const lang = getLang();
  const valid = stayIsValid(stay, city) && guide.status === 'validated';
  if (valid) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ token: stay.token, at: Date.now() })); } catch { /* rien */ }
    // Téléphone déjà relié à un établissement : le passage s'enregistre tout de suite (un seul scan).
    let me = null;
    try { me = localStorage.getItem('kombrio-partner'); } catch { /* rien */ }
    if (me) return { html: '', mount: () => ctx.replace(`p/${me}`) };
  }

  // v60 : téléphone pas encore relié — deux choix clairs en haut ; le nom du client n'est pas montré.
  if (!valid) {
    return { html: `<div class="notice bad">${t('scan.invalid')}</div><div class="card">${guideCard(guide, city)}</div>` };
  }
  return {
    html: `
      <div class="card" style="text-align:center"><h1 style="margin-bottom:4px">${t('scan.pass')}</h1>
        <p class="hint" style="margin:0">${validity(stay, true, lang)} · ${t('scan.people', { n: stay.people })}</p></div>
      <div class="scan-choice">
        <div class="card notice ok" style="margin:0"><h2>${t('scan.partner.title')}</h2>
          <p style="margin:0"><b>${t('scan.next')}</b><br>${t('scan.next.hint', { min: PENDING_MINUTES })}</p></div>
        <div class="card" style="margin:0"><h2>${t('np.title')}</h2>
          <p class="hint">${t('np.text')}</p>
          <a class="btn secondary block" href="#/parceria">${t('np.cta')}</a></div>
      </div>
      <div class="card" style="margin-top:12px">${guideCard(guide, city)}</div>`,
  };
}

