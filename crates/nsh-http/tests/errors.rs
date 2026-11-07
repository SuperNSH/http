//! Behavior row 3: the six-case error taxonomy, every case through the client
//! on stub routes, refused-by-capability kept distinct from network failure.

mod common;

use std::sync::{Arc, OnceLock};

use nsh_core::platform::{HttpBody, HttpRequest};
use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::{Error, MockTransport};
use nsh_testing::{StubHandler, StubReply, StubRoute};
use serde::Deserialize;

use common::{Fixture, TEST_BASE, json, route};

use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Deserialize)]
struct Payload {
    #[allow(dead_code)]
    value: String,
}

struct Nothing;

static ERRORS: OnceLock<Fixture<Nothing>> = OnceLock::new();

/// One route per error case; each scenario names its route and shows the
/// error's taxonomy word.
fn errors_rig() -> common::Rig {
    let refused: StubHandler = Arc::new(|_request: HttpRequest, reply: StubReply| {
        // The engine's exact refusal message for an undeclared host, relayed
        // through the stub the way the engine relays its own.
        reply.send(common::failing(
            "fetch GET http://evil.io/ is not granted: add `evil.io` to capabilities.network in nsh.json",
        ));
    });
    let cancelled: StubHandler = Arc::new(|_request, reply: StubReply| {
        reply.send(common::failing("request aborted by the caller"));
    });
    Fixture::start(
        &ERRORS,
        vec![
            route(
                &format!("GET {TEST_BASE}/offline"),
                common::failing("io: Connection refused (os error 61)"),
            ),
            route(
                &format!("GET {TEST_BASE}/broken-json"),
                json(200, "not json at all"),
            ),
            route(
                &format!("GET {TEST_BASE}/wrong-shape"),
                json(200, r#"{"other":1}"#),
            ),
            route(
                &format!("GET {TEST_BASE}/missing"),
                json(404, r#"{"error":"no such user"}"#),
            ),
            (
                format!("GET {TEST_BASE}/refused"),
                StubRoute::Handler(refused),
            ),
            (
                format!("GET {TEST_BASE}/cancelled"),
                StubRoute::Handler(cancelled),
            ),
        ],
        |builder| {
            // One attempt, whatever happens: the taxonomy is the subject here.
            builder.retry(nsh_http::RetryPolicy::off()).build()
        },
        Nothing,
        |_| Root::of::<ErrorsApp>(),
    )
}

#[component]
fn ErrorsApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = ERRORS
        .get()
        .expect("errors_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        for (path, name) in [
            ("/offline", "network"),
            ("/refused", "refused"),
            ("/cancelled", "cancelled"),
            ("/missing", "http"),
            ("/broken-json", "decode"),
            ("/wrong-shape", "decode"),
        ] {
            let error = client.get::<Payload>(path).await.unwrap_err();
            let kind = match &error {
                Error::Network { .. } => "network",
                Error::Timeout => "timeout",
                Error::Cancelled => "cancelled",
                Error::RefusedByCapability { .. } => "refused",
                Error::HttpStatus { .. } => "http",
                Error::Decode { .. } => "decode",
            };
            scenario
                .lines
                .update(|all| all.push(format!("{name}:{kind}")));
            // The refusal carries the URL and the capability it needs.
            if name == "refused"
                && matches!(&error, Error::RefusedByCapability { message } if message.contains("evil.io"))
            {
                scenario
                    .lines
                    .update(|all| all.push("refused-url true".to_owned()));
            }
            if let (true, Error::HttpStatus { status, body, .. }) = (name == "http", &error) {
                scenario.lines.update(|all| {
                    all.push(format!(
                        "http-body {status} {}",
                        body.contains("no such user")
                    ))
                });
            }
        }
        done.set(true);
    });
    scenario.view()
}

#[test]
fn every_error_lands_in_its_own_case() {
    let mut rig = errors_rig();
    rig.app.wait_for("text:done").unwrap();
    for line in [
        "network:network",
        "refused:refused",
        "cancelled:cancelled",
        "http:http",
        "decode:decode",
    ] {
        assert!(common::shows_containing(&rig.app, line), "{line}");
    }
    assert!(common::shows_containing(&rig.app, "refused-url true"));
    assert!(common::shows_containing(&rig.app, "http-body 404 true"));
    // The wrong shape decodes as a decode failure, not a network one.
    let events = rig.events.lock().unwrap();
    assert_eq!(events.len(), 6);
}

#[test]
fn refusal_is_a_different_error_from_a_network_failure() {
    let refused = Error::classify(
        "fetch GET http://evil.io/ is not granted: add `evil.io` to capabilities.network in nsh.json"
            .to_owned(),
    );
    let network = Error::classify("io: Connection refused (os error 61)".to_owned());
    let cancelled = Error::classify("request aborted by the caller".to_owned());
    assert!(matches!(refused, Error::RefusedByCapability { .. }));
    assert!(matches!(network, Error::Network { .. }));
    assert!(matches!(cancelled, Error::Cancelled));
    // `ERR_ACCESS_DENIED` maps to refusal wherever the host phrases it so.
    assert!(matches!(
        Error::classify("ERR_ACCESS_DENIED: network".to_owned()),
        Error::RefusedByCapability { .. }
    ));
    assert_ne!(refused, network);
    assert!(!refused.is_retryable());
}

// --- a streamed request body is refused loudly, never sent empty --------------

struct StreamProbe {
    calls: Arc<AtomicUsize>,
}

static STREAM: OnceLock<Fixture<StreamProbe>> = OnceLock::new();

fn stream_rig() -> common::Rig {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let mock = MockTransport::new(move |_request| {
        counter.fetch_add(1, Ordering::SeqCst);
        Ok(common::as_http(&json(200, r#"{"sent":true}"#)))
    });
    // The client keeps its DEFAULT retry policy: the refusal must surface in
    // one attempt, without burning the budget on a caller mistake.
    Fixture::start(
        &STREAM,
        vec![],
        |builder| builder.transport(Arc::new(mock)).build(),
        StreamProbe { calls },
        |_| Root::of::<StreamApp>(),
    )
}

#[component]
fn StreamApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let fixture = STREAM
        .get()
        .expect("stream_rig() builds the fixture before the app mounts");
    let client = fixture.client.clone();
    spawn(async move {
        let request = HttpRequest {
            method: "GET".to_owned(),
            url: format!("{TEST_BASE}/streamed"),
            headers: Vec::new(),
            body: HttpBody::Stream,
            follow_redirects: true,
        };
        let outcome = client.send_request(request).await;
        let loud = match &outcome {
            Err(Error::Network { message }) => message.contains("docs/decision.md"),
            _ => false,
        };
        scenario
            .lines
            .update(|all| all.push(format!("stream loud={loud}")));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_streamed_request_body_fails_loudly_instead_of_sending_empty() {
    let mut rig = stream_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(
        common::shows_containing(&rig.app, "stream loud=true"),
        "the error names the decision doc: {:?}",
        rig.app.screen().texts()
    );
    // The mock never saw a request: nothing went out, empty or otherwise.
    let fixture = STREAM.get().expect("fixture");
    assert_eq!(fixture.extra.calls.load(Ordering::SeqCst), 0);
    // With the default retry policy in force, zero events means the refusal
    // surfaced in a single attempt: no sends, no backoff waits, no burned
    // retry budget.
    let events = rig.events.lock().unwrap();
    assert_eq!(events.len(), 0, "the refusal is not an attempt");
}
