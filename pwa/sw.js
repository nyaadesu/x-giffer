// Minimal app-shell cache so the PWA is installable and opens offline.
// Network first, so updates show up immediately when online.
const CACHE = "xgd-v7";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon.svg",
  "../extension/converter.js",
  "../extension/mp4.js",
  "../extension/net.js",
  "../extension/presets.js",
  "../extension/video.js",
  "../extension/vendor/gifenc.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Share-target launches carry a query string; serve them the cached shell.
  const key = url.pathname.endsWith("/") ? new Request(url.origin + url.pathname) : e.request;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Don't let a 404 or 500 (say, mid-deploy) replace the offline copy.
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key)),
  );
});
