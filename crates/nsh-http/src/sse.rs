//! Server-sent events with reconnect and `Last-Event-ID` (behavior row 14).
//!
//! Honest limits on 0.4.0 (docs/decision.md, experiment 2): the Rust transport
//! resolves a request once, when the whole body has arrived — so events are
//! parsed when the server closes the stream, not one by one as they are sent.
//! Reconnect (with backoff) and the `Last-Event-ID` header still work exactly
//! as the spec says, because they are the client's own behavior across
//! connections. The TSX client has the incremental path.
//!
//! Cancellation is structured: [`EventSource::listen`] is the loop — it spawns
//! nothing — so dropping it stops everything (the in-flight request is dropped
//! with it), and a [`CancelToken`] stops it cleanly at the next step boundary
//! with no lost wakeup: the token's check and waker registration happen under
//! one lock acquisition.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};
use std::time::Duration;

use nsh_core::prelude::timer;

use crate::client::{CallOptions, HttpClient};
use crate::error::Error;

/// One server-sent event, after parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// The event's `id:` line, when it (or an earlier event's) carried one.
    /// Reconnects send it back as `Last-Event-ID`.
    pub id: Option<String>,
    /// The `event:` field; `message` when the server sent none.
    pub event: String,
    /// The `data:` lines joined with `\n`.
    pub data: String,
    /// The event's `retry:` field, when it carried a valid one: the server's
    /// wish for the next reconnect delay.
    pub retry: Option<Duration>,
}

/// The incremental SSE parser (the WHATWG `text/event-stream` format).
/// Feed it whatever bytes arrived; it gives back the events completed by a
/// blank line. Handles `id:`, `event:`, `data:` (multi-line), `retry:`,
/// comments (`:`-prefixed), unknown fields, CRLF/CR/LF endings, a leading
/// UTF-8 BOM and UTF-8 characters split across feeds. A trailing line
/// without its terminator stays buffered: per the spec it dispatches only
/// when its blank line arrives.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    data: Vec<String>,
    event: Option<String>,
    retry: Option<Duration>,
    last_id: Option<String>,
    saw_bytes: bool,
}

impl SseParser {
    /// An empty parser.
    pub fn new() -> Self {
        Self::default()
    }

    /// The last `id:` the stream named (the reconnect's `Last-Event-ID`).
    pub fn last_id(&self) -> Option<&str> {
        self.last_id.as_deref()
    }

    /// Feeds `bytes` and gives every event they completed, in order.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.buffer.extend_from_slice(bytes);
        if !self.saw_bytes {
            if self.buffer.starts_with(&[0xEF, 0xBB, 0xBF]) {
                self.buffer.drain(..3);
            }
            self.saw_bytes = !self.buffer.is_empty();
        }
        let mut events = Vec::new();
        while let Some((line_end, consumed)) = next_line(&self.buffer) {
            let line = self.buffer[..line_end].to_vec();
            self.buffer.drain(..consumed);
            if let Some(event) = self.process(&line) {
                events.push(event);
            }
        }
        events
    }

    /// One complete line: `Some(event)` when it was the blank line that
    /// dispatched one, `None` otherwise.
    fn process(&mut self, line: &[u8]) -> Option<SseEvent> {
        let line = String::from_utf8_lossy(line).into_owned();
        if line.is_empty() {
            return self.dispatch();
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (&line[..], ""),
        };
        match field {
            "event" => self.event = Some(value.to_owned()),
            "data" => self.data.push(value.to_owned()),
            "id" if !value.contains('\0') => self.last_id = Some(value.to_owned()),
            "retry" => {
                if let Ok(ms) = value.parse::<u64>() {
                    self.retry = Some(Duration::from_millis(ms));
                }
            }
            _ => {}
        }
        None
    }

    /// The blank line: an event with data dispatches, an empty one only resets.
    fn dispatch(&mut self) -> Option<SseEvent> {
        let data = self.data.join("\n");
        let event = (!data.is_empty()).then(|| SseEvent {
            id: self.last_id.clone(),
            event: self.event.take().unwrap_or_else(|| "message".to_owned()),
            data,
            retry: self.retry.take(),
        });
        self.data.clear();
        self.event = None;
        self.retry = None;
        event
    }
}

/// Finds one line at the front of `buffer`, honoring `\n`, `\r` and `\r\n`:
/// `(line end index, bytes consumed)`, or `None` when no complete line is in.
fn next_line(buffer: &[u8]) -> Option<(usize, usize)> {
    let end = buffer
        .iter()
        .position(|byte| *byte == b'\n' || *byte == b'\r')?;
    let skip = if buffer[end] == b'\r' && buffer.get(end + 1) == Some(&b'\n') {
        2
    } else {
        1
    };
    Some((end, end + skip))
}

