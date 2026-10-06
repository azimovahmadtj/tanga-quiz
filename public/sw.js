// Service worker for the installable app (PWA): opens instantly and shows the app shell without a connection.
// Only this site's own files are cached; Firebase data and sign-in always go to the network.
const VERSION = "tanga-v3";
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

  // Network first for everything, so a new version of the site (pages, fb.js, firebase-config.js) is used
  // right away; the cached copy is only for when there is no connection
  e.respondWith(fetch(req).then(res => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(r => r || (req.mode === "navigate" ? caches.match("/") : Response.error()))));
});
