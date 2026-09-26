// Only the offline page is cached. Never cache auth, room state, or answers.
const CACHE = "mindmatch-offline-v1";
self.addEventListener("install", (e) =>
  e.waitUntil(caches.open(CACHE).then((c) => c.add("/offline.html"))),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("mindmatch-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (e) => {
  if (
    e.request.mode === "navigate" &&
    new URL(e.request.url).origin === self.location.origin
  ) {
    e.respondWith(fetch(e.request).catch(() => caches.match("/offline.html")));
  }
});
