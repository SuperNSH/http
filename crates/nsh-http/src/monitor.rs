//! Network monitoring (behavior rows 11-12): the frozen [`NetworkEvent`] wire
//! shape shared with the TypeScript package and `nsh-firebase`, a [`Monitor`]
//! with a ring buffer, per-host/path aggregates, redaction by default and a
//! sampling option, the observer adapter for the client's seam, and a
//! standalone instrumented fetch for callers who skip the client.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use nsh_core::access::parse_url;
use nsh_core::platform::{HttpBody, HttpRequest};
use nsh_core::prelude::HttpResponse;
use serde::Serialize;

use crate::error::Error;

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

/// Which finished attempts a [`Monitor`] keeps.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sampling {
    /// Every attempt (the default).
    All,
    /// One in `n`: the first attempt, then every `n`-th after it. `0` keeps all.
    Every(u32),
    /// A per-attempt draw kept with probability `rate` (clamped to `0.0..=1.0`).
    /// The draw is deterministic, so `0.0` and `1.0` hold exactly in tests.
    Rate(f64),
}

/// Count, error rate and duration percentiles for one host or one path.
#[derive(Debug, Clone, PartialEq)]
pub struct Stats {
    /// Attempts kept by the ring buffer for this host or path.
    pub count: u64,
    /// Of those, the attempts whose event carries an error.
    pub errors: u64,
    /// `errors / count`.
    pub error_rate: f64,
    /// Median `duration_ms`, nearest-rank; `None` with no attempts.
    pub p50_ms: Option<u64>,
    /// 95th-percentile `duration_ms`, nearest-rank; `None` with no attempts.
    pub p95_ms: Option<u64>,
}

/// Builds a [`Monitor`]. Defaults: capacity [`DEFAULT_CAPACITY`], every attempt
/// kept, redaction on.
#[derive(Debug, Clone)]
pub struct MonitorBuilder {
    capacity: usize,
    sampling: Sampling,
    redact: bool,
}

impl MonitorBuilder {
    /// At most this many events are kept; the oldest is evicted first.
    #[must_use]
    pub fn capacity(mut self, capacity: usize) -> Self {
        self.capacity = capacity;
        self
    }

    /// Which attempts are kept ([`Sampling::All`] by default).
    #[must_use]
    pub fn sampling(mut self, sampling: Sampling) -> Self {
        self.sampling = sampling;
        self
    }

    /// `false` records raw URLs and messages; the default (`true`) masks
    /// secret query values and header values first (criterion 8).
    #[must_use]
    pub fn redact(mut self, redact: bool) -> Self {
        self.redact = redact;
        self
    }

    /// Makes the monitor.
    #[must_use]
    pub fn build(self) -> Monitor {
        Monitor {
            core: Mutex::new(Core {
                capacity: self.capacity,
                redact: self.redact,
                ring: VecDeque::with_capacity(self.capacity.min(1024)),
                sampler: Sampler::new(self.sampling),
            })
            .into(),
        }
    }
}

/// One lock guards ring, sampler and config together, so sampling order and
/// eviction stay consistent whoever calls.
#[derive(Debug)]
struct Core {
    capacity: usize,
    redact: bool,
    ring: VecDeque<NetworkEvent>,
    sampler: Sampler,
}

/// The monitor: an observer adapter for the client's seam, aggregates over the
/// retained events, and a standalone instrumented fetch. Clone freely; clones
/// share one ring. Aggregates describe the ring's recent traffic only.
#[derive(Clone, Debug)]
pub struct Monitor {
    core: Arc<Mutex<Core>>,
}

/// The default ring size, one number with the TypeScript package's
/// `DEFAULT_CAPACITY` so both sides keep the same recent traffic.
const DEFAULT_CAPACITY: usize = 200;

impl Default for Monitor {
    fn default() -> Self {
        Self::builder().build()
    }
}

