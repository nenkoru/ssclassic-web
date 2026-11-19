// Browser multiplayer: the page side of the virtual LAN (port/common/NetLan.c, rust/se1-server).
//
//   ?room=<name>&host=1[&level=Levels/KarnakDemo.wld]   host a network game in that room
//   ?room=<name>                                         join the room's host
//   &net=ws://<server>:9002                              LAN switch (default: this page's host, port 9002)
//
// The engine's UDP socket is virtual: packets go through two byte rings in wasm memory. This
// script (on the page's main thread, which owns the WebSocket; the engine may run in a worker)
// sends what the engine wrote to the outbound ring and writes received packets into the inbound
// ring. Engine start waits until the switch has assigned this browser its virtual IP (10.77.0.x).
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this script too
  var q = new URLSearchParams(location.search);
  var room = q.get('room');
  if (!room) return;
  var host = q.get('host') === '1';
  var server = q.get('net') || ('ws://' + (location.hostname || '127.0.0.1') + ':9002');
  var RING = 1 << 20, HOST_IP = '10.77.0.1';
  var N = Module.se1Net = { room: room, host: host, ip: null, ws: null, sent: 0, recv: 0, dropped: 0, peers: {}, error: null };

  // engine command line: host a network game, or join the room's host
  var level = q.get('level') || 'Levels/01_Hatshepsut.wld';
  Module['arguments'] = (Module['arguments'] || []).concat(host ? ['+server', '+level', level] : ['+connect', HOST_IP, '+quickjoin']);

  function ipNum(s) { var p = s.split('.').map(Number); return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; }

  Module['preRun'] = (Module['preRun'] || []).concat([function () {
    addRunDependency('se1net');
    var ws = N.ws = new WebSocket(server + '/?room=' + encodeURIComponent(room) + (host ? '&host=1' : ''));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (e) {
      if (typeof e.data === 'string') {
        var m = JSON.parse(e.data);
        if (m.type === 'welcome') {
          N.ip = m.ip; Module.se1NetIp = ipNum(m.ip);
          m.peers.forEach(function (p) { N.peers[p.id] = p.ip; });
          console.log('se1 net: joined room "' + room + '" as ' + m.ip + (host ? ' (host)' : ''));
          removeRunDependency('se1net');
        } else if (m.type === 'join') { N.peers[m.id] = m.ip; }
        else if (m.type === 'leave') { delete N.peers[m.id]; }
        else if (m.type === 'error') { N.error = m.message; console.error('se1 net: ' + m.message); }
        return;
      }
      inbound(new Uint8Array(e.data));
    };
    ws.onerror = function () { N.error = 'cannot reach the LAN switch at ' + server; console.error('se1 net: ' + N.error); };
    ws.onclose = function () { if (!N.ip) removeRunDependency('se1net'); };   // start anyway (offline)
  }]);

  // rings (wasm memory; shared with the engine worker in the threaded build)
  var ctl = 0, out = 0, inp = 0;
  function ready() {
    if (ctl) return true;
    if (!Module._SE1_NetLan_Ctl || typeof HEAPU8 === 'undefined') return false;
    ctl = Module._SE1_NetLan_Ctl() >> 2; out = Module._SE1_NetLan_Out(); inp = Module._SE1_NetLan_In();
    return true;
  }
  function inbound(pkt) {   // switch frame [src ip][src port][dst port][payload] -> inbound ring
    if (!ready()) return;
    var H = HEAPU8, w = Atomics.load(HEAP32, ctl + 2) >>> 0, r = Atomics.load(HEAP32, ctl + 3) >>> 0, n = pkt.length;
    if (RING - ((w - r) >>> 0) < n + 2) { N.dropped++; return; }
    H[inp + (w & (RING - 1))] = n >> 8; H[inp + ((w + 1) & (RING - 1))] = n & 255;
    for (var k = 0; k < n; k++) H[inp + ((w + 2 + k) & (RING - 1))] = pkt[k];
    Atomics.store(HEAP32, ctl + 2, (w + 2 + n) | 0);
    N.recv++;
  }
  function pump() {         // outbound ring -> switch, as [dst ip][src port][dst port][payload]
    if (!ready() || !N.ws || N.ws.readyState !== 1) return;
    var H = HEAPU8, w = Atomics.load(HEAP32, ctl) >>> 0, r = Atomics.load(HEAP32, ctl + 1) >>> 0;
    while (r !== w) {
      var n = (H[out + (r & (RING - 1))] << 8) | H[out + ((r + 1) & (RING - 1))];
      var pkt = new Uint8Array(n);
      for (var k = 0; k < n; k++) pkt[k] = H[out + ((r + 2 + k) & (RING - 1))];
      N.ws.send(pkt);
      N.sent++;
      r = (r + 2 + n) >>> 0;
    }
    Atomics.store(HEAP32, ctl + 1, r | 0);
  }
  setInterval(pump, 2);
})();
