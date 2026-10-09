// Offline-Cache. Version wird bei jedem Build neu berechnet.
const CACHE = "vocabulario-d5b023e2bf";
const FILES = ["./", "app.css","app.js","config.js","fonts/fraunces-latin-600-italic.woff2","fonts/fraunces-latin-600-normal.woff2","fonts/manrope-latin-400-normal.woff2","fonts/manrope-latin-500-normal.woff2","fonts/manrope-latin-600-normal.woff2","fonts/manrope-latin-700-normal.woff2","fonts/manrope-latin-800-normal.woff2","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512-maskable.png","icons/icon-512.png","index.html","manifest.webmanifest"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Firebase & Co. laufen am Cache vorbei
  if (req.mode === "navigate") {
    const net = fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put("./", c)); } return r; });
    const slow = new Promise(res => setTimeout(() => caches.match("./").then(res), 2500));
    e.respondWith(Promise.race([net.catch(() => caches.match("./")), slow]).then(r => r || net));
    return;
  }
  e.respondWith(caches.match(req, {ignoreSearch: true}).then(hit => hit || fetch(req)));
});
