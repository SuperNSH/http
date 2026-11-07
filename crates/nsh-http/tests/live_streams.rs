//! LIVE: these tests run against the real echo server (`tools/echo-server`,
//! port from its `.runtime.json`) over `UreqNetwork`, proving on the wire what
//! the stubs cannot: a server dripping `/stream` chunks and closing `/sse`,
//! the reconnect's `Last-Event-ID` replay, a real `/multipart` parse, and a
//! real `Content-Length` on `/bytes/:n`. They carry `#[ignore]` (run with
//! `cargo test -- --ignored` while the server is up) and fail loudly when the
//! port file is missing. The honest 0.4.0 limit under test: the Rust transport
//! resolves a request only at end of body (docs/decision.md, experiment 2),
//! so a dripped stream arrives whole and progress reports exactly once.

mod common;

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::multipart::MultipartForm;
use nsh_http::sse::{EventSource, SseBackoff};
use nsh_http::streaming;
use nsh_http::{
    CallOptions, Error, HttpClientBuilder, Middleware, Next, Request, Response, RetryPolicy,
};

use common::Fixture;

/// The echo server's port, read fresh: no file, no test.
fn echo_port() -> u16 {
    let path = Path::new("../../tools/echo-server/.runtime.json");
    let raw = std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!(
            "the echo server's {} is missing ({error}); start the server first",
            path.display()
        )
    });
    let value: serde_json::Value = serde_json::from_str(&raw).expect("the runtime file parses");
    let port = value
        .get("port")
        .and_then(|port| port.as_u64())
        .expect("the runtime file names its port");
    u16::try_from(port).expect("the port fits u16")
}

/// One sent request: method, URL, headers.
type Sent = (String, String, Vec<(String, String)>);

/// Every request one test's app sent, in order, so the tests can assert what
/// the pipeline actually put on the wire.
#[derive(Clone)]
struct Wire {
    sent: Arc<Mutex<Vec<Sent>>>,
}

impl Wire {
    /// The middleware that records into this wire.
    fn capture() -> (Arc<dyn Middleware>, Self) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sink = sent.clone();
        let middleware: Arc<dyn Middleware> = Arc::new(
            move |request: Request,
                  next: Next|
                  -> Pin<Box<dyn Future<Output = Result<Response, Error>> + 'static>> {
                sink.lock().unwrap().push((
                    request.method.clone(),
                    request.url.clone(),
                    request.headers.clone(),
                ));
                Box::pin(next.run(request))
            },
        );
        (middleware, Self { sent })
    }

    /// The headers of the requests to `method` + a URL fragment, in order.
    fn headers_of(&self, method: &str, url_contains: &str) -> Vec<Vec<(String, String)>> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(sent_method, url, _)| sent_method == method && url.contains(url_contains))
            .map(|(_, _, headers)| headers.clone())
            .collect()
    }

    /// The `last-event-id` header of the `index`-th (0-based) request to
    /// `method` + a URL fragment.
    fn last_event_id(&self, method: &str, url_contains: &str, index: usize) -> Option<String> {
        self.headers_of(method, url_contains)
            .get(index)
            .and_then(|headers| {
                headers
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case("last-event-id"))
                    .map(|(_, value)| value.clone())
            })
    }

    /// How many requests went to `method` + a URL fragment.
    fn count(&self, method: &str, url_contains: &str) -> usize {
        self.headers_of(method, url_contains).len()
    }
}

/// One test's rig: its own app, its own wire log, one flow per app.
struct LiveRig {
    wire: Wire,
    base_url: String,
}

/// Builds a test's fixture: the echo base URL, no client timeout and no
/// retries (a stream outlives any deadline, and reconnection is the SSE
/// source's own job), the wire recorder installed as middleware.
fn live_rig(
    cell: &'static OnceLock<Fixture<LiveRig>>,
    make_root: impl FnOnce(&Fixture<LiveRig>) -> Root,
) -> common::Rig {
    let (capture, wire) = Wire::capture();
    let base_url = format!("http://127.0.0.1:{}", echo_port());
    let for_client = base_url.clone();
    let tune = move |builder: HttpClientBuilder| {
        builder
            .base_url(for_client)
            .retry(RetryPolicy::off())
            .middleware(capture)
            .build()
    };
    common::start_live(cell, tune, LiveRig { wire, base_url }, make_root)
}

