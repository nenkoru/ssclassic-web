// Cross-origin isolation for static hosts (GitHub Pages and the like) that can't send headers.
// The threaded build needs SharedArrayBuffer, which browsers only allow on cross-origin isolated
// pages (COOP + COEP). This service worker adds those headers to every response it serves;
// port/web/isolate.js registers it and reloads once. Hosts that send the headers themselves
// (tools/devserver.py) never need it.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;   // Chrome quirk
  e.respondWith(fetch(req).then(function (res) {
    if (res.status === 0) return res;           // opaque responses can't be rewrapped
    var h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
