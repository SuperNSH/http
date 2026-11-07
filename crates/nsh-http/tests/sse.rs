//! Behavior row 14: SSE connect, reconnect with backoff and `Last-Event-ID`,
//! and clean cancellation, on stubs and the manual clock. The stub cannot
//! stream a body in pieces (`StubNetwork` answers whole), which on 0.4.0 is
//! exactly what the production Rust transport does too (`docs/decision.md`,
//! experiment 2): the parse-then-reconnect machinery here runs against the
//! same shape the wire gives it. The wire-level proof — a real server
//! streaming events and replaying on `Last-Event-ID` — lives in
//! `tests/live_streams.rs`.

mod common;

use std::cell::RefCell;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use nsh_core::platform::HttpRequest;
use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::sse::{CancelToken, EventSource};
use nsh_http::{Error, RetryPolicy};
use nsh_testing::{StubHandler, StubReply, StubRoute};

use common::{Fixture, TEST_BASE, json, route};

const BACKOFF_MS: u64 = 1_000;

fn sse_body(events: &[(&str, &str)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, data) in events {
        body.extend_from_slice(format!("id: {id}\nevent: tick\ndata: {data}\n\n").as_bytes());
    }
    body
}

/// An `event-stream` response for the stub (whole body; the stub always ends).
fn event_stream(body: Vec<u8>) -> nsh_testing::StubResponse {
    let mut response = nsh_testing::StubResponse::default();
    response.status = 200;
    response.headers = vec![("content-type".to_owned(), "text/event-stream".to_owned())];
    response.body = body;
    response
}

// --- reconnect with Last-Event-ID ---------------------------------------------

struct ReconnectRig {
    last_event_ids: Arc<Mutex<Vec<Option<String>>>>,
}

static RECONNECT: OnceLock<Fixture<ReconnectRig>> = OnceLock::new();

/// Connect 1 (no `Last-Event-ID`): events 1 and 2, then the server closes.
/// Connect 2 (`Last-Event-ID: 2`): event 3; the client stops there.
fn reconnect_rig() -> common::Rig {
    let last_event_ids = Arc::new(Mutex::new(Vec::new()));
    let recorder = last_event_ids.clone();
    let handler: StubHandler = Arc::new(move |request: HttpRequest, reply: StubReply| {
        let last = request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("last-event-id"))
            .map(|(_, value)| value.clone());
        let replay = last.is_some();
        recorder.lock().unwrap().push(last);
        reply.send(if replay {
            event_stream(sse_body(&[("3", "three")]))
        } else {
            event_stream(sse_body(&[("1", "one"), ("2", "two")]))
        });
    });
    Fixture::start(
        &RECONNECT,
        vec![(format!("GET {TEST_BASE}/sse"), StubRoute::Handler(handler))],
        |builder| builder.retry(RetryPolicy::off()).build(),
        ReconnectRig { last_event_ids },
        |_| Root::of::<ReconnectApp>(),
    )
}

