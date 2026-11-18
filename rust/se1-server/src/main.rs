//! se1-server: native companion server for the web build.
//!
//! Planned (see notes/plan.md, notes/nfsu2-tricks.md §7):
//!   - WebSocket "virtual LAN" relay emulating the engine's UDP sockets (up to 128 players),
//!     with interest management so each client only gets nearby players;
//!   - static hosting of the build with COOP/COEP headers;
//!   - mod catalog / download proxy.
//! Placeholder until the relay is implemented.

fn main() {
    println!("se1-server {}: not implemented yet", env!("CARGO_PKG_VERSION"));
}
