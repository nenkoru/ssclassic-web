// SE1_THREADS build only (first --pre-js): the engine runs in a worker and shares memory with the
// page, which needs a cross-origin isolated page. If the server didn't send COOP/COEP, install
// coi-sw.js (it adds them) and reload once, before the runtime tries to create shared memory.
(function () {
  var KEY = 'se1-coi-reload';
  if (typeof window === 'undefined') return;        // pthread workers load this script too
  if (window.crossOriginIsolated) { try { sessionStorage.removeItem(KEY); } catch (e) {} return; }
  var fail = function (why) {
    var msg = 'Serious Sam (threaded build) needs a cross-origin isolated page: ' + why +
              '. Serve it with COOP/COEP headers (tools/devserver.py does) or over HTTPS.';
    console.error(msg);
    if (document.body) {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:auto 0 0 0;padding:12px;background:#300;color:#fff;font:14px sans-serif;z-index:9';
      d.textContent = msg;
      document.body.appendChild(d);
    }
  };
  var tried = false;
  try { tried = sessionStorage.getItem(KEY) === '1'; } catch (e) {}
  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    fail('service workers are unavailable here');
  } else if (tried) {
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    fail('the isolation service worker did not take effect');
  } else {
    try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
    var swUrl = new URL('coi-sw.js', document.currentScript ? document.currentScript.src : location.href);
    navigator.serviceWorker.register(swUrl.href).then(function (reg) {
      var reload = function () { location.reload(); };
      if (navigator.serviceWorker.controller) reload();
      else navigator.serviceWorker.addEventListener('controllerchange', reload);
      if (reg.active && !navigator.serviceWorker.controller) reload();
    }, function (e) { fail('service worker registration failed (' + e + ')'); });
  }
  // stop this script here: without isolation the runtime can't start
  throw new Error('se1: waiting for cross-origin isolation (reloading)');
})();
