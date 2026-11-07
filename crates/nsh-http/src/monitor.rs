//! Network monitoring data model shared with the TypeScript package and `nsh-firebase`.
//! The monitor area owns this file's implementation (ring buffer, per-host/path
//! aggregates, redaction, sampling); the scaffold only fixes the frozen event shape
//! and the observer alias.

use std::sync::Arc;

use serde::Serialize;

/// One finished request attempt. The field names and wire shape are FROZEN:
/// `nsh-firebase` consumes this exact JSON, so keys are camelCase and mirror the
/// TypeScript `NetworkEvent` interface 1:1.
///
/// `ttfb_ms` stays `None` wherever `docs/decision.md` says time-to-first-byte cannot
/// be measured honestly; a number is never invented.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEvent {
    /// Unique id for this attempt.
    pub id: String,
    /// HTTP method, e.g. `GET`.
    pub method: String,
    /// Full request URL.
    pub url: String,
    /// Host component of the URL.
    pub host: String,
    /// Path component of the URL.
    pub path: String,
    /// Response status; `None` when the attempt failed before a response arrived.
    pub status: Option<u16>,
    /// Wall-clock start of the attempt, milliseconds since the Unix epoch.
    pub started_at_ms: u64,
    /// Total elapsed time of the attempt, in milliseconds.
    pub duration_ms: u64,
    /// Time to response headers when honestly measurable, else `None`.
    pub ttfb_ms: Option<u64>,
    /// Request body bytes sent, when known.
    pub request_bytes: Option<u64>,
    /// Response body bytes received, when known.
    pub response_bytes: Option<u64>,
    /// Error message or classification; `None` on success.
    pub error: Option<String>,
    /// What started the request, when attributed; else `None`.
    pub initiator: Option<String>,
}

/// Callback invoked once per finished attempt, registered through the client's
/// observer seam (`HttpClient::builder().observe(..)`).
pub type Observer = Arc<dyn Fn(&NetworkEvent) + Send + Sync>;

/// Placeholder: the monitor area replaces this file's contents with the real
/// `Monitor` (ring buffer, aggregates, redaction, sampling).
#[derive(Debug, Default, Clone)]
pub struct Monitor;
