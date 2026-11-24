// Archipelago (multiworld randomizer) client, page side. The game's Rust mod decides what is a
// location check and gives the items; this script only talks to an Archipelago server over a
// WebSocket and relays messages between the server and the mod. Protocol: notes/archipelago.md.
//
// URL options (URLSearchParams(location.search)):
//   ap=host:port, ap=ws://host:port or ap=wss://...   connect to the server. Without a scheme the
//                                                     scheme is wss:// on https pages, else ws://.
//                                                     Sets Module.se1Ap = 1 (the mod reads it as
//                                                     a numeric page option and enables its AP side).
//   slot=<name>            our slot name (default 'Sam')
//   appass=<password>      the slot's password (default '')
//   apscan=1               pickup scan mode: the mod posts "ap_scan" messages; works with or
//                          without ap
//   level=<file.wld>       start that level at once (tests and scans)
// Without ap and apscan this script does nothing.
//
// Message flow:
//   mod -> page: the mod posts JSON strings through Module.se1ModUi. Ours (by "type"):
//     ap_check {locations:[ids]}  we forward a LocationChecks packet to the server
//     ap_sync                      we forward a Sync packet
//     ap_scan  {world, pickups}    we store it in Module.se1ApClient.scans and log it
//   page -> mod: we push JSON strings onto Module.se1ModInbox (the mod pops them each frame):
//     ap_connected {slot, checked, missing}  after Connected
//     ap_items     {index, items}            on ReceivedItems
//
// State for tools and tests: Module.se1ApClient = { state, slot, slotId, team, checked, received,
// sent, errors, scans }.
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this script too
  var q = new URLSearchParams(location.search);
  var ap = q.get('ap'), apscan = q.get('apscan') === '1';
  if (!ap && !apscan) return;
  var slot = q.get('slot') || 'Sam';
  var pass = q.get('appass') || '';
  if (ap) Module.se1Ap = 1;
  if (apscan) Module.se1ApScan = 1;
  // &level=Levels/01_Hatshepsut.wld: start that level at once (tests, scans), as survivors.js does
  if (q.get('level') && !(Module['arguments'] || []).some(function (a) { return a === '+level'; }))
    Module['arguments'] = (Module['arguments'] || []).concat(['+level', q.get('level')]);

  var client = Module.se1ApClient = {
    state: 'connecting', slot: slot, slotId: null, team: null,
    checked: [], received: [], sent: [], errors: [], scans: {}
  };
  Module.se1ModInbox = Module.se1ModInbox || [];
  function inbox(obj) { Module.se1ModInbox.push(JSON.stringify(obj)); }

  // ---- our uuid: stable across sessions (localStorage), random hex otherwise
  function randHex(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
    return s;
  }
  var uuid = randHex(32);
  try {
    var stored = localStorage.getItem('se1ApUuid');
    if (stored) uuid = stored;
    else localStorage.setItem('se1ApUuid', uuid);
  } catch (e) {}

  // ---- websocket
  var ws = null, refused = false, reconnects = 0, MAX_RECONNECTS = 20;
  var queuedChecks = [];
  var wsUrl = !ap ? null : ap.indexOf('://') !== -1 ? ap : (location.protocol === 'https:' ? 'wss://' : 'ws://') + ap;

  function send(packets) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(packets));
  }
  Module.se1ApSend = send;

  function onMessage(ev) {
    var ps;
    try { ps = JSON.parse(ev.data); } catch (e) { return; }
    if (!ps) return;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      switch (p.cmd) {
        case 'RoomInfo':
          var v = (p.version && p.version.class === 'Version')
            ? { major: p.version.major, minor: p.version.minor, build: p.version.build, class: 'Version' }
            : { major: 0, minor: 6, build: 0, class: 'Version' };
          send([{ cmd: 'Connect', password: pass, game: 'Serious Sam TFE', name: slot, uuid: uuid,
                  version: v, items_handling: 7, tags: [], slot_data: true }]);
          break;
        case 'Connected':
          client.state = 'connected';
          client.slotId = p.slot;
          client.team = p.team;
          client.checked = p.checked_locations || [];
          reconnects = 0;
          inbox({ type: 'ap_connected', slot: p.slot, checked: client.checked,
                  missing: p.missing_locations || [] });
          for (var j = 0; j < queuedChecks.length; j++) {
            send([{ cmd: 'LocationChecks', locations: queuedChecks[j] }]);
          }
          queuedChecks = [];
          console.log('[ap] connected as ' + slot + ' (slot ' + p.slot + '), ' +
            (p.missing_locations || []).length + ' locations left');
          break;
        case 'ConnectionRefused':
          refused = true;
          client.state = 'refused';
          client.errors = p.errors || [];
          console.warn('[ap] refused: ' + client.errors);
          break;
        case 'ReceivedItems':
          if (p.index === 0) client.received = [];
          var got = (p.items || []).map(function (it) { return it.item; });
          var ids = got.join(', ');
          client.received = client.received.concat(got);
          inbox({ type: 'ap_items', index: p.index, items: p.items || [] });
          console.log('[ap] received ' + (p.items || []).length + ' item(s) at index ' + p.index + ': ' + ids);
          break;
        case 'RoomUpdate':
          if (p.checked_locations) {
            for (var k = 0; k < p.checked_locations.length; k++) {
              if (client.checked.indexOf(p.checked_locations[k]) === -1) client.checked.push(p.checked_locations[k]);
            }
          }
          break;
        case 'PrintJSON':
          console.log('[ap] ' + (p.data || []).map(function (d) { return d.text || ''; }).join(''));
          break;
        default:
          break;   // ignore
      }
    }
  }

  function connect() {
    client.state = 'connecting';
    ws = new WebSocket(wsUrl);
    ws.onopen = function () { console.log('[ap] connected to ' + wsUrl); };
    ws.onmessage = onMessage;
    ws.onerror = function () { console.warn('[ap] websocket error'); };
    ws.onclose = function () {
      if (refused) return;
      client.state = 'closed';
      console.warn('[ap] connection closed');
      if (reconnects < MAX_RECONNECTS) {
        reconnects++;
        setTimeout(connect, 3000);
      }
    };
  }

  // ---- mod -> page: wrap Module.se1ModUi (playtest.js wraps it too; both call each other's inner)
  var inner = Module.se1ModUi;
  Module.se1ModUi = function (json) {
    var m = null;
    try { m = JSON.parse(json); } catch (e) {}
    if (m && (m.type === 'ap_check' || m.type === 'ap_sync' || m.type === 'ap_scan')) {
      if (m.type === 'ap_check') {
        var ids = m.locations || [];
        client.sent.push(ids);
        if (client.state === 'connected') send([{ cmd: 'LocationChecks', locations: ids }]);
        else queuedChecks.push(ids);
        console.log('[ap] check sent ' + JSON.stringify(ids));
      } else if (m.type === 'ap_sync') {
        if (client.state === 'connected') send([{ cmd: 'Sync' }]);
      } else if (m.type === 'ap_scan') {
        client.scans[m.world] = m;
        console.log('[ap-scan] ' + json);
      }
      return;
    }
    if (inner) inner(json);
  };

  if (ap) connect();
})();
