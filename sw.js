/* Service worker de Graine de Parole.
   Stratégie « réseau d'abord » : en ligne, on sert toujours la dernière version
   (pratique pendant qu'on fait évoluer l'appli) ; hors-ligne, on retombe sur le
   cache. On pré-cache la coquille pour un premier lancement hors-ligne possible. */

const CACHE = 'graine-v7';
const ASSETS = [
  '.', 'index.html', 'app.css', 'app.js',
  'data/verses.json', 'data/collections.json', 'icon.svg', 'manifest.webmanifest',
  // Module « Lire » — les 22 livres (~1,6 Mo) sont pré-cachés pour un
  // hors-ligne complet ; ils ne sont chargés à l'écran qu'à la demande.
  'lire/', 'lire/index.html', 'lire/lire.css', 'lire/lire.js',
  'lire/data/genese.json', 'lire/data/exode.json', 'lire/data/psaumes.json', 'lire/data/proverbes.json',
  'lire/data/matthieu.json', 'lire/data/marc.json', 'lire/data/luc.json', 'lire/data/jean.json',
  'lire/data/actes.json', 'lire/data/romains.json', 'lire/data/1corinthiens.json', 'lire/data/2corinthiens.json',
  'lire/data/galates.json', 'lire/data/ephesiens.json', 'lire/data/philippiens.json', 'lire/data/colossiens.json',
  'lire/data/1thessaloniciens.json', 'lire/data/2thessaloniciens.json', 'lire/data/1timothee.json',
  'lire/data/2timothee.json', 'lire/data/tite.json', 'lire/data/philemon.json',
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