fn progress_collector() -> (
    Arc<Mutex<Vec<streaming::Progress>>>,
    streaming::ProgressSink,
) {
    let seen: Arc<Mutex<Vec<streaming::Progress>>> = Arc::default();
    let sink = seen.clone();
    let sink: streaming::ProgressSink = Arc::new(move |progress| {
        sink.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(*progress);
    });
    (seen, sink)
}

// --- /stream: a dripped body arrives whole --------------------------------------

static STREAM: OnceLock<Fixture<LiveRig>> = OnceLock::new();

fn stream_rig() -> common::Rig {
    live_rig(&STREAM, |_| Root::of::<StreamApp>())
}

#[component]
fn StreamApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = STREAM
        .get()
        .expect("stream_rig() builds the fixture")
        .client
        .clone();
    spawn(async move {
        let (reports, sink) = progress_collector();
        let outcome = streaming::download(
            &client,
            "/stream?chunks=3&delay=10",
            &CallOptions::new(),
            Some(sink),
        )
        .await;
        match outcome {
            Ok(file) => {
                let chunks = String::from_utf8_lossy(&file.bytes)
                    .lines()
                    .filter(|line| line.contains("\"route\":\"stream\""))
                    .count();
                let report = reports
                    .lock()
                    .unwrap()
                    .first()
                    .map(|p| p.bytes)
                    .unwrap_or(0);
                scenario.lines.update(|all| {
                    all.push(format!(
                        "stream chunks={chunks} reports={} bytes-match={}",
                        reports.lock().unwrap().len(),
                        report == file.bytes.len() as u64
                    ))
                });
            }
            Err(error) => scenario
                .lines
                .update(|all| all.push(format!("stream err {error}"))),
        }
        done.set(true);
    });
    scenario.view()
}

#[test]
#[ignore = "LIVE: needs the echo server up (cargo test -- --ignored)"]
fn the_stream_arrives_whole_with_one_progress_report() {
    let mut rig = stream_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(
        common::shows_containing(&rig.app, "stream chunks=3 reports=1 bytes-match=true"),
        "{:?}",
        rig.app.screen().texts()
    );
}

// --- /sse: close, reconnect with Last-Event-ID, replay --------------------------

static SSE: OnceLock<Fixture<LiveRig>> = OnceLock::new();

fn sse_rig() -> common::Rig {
    live_rig(&SSE, |_| Root::of::<SseApp>())
}

#[component]
fn SseApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = SSE
        .get()
        .expect("sse_rig() builds the fixture")
        .client
        .clone();
    spawn(async move {
        // Three events, the server closes, a reconnect carries Last-Event-ID: 3
        // and replays id 3 (the server resumes AT the id: at-least-once), then
        // the token stops the loop before a third connect.
        let source = EventSource::new(client, "/sse?count=3&delay=10")
            .with_backoff(SseBackoff::new(Duration::from_millis(200)));
        let token = source.token();
        let mut seen = 0_usize;
        let outcome = source
            .listen(move |event| {
                seen += 1;
                let id = event.id.clone().unwrap_or_else(|| "-".to_owned());
                scenario
                    .lines
                    .update(|all| all.push(format!("sse {id} {}", event.data)));
                if seen == 4 {
                    token.cancel();
                }
            })
            .await;
        scenario
            .lines
            .update(|all| all.push(format!("sse clean {}", outcome.is_ok())));
        done.set(true);
    });
    scenario.view()
}

#[test]
#[ignore = "LIVE: needs the echo server up (cargo test -- --ignored)"]
fn sse_reconnects_with_last_event_id_and_replays_from_it() {
    let mut rig = sse_rig();
    rig.app.wait_for("text:done").unwrap();
    for line in ["sse 1 ", "sse 2 ", "sse 3 ", "sse clean true"] {
        assert!(
            common::shows_containing(&rig.app, line),
            "missing {line}: {:?}",
            rig.app.screen().texts()
        );
    }
    let wire = &SSE.get().unwrap().extra.wire;
    // Two connects: the first with nothing to replay, the second asking to
    // resume from id 3. The duplicate id 3 (the server replays AT the id)
    // was the fourth event; the token cancelled before a third connect.
    assert_eq!(wire.count("GET", "/sse?count=3"), 2, "one replay, no more");
    assert_eq!(wire.last_event_id("GET", "/sse?count=3", 0), None);
    assert_eq!(
        wire.last_event_id("GET", "/sse?count=3", 1),
        Some("3".to_owned())
    );
}

// --- /multipart: the real server parses the parts --------------------------------

