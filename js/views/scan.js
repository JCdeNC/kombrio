// Ce que voit le partenaire quand il scanne le QR du client avec l'appareil photo de son téléphone.
// Le séjour scanné est gardé quelques minutes dans ce téléphone, le temps de scanner le QR Partenaire.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, fmtDay, stayIsValid, notify } from '../util.js';
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

// v59 : « Devenir partenaire » — un établissement non partenaire laisse ses coordonnées (Kombrio rappelle).
export async function leadView() {
  return {
    html: `
      <form class="card" id="lead">
        <h1>${t('np.form.title')}</h1>
        <p class="hint">${t('np.form.hint')}</p>
        <div class="field"><label for="l-name">${t('np.name')}</label><input id="l-name" name="name" required maxlength="120"></div>
        <div class="field"><label for="l-contact">${t('np.contact')}</label><input id="l-contact" name="contact" required maxlength="120" autocomplete="name"></div>
        <div class="grid2">
          <div class="field"><label for="l-phone">${t('np.phone')}</label><input id="l-phone" name="phone" type="tel" maxlength="30" autocomplete="tel"></div>
          <div class="field"><label for="l-email">${t('np.email')}</label><input id="l-email" name="email" type="email" maxlength="120" autocomplete="email"></div>
        </div>
        <div class="field"><label for="l-type">${t('np.type')}</label><select id="l-type" name="type">
          ${['restaurant', 'shop'].map((k) => `<option value="${k}">${t(`ptype.${k}`)}</option>`).join('')}</select></div>
        <div class="field"><label for="l-msg">${t('np.message')}</label><textarea id="l-msg" name="message" maxlength="500" rows="3"></textarea></div>
        <button class="btn block">${t('np.send')}</button>
      </form>`,
    mount(root) {
      const f = root.querySelector('#lead');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(f));
        if (!d.name.trim() || !d.contact.trim() || (!d.phone.trim() && !d.email.trim())) { notify(tRaw('np.err.missing')); return; }
        const b = f.querySelector('button'); b.disabled = true;
        try {
          const r = await store.createPartnerLead(d);
          if (r && r.ok) f.outerHTML = `<div class="notice ok">${t('np.sent')}</div>`;
          else { b.disabled = false; notify(tRaw(r && r.reason === 'missing' ? 'np.err.missing' : 'err.generic')); }
        } catch { b.disabled = false; notify(tRaw('err.generic')); }
      };
    },
  };
}
