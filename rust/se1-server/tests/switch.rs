//! Integration tests for the se1-server "virtual LAN switch".
//!
//! Each test starts its own `se1-server` binary on a free port and exercises the
//! WebSocket protocol with real tungstenite clients.

use serde_json::Value;
use std::io::Read;
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tungstenite::protocol::WebSocket;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;
type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

const BIN: &str = env!("CARGO_BIN_EXE_se1-server");

/// Kills the server on drop so no process survives a panicking test.
struct Server(Option<Child>);

impl Server {
    fn start(port: u16) -> Self {
        let child = Command::new(BIN)
            .args(["--port", &port.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self(Some(child))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

fn start_server() -> (Server, u16) {
    // Try up to 5 times: pick a port, spawn the server, and verify it's listening.
    // This guards against the rare case where the OS hands the same port to
    // another process between our probe and the server's bind.
    for _ in 0..5 {
        let port = free_port();
        let server = Server::start(port);
        // Poll for up to 2 s to see if the server is actually accepting connections.
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut up = false;
        while Instant::now() < deadline {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                up = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if up {
            return (server, port);
        }
        // Server didn't come up (port likely sniped); kill and retry with a new port.
        drop(server);
    }
    panic!("could not start se1-server on a free port after 5 attempts");
}

fn url(port: u16, room: &str, host: bool) -> String {
    if host {
        format!("ws://127.0.0.1:{port}/?room={room}&host=1")
    } else {
        format!("ws://127.0.0.1:{port}/?room={room}")
    }
}

/// Connect with 50 ms retries for up to 5 s (the server needs a moment to bind).
fn connect(port: u16, room: &str, host: bool) -> Ws {
    let u = url(port, room, host);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match tungstenite::connect(&u) {
            Ok((ws, _)) => return ws,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => panic!("connect to {u} failed: {e}"),
        }
    }
}

fn set_timeout(ws: &mut Ws, ms: u64) {
    if let tungstenite::stream::MaybeTlsStream::Plain(s) = ws.get_ref() {
        s.set_read_timeout(Some(Duration::from_millis(ms))).unwrap();
    }
}

/// Read until a Text frame arrives; panics after ~3 s total.
fn recv_json(ws: &mut Ws) -> Value {
    let deadline = Instant::now() + Duration::from_millis(3000);
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => return serde_json::from_str(&t).unwrap(),
            Ok(Message::Close(_)) => panic!("connection closed while waiting for JSON"),
            Ok(_) => {}
            Err(e) => {
                if is_timeout(&e) {
                    if Instant::now() >= deadline {
                        panic!("timed out waiting for JSON frame");
                    }
                    continue;
                }
                panic!("unexpected error reading JSON frame: {e}");
            }
        }
    }
}

/// Read until a Binary frame arrives; skips Text frames (join/leave, etc.).
fn recv_bin(ws: &mut Ws) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_millis(3000);
    loop {
        match ws.read() {
            Ok(Message::Binary(b)) => return b,
            Ok(Message::Close(_)) => panic!("connection closed while waiting for binary frame"),
            Ok(_) => {}
            Err(e) => {
                if is_timeout(&e) {
                    if Instant::now() >= deadline {
                        panic!("timed out waiting for binary frame");
                    }
                    continue;
                }
                panic!("unexpected error reading binary frame: {e}");
            }
        }
    }
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(
        e,
        tungstenite::Error::Io(ref io)
            if io.kind() == std::io::ErrorKind::WouldBlock
                || io.kind() == std::io::ErrorKind::TimedOut
    )
}

/// Asserts NO Binary frame arrives within `ms` (Text frames are ignored).
fn expect_silence(ws: &mut Ws, ms: u64) {
    set_timeout(ws, ms);
    let deadline = Instant::now() + Duration::from_millis(ms);
    loop {
        match ws.read() {
            Ok(Message::Binary(_)) => panic!("expected silence but got a binary frame"),
            Ok(Message::Close(_)) => panic!("connection closed during silence window"),
            Ok(_) => {}
            Err(e) => {
                if is_timeout(&e) {
                    if Instant::now() >= deadline {
                        return; // silence confirmed
                    }
                    continue;
                }
                panic!("unexpected error during silence window: {e}");
            }
        }
    }
}

fn send_bin(ws: &mut Ws, bytes: &[u8]) {
    ws.send(Message::Binary(bytes.to_vec())).unwrap();
}

fn pkt(dst_octet: u8, src_port: u16, dst_port: u16, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![10, 77, 0, dst_octet];
    v.extend_from_slice(&src_port.to_be_bytes());
    v.extend_from_slice(&dst_port.to_be_bytes());
    v.extend_from_slice(payload);
    v
}

#[test]
fn rejects_missing_room() {
    let (_server, port) = start_server();
    let u = format!("ws://127.0.0.1:{port}/");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ws = loop {
        match tungstenite::connect(&u) {
            Ok((ws, _)) => break ws,
            Err(_) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(e) => panic!("connect failed: {e}"),
        }
    };
    set_timeout(&mut ws, 500);
    let v = recv_json(&mut ws);
    assert_eq!(v["type"], "error");
    assert_eq!(v["message"], "missing ?room=");
}

#[test]
fn host_and_client_addresses() {
    let (server, port) = start_server();
    let mut host = connect(port, "addr-r", true);
    set_timeout(&mut host, 500);
    let w = recv_json(&mut host);
    assert_eq!(w["type"], "welcome");
    assert_eq!(w["ip"], "10.77.0.1");
    assert_eq!(w["peers"], Value::Array(vec![]));
    let host_id = w["id"].as_u64().unwrap();

    let mut a = connect(port, "addr-r", false);
    set_timeout(&mut a, 500);
    let w = recv_json(&mut a);
    assert_eq!(w["type"], "welcome");
    assert_eq!(w["ip"], "10.77.0.2");
    assert_eq!(
        w["peers"],
        serde_json::json!([{"id": host_id, "ip": "10.77.0.1"}])
    );
    let a_id = w["id"].as_u64().unwrap();

    // host is told about the join
    let j = recv_json(&mut host);
    assert_eq!(j["type"], "join");
    assert_eq!(j["id"], serde_json::json!(a_id));
    assert_eq!(j["ip"], "10.77.0.2");

    // second client gets .3 and sees both peers
    let mut b = connect(port, "addr-r", false);
    set_timeout(&mut b, 500);
    let w = recv_json(&mut b);
    assert_eq!(w["type"], "welcome");
    assert_eq!(w["ip"], "10.77.0.3");
    let mut peers = w["peers"].as_array().cloned().unwrap();
    peers.sort_by(|x, y| x["ip"].as_str().unwrap().cmp(y["ip"].as_str().unwrap()));
    assert_eq!(
        peers,
        &[
            serde_json::json!({"id": host_id, "ip": "10.77.0.1"}),
            serde_json::json!({"id": a_id, "ip": "10.77.0.2"})
        ]
    );
    drop(server);
}

#[test]
fn second_host_rejected() {
    let (server, port) = start_server();
    let mut host = connect(port, "two-hosts", true);
    set_timeout(&mut host, 500);
    assert_eq!(recv_json(&mut host)["type"], "welcome");

    let mut second = connect(port, "two-hosts", true);
    set_timeout(&mut second, 500);
    let v = recv_json(&mut second);
    assert_eq!(v["type"], "error");
    assert_eq!(v["message"], "room already has a host");
    drop(server);
}

#[test]
fn unicast_reaches_only_destination() {
    let (server, port) = start_server();
    let mut host = connect(port, "uni-r", true);
    let mut a = connect(port, "uni-r", false);
    let mut b = connect(port, "uni-r", false);
    for ws in [&mut host, &mut a, &mut b] {
        set_timeout(ws, 500);
        assert_eq!(recv_json(ws)["type"], "welcome");
    }

    send_bin(&mut a, &pkt(1, 0x1234, 0x5678, b"hi"));
    let got = recv_bin(&mut host);
    assert_eq!(got, vec![10, 77, 0, 2, 0x12, 0x34, 0x56, 0x78, b'h', b'i']);
    expect_silence(&mut b, 300);
    drop(server);
}

#[test]
fn broadcast_reaches_everyone_else() {
    let (server, port) = start_server();
    let mut host = connect(port, "bc-r", true);
    let mut a = connect(port, "bc-r", false);
    let mut b = connect(port, "bc-r", false);
    for ws in [&mut host, &mut a, &mut b] {
        set_timeout(ws, 500);
        assert_eq!(recv_json(ws)["type"], "welcome");
    }

    send_bin(&mut host, &pkt(255, 0x1111, 0x2222, b"disc"));
    let ga = recv_bin(&mut a);
    let gb = recv_bin(&mut b);
    assert_eq!(ga, vec![10, 77, 0, 1, 0x11, 0x11, 0x22, 0x22, b'd', b'i', b's', b'c']);
    assert_eq!(gb, vec![10, 77, 0, 1, 0x11, 0x11, 0x22, 0x22, b'd', b'i', b's', b'c']);
    expect_silence(&mut host, 300);
    drop(server);
}
#[test]
fn rooms_are_isolated() {
    let (server, port) = start_server();
    let mut hx = connect(port, "iso-x", true);
    let mut cx = connect(port, "iso-x", false);
    let mut cy = connect(port, "iso-y", false);
    for ws in [&mut hx, &mut cx, &mut cy] {
        set_timeout(ws, 500);
        assert_eq!(recv_json(ws)["type"], "welcome");
    }
    // fresh room: the y client must have .2 with no peers — verify via a second y client
    let mut cy2 = connect(port, "iso-y", false);
    set_timeout(&mut cy2, 500);
    let w2 = recv_json(&mut cy2);
    assert_eq!(w2["ip"], "10.77.0.3");
    assert_eq!(w2["peers"].as_array().unwrap().len(), 1);

    // broadcast from x's host reaches the x client, not the y clients
    send_bin(&mut hx, &pkt(255, 0x0101, 0x0202, b"px"));
    let g = recv_bin(&mut cx);
    assert_eq!(g, vec![10, 77, 0, 1, 0x01, 0x01, 0x02, 0x02, b'p', b'x']);
    expect_silence(&mut cy, 300);
    expect_silence(&mut cy2, 300);
    drop(server);
}

#[test]
fn leave_notifies_and_frees_address() {
    let (server, port) = start_server();
    let mut host = connect(port, "leave-r", true);
    let mut a = connect(port, "leave-r", false);
    let mut b = connect(port, "leave-r", false);
    for ws in [&mut host, &mut a, &mut b] {
        set_timeout(ws, 500);
        assert_eq!(recv_json(ws)["type"], "welcome");
    }
    let a_id = {
        // re-derive A's id: it is the id announced in the join message the host got
        // (consumed for a and b; the last join is b, so read b's then a's are gone).
        // Instead, read the leave frame and match against a's known id via welcome.
        // We consumed welcomes, so recover ids: join frames were already read? No —
        // the host read only its own welcome; join frames for a and b are still queued.
        let ja = recv_json(&mut host);
        let jb = recv_json(&mut host);
        assert_eq!(ja["type"], "join");
        assert_eq!(jb["type"], "join");
        ja["id"].clone()
    };

    // close A cleanly
    let _ = a.send(Message::Close(None));
    if let tungstenite::stream::MaybeTlsStream::Plain(s) = a.get_mut() {
        let mut buf = [0u8; 64];
        let _ = s.set_read_timeout(Some(Duration::from_millis(300)));
        loop {
            match s.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    }

    let l = recv_json(&mut host);
    assert_eq!(l["type"], "leave");
    assert_eq!(l["id"], a_id);

    // address .2 is freed: new client C gets it
    let mut c = connect(port, "leave-r", false);
    set_timeout(&mut c, 500);
    let w = recv_json(&mut c);
    assert_eq!(w["type"], "welcome");
    assert_eq!(w["ip"], "10.77.0.2");
    drop(server);
}

#[test]
fn malformed_packets_ignored() {
    let (server, port) = start_server();
    let mut host = connect(port, "mal-r", true);
    let mut a = connect(port, "mal-r", false);
    for ws in [&mut host, &mut a] {
        set_timeout(ws, 500);
        assert_eq!(recv_json(ws)["type"], "welcome");
    }

    // 5-byte packet (< 8) and a packet with a non-10.77.0 dst are dropped silently
    send_bin(&mut a, &[10, 77, 0, 1, 0]);
    send_bin(&mut a, &[192, 168, 0, 1, 0, 1, 0, 2, 7]);
    expect_silence(&mut host, 300);

    // connection is still alive: a valid packet now reaches the host
    send_bin(&mut a, &pkt(1, 0x0a0b, 0x0c0d, b"ok"));
    let g = recv_bin(&mut host);
    assert_eq!(g, vec![10, 77, 0, 2, 0x0a, 0x0b, 0x0c, 0x0d, b'o', b'k']);
    drop(server);
}

fn send_signal(ws: &mut Ws, to: u64, data: Value) {
    ws.send(Message::text(serde_json::to_string(&serde_json::json!({"type":"signal","to":to,"data":data})).unwrap())).unwrap();
}

#[test]
fn signal_relayed_within_room() {
    let (server, port) = start_server();
    let mut host = connect(port, "sig-r", true);
    let mut a = connect(port, "sig-r", false);
    set_timeout(&mut host, 500);
    let hw = recv_json(&mut host);
    assert_eq!(hw["type"], "welcome");
    let host_id = hw["id"].as_u64().unwrap();
    set_timeout(&mut a, 500);
    let aw = recv_json(&mut a);
    assert_eq!(aw["type"], "welcome");
    let jv = recv_json(&mut host);
    let a_id = jv["id"].as_u64().unwrap();
    send_signal(&mut a, host_id, serde_json::json!({"sdp": "offer-1"}));
    let s = recv_json(&mut host);
    assert_eq!(s["type"], "signal");
    assert_eq!(s["from"], a_id);
    assert_eq!(s["data"], serde_json::json!({"sdp": "offer-1"}));
    drop(server);
}

#[test]
fn signal_not_relayed_across_rooms() {
    let (server, port) = start_server();
    let mut hx = connect(port, "sig-x", true);
    let mut cx = connect(port, "sig-x", false);
    let mut cy = connect(port, "sig-y", false);
    for ws in [&mut hx, &mut cx, &mut cy] {
        set_timeout(ws, 500);
        assert_eq!(recv_json(ws)["type"], "welcome");
    }
    // cy's id: a second y client's welcome lists it
    let mut cy2 = connect(port, "sig-y", false);
    set_timeout(&mut cy2, 500);
    let cy_id = recv_json(&mut cy2)["peers"][0]["id"].as_u64().unwrap();

    send_signal(&mut cx, cy_id, serde_json::json!({"sdp": "x->y"}));
    expect_silence(&mut cy, 300);
    drop(server);
}

#[test]
fn signal_to_unknown_peer_dropped() {
    let (server, port) = start_server();
    let mut host = connect(port, "sig-unk", true);
    let mut a = connect(port, "sig-unk", false);
    for ws in [&mut host, &mut a] {
        set_timeout(ws, 500);
        assert_eq!(recv_json(ws)["type"], "welcome");
    }

    // unknown peer id and missing "to": both dropped, no reply, no crash
    send_signal(&mut a, 999, serde_json::json!({"sdp": "nope"}));
    a.send(Message::text(r#"{"type":"signal","data":{}}"#)).unwrap();
    expect_silence(&mut host, 300);

    // sender's connection stays usable
    send_bin(&mut a, &pkt(1, 0x0a0b, 0x0c0d, b"ok"));
    let g = recv_bin(&mut host);
    assert_eq!(g, vec![10, 77, 0, 2, 0x0a, 0x0b, 0x0c, 0x0d, b'o', b'k']);
    drop(server);
}