/// Stops an [`EventSource`] from anywhere, any thread. The loop checks it
/// before every step and races every wait against it, so a cancel lands at
/// the next boundary — mid-request it drops the request, mid-backoff it ends
/// the wait — with no orphan work after it.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<CancelState>);

#[derive(Debug, Default)]
struct CancelState {
    cancelled: AtomicBool,
    // One waiter at a time: the listen loop is linear. Check + store happen
    // under this one lock, so a cancel either lands before the check or takes
    // the stored waker — it can never fall between them.
    waiter: Mutex<Option<Waker>>,
}

impl CancelToken {
    /// A token nobody cancelled.
    pub fn new() -> Self {
        Self::default()
    }

    /// Cancels: wakes a waiting loop, if any.
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        let waker = self
            .0
            .waiter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// Whether [`CancelToken::cancel`] has run.
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// A future resolving at the next cancel (immediately, if already
    /// cancelled). Dropping it releases the token for the next waiter.
    pub fn wait(&self) -> Cancelled<'_> {
        Cancelled {
            token: self,
            registered: None,
        }
    }
}

/// The future [`CancelToken::wait`] hands out.
pub struct Cancelled<'a> {
    token: &'a CancelToken,
    registered: Option<Waker>,
}

impl Future for Cancelled<'_> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<()> {
        let this = Pin::into_inner(self);
        if this.token.is_cancelled() {
            return Poll::Ready(());
        }
        let mut waiter = this
            .token
            .0
            .waiter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if this.token.is_cancelled() {
            return Poll::Ready(());
        }
        let waker = cx.waker().clone();
        *waiter = Some(waker.clone());
        this.registered = Some(waker);
        Poll::Pending
    }
}

impl Drop for Cancelled<'_> {
    fn drop(&mut self) {
        let Some(registered) = self.registered.take() else {
            return;
        };
        let mut waiter = self
            .token
            .0
            .waiter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Only our own registration: a later waiter's stays put.
        if waiter
            .as_ref()
            .is_some_and(|held| held.will_wake(&registered))
        {
            *waiter = None;
        }
    }
}

/// Resolves with `Some(out)` when `fut` finishes first, `None` when the token
/// cancels first — dropping `fut` mid-await, which for a client request is
/// the cancellation (see `HttpClient`). Both branches are owned, poll-only
/// futures, so racing them loses nothing. `fut` is boxed: a cancel stops it
/// at the next step boundary, and no branch is ever polled behind a lock.
struct Race<'a, F: Future> {
    fut: Pin<Box<F>>,
    cancelled: Cancelled<'a>,
}

impl<F: Future> Future for Race<'_, F> {
    type Output = Option<F::Output>;

    fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<Self::Output> {
        let this = Pin::into_inner(self);
        if this.cancelled.token.is_cancelled() {
            return Poll::Ready(None);
        }
        if let Poll::Ready(out) = this.fut.as_mut().poll(cx) {
            return Poll::Ready(Some(out));
        }
        // The registration inside `cancelled` is its own check+store under the
        // token's lock; poll it once to arm the wake for this step.
        if Poll::Ready(()) == Pin::new(&mut this.cancelled).poll(cx) {
            return Poll::Ready(None);
        }
        Poll::Pending
    }
}

/// Races `fut` against `token`: `None` means cancelled.
fn until_cancelled<'a, F: Future>(fut: F, token: &'a CancelToken) -> Race<'a, F> {
    Race {
        fut: Box::pin(fut),
        cancelled: token.wait(),
    }
}

/// The reconnect delays: exponential with a cap, until the server names one
/// with an event's `retry:` field (which then holds steady, per the spec).
#[derive(Debug, Clone, PartialEq)]
pub struct SseBackoff {
    initial: Duration,
    max: Duration,
    factor: f64,
}

impl Default for SseBackoff {
    fn default() -> Self {
        Self {
            initial: Duration::from_millis(1_000),
            max: Duration::from_millis(30_000),
            factor: 2.0,
        }
    }
}

impl SseBackoff {
    /// Backoff starting at `initial`, doubling to `max`.
    pub fn new(initial: Duration) -> Self {
        Self {
            initial,
            ..Self::default()
        }
    }

    /// Caps the growth.
    #[must_use]
    pub fn with_max(mut self, max: Duration) -> Self {
        self.max = max;
        self
    }

