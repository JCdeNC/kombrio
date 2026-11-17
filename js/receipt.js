// v90 : lecture automatique du comprovante Pix, à chaque étape de paiement.
// L'admin (ou le partenaire) joint la capture du reçu bancaire : fichier, photo, ou Cmd+V d'une capture.
// L'app lit le texte dans le navigateur (Tesseract, sans clé ni coût, rien n'est envoyé à un service de lecture),
// trouve l'ID E2E (E + 31 caractères) et le montant, remplit le champ et contrôle le montant attendu.
// Le champ reste corrigeable : l'image est affichée à côté pour comparer.
import { t, tRaw } from './i18n.js';
import { esc, photoToJpeg } from './util.js';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loader = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!loader) loader = new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = TESSERACT; s.async = true;
    s.onload = () => (window.Tesseract ? ok(window.Tesseract) : ko(new Error('tesseract')));
    s.onerror = () => { loader = null; ko(new Error('tesseract')); };
    document.head.appendChild(s);
  });
  return loader;
}

// Chiffres que la lecture confond souvent avec des lettres (seulement dans la partie numérique de l'E2E).
const DIGIT = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', '!': '1', Z: '2', z: '2', S: '5', s: '5', B: '8', G: '6', b: '6', g: '9', q: '9', T: '7' };
const asDigits = (s) => s.split('').map((c) => DIGIT[c] ?? c).join('');

// E2E Pix : « E » + ISPB (8 chiffres) + date AAAAMMJJhhmm (12 chiffres) + 11 caractères alphanumériques.
export function findE2e(text) {
  const lines = String(text || '').split(/\n/).map((l) => l.replace(/[\s ]/g, ''));
  const pool = [...lines, lines.join('')];
  for (const line of pool) {
    const re = /[EÉ€£]([0-9OoDQIli|!ZzSsBGbgqT]{20})([A-Za-z0-9]{11})/g;
    let m;
    while ((m = re.exec(line))) {
      const digits = asDigits(m[1]);
      if (!/^\d{20}$/.test(digits)) continue;
      const y = +digits.slice(8, 12), mo = +digits.slice(12, 14), d = +digits.slice(14, 16), h = +digits.slice(16, 18), mi = +digits.slice(18, 20);
      if (y < 2020 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) continue;
      return { e2e: `E${digits}${m[2]}`, day: `${digits.slice(8, 12)}-${digits.slice(12, 14)}-${digits.slice(14, 16)}` };
    }
  }
  return null;
}

// Montants « R$ 1.234,56 » : le premier du reçu est le montant du Pix.
export function findAmounts(text) {
  const out = [];
  const re = /R\s?\$\s*([0-9OoIl]{1,3}(?:[.\s][0-9]{3})*,[0-9OoIl]{2})/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const v = asDigits(m[1]).replace(/[.\s]/g, '').replace(',', '.');
    const cents = Math.round(Number(v) * 100);
    if (Number.isFinite(cents)) out.push(cents);
  }
  return out;
}

export async function readReceiptImage(file) {
  const T = await loadTesseract();
  const { data } = await T.recognize(file, 'eng');
  const text = data?.text || '';
  return { text, e2e: findE2e(text), amounts: findAmounts(text) };
}

// Bloc à placer dans un formulaire : bouton « Comprovante », aperçu et message de lecture.
export function receiptZone() {
  return `<div class="rcpt" data-rcpt>
    <label class="btn small secondary rcpt-pick">📎 ${t('rc.pick')}<input type="file" accept="image/*" hidden></label>
    <span class="hint rcpt-msg">${t('rc.hint')}</span>
    <a href="#" class="rcpt-view" hidden><img class="rcpt-thumb" alt=""></a>
  </div>`;
}

let activeZone = null;
let pasteBound = false;
function bindPaste() {
  if (pasteBound) return;
  pasteBound = true;
  window.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    const zones = [...document.querySelectorAll('[data-rcpt]')];
    const zone = (activeZone && document.contains(activeZone)) ? activeZone : zones.length === 1 ? zones[0] : null;
    if (!zone) return;
    e.preventDefault();
    zone._handle(file);
  });
}

// Branche chaque zone d'un écran. opts.input(form) : le champ E2E ; opts.expect(form) : montant attendu en centavos (ou null).
// La capture (JPEG réduit) est gardée dans form._receipt pour être enregistrée avec le paiement.
export function mountReceipts(root, opts) {
  bindPaste();
  root.querySelectorAll('[data-rcpt]').forEach((zone) => {
    const form = zone.closest('form');
    if (!form) return;
    const msg = zone.querySelector('.rcpt-msg');
    const view = zone.querySelector('.rcpt-view');
    const fileInput = zone.querySelector('input[type=file]');
    const fmt = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const say = (cls, html) => { msg.className = `rcpt-msg ${cls}`; msg.innerHTML = html; };
    form.addEventListener('focusin', () => { activeZone = zone; });
    form.addEventListener('pointerdown', () => { activeZone = zone; });
    view.onclick = (e) => { e.preventDefault(); const w = window.open(); if (w) w.document.write(`<img src="${form._receipt?.data || ''}" style="max-width:100%">`); };
    zone._handle = async (file) => {
      if (!file || !file.type.startsWith('image/')) { say('notice warn', esc(tRaw('rc.notimage'))); return; }
      activeZone = zone;
      try {
        const data = await photoToJpeg(file, 1100, 0.72);
        form._receipt = { name: file.name || 'comprovante.jpg', type: 'image/jpeg', data };
        view.querySelector('img').src = data; view.hidden = false;
      } catch { /* l'aperçu n'est pas indispensable */ }
      say('hint', esc(tRaw('rc.reading')));
      let r;
      try { r = await readReceiptImage(file); } catch { say('notice warn', esc(tRaw('rc.err'))); return; }
      const input = opts.input(form);
      if (!r.e2e) { say('notice warn', esc(tRaw('rc.noe2e'))); input?.focus(); return; }
      if (input) input.value = r.e2e.e2e;
      const expect = opts.expect ? opts.expect(form) : null;
      const got = r.amounts[0];
      const lines = [`✓ ${esc(tRaw('rc.e2e'))} <b>${esc(r.e2e.e2e)}</b>`];
      let ok = true;
      if (expect != null) {
        if (got == null) { lines.push(`⚠ ${esc(tRaw('rc.noamount', { amount: fmt(expect) }))}`); ok = false; }
        else if (got !== expect) { lines.push(`⚠ ${esc(tRaw('rc.amount.ko', { got: fmt(got), want: fmt(expect) }))}`); ok = false; }
        else lines.push(`✓ ${esc(tRaw('rc.amount.ok', { amount: fmt(got) }))}`);
      }
      lines.push(`<span class="hint">${esc(tRaw('rc.check'))}</span>`);
      say(`notice ${ok ? 'ok' : 'warn'}`, lines.join('<br>'));
      const submit = form.querySelector('button:not([type=button])');
      if (submit && ok) { submit.classList.add('rcpt-go'); submit.focus(); }
    };
    fileInput.onchange = () => { if (fileInput.files[0]) zone._handle(fileInput.files[0]); fileInput.value = ''; };
    zone.addEventListener('dragover', (e) => { e.preventDefault(); });
    zone.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) zone._handle(f); });
  });
}