impl Monitor {
    /// Configures a monitor: capacity, sampling, redaction, then `build`.
    pub fn builder() -> MonitorBuilder {
        MonitorBuilder {
            capacity: DEFAULT_CAPACITY,
            sampling: Sampling::All,
            redact: true,
        }
    }

    /// The default monitor: capacity [`DEFAULT_CAPACITY`], all attempts,
    /// redaction on.
    pub fn new() -> Self {
        Self::default()
    }

    /// An observer for the client's seam:
    /// `HttpClient::builder().observe(monitor.observer())`.
    pub fn observer(&self) -> Observer {
        let core = self.core.clone();
        Arc::new(move |event| Self::admit(&core, event))
    }

    /// Records one finished attempt through redaction and sampling — the same
    /// path the observer adapter and [`Monitor::fetch`] take.
    pub fn record(&self, event: &NetworkEvent) {
        Self::admit(&self.core, event);
    }

    /// The retained events, oldest first.
    pub fn events(&self) -> Vec<NetworkEvent> {
        self.lock().ring.iter().cloned().collect()
    }

    /// Aggregates keyed by URL host.
    pub fn host_stats(&self) -> BTreeMap<String, Stats> {
        self.grouped(|event| &event.host)
    }

    /// Aggregates keyed by URL path (no query).
    pub fn path_stats(&self) -> BTreeMap<String, Stats> {
        self.grouped(|event| &event.path)
    }