    /// Sets the growth factor per failed attempt.
    #[must_use]
    pub fn with_factor(mut self, factor: f64) -> Self {
        self.factor = factor;
        self
    }

    /// The wait before reconnect number `failure` (1 = the first failure),
    /// overridden by the server's `retry`.
    fn delay(&self, failure: u32, server_retry: Option<Duration>) -> Duration {
        if let Some(retry) = server_retry {
            return retry;
        }
        let grown = self
            .initial
            .mul_f64(self.factor.powi(failure.saturating_sub(1) as i32));
        grown.min(self.max)
    }
}

/// A live SSE connection's source: a client, a path on it, and the reconnect
/// policy. `listen` runs the whole connect → parse → (close) → backoff →
/// reconnect-with-`Last-Event-ID` loop as one future.
///
/// Build the client for it with `.without_timeout()` — a deadline races the
/// whole request on 0.4.0 (there is no headers-only phase to time out), so a
/// client timeout would cut off a quiet stream — and with
/// `RetryPolicy::off()`: reconnecting is this type's job, and the client's
/// retries would run beside it.
pub struct EventSource {
    client: HttpClient,
    path: String,
    headers: Vec<(String, String)>,
    token: CancelToken,
    backoff: SseBackoff,
    max_attempts: u32,
}

impl EventSource {
    /// A source on `path` (joined to the client's base URL), reconnecting
    /// with the default backoff and no bound on failed connects.
    pub fn new(client: HttpClient, path: impl Into<String>) -> Self {
        Self {
            client,
            path: path.into(),
            headers: Vec::new(),
            token: CancelToken::new(),
            backoff: SseBackoff::default(),
            max_attempts: u32::MAX,
        }
    }

    /// A header on every connect (a reconnect's `Last-Event-ID` is added on
    /// its own, after the last event's `id`).
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// The token this source honors, so several streams stop together.
    /// `token()` gives the source's own when none is shared.
    #[must_use]
    pub fn with_token(mut self, token: CancelToken) -> Self {
        self.token = token;
        self
    }

    /// The reconnect delays.
    #[must_use]
    pub fn with_backoff(mut self, backoff: SseBackoff) -> Self {
        self.backoff = backoff;
        self
    }

    /// Gives up after `max_attempts` consecutive failed connects, with the
    /// last error. The default never gives up (an `EventSource`'s semantics).
    #[must_use]
    pub fn with_max_attempts(mut self, max_attempts: u32) -> Self {
        self.max_attempts = max_attempts;
        self
    }

    /// This source's cancel token, for stopping it from elsewhere.
    pub fn token(&self) -> CancelToken {
        self.token.clone()
    }

