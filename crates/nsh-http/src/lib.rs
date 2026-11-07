//! An HTTP client for Native Shell Rust apps, built on the engine's own `fetch`
//! (per `docs/decision.md`): typed JSON decoding, timeouts, retries, middleware,
//! token refresh, streaming and network monitoring.

mod auth;
mod client;
mod error;
mod etag;
mod middleware;
mod mock;
mod retry;

// The four module bodies below belong to later areas; they are declared here so
// `lib.rs` is settled once, at scaffold time.
pub mod monitor;
pub mod multipart;
pub mod sse;
pub mod streaming;

/// One-line import for app code: `use nsh_http::prelude::*;`
pub mod prelude {
    pub use crate::monitor::{NetworkEvent, Observer};
}