#[component]
fn ReconnectApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = RECONNECT
        .get()
        .expect("reconnect_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let source = EventSource::new(client, "/sse");
        let token = source.token();
        let mut seen = 0_usize;
        let outcome = source
            .listen(move |event| {
                seen += 1;
                let id = event.id.clone().unwrap_or_else(|| "-".to_owned());
                scenario
                    .lines
                    .update(|all| all.push(format!("{id}/{}", event.data)));
                if seen == 3 {
                    token.cancel();
                }
            })
            .await;
        scenario
            .lines
            .update(|all| all.push(format!("clean {}", outcome.is_ok())));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_reconnect_carries_last_event_id_after_backoff_and_stops_on_cancel() {
    let mut rig = reconnect_rig();
    rig.app.wait_for("text:done").unwrap();
    for line in ["1/one", "2/two", "3/three", "clean true"] {
        assert!(
            common::shows_containing(&rig.app, line),
            "missing {line}: {:?}",
            rig.app.screen().texts()
        );
    }

    // Two connects: the second asked from where the first ended.
    let requests = rig.network.requests();
    assert_eq!(requests.len(), 2, "one reconnect, no more after cancel");
    let ids = RECONNECT
        .get()
        .unwrap()
        .extra
        .last_event_ids
        .lock()
        .unwrap();
    assert_eq!(ids[0], None, "the first connect has nothing to replay");
    assert_eq!(
        ids[1].as_deref(),
        Some("2"),
        "the reconnect names the last id"
    );

    // The reconnect waited the backoff on the manual clock (events quantize
    // to frames; the wait must be at least the full backoff).
    let events = rig.events.lock().unwrap();
    let gap = events[1].started_at_ms - events[0].started_at_ms;
    assert!(
        gap >= BACKOFF_MS,
        "the reconnect waited the backoff: {gap} ms"
    );
}

// --- the server's retry field --------------------------------------------------

static RETRY_FIELD: OnceLock<Fixture<()>> = OnceLock::new();

/// The first body carries `retry: 250`: the reconnect must wait 250, not the
/// 1000 ms default.
fn retry_field_rig() -> common::Rig {
    let handler: StubHandler = Arc::new(|_request: HttpRequest, reply: StubReply| {
        let mut body = b"retry: 250\n".to_vec();
        body.extend_from_slice(&sse_body(&[("1", "first")]));
        reply.send(event_stream(body));
    });
    Fixture::start(
        &RETRY_FIELD,
        vec![(format!("GET {TEST_BASE}/sse"), StubRoute::Handler(handler))],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<RetryFieldApp>(),
    )
}

#[component]
fn RetryFieldApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = RETRY_FIELD.get().expect("fixture").client.clone();
    spawn(async move {
        let source = EventSource::new(client, "/sse");
        let token = source.token();
        let mut seen = 0_usize;
        let outcome = source
            .listen(move |event| {
                seen += 1;
                let id = event.id.clone().unwrap_or_else(|| "-".to_owned());
                scenario.lines.update(|all| all.push(id.to_string()));
                if seen == 2 {
                    token.cancel();
                }
            })
            .await;
        scenario
            .lines
            .update(|all| all.push(format!("clean {}", outcome.is_ok())));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn the_server_retry_field_sets_the_reconnect_delay() {
    let mut rig = retry_field_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "clean true"));
    assert_eq!(rig.network.requests().len(), 2);
    let events = rig.events.lock().unwrap();
    let gap = events[1].started_at_ms - events[0].started_at_ms;
    assert!(
        (250..950).contains(&gap),
        "the reconnect waited the server's 250, not the 1000 default: {gap} ms"
    );
}

// --- cancel during the backoff, from another thread ----------------------------

static MID_BACKOFF_TOKEN: OnceLock<CancelToken> = OnceLock::new();

static MID_BACKOFF: OnceLock<Fixture<()>> = OnceLock::new();

fn mid_backoff_rig() -> common::Rig {
    Fixture::start(
        &MID_BACKOFF,
        vec![route(
            &format!("GET {TEST_BASE}/sse"),
            event_stream(sse_body(&[("1", "one")])),
        )],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<MidBackoffApp>(),
    )
}

#[component]
fn MidBackoffApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = MID_BACKOFF.get().expect("fixture").client.clone();
    spawn(async move {
        let source = EventSource::new(client, "/sse");
        let _ = MID_BACKOFF_TOKEN.set(source.token());
        let outcome = source
            .listen(|_event| {
                scenario
                    .lines
                    .update(|all| all.push("connected".to_owned()));
            })
            .await;
        scenario
            .lines
            .update(|all| all.push(format!("clean {}", outcome.is_ok())));
        done.set(true);
    });
    scenario.view()
}

/// A cancel from off the engine thread, while the loop is parked in the
/// backoff wait, ends it promptly — well before the backoff would fire — and
/// no second connect ever runs.
#[test]
fn a_cancel_during_the_backoff_stops_the_loop_before_the_next_connect() {
    let mut rig = mid_backoff_rig();
    rig.app.wait_for("text:connected").unwrap();
    MID_BACKOFF_TOKEN
        .get()
        .expect("the app stored its token")
        .cancel();
    // Far less than the 1000 ms backoff: the wake from the cancel alone
    // must end the loop.
    rig.app.run_for(Duration::from_millis(200)).unwrap();
    assert!(
        common::shows_containing(&rig.app, "clean true"),
        "the cancel ended the wait without the backoff elapsing"
    );
    assert_eq!(
        rig.network.requests().len(),
        1,
        "the parked backoff never reached a second connect"
    );
}

// --- dropping the listen task ---------------------------------------------------

// A `Spawned` handle is `Rc`-held on the engine thread: a thread_local, as in
// tests/timeout.rs.
thread_local! {
    static LISTEN_TASK: RefCell<Option<Spawned<()>>> = const { RefCell::new(None) };
}

static DROP_NOTE: OnceLock<Signal<Vec<String>>> = OnceLock::new();

#[test]
fn dropping_the_listen_task_leaves_no_orphan_connects() {
    let mut config = nsh_engine::EngineConfig::new(Root::of::<DropApp>());
    let clock = common::manual_clock();
    let network = Arc::new(
        nsh_testing::StubNetwork::new(vec![route(
            &format!("GET {TEST_BASE}/sse"),
            event_stream(sse_body(&[("1", "one")])),
        )])
        .with_clock(clock.clone()),
    );
    config.clock = clock;
    config.network = Some(network.clone());
    let mut app = nsh_testing::Headless::start(config).unwrap();
    app.wait_for("text:leave").unwrap();
    app.press("text:leave").unwrap();
    app.run_for(Duration::from_millis(10_000)).unwrap();
    assert!(app.shows("abandoned"));
    assert!(!common::shows_containing(&app, "reconnected"));
    assert_eq!(
        network.requests().len(),
        1,
        "the first connect ran, the parked backoff never did"
    );
}

