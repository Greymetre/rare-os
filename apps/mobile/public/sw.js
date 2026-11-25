// RCH-8: what makes opening the app with no signal show the app.
//
// The rule is narrow on purpose: **cache the shell, never the data.** The HTML, the script and
// the stylesheet are cached so the app starts in a market with no bars. Nothing from /api/ is
// ever cached, because a cached answer is a stale answer, and a rep shown yesterday's
// outstanding would collect against a number that is wrong. The day's data has one home, and it
// is IndexedDB, where the app put it deliberately and knows how old it is.
const SHELL = 'rare-field-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(['/mobile/', '/mobile/manifest.webmanifest'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  // Never the API, and never the identity server. Those must fail honestly when there is no
  // line, so that the queue knows it is offline instead of being handed an old success.
  if (url.pathname.startsWith('/api/')) return;
  if (!url.pathname.startsWith('/mobile/')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      try {
        const fresh = await fetch(event.request);
        if (fresh.ok) cache.put(event.request, fresh.clone());
        return fresh;
      } catch {
        const held = await cache.match(event.request);
        if (held) return held;
        // A deep link opened with no network still gets the app shell, which then draws from
        // IndexedDB.
        const shell = await cache.match('/mobile/');
        if (shell) return shell;
        throw Error('offline');
      }
    })(),
  );
});
