# Multiplayer (virtual LAN)

Browsers play together the way nfsu2-web does it: each browser opens one WebSocket to a small
**LAN switch** (`rust/se1-server`). The switch gives every browser a virtual IPv4 address in the room
(10.77.0.x; the host is always 10.77.0.1) and forwards packets between them. The engine's own
client/server netcode runs unchanged in the browsers. There's no game server; the switch only
routes packets.

## Play

1. Start the switch: `cd rust && cargo run -p se1-server --release` (listens on ws://0.0.0.0:9002).
2. Host: open `http://<host>:8094/serioussam.html?room=myroom&host=1&level=Levels/KarnakDemo.wld`.
   - The host starts `+server +level <level>`.
   - The default level is `Levels/01_Hatshepsut.wld` (full game).
3. Players: open `http://<host>:8094/serioussam.html?room=myroom` (2–4 players for co-op).
   - They join 10.77.0.1 with `+connect … +quickjoin`.
4. Optional: `&net=ws://<switch>:9002` if the switch runs elsewhere.
   - The default is this page's host, port 9002.

The page must be served over HTTPS or from localhost, with COOP/COEP (threaded build). For other
machines on the LAN, see the hosting item in notes/roadmap.md.

## How it works

- `port/common/NetLan.c` wraps the engine's socket calls at link time (`--wrap=socket,bind,sendto,
  recvfrom,fcntl,close,gethostname,gethostbyname`).
  - A UDP socket becomes virtual. `sendto` appends `[dst ip][src port][dst port][payload]` to an
    outbound byte ring in wasm memory; `recvfrom` reads the inbound ring.
  - Nothing blocks or proxies to the main thread, so the threaded build's engine worker never waits.
- `port/web/net.js`, on the page's main thread, owns the WebSocket.
  - It sends the outbound ring every ~2 ms and writes received packets into the inbound ring.
  - The engine starts only after the switch has assigned this browser its address.
- The switch rewrites the first header field to the sender's address and forwards the packet to the
  owner of the destination address. 10.77.0.255 broadcasts, for LAN server discovery.
- Web-port fixes the engine needed:
  - `SE1_ApplyWebStartup` picks a connection preset (5mb-Fiber); otherwise a fresh visit stops at
    "choose your connection".
  - SeriousSam.cpp makes each browser's player profiles unique (GUID and default name "Sam <n>"):
    every fresh browser has the same default profile, and the host refused the duplicate.

## Test

`node tools/mptest.mjs http://127.0.0.1:8094/serioussam.html Levels/KarnakDemo.wld`

It starts the switch and two headless browsers (host and client), then checks addresses, packets in
both directions and that the client keeps running. It saves both screenshots, which show the shared
scoreboard ("Sam 1", "Sam 2"). `SE1_MPLOG=1500` prints the engine log tails on failure
(single-threaded build).

## Next

- Lobby UI: create/join rooms from the menu instead of URL parameters.
- Interest management in the switch for large games (the 128-player goal).
- WebRTC peer-to-peer as an optional lower-latency path; the switch would stay the fallback and the
  signalling channel.
