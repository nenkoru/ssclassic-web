//! se1-server: native companion server for the web build.
//!
//! Now: a "virtual LAN switch" for browser multiplayer (the approach nfsu2-web uses). Each browser
//! opens one WebSocket, joins a room, and gets a virtual IPv4 address (10.77.0.x; the host is always
//! 10.77.0.1). The engine's UDP sockets are emulated in the browser (port/common/NetLan.c) and every
//! packet goes through this switch, which only forwards it to the peer with the destination address.
//! The game's own client/server logic runs in the browsers; there is no game server here.
//!
//!   se1-server [--port 9002]
//!   ws://<host>:9002/?room=<name>[&host=1]
//!
//! Control messages (JSON text frames, server -> client):
//!   {"type":"welcome","id":N,"ip":"10.77.0.K","peers":[{"id":..,"ip":".."}]}
//!   {"type":"join","id":N,"ip":".."}   {"type":"leave","id":N}   {"type":"error","message":".."}
//! Packets (binary frames, big-endian):
//!   client -> server  [dst ip u32][src port u16][dst port u16][payload]
//!   server -> client  [src ip u32][src port u16][dst port u16][payload]
//!   dst 10.77.0.255 broadcasts to everyone else in the room (LAN server discovery).
//!
//! Planned (notes/plan.md, notes/nfsu2-tricks.md §7): interest management for large games (only
//! forward what each player needs), static hosting with COOP/COEP, a mod catalog.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::{accept_hdr, Message};

const MAX_PEERS: usize = 128;
const NET: [u8; 3] = [10, 77, 0];
const MAX_PACKET: usize = 8 + 4096;

struct Peer {
    ip: u8, // last octet of 10.77.0.x
    tx: Sender<Message>,
}

#[derive(Default)]
struct Room {
    peers: HashMap<u32, Peer>,
}

type Rooms = Arc<Mutex<HashMap<String, Room>>>;

fn query_param(uri: &str, key: &str) -> Option<String> {
    let q = uri.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| v.to_string())
    })
}

fn ip_str(octet: u8) -> String {
    format!("{}.{}.{}.{octet}", NET[0], NET[1], NET[2])
}

fn text(v: Value) -> Message {
    Message::text(v.to_string())
}

fn handle(stream: TcpStream, rooms: Rooms, id: u32) {
    let _ = stream.set_nodelay(true);
    let mut uri = String::new();
    let ws = accept_hdr(stream, |req: &Request, resp: Response| {
        uri = req.uri().to_string();
        Ok(resp)
    });
    let Ok(mut ws) = ws else { return };
    let Some(room_name) = query_param(&uri, "room").filter(|r| !r.is_empty() && r.len() <= 64) else {
        let _ = ws.send(text(json!({"type":"error","message":"missing ?room="})));
        return;
    };
    let want_host = query_param(&uri, "host").as_deref() == Some("1");
    let (tx, rx): (Sender<Message>, Receiver<Message>) = channel();

    // join the room: the host gets .1, everyone else the lowest free address from .2
    let joined = {
        let mut rooms = rooms.lock().unwrap();
        let room = rooms.entry(room_name.clone()).or_default();
        let taken: Vec<u8> = room.peers.values().map(|p| p.ip).collect();
        let ip = if want_host {
            (!taken.contains(&1)).then_some(1)
        } else if room.peers.len() >= MAX_PEERS {
            None
        } else {
            (2u8..=254).find(|o| !taken.contains(o))
        };
        match ip {
            None => Err(if want_host { "room already has a host" } else { "room is full" }),
            Some(ip) => {
                let peers: Vec<Value> = room.peers.iter().map(|(pid, p)| json!({"id": pid, "ip": ip_str(p.ip)})).collect();
                for p in room.peers.values() {
                    let _ = p.tx.send(text(json!({"type":"join","id":id,"ip":ip_str(ip)})));
                }
                room.peers.insert(id, Peer { ip, tx: tx.clone() });
                Ok((ip, json!({"type":"welcome","id":id,"ip":ip_str(ip),"peers":peers})))
            }
        }
    };
    let my_ip = match joined {
        Err(msg) => {
            let _ = ws.send(text(json!({"type":"error","message":msg})));
            return;
        }
        Ok((ip, welcome)) => {
            if ws.send(text(welcome)).is_err() {
                leave(&rooms, &room_name, id);
                return;
            }
            ip
        }
    };
    println!("room {room_name}: peer {id} joined as {}", ip_str(my_ip));

    // one thread per connection: short read timeouts, and between reads, send what other peers
    // forwarded to us (tungstenite sockets aren't shared across threads)
    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(2)));
    'conn: loop {
        while let Ok(out) = rx.try_recv() {
            if ws.write(out).is_err() {
                break 'conn;
            }
        }
        let _ = ws.flush();
        match ws.read() {
            Ok(Message::Binary(b)) if b.len() >= 8 && b.len() <= MAX_PACKET => {
                // [dst ip][src port][dst port][payload] -> rewrite to [src ip][...] and forward
                if b[0..3] != NET {
                    continue;
                }
                let dst = b[3];
                let mut out = b.to_vec();
                out[0..4].copy_from_slice(&[NET[0], NET[1], NET[2], my_ip]);
                let out = Message::binary(out);
                let rooms = rooms.lock().unwrap();
                if let Some(room) = rooms.get(&room_name) {
                    for (pid, p) in &room.peers {
                        if *pid != id && (dst == 255 || p.ip == dst) {
                            let _ = p.tx.send(out.clone());
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    leave(&rooms, &room_name, id);
    println!("room {room_name}: peer {id} left");
}

fn leave(rooms: &Rooms, room_name: &str, id: u32) {
    let mut rooms = rooms.lock().unwrap();
    if let Some(room) = rooms.get_mut(room_name) {
        room.peers.remove(&id);
        for p in room.peers.values() {
            let _ = p.tx.send(text(json!({"type":"leave","id":id})));
        }
        if room.peers.is_empty() {
            rooms.remove(room_name);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(9002);
    let listener = TcpListener::bind(("0.0.0.0", port)).expect("bind");
    println!("se1-server {}: LAN switch on ws://0.0.0.0:{port}/?room=<name>[&host=1]", env!("CARGO_PKG_VERSION"));
    let rooms: Rooms = Arc::new(Mutex::new(HashMap::new()));
    let mut next_id: u32 = 1;
    for stream in listener.incoming().flatten() {
        let rooms = rooms.clone();
        let id = next_id;
        next_id += 1;
        std::thread::spawn(move || handle(stream, rooms, id));
    }
}