    /// A standalone instrumented request for callers who do not want the whole
    /// client: NSH's own `fetch` (docs/decision.md), one recorded event per
    /// attempt, `ttfb_ms` `None` (the Rust transport resolves once, at end of
    /// body). Await it inside a component task, like the client's methods.
    pub async fn fetch(&self, request: impl Into<HttpRequest>) -> Result<HttpResponse, Error> {
        let request = request.into();
        let started_at_ms = nsh_core::time::unix_ms();
        let t0 = nsh_core::time::now();
        let outcome = nsh_core::prelude::fetch(request.clone()).await;
        self.record(&fetch_event(&request, &outcome, started_at_ms, t0));
        outcome.map_err(Error::classify)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Core> {
        self.core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn admit(core: &Mutex<Core>, event: &NetworkEvent) {
        let mut core = core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !core.sampler.admits() {
            return;
        }
        let mut event = event.clone();
        if core.redact {
            redact_event(&mut event);
        }
        core.ring.push_back(event);
        while core.ring.len() > core.capacity {
            core.ring.pop_front();
        }
    }

    fn grouped(&self, key: impl Fn(&NetworkEvent) -> &str) -> BTreeMap<String, Stats> {
        let core = self.lock();
        // (count, errors, durations)
        let mut groups: BTreeMap<String, (u64, u64, Vec<u64>)> = BTreeMap::new();
        for event in &core.ring {
            let group = groups.entry(key(event).to_owned()).or_default();
            group.0 += 1;
            if event.error.is_some() {
                group.1 += 1;
            }
            group.2.push(event.duration_ms);
        }
        groups
            .into_iter()
            .map(|(name, (count, errors, mut durations))| {
                durations.sort_unstable();
                (
                    name,
                    Stats {
                        count,
                        errors,
                        error_rate: errors as f64 / count as f64,
                        p50_ms: nearest_rank(&durations, 50.0),
                        p95_ms: nearest_rank(&durations, 95.0),
                    },
                )
            })
            .collect()
    }
}

/// Nearest-rank percentile of a sorted list: `ceil(p/100 * n)`, 1-based.
fn nearest_rank(sorted: &[u64], pct: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (pct / 100.0 * sorted.len() as f64)
        .ceil()
        .clamp(1.0, sorted.len() as f64) as usize;
    Some(sorted[rank - 1])
}

/// The sampling decision and its counter, one per monitor.
#[derive(Debug)]
struct Sampler {
    policy: Sampling,
    seen: u64,
    noise: u64,
}

impl Sampler {
    fn new(policy: Sampling) -> Self {
        Self {
            policy,
            seen: 0,
            noise: 0x9e37_79b9_7f4a_7c15,
        }
    }

    fn admits(&mut self) -> bool {
        self.seen += 1;
        match self.policy {
            Sampling::All => true,
            Sampling::Every(n) => (self.seen - 1).is_multiple_of(u64::from(n.max(1))),
            Sampling::Rate(rate) => self.draw() < rate.clamp(0.0, 1.0),
        }
    }

    /// xorshift64: a deterministic stand-in for a random draw, so rate bounds
    /// (`0.0` never, `1.0` always) hold exactly under test.
    fn draw(&mut self) -> f64 {
        self.noise ^= self.noise << 13;
        self.noise ^= self.noise >> 7;
        self.noise ^= self.noise << 17;
        ((self.noise >> 11) as f64) / ((1_u64 << 53) as f64)
    }
}

/// Ids the monitor stamps on its own fetch events; unique in a process and
/// distinct from the client's `nsh-http-` ids.
static NEXT_MONITOR_ID: AtomicU64 = AtomicU64::new(1);

/// The event one instrumented fetch emits, honest by construction and shaped
/// like the client's: `ttfb_ms` `None` (docs/decision.md), bytes from what the
/// request carried and what came back.
fn fetch_event(
    request: &HttpRequest,
    outcome: &Result<HttpResponse, String>,
    started_at_ms: f64,
    t0: nsh_core::time::Instant,
) -> NetworkEvent {
    let (host, path) = host_and_path(&request.url);
    NetworkEvent {
        id: format!(
            "nsh-monitor-{}",
            NEXT_MONITOR_ID.fetch_add(1, Ordering::Relaxed)
        ),
        method: request.method.clone(),
        url: request.url.clone(),
        host,
        path,
        status: outcome.as_ref().ok().map(|response| response.status()),
        started_at_ms: started_at_ms.max(0.0) as u64,
        duration_ms: nsh_core::time::now().duration_since(t0).as_millis() as u64,
        ttfb_ms: None,
        request_bytes: Some(request_bytes_of(request)),
        response_bytes: outcome
            .as_ref()
            .ok()
            .map(|response| response.body.len() as u64),
        error: outcome
            .as_ref()
            .err()
            .map(|message| Error::classify(message.clone()).to_string()),
        initiator: None,
    }
}

/// Splits a URL into its host and its query-less path, as the client does.
fn host_and_path(url: &str) -> (String, String) {
    parse_url(url).map_or_else(
        || (url.to_owned(), "/".to_owned()),
        |parts| {
            (
                parts.host.clone(),
                parts.path.split('?').next().unwrap_or("/").to_owned(),
            )
        },
    )
}

/// What the request would put on the wire (the 0.4.0 Rust path never streams).
fn request_bytes_of(request: &HttpRequest) -> u64 {
    match &request.body {
        HttpBody::Empty | HttpBody::Stream => 0,
        HttpBody::Bytes(bytes) => bytes.len() as u64,
    }
}

/// The mask a redacted value leaves behind.
const REDACTED: &str = "[redacted]";

/// Query names whose values are secrets, matched normalized: lower-case with
/// `-` and `_` dropped, so `access-token` and `ACCESS_TOKEN` hit too.
const SECRET_QUERY_KEYS: [&str; 21] = [
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "authtoken",
    "auth",
    "authorization",
    "apikey",
    "key",
    "secret",
    "clientsecret",
    "password",
    "passwd",
    "pwd",
    "session",
    "sessionid",
    "jwt",
    "signature",
    "sig",
    "credential",
    "privatekey",
];

/// Header names whose values are secrets, matched as lower-case substrings at
/// name boundaries. Query names live in [`SECRET_QUERY_KEYS`]; this list covers
/// header lines and the header echoes a transport error may carry.
const SECRET_HEADER_NAMES: [&str; 19] = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "api-key",
    "x-api-key",
    "auth-token",
    "x-auth-token",
    "access-token",
    "x-access-token",
    "csrf-token",
    "x-csrf-token",
    "refresh-token",
    "id-token",
    "session-token",
    "x-session-token",
    "token",
    "password",
    "secret",
];

/// Masks the event's free-text fields (criterion 8): query values of secret
/// names in `url` and anywhere they are echoed, and secret header values.
/// Host, path and method are structured and carry no query or header text.
fn redact_event(event: &mut NetworkEvent) {
    event.url = mask_headers(&mask_query(&event.url));
    for field in [&mut event.error, &mut event.initiator] {
        if let Some(text) = field.as_ref() {
            let masked = mask_headers(&mask_query(text));
            if &masked != text {
                *field = Some(masked);
            }
        }
    }
}

/// Lower-cases and drops `-`/`_`, so `Access_Token` and `api-key` normalize.
fn normalize_name(name: &str) -> String {
    name.chars()
        .filter(|c| *c != '-' && *c != '_')
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Masks the values of secret query names; other pairs survive byte-exact.
/// Everything after the first `?` is treated as the query, so an error message
/// that quotes a URL loses any secrets past it.
fn mask_query(text: &str) -> String {
    let Some((base, query)) = text.split_once('?') else {
        return text.to_owned();
    };
    let pairs: Vec<String> = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((name, _)) if SECRET_QUERY_KEYS.contains(&normalize_name(name).as_str()) => {
                format!("{name}={REDACTED}")
            }
            _ => pair.to_owned(),
        })
        .collect();
    format!("{base}?{}", pairs.join("&"))
}