static MULTIPART: OnceLock<Fixture<LiveRig>> = OnceLock::new();

fn multipart_rig() -> common::Rig {
    live_rig(&MULTIPART, |_| Root::of::<MultipartApp>())
}

#[component]
fn MultipartApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let fixture = MULTIPART.get().expect("multipart_rig() builds the fixture");
    let client = fixture.client.clone();
    let base_url = fixture.extra.base_url.clone();
    spawn(async move {
        let form = MultipartForm::new().text("note", "hello").file(
            "doc",
            "doc.txt",
            "text/plain",
            b"file body".to_vec(),
        );
        let outcome = form.send(&client, format!("{base_url}/multipart")).await;
        match outcome {
            Ok(response) => {
                let body = response.text();
                let note =
                    body.contains("\"name\":\"note\"") && body.contains("\"value\":\"hello\"");
                let doc = body.contains("\"filename\":\"doc.txt\"")
                    && body.contains("\"content\":\"file body\"");
                scenario
                    .lines
                    .update(|all| all.push(format!("multipart {note} {doc}")));
            }
            Err(error) => scenario
                .lines
                .update(|all| all.push(format!("multipart err {error}"))),
        }
        done.set(true);
    });
    scenario.view()
}

#[test]
#[ignore = "LIVE: needs the echo server up (cargo test -- --ignored)"]
fn a_multipart_form_is_parsed_by_the_real_server() {
    let mut rig = multipart_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(
        common::shows_containing(&rig.app, "multipart true true"),
        "{:?}",
        rig.app.screen().texts()
    );
}

// --- /bytes/:n: a real Content-Length --------------------------------------------

static BYTES: OnceLock<Fixture<LiveRig>> = OnceLock::new();

fn bytes_rig() -> common::Rig {
    live_rig(&BYTES, |_| Root::of::<BytesApp>())
}

#[component]
fn BytesApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = BYTES
        .get()
        .expect("bytes_rig() builds the fixture")
        .client
        .clone();
    spawn(async move {
        let (reports, sink) = progress_collector();
        let outcome =
            streaming::download(&client, "/bytes/1000", &CallOptions::new(), Some(sink)).await;
        match outcome {
            Ok(file) => {
                let pattern_ok = file.bytes.len() == 1000
                    && file.bytes[0] == 0
                    && file.bytes[255] == 255
                    && file.bytes[256] == 0;
                scenario.lines.update(|all| {
                    all.push(format!(
                        "bytes len={} total={:?} reports={} pattern={pattern_ok}",
                        file.bytes.len(),
                        file.total,
                        reports.lock().unwrap().len()
                    ))
                });
            }
            Err(error) => scenario
                .lines
                .update(|all| all.push(format!("bytes err {error}"))),
        }
        done.set(true);
    });
    scenario.view()
}

#[test]
#[ignore = "LIVE: needs the echo server up (cargo test -- --ignored)"]
fn bytes_download_matches_its_content_length() {
    let mut rig = bytes_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(
        common::shows_containing(
            &rig.app,
            "bytes len=1000 total=Some(1000) reports=1 pattern=true"
        ),
        "{:?}",
        rig.app.screen().texts()
    );
}

// --- a body that is not an event stream ------------------------------------------

static WRONG_TYPE: OnceLock<Fixture<LiveRig>> = OnceLock::new();

fn wrong_type_rig() -> common::Rig {
    live_rig(&WRONG_TYPE, |_| Root::of::<WrongTypeApp>())
}

#[component]
fn WrongTypeApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = WRONG_TYPE
        .get()
        .expect("wrong_type_rig() builds the fixture")
        .client
        .clone();
    spawn(async move {
        let outcome = EventSource::new(client, "/fast").listen(|_| {}).await;
        let refused = match &outcome {
            Err(Error::Network { message }) => message.contains("text/event-stream"),
            _ => false,
        };
        scenario
            .lines
            .update(|all| all.push(format!("wrong-type {refused}")));
        done.set(true);
    });
    scenario.view()
}

#[test]
#[ignore = "LIVE: needs the echo server up (cargo test -- --ignored)"]
fn a_non_event_stream_is_refused_without_a_reconnect() {
    let mut rig = wrong_type_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "wrong-type true"));
    // The /fast connect is the ONLY /fast connect: no SSE retry loop ran.
    assert_eq!(
        WRONG_TYPE.get().unwrap().extra.wire.count("GET", "/fast"),
        1
    );
}
