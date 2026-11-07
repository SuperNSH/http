//! An HTTP client for Native Shell Rust apps, built on the engine's own `fetch`
//! (per `docs/decision.md`): typed JSON decoding, timeouts, retries, middleware,
//! token refresh and network monitoring.

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
    pub use crate::client::{CallOptions, HttpClient, NshTransport};
    pub use crate::error::Error;
    pub use crate::etag::{ConditionalGet, etag_of, max_age_ms};
    pub use crate::middleware::{Middleware, Next, Request, Response};
    pub use crate::mock::MockTransport;
    pub use crate::monitor::{Monitor, MonitorBuilder, NetworkEvent, Observer, Sampling, Stats};
    pub use crate::retry::{RetryPolicy, parse_retry_after};
    pub use crate::{TokenProvider, Transport};
}

pub use crate::auth::TokenProvider;
pub use crate::client::{CallOptions, HttpClient, HttpClientBuilder, NshTransport, Transport};
pub use crate::error::Error;
pub use crate::etag::{ConditionalGet, etag_of, max_age_ms};
pub use crate::middleware::{BoxFuture, Middleware, Next, Request, Response};
pub use crate::mock::MockTransport;
pub use crate::monitor::{Monitor, MonitorBuilder, NetworkEvent, Observer, Sampling, Stats};
pub use crate::retry::{
    RetryPolicy, format_http_date, is_idempotent, parse_http_date, parse_retry_after,
};