#[component]
fn DropApp() -> impl IntoElement {
    let lines = *DROP_NOTE.get_or_init(|| signal(Vec::<String>::new()));
    let note = lines;
    let client = nsh_http::HttpClient::builder()
        .base_url(TEST_BASE)
        .retry(RetryPolicy::off())
        .build();
    let task = spawn(async move {
        let source = EventSource::new(client, "/sse");
        let _ = source
            .listen(|event| {
                let id = event.id.clone().unwrap_or_else(|| "-".to_owned());
                if let Some(all) = DROP_NOTE.get() {
                    all.update(|lines| lines.push(format!("event {id}")));
                }
            })
            .await;
        if let Some(all) = DROP_NOTE.get() {
            all.update(|lines| lines.push("reconnected".to_owned()));
        }
    });
    LISTEN_TASK.with(|cell| *cell.borrow_mut() = Some(task));
    view()
        .child(text("leave").on_press(|| {
            LISTEN_TASK.with(|cell| {
                if let Some(task) = cell.borrow_mut().take() {
                    task.cancel();
                    if let Some(all) = DROP_NOTE.get() {
                        all.update(|lines| lines.push("abandoned".to_owned()));
                    }
                }
            });
        }))
        .child(each(
            lines,
            |line| line.clone(),
            |line, _index| text(move || line.get()),
        ))
}

// --- connects that do not produce a stream -------------------------------------

static STATUS: OnceLock<Fixture<()>> = OnceLock::new();

fn status_rig(status: u16) -> common::Rig {
    Fixture::start(
        &STATUS,
        vec![route(
            &format!("GET {TEST_BASE}/sse"),
            json(status, r#"{"no":"stream"}"#),
        )],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<StatusApp>(),
    )
}

#[component]
fn StatusApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = STATUS.get().expect("fixture").client.clone();
    spawn(async move {
        let outcome = EventSource::new(client, "/sse").listen(|_| {}).await;
        let note = match &outcome {
            Ok(()) => "ended clean".to_owned(),
            Err(Error::HttpStatus { status, .. }) => format!("status {status}"),
            Err(error) => format!("other {error}"),
        };
        scenario.lines.update(|all| all.push(note));
        done.set(true);
    });
    scenario.view()
}

/// A non-2xx connect is the server refusing SSE: the source ends with the
/// pipeline's status error and does not reconnect.
#[test]
fn a_non_2xx_connect_ends_the_source_without_a_reconnect() {
    let mut rig = status_rig(503);
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "status 503"));
    assert_eq!(
        rig.network.requests().len(),
        1,
        "no SSE reconnect on a status"
    );
}

// --- a body that is not an event stream -----------------------------------------

static WRONG_TYPE: OnceLock<Fixture<()>> = OnceLock::new();

fn wrong_type_rig() -> common::Rig {
    Fixture::start(
        &WRONG_TYPE,
        vec![route(
            &format!("GET {TEST_BASE}/sse"),
            json(200, r#"{"ok":true}"#),
        )],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<WrongTypeApp>(),
    )
}

#[component]
fn WrongTypeApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = WRONG_TYPE.get().expect("fixture").client.clone();
    spawn(async move {
        let outcome = EventSource::new(client, "/sse").listen(|_| {}).await;
        let note = match outcome {
            Err(Error::Network { message }) => {
                format!("wrong-type {}", message.contains("text/event-stream"))
            }
            _ => "wrong-type missed".to_owned(),
        };
        scenario.lines.update(|all| all.push(note));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_json_body_is_refused_without_a_reconnect() {
    let mut rig = wrong_type_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "wrong-type true"));
    assert_eq!(rig.network.requests().len(), 1);
}

// --- exhausted failed connects ---------------------------------------------------

static FLAKY_CONNECT: OnceLock<Fixture<()>> = OnceLock::new();

fn flaky_connect_rig() -> common::Rig {
    Fixture::start(
        &FLAKY_CONNECT,
        vec![route(
            &format!("GET {TEST_BASE}/sse"),
            common::failing("io: connection reset"),
        )],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<FlakyConnectApp>(),
    )
}

#[component]
fn FlakyConnectApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = FLAKY_CONNECT.get().expect("fixture").client.clone();
    spawn(async move {
        let source = EventSource::new(client, "/sse").with_max_attempts(2);
        let outcome = source.listen(|_| {}).await;
        let note = match outcome {
            Err(Error::Network { .. }) => "exhausted network".to_owned(),
            Ok(()) => "exhausted clean".to_owned(),
            Err(error) => format!("exhausted {error}"),
        };
        scenario.lines.update(|all| all.push(note));
        done.set(true);
    });
    scenario.view()
}

/// Two failed connects (bounded by `max_attempts`), the second after a full
/// backoff, then the last error stands.
#[test]
fn failed_connects_back_off_and_exhaust_the_attempt_bound() {
    let mut rig = flaky_connect_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "exhausted network"));
    assert_eq!(rig.network.requests().len(), 2);
    let events = rig.events.lock().unwrap();
    let gap = events[1].started_at_ms - events[0].started_at_ms;
    assert!(gap >= BACKOFF_MS, "the retry waited the backoff: {gap} ms");
}
