// StationBrain service worker.
// Page navigations: network-first (so updates land immediately) with a short
// timeout and cache fallback, so the app still opens with no signal.
// Other same-origin assets: stale-while-revalidate.
const CACHE_NAME = 'stationbrain-v2-3-0';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isCacheable(response) {
  return response && response.status === 200 && response.type === 'basic';
}

async function handleNavigation(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = (await cache.match(event.request, { ignoreSearch: true })) || (await cache.match('./index.html'));
  const network = fetch(event.request).then(response => {
    if (isCacheable(response)) cache.put(event.request, response.clone());
    return response;
  });
  event.waitUntil(network.catch(() => {}));
  if (!cached) return network;
  const timeout = new Promise(resolve => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
  return Promise.race([network, timeout]).catch(() => cached);
}

async function handleAsset(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);
  const network = fetch(event.request).then(response => {
    if (isCacheable(response)) cache.put(event.request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(request.mode === 'navigate' ? handleNavigation(event) : handleAsset(event));
});
