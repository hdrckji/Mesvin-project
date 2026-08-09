/* Service worker de Graine de Parole.
   Stratégie « réseau d'abord » : en ligne, on sert toujours la dernière version
   (pratique pendant qu'on fait évoluer l'appli) ; hors-ligne, on retombe sur le
   cache. On pré-cache la coquille pour un premier lancement hors-ligne possible. */

const CACHE = 'graine-v6';
const ASSETS = [
  '.', 'index.html', 'app.css', 'app.js',
  'data/verses.json', 'data/collections.json', 'icon.svg', 'manifest.webmanifest',
  // Module « Lire »
  'lire/', 'lire/index.html', 'lire/lire.css', 'lire/lire.js',
  'lire/data/marc.json', 'lire/data/jean.json',
  // Module « Défi »
  'defi/', 'defi/index.html', 'defi/defi.css', 'defi/defi.js',
  'defi/data/questions.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('index.html')))
  );
});
