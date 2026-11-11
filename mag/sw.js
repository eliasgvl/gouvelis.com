// Minimal service worker: makes the site installable. It deliberately does NOT
// cache anything, so every request goes to the network and pages never go stale.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