    /// Connects, delivers every event to `on_event` in arrival order, and
    /// keeps reconnecting — `Last-Event-ID` carrying the last seen `id`,
    /// waiting [`SseBackoff`] (or the server's `retry:`) between connects —
    /// until [`CancelToken::cancel`] (`Ok(())`), a non-2xx connect, a body
    /// whose content type is not `text/event-stream`, or `max_attempts`
    /// consecutive failed connects (the `Err`).
    ///
    /// Cancellation: dropping this future stops everything (it spawns
    /// nothing); the token stops it cleanly at the next step boundary.
    pub async fn listen(self, mut on_event: impl FnMut(SseEvent)) -> Result<(), Error> {
        let mut last_id: Option<String> = None;
        let mut server_retry: Option<Duration> = None;
        let mut failures = 0_u32;
        loop {
            if self.token.is_cancelled() {
                return Ok(());
            }
            let mut options = CallOptions::new();
            for (name, value) in &self.headers {
                options = options.header(name, value);
            }
            if let Some(id) = &last_id {
                options = options.header("last-event-id", id);
            }
            let outcome = until_cancelled(
                self.client.execute("GET", &self.path, &options),
                &self.token,
            )
            .await;
            let response = match outcome {
                None => return Ok(()),
                // A non-2xx is the server refusing SSE: it ends the source,
                // with the client pipeline's status error.
                Some(Err(status @ Error::HttpStatus { .. })) => return Err(status),
                Some(Err(error)) => {
                    failures += 1;
                    if failures >= self.max_attempts {
                        return Err(error);
                    }
                    let delay = self.backoff.delay(failures, server_retry);
                    if until_cancelled(timer(delay), &self.token).await.is_none() {
                        return Ok(());
                    }
                    continue;
                }
                Some(Ok(response)) => response,
            };
            if !response
                .header("content-type")
                .is_some_and(|value| value.contains("text/event-stream"))
            {
                return Err(Error::Network {
                    message: format!(
                        "the SSE connect answered {} without a text/event-stream body",
                        response.status()
                    ),
                });
            }
            failures = 0;
            let mut parser = SseParser::new();
            for event in parser.feed(&response.body) {
                if let Some(retry) = event.retry {
                    server_retry = Some(retry);
                }
                if let Some(id) = &event.id {
                    last_id = Some(id.clone());
                }
                on_event(event);
            }
            // The server closed the body: back off and reconnect.
            let delay = self.backoff.delay(1, server_retry);
            if until_cancelled(timer(delay), &self.token).await.is_none() {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two `data:` lines join with a newline; `id`/`event`/`retry` land on
    /// the event; `last_id` survives into the next event's `id`.
    #[test]
    fn id_event_data_and_retry_lines_build_events() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"id: 7\nevent: tick\ndata: one\ndata: two\nretry: 2500\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id.as_deref(), Some("7"));
        assert_eq!(events[0].event, "tick");
        assert_eq!(events[0].data, "one\ntwo");
        assert_eq!(events[0].retry, Some(Duration::from_millis(2_500)));
        assert_eq!(parser.last_id(), Some("7"));
        let later = parser.feed(b"data: next\n\n");
        assert_eq!(later[0].id.as_deref(), Some("7"), "the id persists");
        assert_eq!(later[0].event, "message", "the type resets per event");
        assert_eq!(later[0].retry, None, "retry resets per event");
    }

    #[test]
    fn crlf_and_cr_line_endings_all_parse() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"data: a\r\ndata: b\rdata: c\r\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "a\nb\nc");
    }

    /// A blank line with no data dispatches nothing but clears the block, and
    /// comments and unknown fields are ignored.
    #[test]
    fn comments_unknown_fields_and_empty_events_stay_out() {
        let mut parser = SseParser::new();
        assert!(parser.feed(b": keep-alive\nfoo: bar\n\n").is_empty());
        assert!(parser.feed(b"data: real\n\n").len() == 1);
        // A `data:` with no value is an empty data buffer: no dispatch.
        assert!(parser.feed(b"data:\n\n").is_empty());
    }

    /// Bytes arrive split mid-line and mid-UTF-8 character; nothing is lost.
    #[test]
    fn chunk_splits_inside_lines_and_utf8_scalars_are_safe() {
        let full = "data: héllo 👋\n\n".as_bytes();
        let mut parser = SseParser::new();
        assert!(parser.feed(&full[..5]).is_empty());
        assert!(
            parser.feed(&full[5..12]).is_empty(),
            "mid-scalar feeds buffer"
        );
        let events = parser.feed(&full[12..]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "héllo 👋");
    }

    #[test]
    fn a_bom_is_dropped_and_an_invalid_retry_is_ignored() {
        let mut parser = SseParser::new();
        // The BOM sits on the first field's line: kept, it would mangle the
        // field name and the event would vanish.
        let events = parser.feed(b"\xEF\xBB\xBFdata: x\nretry: soon\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].retry, None);
        assert_eq!(events[0].data, "x");
    }

    /// An `id` with a NUL byte is ignored, per the spec.
    #[test]
    fn an_id_with_a_nul_is_ignored() {
        let mut parser = SseParser::new();
        parser.feed(b"id: bad\0id\ndata: x\n\n");
        assert_eq!(parser.last_id(), None);
    }

    /// The trailing line without a terminator stays buffered and never
    /// dispatches on its own; a later feed can still complete it.
    #[test]
    fn an_unterminated_line_waits_for_its_newline() {
        let mut parser = SseParser::new();
        assert!(parser.feed(b"data: lost").is_empty());
        let events = parser.feed(b"\n\n");
        assert_eq!(events.len(), 1, "the line completed by a later feed");
        assert_eq!(events[0].data, "lost");
    }

    #[test]
    fn backoff_grows_to_its_cap_and_the_server_retry_overrides_it() {
        let backoff = SseBackoff::new(Duration::from_millis(100))
            .with_max(Duration::from_millis(1_000))
            .with_factor(3.0);
        assert_eq!(backoff.delay(1, None), Duration::from_millis(100));
        assert_eq!(backoff.delay(2, None), Duration::from_millis(300));
        assert_eq!(backoff.delay(3, None), Duration::from_millis(900));
        assert_eq!(
            backoff.delay(4, None),
            Duration::from_millis(1_000),
            "capped"
        );
        assert_eq!(
            backoff.delay(9, Some(Duration::from_millis(40))),
            Duration::from_millis(40),
            "the server's retry wins"
        );
    }
}