/// Masks header-shaped values in free text. After a sensitive name at a name
/// boundary: an optional closing quote (JSON/Rust-debug echoes), blanks, then
/// `:` or `=` (or `,` when the name was quoted, the tuple-debug shape), blanks,
/// an optional opening quote, and the value up to a stop character.
fn mask_headers(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    // to_ascii_lowercase is byte-length-preserving: `lower` indices index `text`.
    let bytes = lower.as_bytes();
    let is_name_char = |b: u8| b.is_ascii_alphanumeric() || b == b'-' || b == b'_';
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for name in SECRET_HEADER_NAMES {
        let mut from = 0;
        while let Some(at) = lower[from..].find(name) {
            let start = from + at;
            let end = start + name.len();
            from = end;
            let bounded = (start == 0 || !is_name_char(bytes[start - 1]))
                && (end == bytes.len() || !is_name_char(bytes[end]));
            if !bounded {
                continue;
            }
            let mut cursor = end;
            let quoted_name = matches!(bytes.get(cursor), Some(b'"' | b'\''));
            if quoted_name {
                cursor += 1;
            }
            while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
                cursor += 1;
            }
            let separator = bytes.get(cursor).copied();
            let separates =
                matches!(separator, Some(b':' | b'=')) || (quoted_name && separator == Some(b','));
            if !separates {
                continue;
            }
            cursor += 1;
            while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
                cursor += 1;
            }
            let opener = bytes
                .get(cursor)
                .copied()
                .filter(|b| matches!(b, b'"' | b'\'' | b'`'));
            if opener.is_some() {
                cursor += 1;
            }
            let value = cursor;
            // `]` `}` `)` are not stops: the `[redacted]` placeholder must
            // survive re-masking, and quoted values end at their quote.
            while !matches!(
                bytes.get(cursor),
                None | Some(b'\n' | b'\r' | b'"' | b'\'' | b'`' | b',' | b';' | b'&')
            ) {
                cursor += 1;
            }
            if let Some(quote) = opener
                && let Some(closing) = lower[value..].find(quote as char)
            {
                cursor = value + closing;
            }
            if cursor > value {
                spans.push((value, cursor));
            }
        }
    }
    spans.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    let mut out = text.to_owned();
    for (start, end) in merged.iter().rev() {
        out.replace_range(*start..*end, REDACTED);
    }
    out
}
