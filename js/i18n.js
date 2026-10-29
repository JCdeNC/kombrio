// Traductions. Ajouter une langue = ajouter un fichier dans js/lang/ et une ligne dans LANGS.
import { esc } from './util.js';
import pt from './lang/pt.js';
import fr from './lang/fr.js';
import en from './lang/en.js';
import es from './lang/es.js';

const DICTS = { pt, fr, en, es };
export const LANGS = [['pt', 'Português'], ['fr', 'Français'], ['en', 'English'], ['es', 'Español']];
const STORE_KEY = 'kombrio-lang';

let current = 'pt';

export function chosenLang() {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}

export function chooseLang(lang) {
  try { localStorage.setItem(STORE_KEY, lang); } catch { /* navigation privée */ }
  useLang(lang);
}

export function useLang(lang) {
  current = DICTS[lang] ? lang : 'pt';
  document.documentElement.lang = current;
}

export const getLang = () => current;

// Langue du téléphone si on la parle, sinon l'anglais (pour les clients).
export function browserLang() {
  const code = (navigator.language || 'en').slice(0, 2);
  return DICTS[code] ? code : 'en';
}

function lookup(key) {
  return DICTS[current][key] ?? DICTS.pt[key] ?? DICTS.fr[key] ?? key;
}

// Texte traduit pour du HTML : les valeurs insérées sont échappées.
export function t(key, vars = {}) {
  return lookup(key).replace(/\{(\w+)\}/g, (_, k) => esc(vars[k] ?? ''));
}

// Texte traduit brut (pour un message WhatsApp, une alerte…).
export function tRaw(key, vars = {}) {
  return lookup(key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}
