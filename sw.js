/* Service worker de Bible Horizon.
   Stratégie « réseau d'abord, mais pas à n'importe quel prix » : en ligne, on
   sert la dernière version ; si le réseau traîne plus de 3 s ou échoue, on
   sert la copie locale — l'app entière est pré-cachée, personne ne doit fixer
   un écran blanc avec deux barres de réseau. La coquille est pré-cachée en
   bloc (tout ou rien) ; la Bible complète suit en best-effort : un livre qui
   rate ne prive pas du hors-ligne de base, il se rattrapera à l'usage. */

const CACHE = 'graine-v37';
// La coquille : le minimum pour que l'appli s'ouvre et vive hors-ligne.
const SHELL = [
  '.', 'index.html', 'app.css', 'app.js', 'icons.js', 'api-client.js', 'pierres.js',
  'data/verses.json', 'data/collections.json', 'icon.svg', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'lire/', 'lire/index.html', 'lire/lire.css', 'lire/lire.js',
  'defi/', 'defi/index.html', 'defi/defi.css', 'defi/defi.js',
  'defi/data/questions.json',
  'frise/', 'frise/index.html',
  'quiadit/', 'quiadit/index.html', 'quiadit/data/banque.json',
  'ecritoupas/', 'ecritoupas/index.html', 'ecritoupas/data/banque.json',
  'portrait/', 'portrait/index.html', 'portrait/data/banque.json'
];
// La Bible complète (66 livres, ~4,4 Mo) — pré-cachée en arrière-plan pour un
// hors-ligne total ; à l'écran, chaque livre reste chargé à la demande.
const BIBLE = [
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
  'lire/data/tite.json', 'lire/data/zacharie.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // Coquille : atomique — si elle rate, on réessaiera une autre fois.
      .then(c => c.addAll(SHELL)
        // Bible : chaque livre pour lui-même — sur un réseau fragile, en
        // garder 60 sur 66 vaut infiniment mieux que tout perdre.
        .then(() => Promise.allSettled(BIBLE.map(u => c.add(u)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const RESEAU_PATIENCE_MS = 3000; // au-delà, la copie locale prend le relais

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Autres origines (bouton Google…) : on ne s'en mêle pas — les réponses
  // opaques gonflent le quota et n'ont rien à faire dans notre cache.
  if (url.origin !== location.origin) return;
  // L'API n'est JAMAIS mise en cache ni servie depuis le cache : données
  // privées et toujours fraîches ; hors-ligne, l'appli gère l'échec elle-même.
  if (url.pathname.includes('/api/')) return;
  e.respondWith((async () => {
    const enCache = await caches.match(e.request);
    const reseau = fetch(e.request).then(res => {
      // Seules les réponses SAINES entrent au cache : une 404/500 passagère
      // ne doit jamais remplacer une bonne copie ni être servie hors-ligne.
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    });
    if (!enCache) {
      return reseau.catch(() => caches.match('index.html'));
    }
    // Copie locale disponible : le réseau a RESEAU_PATIENCE_MS pour faire
    // mieux, sinon on sert le local — un réseau à deux barres ne doit jamais
    // se traduire par un écran blanc alors que tout est déjà sur l'appareil.
    const chrono = new Promise(resolve => setTimeout(() => resolve(null), RESEAU_PATIENCE_MS));
    const res = await Promise.race([reseau.catch(() => null), chrono]);
    return (res && res.ok) ? res : enCache;
  })());
});

/* ---- « Le verset offert » : notifications push ----
   Le serveur envoie un JSON { title, body, url } chiffré (RFC 8291). La
   notification OFFRE un verset — elle ne réclame jamais rien. Le tag
   'verset-offert' fait qu'un nouveau verset REMPLACE le précédent au lieu
   d'empiler des notifications non lues (jamais de pile culpabilisante). */
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { /* payload illisible : valeurs sûres */ }
  e.waitUntil(self.registration.showNotification(data.title || '🌱 Un verset pour toi', {
    body: data.body || '',
    // PNG obligatoire : Android n'affiche pas les icônes SVG de notification.
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'verset-offert',
    data: { url: data.url || '/' }
  }));
});

/* Toucher la notification : on retrouve une fenêtre de l'appli déjà ouverte
   (focus), sinon on en ouvre une sur l'accueil. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
