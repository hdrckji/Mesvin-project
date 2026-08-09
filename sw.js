/* Service worker de Graine de Parole — met l'appli en cache pour un fonctionnement
   hors-ligne. Stratégie : « cache d'abord », avec repli réseau. On incrémente CACHE
   à chaque version pour forcer la mise à jour des fichiers. */

const CACHE = 'graine-v1';
const ASSETS = [
  '.', 'index.html', 'app.css', 'app.js',
  'data/verses.json', 'icon.svg', 'manifest.webmanifest'
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
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
