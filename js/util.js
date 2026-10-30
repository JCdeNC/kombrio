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

// Lien Google Maps vers un partenaire (adresse si connue, sinon nom + quartier + ville).
export function mapsLink(p, cityName = '') {
  const q = p.address || [p.name, p.area, cityName].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// Réduit une photo (fichier) en JPEG d'au plus `max` px de large : ~40 Ko, assez pour une fiche.
export async function photoToJpeg(file, max = 640, quality = 0.72) {
  const url = await readFileAsDataUrl(file);
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
  const scale = Math.min(1, max / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

// Image du QR client aux couleurs Kombrio (à partager dans WhatsApp ou à garder dans les photos).
export async function qrCardBlob(text, { title, line1, line2 }) {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  try { await document.fonts.ready; } catch { /* rien */ }
  g.fillStyle = '#F4F7F8'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#102C38'; g.fillRect(0, 0, W, 170);
  const icon = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = new URL('../icon.svg', import.meta.url).href; });
  if (icon) g.drawImage(icon, 60, 45, 80, 80);
  g.fillStyle = '#fff'; g.font = '800 64px "Plus Jakarta Sans", sans-serif'; g.textBaseline = 'middle';
  g.fillText('kombrio', 160, 88);
  const wWord = g.measureText('kombrio').width;
  g.fillStyle = '#F6B73C'; g.beginPath(); g.arc(160 + wWord + 12, 62, 9, 0, Math.PI * 2); g.fill();
  g.textAlign = 'center'; g.fillStyle = '#102C38';
  g.font = '700 56px "Plus Jakarta Sans", sans-serif'; g.fillText(title, W / 2, 270, W - 120);
  g.font = '500 36px "DM Sans", sans-serif'; g.fillStyle = '#007F65'; g.fillText(line1, W / 2, 340, W - 120);
  const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), size = 760, cell = Math.floor(size / (n + 4)), qs = cell * (n + 4);
  const x0 = (W - qs) / 2, y0 = 400;
  g.fillStyle = '#fff'; g.beginPath(); g.roundRect(x0 - 20, y0 - 20, qs + 40, qs + 40, 32); g.fill();
  g.fillStyle = '#102C38';
  for (let r = 0; r < n; r += 1) for (let k = 0; k < n; k += 1) if (qr.isDark(r, k)) g.fillRect(x0 + (k + 2) * cell, y0 + (r + 2) * cell, cell, cell);
  g.font = '500 34px "DM Sans", sans-serif'; g.fillStyle = '#5B6F78'; g.fillText(line2, W / 2, y0 + qs + 80, W - 120);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

// Partage l'image (feuille de partage du téléphone : WhatsApp, Photos…) ou la télécharge sur ordinateur.
export async function shareOrDownload(blob, filename, text) {
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- Pix « copia e cola » (BR Code statique, avec montant) ---------- */
const emv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;
function crc16(s) {
  let c = 0xFFFF;
  for (let i = 0; i < s.length; i += 1) {
    c ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b += 1) c = ((c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1)) & 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
const ascii = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
export function pixPayload({ key, amount, name = 'KOMBRIO', city = 'RIO DE JANEIRO', txid = '' }) {
  const ref = txid.replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const p = emv('00', '01')
    + emv('26', emv('00', 'br.gov.bcb.pix') + emv('01', key.trim()))
    + emv('52', '0000') + emv('53', '986')
    + (amount > 0 ? emv('54', amount.toFixed(2)) : '')
    + emv('58', 'BR') + emv('59', ascii(name).slice(0, 25)) + emv('60', ascii(city).slice(0, 15))
    + emv('62', emv('05', ref)) + '6304';
  return p + crc16(p);
}
// La clé Pix de Kombrio pour une ville (vide tant qu'elle n'est pas définie).
export const pixKeyOf = (city) => (city?.payTo && !/d[ée]finir/i.test(city.payTo) && (city.methods || []).includes('pix') ? city.payTo.trim() : '');

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

/* ---------- CPF / CNPJ (Brésil) ---------- */
export const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

function checkDigits(base, weights) {
  const sum = weights.reduce((s, w, i) => s + Number(base[i]) * w, 0);
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}
export function validCpf(value) {
  const d = onlyDigits(value);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const d1 = (() => { const s = [...d.slice(0, 9)].reduce((a, n, i) => a + Number(n) * (10 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; })();
  const d2 = (() => { const s = [...d.slice(0, 10)].reduce((a, n, i) => a + Number(n) * (11 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; })();
  return d1 === Number(d[9]) && d2 === Number(d[10]);
}
export function validCnpj(value) {
  const d = onlyDigits(value);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const d1 = checkDigits(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = checkDigits(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(d[12]) && d2 === Number(d[13]);
}
// CPF (11 chiffres) ou CNPJ (14 chiffres).
export const validTaxId = (value) => validCpf(value) || validCnpj(value);
// Met en forme un champ CPF / CNPJ pendant la saisie (000.000.000-00 ou 00.000.000/0000-00).
export function maskTaxId(input, only = 'both') {
  input.addEventListener('input', () => {
    const max = only === 'cpf' ? 11 : 14;
    const d = onlyDigits(input.value).slice(0, max);
    let v = d;
    if (d.length <= 11 && only !== 'cnpj') {
      v = d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
    } else {
      v = d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
        .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3/$4').replace(/\/(\d{4})(\d{1,2})$/, '/$1-$2');
    }
    input.value = v;
  });
}
export function fmtTaxId(value) {
  const d = onlyDigits(value);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}
