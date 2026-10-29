// Petits outils partagés : échappement, formats, dates, QR.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const LOCALES = { pt: 'pt-BR', fr: 'fr-FR', en: 'en-US', es: 'es-ES' };
export const locale = (lang) => LOCALES[lang] || 'pt-BR';

export function money(amount, currency, lang) {
  return new Intl.NumberFormat(locale(lang), { style: 'currency', currency }).format(amount || 0);
}

// Une date "AAAA-MM-JJ" affichée sans décalage de fuseau.
export function fmtDay(day, lang) {
  if (!day) return '';
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${day}T12:00:00Z`));
}

// Un instant (ISO) affiché à l'heure locale de la ville.
export function fmtMoment(iso, lang, timeZone) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium', timeStyle: 'short', timeZone })
    .format(new Date(iso));
}

// La date du jour ("AAAA-MM-JJ") dans le fuseau de la ville.
export function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Le QR d'un séjour marche jusqu'au dernier jour, 23 h 59, heure locale.
export function stayIsValid(stay, city) {
  return todayIn(city.timezone) <= stay.end;
}

export function randomToken(length = 20) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

// Racine du site (le dossier qui contient js/), en ligne comme sur le Mac.
const ROOT = new URL('../', import.meta.url).href;
export const APP_DIRS = { hub: '', client: 'client/', partner: 'partner/', guide: 'guide/', admin: 'admin/' };

// Lien absolu vers un écran d'une des 4 applications (ex. appLink('partner', 's/abc')).
export function appLink(app, path = '') {
  return `${ROOT}${APP_DIRS[app]}${path ? `#/${path}` : ''}`;
}

export function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '<p class="hint">QR indisponible (pas de connexion ?)</p>';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Message d'erreur affiché en haut de la page (les fenêtres alert/confirm ne s'affichent pas partout).
export function notify(message) {
  const main = document.querySelector('main');
  if (!main) return;
  main.querySelector('.notice.js-notify')?.remove();
  const box = document.createElement('div');
  box.className = 'notice bad js-notify';
  box.setAttribute('role', 'alert');
  box.textContent = message;
  main.prepend(box);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Confirmation en deux clics : le premier affiche la question sur le bouton, le second lance l'action.
export function confirmTwice(button, question, action, errorMessage) {
  const label = button.textContent;
  let armed = false;
  let timer;
  button.onclick = async () => {
    if (!armed) {
      armed = true;
      button.textContent = question;
      button.classList.add('armed');
      timer = setTimeout(() => { armed = false; button.textContent = label; button.classList.remove('armed'); }, 8000);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    try { await action(); } catch { button.disabled = false; notify(errorMessage); }
  };
}
