// Kombrio · service worker (v15) : installation propre sur Android et page « sem conexão » hors ligne.
// Toujours le réseau d'abord : on ne sert une copie que s'il n'y a pas de connexion.
// Les données (Supabase) et les autres sites ne passent jamais par ici.
const CACHE = 'kombrio-v15';
const BASE = new URL('./', self.location).href;
const HORS = BASE + 'hors-ligne.html';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([HORS, BASE + 'icon.svg', BASE + 'icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(l => Promise.all(l.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).catch(() => caches.match(HORS)));
    return;
  }
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const copie = res.clone(); caches.open(CACHE).then(c => c.put(r, copie)); }
    return res;
  }).catch(() => caches.match(r)));
});
