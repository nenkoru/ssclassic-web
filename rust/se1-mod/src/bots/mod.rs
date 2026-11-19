//! Co-op bots (notes/bots.md): pure logic, no engine calls. The engine wiring comes later.
//! - `nav`: walkable graph from ray casts, A*, smoothing.
//! - `brain`: per-tick decisions, aim and steering behind the `Paths` trait.

pub mod brain;
pub mod nav;
