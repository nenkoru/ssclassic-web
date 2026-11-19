// Multiplayer lobby: a page-side overlay to host/join a co-op game (the URL-params side of net.js).
// Creates the #mp button in #bar and the #lobby modal; in-room, it shows live status instead.
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this script too

  // styles for the overlay (injected here so shell.html stays untouched)
  var css =
    '#lobby { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.6); }\n' +
    '#lobby.open { display: flex; }\n' +
    '#lobby .panel { width: 320px; max-width: calc(100vw - 24px); background: #1a1a1a; color: #ddd; border: 1px solid #555;\n' +
    '  border-radius: 8px; padding: 16px; font: 14px/1.5 system-ui, sans-serif; }\n' +
    '#lobby h2 { margin: 0 0 10px; font-size: 16px; color: #ffd75e; }\n' +
    '#lobby label { display: block; margin: 10px 0 3px; font-weight: 600; font-size: 13px; }\n' +
    '#lobby input[type=text], #lobby select { width: 100%; box-sizing: border-box; padding: 6px 8px; background: #111;\n' +
    '  color: #ddd; border: 1px solid #555; border-radius: 5px; font: 14px system-ui, sans-serif; }\n' +
    '#lobby #lobby-error { min-height: 1.2em; margin-top: 4px; color: #e06c5e; font-size: 13px; }\n' +
    '#lobby .row { display: flex; gap: 8px; margin-top: 12px; }\n' +
    '#lobby .row button { flex: 1; font: 600 13px system-ui, sans-serif; color: #ddd; background: rgba(20,20,20,.9);\n' +
    '  border: 1px solid #555; border-radius: 5px; padding: 8px 10px; cursor: pointer; }\n' +
    '#lobby .row button:hover { border-color: #aaa; }\n' +
    '#lobby .row button.primary { border-color: #6b8f2a; color: #ffd75e; }\n' +
    '#lobby .help { margin: 10px 0 0; color: #999; font-size: 12px; }\n' +
    '#lobby .status { margin: 0; font-size: 13px; }\n' +
    '#lobby .status dt { margin-top: 8px; font-weight: 600; color: #999; font-size: 12px; }\n' +
    '#lobby .status dd { margin: 2px 0 0; word-break: break-all; }\n' +
    '#lobby .status dd.err { color: #e06c5e; }';
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  var ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;

  // demo data levels (data/tfe-demo/Levels); net.js's default (01_Hatshepsut) is not in the demo, so KarnakDemo is the default
  var LEVELS = [
    ['Levels/Intro.wld', 'Intro'],
    ['Levels/KarnakDemo.wld', 'Karnak'],
    ['Levels/TechTest.wld', 'Tech Test'],
    ['Levels/Deathmatch/DesertTemple.wld', 'Desert Temple (deathmatch)'],
  ];

  function randRoom() {
    var words = ['sam', 'tomb', 'pylon', 'khop', 'ankh', 'grail', 'cactus', 'serpent'];
    return words[Math.floor(Math.random() * words.length)] + '-' + (1000 + Math.floor(Math.random() * 9000));
  }

  // navigate to the same page, dropping room/host/level and setting the given overrides
  function go(overrides) {
    var q = new URLSearchParams(location.search);
    q.delete('room'); q.delete('host'); q.delete('level');
    Object.keys(overrides).forEach(function (k) { q.set(k, overrides[k]); });
    location.assign(location.pathname + '?' + q.toString());
  }

  // --- #mp button ---
  var bar = document.getElementById('bar');
  var mp = document.createElement('button');
  mp.id = 'mp';
  mp.type = 'button';
  mp.title = 'Multiplayer lobby';
  mp.textContent = 'Multiplayer';
  bar.appendChild(mp);

  function inRoom() { return !!(Module && Module.se1Net); }
  function refreshMpLabel() {
    mp.textContent = inRoom() ? 'Room ' + Module.se1Net.room : 'Multiplayer';
  }

  // --- overlay ---
  var lobby = document.createElement('div');
  lobby.id = 'lobby';
  lobby.innerHTML =
    '<div class="panel">' +
    '  <h2>Multiplayer</h2>' +
    '  <div id="lobby-form" style="display:none">' +
    '    <label for="lobby-room">Room name</label>' +
    '    <input id="lobby-room" type="text" maxlength="32" autocomplete="off">' +
    '    <label for="lobby-level">Level</label>' +
    '    <select id="lobby-level"></select>' +
    '    <div id="lobby-error"></div>' +
    '    <div class="row">' +
    '      <button id="lobby-host" type="button" class="primary">Host game</button>' +
    '      <button id="lobby-join" type="button">Join game</button>' +
    '      <button id="lobby-close" type="button">Close</button>' +
    '    </div>' +
    '    <p class="help">Share the room name with your friend; they press Join. A LAN switch (se1-server) must be running.</p>' +
    '  </div>' +
    '  <div id="lobby-status" style="display:none">' +
    '    <dl class="status">' +
    '      <dt>Room</dt><dd id="lobby-s-room"></dd>' +
    '      <dt>Role</dt><dd id="lobby-s-role"></dd>' +
    '      <dt>IP</dt><dd id="lobby-s-ip"></dd>' +
    '      <dt>Peers</dt><dd id="lobby-s-peers"></dd>' +
    '      <dt>Error</dt><dd id="lobby-s-error" class="err"></dd>' +
    '    </dl>' +
    '    <div class="row">' +
    '      <button id="lobby-copy" type="button">Copy invite link</button>' +
    '      <button id="lobby-leave" type="button">Leave</button>' +
    '      <button id="lobby-close2" type="button">Close</button>' +
    '    </div>' +
    '</div>';
  document.body.appendChild(lobby);

  var form = lobby.querySelector('#lobby-form');
  var statusBox = lobby.querySelector('#lobby-status');
  var roomInput = lobby.querySelector('#lobby-room');
  var levelSel = lobby.querySelector('#lobby-level');
  var errEl = lobby.querySelector('#lobby-error');

  LEVELS.forEach(function (l) {
    var o = document.createElement('option');
    o.value = l[0];
    o.textContent = l[1];
    levelSel.appendChild(o);
  });
  levelSel.value = 'Levels/KarnakDemo.wld';

  function roomValid() {
    var v = roomInput.value;
    if (!ROOM_RE.test(v)) {
      errEl.textContent = 'Room name: 1-32 characters, letters, digits, - or _ only.';
      return false;
    }
    errEl.textContent = '';
    return true;
  }
  roomInput.addEventListener('input', roomValid);

  function updateStatus() {
    var N = Module.se1Net;
    if (!N) return;
    lobby.querySelector('#lobby-s-room').textContent = N.room;
    lobby.querySelector('#lobby-s-role').textContent = N.host ? 'host' : 'client';
    lobby.querySelector('#lobby-s-ip').textContent = N.ip || 'connecting…';
    lobby.querySelector('#lobby-s-peers').textContent = String(Object.keys(N.peers).length);
    lobby.querySelector('#lobby-s-error').textContent = N.error || '';
  }

  var statusTimer = null;
  function open() {
    refreshMpLabel();
    if (inRoom()) {
      form.style.display = 'none';
      statusBox.style.display = '';
      updateStatus();
      statusTimer = setInterval(updateStatus, 500);
    } else {
      statusBox.style.display = 'none';
      form.style.display = '';
      roomInput.value = randRoom();
      roomValid();
      roomInput.focus();
    }
    lobby.classList.add('open');
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function close() {
    lobby.classList.remove('open');
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  }

  mp.addEventListener('click', function () {
    lobby.classList.contains('open') ? close() : open();
  });
  lobby.querySelector('#lobby-close').addEventListener('click', close);
  lobby.querySelector('#lobby-close2').addEventListener('click', close);
  lobby.querySelector('#lobby-host').addEventListener('click', function () {
    if (roomValid()) go({ room: roomInput.value, host: '1', level: levelSel.value });
  });
  lobby.querySelector('#lobby-join').addEventListener('click', function () {
    if (roomValid()) go({ room: roomInput.value });
  });

  // copy the join URL (current URL without host/level)
  function inviteUrl() {
    var q = new URLSearchParams(location.search);
    q.delete('host'); q.delete('level');
    return location.origin + location.pathname + '?' + q.toString();
  }
  lobby.querySelector('#lobby-copy').addEventListener('click', function () {
    var url = inviteUrl();
    function done() {
      var b = this, old = b.textContent;
      b.textContent = 'Copied!';
      setTimeout(function () { b.textContent = old; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done.bind(this), function () { selectFallback(); done.call(this); }.bind(this));
    } else selectFallback();
    function selectFallback() {
      var t = document.createElement('input');
      t.type = 'text'; t.value = url;
      t.style.position = 'fixed'; t.style.left = '-9999px';
      document.body.appendChild(t);
      t.select();
      try { document.execCommand('copy'); } catch (e) { /* no clipboard: user can select manually */ }
      document.body.removeChild(t);
    }
  });
  lobby.querySelector('#lobby-leave').addEventListener('click', function () {
    var q = new URLSearchParams(location.search);
    q.delete('room'); q.delete('host'); q.delete('level');
    location.assign(location.pathname + '?' + q.toString());
  });

  // while open, the overlay keeps keyboard/mouse away from the game
  // (Escape is handled here too: keys typed in the room field never reach the document)
  lobby.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') close(); });
  lobby.addEventListener('keyup', function (e) { e.stopPropagation(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && lobby.classList.contains('open')) close();
  });
})();
