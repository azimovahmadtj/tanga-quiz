// Service worker for the installable app (PWA): opens instantly and shows the app shell without a connection.
// Only this site's own files are cached; Firebase data and sign-in always go to the network.
const VERSION = "tanga-v1";
const SHELL = ["/", "/fb.js", "/firebase-config.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/__/")) return;

  // Pages: network first so updates show up right away, cached copy when offline
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(res => {
      if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match("/"))));
    return;
  }

  // Other own files: serve from cache, refresh it in the background
  e.respondWith(caches.match(req).then(cached => {
    const fresh = fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
