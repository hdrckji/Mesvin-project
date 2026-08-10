/* Service worker de Bible Horizon.
   Stratégie « réseau d'abord » : en ligne, on sert toujours la dernière version
   (pratique pendant qu'on fait évoluer l'appli) ; hors-ligne, on retombe sur le
   cache. On pré-cache la coquille pour un premier lancement hors-ligne possible. */

const CACHE = 'graine-v12';
const ASSETS = [
  '.', 'index.html', 'app.css', 'app.js', 'api-client.js',
  'data/verses.json', 'data/collections.json', 'icon.svg', 'manifest.webmanifest',
  // Module « Lire » — la Bible complète (66 livres, ~4,4 Mo) est pré-cachée
  // pour un hors-ligne total ; à l'écran, chaque livre reste chargé à la demande.
  'lire/', 'lire/index.html', 'lire/lire.css', 'lire/lire.js',
  'lire/data/1chroniques.json', 'lire/data/1corinthiens.json', 'lire/data/1jean.json', 'lire/data/1pierre.json',
  'lire/data/1rois.json', 'lire/data/1samuel.json', 'lire/data/1thessaloniciens.json', 'lire/data/1timothee.json',
  'lire/data/2chroniques.json', 'lire/data/2corinthiens.json', 'lire/data/2jean.json', 'lire/data/2pierre.json',
  'lire/data/2rois.json', 'lire/data/2samuel.json', 'lire/data/2thessaloniciens.json', 'lire/data/2timothee.json',
  'lire/data/3jean.json', 'lire/data/abdias.json', 'lire/data/actes.json', 'lire/data/aggee.json',
  'lire/data/amos.json', 'lire/data/apocalypse.json', 'lire/data/cantique.json', 'lire/data/colossiens.json',
  'lire/data/daniel.json', 'lire/data/deuteronome.json', 'lire/data/ecclesiaste.json', 'lire/data/ephesiens.json',
  'lire/data/esaie.json', 'lire/data/esdras.json', 'lire/data/esther.json', 'lire/data/exode.json',
  'lire/data/ezechiel.json', 'lire/data/galates.json', 'lire/data/genese.json', 'lire/data/habacuc.json',
  'lire/data/hebreux.json', 'lire/data/jacques.json', 'lire/data/jean.json', 'lire/data/jeremie.json',
  'lire/data/job.json', 'lire/data/joel.json', 'lire/data/jonas.json', 'lire/data/josue.json',
  'lire/data/jude.json', 'lire/data/juges.json', 'lire/data/lamentations.json', 'lire/data/levitique.json',
  'lire/data/luc.json', 'lire/data/malachie.json', 'lire/data/marc.json', 'lire/data/matthieu.json',
  'lire/data/michee.json', 'lire/data/nahum.json', 'lire/data/nehemie.json', 'lire/data/nombres.json',
  'lire/data/osee.json', 'lire/data/philemon.json', 'lire/data/philippiens.json', 'lire/data/proverbes.json',
  'lire/data/psaumes.json', 'lire/data/romains.json', 'lire/data/ruth.json', 'lire/data/sophonie.json',
  'lire/data/tite.json', 'lire/data/zacharie.json',
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
  // L'API n'est JAMAIS mise en cache ni servie depuis le cache : données
  // privées et toujours fraîches ; hors-ligne, l'appli gère l'échec elle-même.
  if (new URL(e.request.url).pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('index.html')))
  );
});
