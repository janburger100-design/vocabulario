#!/bin/sh
# Baut die App und schreibt eine neue Cache-Version in sw.js
set -e
cd "$(dirname "$0")"
./node_modules/.bin/esbuild src/app.js --bundle --format=esm --minify --target=safari15 --outfile=docs/app.js
VER=$(cat docs/app.js docs/app.css docs/index.html docs/config.js | sha1sum | cut -c1-10)
FILES=$(cd docs && find . -type f ! -name sw.js ! -name '.*' | sed 's|^\./||' | sort | awk '{printf "\"%s\",", $0}')
cat > docs/sw.js <<SW
// Offline-Cache. Version wird bei jedem Build neu berechnet.
const CACHE = "vocabulario-$VER";
const FILES = ["./", ${FILES%,}];
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
SW
echo "Build $VER fertig"
