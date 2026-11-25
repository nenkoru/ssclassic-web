// Browser multiplayer: the page side of the virtual LAN (port/common/NetLan.c, rust/se1-server).
//
//   ?room=<name>&host=1[&level=Levels/KarnakDemo.wld]   host a network game in that room
//   ?room=<name>                                         join the room's host
//   &net=ws://<server>:9002                              LAN switch (default: this page's host, port 9002)
//   &rtc=1                                               enable WebRTC peer-to-peer data channels
//   &ice=stun:stun.l.google.com:19302[,turn:...]         ICE servers (default: none, LAN only)
//
// The engine's UDP socket is virtual: packets go through two byte rings in wasm memory. This
// script (on the page's main thread, which owns the WebSocket; the engine may run in a worker)
// sends what the engine wrote to the outbound ring and writes received packets into the inbound
// ring. Engine start waits until the switch has assigned this browser its virtual IP (10.77.0.x).
//
// With &rtc=1, unicast packets to peers with an open data channel go directly over WebRTC;
// broadcasts and packets to peers without an open channel go through the switch. The switch
// stays the signalling channel ({"type":"signal",...}) and the fallback path.
(function () {
  if (typeof window === 'undefined') return;   // pthread workers load this script too
  var q = new URLSearchParams(location.search);
  var room = q.get('room');
  if (!room) return;
  var host = q.get('host') === '1';
  var server = q.get('net') || ('ws://' + (location.hostname || '127.0.0.1') + ':9002');
  var rtc = q.get('rtc') === '1';
  var rtcDebug = q.get('rtcdebug') === '1';
  var RING = 1 << 20, HOST_IP = '10.77.0.1';
  var N = Module.se1Net = { room: room, host: host, ip: null, ws: null, sent: 0, recv: 0, dropped: 0, peers: {}, error: null };

  // engine command line: host a network game, or join the room's host
  var level = q.get('level') || 'Levels/01_Hatshepsut.wld';
  Module['arguments'] = (Module['arguments'] || []).concat(host ? ['+server', '+level', level] : ['+connect', HOST_IP, '+quickjoin']);

  function ipNum(s) { var p = s.split('.').map(Number); return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; }

  // ---- WebRTC peer links (only when &rtc=1) ----
  var rtcLinks = {};   // peer id -> { pc: RTCPeerConnection, dc: RTCDataChannel, state: string }
  N.rtc = { links: {}, sent: 0, recv: 0 };

  function iceServers() {
    var s = q.get('ice');
    if (!s) return [];
    return s.split(',').map(function (u) { return { urls: u.trim() }; });
  }

  function setLinkState(peerId, state) {
    N.rtc.links[peerId] = state;
    var ip = N.peers[peerId] || '?';
    console.log('se1 net: rtc link to ' + ip + ' ' + state);
  }

  function makePeerConnection(peerId) {
    var pc = new RTCPeerConnection({ iceServers: iceServers() });
    var link = { pc: pc, dc: null, state: 'connecting', iceQ: [] };
    rtcLinks[peerId] = link;
    setLinkState(peerId, 'connecting');
    if (rtcDebug) console.log('se1 net: rtc pc created for peer ' + peerId);

    pc.onicecandidate = function (e) {
      if (e.candidate) {
        if (rtcDebug) console.log('se1 net: rtc ice candidate sent to ' + peerId + ' ' + (e.candidate.candidate || '').slice(0, 40));
        sendSignal(peerId, { ice: e.candidate });
      }
    };
    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      if (rtcDebug) console.log('se1 net: rtc pc state ' + peerId + ' ' + st);
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        closeLink(peerId);
      }
    };

    return link;
  }

  // Wire a data channel (ours or the offerer's, via ondatachannel). Packets arrive in the switch's
  // frame format; the sender address is stamped here from the link, like the switch does, so a
  // peer cannot pretend to be someone else, and sizes are checked the way the switch checks them.
  var MAX_FRAME = 8 + 16384 + 64;   // the engine's biggest packet (CPacket.h), as in rust/se1-server
  function wireChannel(peerId, link, dc) {
    link.dc = dc;
    dc.binaryType = 'arraybuffer';
    if (rtcDebug) console.log('se1 net: rtc dc ready for peer ' + peerId);
    dc.onopen = function () { setLinkState(peerId, 'open'); };
    dc.onclose = function () { setLinkState(peerId, 'closed'); closeLink(peerId); };
    dc.onerror = function () { setLinkState(peerId, 'error'); closeLink(peerId); };
    dc.onmessage = function (e) {
      var pkt = new Uint8Array(e.data), ip = N.peers[peerId];
      if (pkt.length < 8 || pkt.length > MAX_FRAME || !ip) return;
      var src = ipNum(ip);
      pkt[0] = (src >>> 24) & 255; pkt[1] = (src >>> 16) & 255; pkt[2] = (src >>> 8) & 255; pkt[3] = src & 255;
      N.rtc.recv++;
      inbound(pkt, true);
    };
  }
  function makeDataChannel(peerId, link) {
    wireChannel(peerId, link, link.pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 }));
  }

  function closeLink(peerId) {
    var link = rtcLinks[peerId];
    if (!link) return;
    delete rtcLinks[peerId];
    if (link.dc) { try { link.dc.close(); } catch (e) {} }
    if (link.pc) { try { link.pc.close(); } catch (e) {} }
    if (N.rtc.links[peerId] !== 'closed') setLinkState(peerId, 'closed');
  }

  function sendSignal(peerId, data) {
    if (N.ws && N.ws.readyState === 1) {
      N.ws.send(JSON.stringify({ type: 'signal', to: peerId, data: data }));
    }
  }

  function handleSignal(peerId, data) {
    if (rtcDebug) console.log('se1 net: rtc signal from ' + peerId + ' ' + JSON.stringify(Object.keys(data)));
    var link = rtcLinks[peerId];
    if (!link) {
      if (N.id == null) return;
      if (peerId > N.id) {
        // We are the lower id: we offer first
        if (rtcDebug) console.log('se1 net: rtc creating offer for peer ' + peerId);
        link = makePeerConnection(peerId);
        makeDataChannel(peerId, link);
        link.pc.createOffer().then(function (offer) {
          return link.pc.setLocalDescription(offer);
        }).then(function () {
          if (rtcDebug) console.log('se1 net: rtc offer sent to ' + peerId);
          sendSignal(peerId, { sdp: link.pc.localDescription });
        }).catch(function (e) { console.error('se1 net: rtc offer failed', e); });
        return;
      }
      // We are the higher id (answerer): create the connection, no data channel (ondatachannel fires)
      if (rtcDebug) console.log('se1 net: rtc creating answerer pc for peer ' + peerId);
      link = makePeerConnection(peerId);
      link.pc.ondatachannel = function (e) { wireChannel(peerId, link, e.channel); };
      // fall through to SDP handling below
    }
    if (data.ice) {
      if (link.pc.remoteDescription) {
        if (rtcDebug) console.log('se1 net: rtc ice candidate added from ' + peerId);
        link.pc.addIceCandidate(new RTCIceCandidate(data.ice)).catch(function (e) {
          console.error('se1 net: rtc addIceCandidate failed', e);
        });
      } else {
        if (rtcDebug) console.log('se1 net: rtc ice candidate queued from ' + peerId);
        link.iceQ.push(data.ice);   // queue until setRemoteDescription
      }
    }
    if (data.sdp) {
      var sdp = data.sdp;
      if (sdp.type === 'offer') {
        if (rtcDebug) console.log('se1 net: rtc offer received from ' + peerId);
        link.pc.setRemoteDescription(sdp).then(function () {
          // flush queued ICE candidates
          link.iceQ.forEach(function (c) {
            link.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function (e) {
              console.error('se1 net: rtc addIceCandidate failed', e);
            });
          });
          link.iceQ = [];
          return link.pc.createAnswer();
        }).then(function (answer) {
          return link.pc.setLocalDescription(answer);
        }).then(function () {
          if (rtcDebug) console.log('se1 net: rtc answer sent to ' + peerId);
          sendSignal(peerId, { sdp: link.pc.localDescription });
        }).catch(function (e) { console.error('se1 net: rtc answer failed', e); });
      } else if (sdp.type === 'answer') {
        if (rtcDebug) console.log('se1 net: rtc answer received from ' + peerId);
        link.pc.setRemoteDescription(sdp).then(function () {
          link.iceQ.forEach(function (c) {
            link.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function (e) {
              console.error('se1 net: rtc addIceCandidate failed', e);
            });
          });
          link.iceQ = [];
        }).catch(function (e) {
          console.error('se1 net: rtc setRemoteDescription failed', e);
        });
      }
    }
  }

  function onPeerJoin(peerId, ip) {
    if (!rtc || N.id == null) return;
    N.peers[peerId] = ip;
    // Lower id offers; if we are lower, create the connection now.
    if (peerId > N.id) {
      var link = makePeerConnection(peerId);
      makeDataChannel(peerId, link);
      link.pc.createOffer().then(function (offer) {
        return link.pc.setLocalDescription(offer);
      }).then(function () {
        sendSignal(peerId, { sdp: link.pc.localDescription });
      }).catch(function (e) { console.error('se1 net: rtc offer failed', e); });
    }
  }

  function onPeerLeave(peerId) {
    if (rtcLinks[peerId]) closeLink(peerId);
    delete N.peers[peerId];
  }

  // ---- rings (wasm memory; shared with the engine worker in the threaded build) ----
  var ctl = 0, out = 0, inp = 0;
  function ready() {
    if (ctl) return true;
    if (!Module._SE1_NetLan_Ctl || typeof HEAPU8 === 'undefined') return false;
    ctl = Module._SE1_NetLan_Ctl() >> 2; out = Module._SE1_NetLan_Out(); inp = Module._SE1_NetLan_In();
    return true;
  }
  function inbound(pkt, viaRtc) {   // frame [src ip][src port][dst port][payload] -> inbound ring
    if (!ready()) return;
    var H = HEAPU8, w = Atomics.load(HEAP32, ctl + 2) >>> 0, r = Atomics.load(HEAP32, ctl + 3) >>> 0, n = pkt.length;
    if (RING - ((w - r) >>> 0) < n + 2) { N.dropped++; return; }
    H[inp + (w & (RING - 1))] = n >> 8; H[inp + ((w + 1) & (RING - 1))] = n & 255;
    for (var k = 0; k < n; k++) H[inp + ((w + 2 + k) & (RING - 1))] = pkt[k];
    Atomics.store(HEAP32, ctl + 2, (w + 2 + n) | 0);
    N.recv++;
    // count packets per path for tools/mptest.mjs (the switch stamps broadcasts with the sender's
    // address too, so this counts every packet; the name is historical)
    var srcIp = ((pkt[0] << 24) >>> 0) + (pkt[1] << 16) + (pkt[2] << 8) + pkt[3];
    if (srcIp !== ((10 << 24) + (77 << 16) + 255)) {
      if (viaRtc) N.rtc.recvUnicast = (N.rtc.recvUnicast || 0) + 1;
      else N.recvUnicast = (N.recvUnicast || 0) + 1;
    }
  }
  function pump() {         // outbound ring -> switch or data channel, as [dst ip][src port][dst port][payload]
    if (!ready() || !N.ws || N.ws.readyState !== 1) return;
    try {
      var H = HEAPU8, w = Atomics.load(HEAP32, ctl) >>> 0, r = Atomics.load(HEAP32, ctl + 1) >>> 0;
      while (r !== w) {
        var n = (H[out + (r & (RING - 1))] << 8) | H[out + ((r + 1) & (RING - 1))];
        var pkt = new Uint8Array(n);
        for (var k = 0; k < n; k++) pkt[k] = H[out + ((r + 2 + k) & (RING - 1))];
        // Route: unicast to a peer with an open data channel goes over WebRTC; everything else via switch
        var dstIp = ((pkt[0] << 24) >>> 0) + (pkt[1] << 16) + (pkt[2] << 8) + pkt[3];
        var sent = false;
        if (rtc && dstIp !== ((10 << 24) + (77 << 16) + 255)) {   // not broadcast
          for (var pid in rtcLinks) {
            var link = rtcLinks[pid];
            if (link.dc && link.dc.readyState === 'open' && N.peers[pid] && ipNum(N.peers[pid]) === dstIp) {
              // Rewrite frame: [src ip = own ip][src port][dst port][payload]
              var frame = new Uint8Array(n);
              var own = ipNum(N.ip);
              frame[0] = (own >>> 24) & 255; frame[1] = (own >>> 16) & 255; frame[2] = (own >>> 8) & 255; frame[3] = own & 255;
              for (var j = 4; j < n; j++) frame[j] = pkt[j];
              try { link.dc.send(frame); N.rtc.sent++; sent = true; }
              catch (e) {   // a broken channel must not stop the game: drop the link, use the switch
                console.error('se1 net: rtc send to ' + N.peers[pid] + ' failed, back to the switch', e);
                closeLink(pid);
              }
              break;
            }
          }
        }
        if (!sent) {
          N.ws.send(pkt);
          N.sent++;
        }
        r = (r + 2 + n) >>> 0;
      }
      Atomics.store(HEAP32, ctl + 1, r | 0);
    } catch (e) {
      // An error in the RTC path must not stop the pump; fall back to the switch.
      if (!pump._errLogged) { console.error('se1 net: pump error, falling back to switch', e); pump._errLogged = true; }
    }
  }
  setInterval(pump, 2);

  Module['preRun'] = (Module['preRun'] || []).concat([function () {
    addRunDependency('se1net');
    var ws = N.ws = new WebSocket(server + '/?room=' + encodeURIComponent(room) + (host ? '&host=1' : ''));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (e) {
      if (typeof e.data === 'string') {
        var m = JSON.parse(e.data);
        if (m.type === 'welcome') {
          N.ip = m.ip; N.id = m.id; Module.se1NetIp = ipNum(m.ip);
          m.peers.forEach(function (p) {
            N.peers[p.id] = p.ip;
            if (rtc) onPeerJoin(p.id, p.ip);
          });
          console.log('se1 net: joined room "' + room + '" as ' + m.ip + (host ? ' (host)' : ''));
          removeRunDependency('se1net');
        } else if (m.type === 'join') {
          if (rtc) onPeerJoin(m.id, m.ip); else N.peers[m.id] = m.ip;
        }
        else if (m.type === 'leave') { onPeerLeave(m.id); }
        else if (m.type === 'signal') {
          if (rtc) handleSignal(m.from, m.data);
        }
        else if (m.type === 'error') { N.error = m.message; console.error('se1 net: ' + m.message); }
        return;
      }
      inbound(new Uint8Array(e.data));
    };
    ws.onerror = function () { N.error = 'cannot reach the LAN switch at ' + server; console.error('se1 net: ' + N.error); };
    ws.onclose = function () { if (!N.ip) removeRunDependency('se1net'); };   // start anyway (offline)
  }]);
})();
