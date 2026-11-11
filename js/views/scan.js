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
        : `<div class="notice bad">${t('scan.invalid')}</div>`}
      <div class="card">
        <h2>${t('np.title')}</h2>
        <p class="hint">${t('np.text')}</p>
        <a class="btn secondary block" href="#/parceria">${t('np.cta')}</a>
      </div>`,
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
