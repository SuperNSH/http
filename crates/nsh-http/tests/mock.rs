//! Behavior row 8: the mock adapter transport — it answers at the client's
//! transport seam, beside (not instead of) NSH's own stubs, which this file
//! also drives in the same app.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::{Error, HttpClient, MockTransport, RetryPolicy};

use common::{Fixture, TEST_BASE, json, route};

struct Mocks {
    calls: Arc<AtomicUsize>,
}

static MOCK: OnceLock<Fixture<Mocks>> = OnceLock::new();

/// A mock transport whose counter lives in the fixture, plus the stub-driven
/// client the same app also uses.
fn mock_rig() -> common::Rig {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let mock = MockTransport::new(move |request| {
        counter.fetch_add(1, Ordering::SeqCst);
        if request.url.ends_with("/mocked") {
            Ok(mock_json(200, r#"{"name":"mocked"}"#))
        } else {
            Err("io: the mock does not know this route".to_owned())
        }
    });
    Fixture::start(
        &MOCK,
        // The stub still answers its own route: both transports in one app.
        vec![route(
            &format!("GET {TEST_BASE}/stubbed"),
            json(200, r#"{"name":"stubbed"}"#),
        )],
        |builder| {
            builder
                .transport(Arc::new(mock))
                .retry(RetryPolicy::off())
                .build()
        },
        Mocks { calls },
        |_| Root::of::<MockApp>(),
    )
}

/// An `HttpResponse` from raw parts (`HttpResponse`'s fields are public but
/// its `head` needs defaults).
fn mock_json(status: u16, body: &str) -> nsh_core::prelude::HttpResponse {
    nsh_core::prelude::HttpResponse {
        head: nsh_core::platform::HttpHead {
            status,
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            ..nsh_core::platform::HttpHead::default()
        },
        body: body.as_bytes().to_vec(),
    }
}

#[component]
fn MockApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = MOCK
        .get()
        .expect("mock_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let mocked: Result<serde_json::Value, _> = client.get("/mocked").await;
        scenario.lines.update(|all| {
            all.push(format!(
                "mocked {}",
                mocked
                    .ok()
                    .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                    .unwrap_or_default()
            ))
        });
        let unknown: Result<serde_json::Value, _> = client.get("/unknown").await;
        scenario.lines.update(|all| {
            all.push(format!(
                "unknown {}",
                matches!(unknown, Err(Error::Network { .. }))
            ))
        });
        // A second client on the default transport: the same app talking to
        // the engine's stub network beside the mock.
        let stub_client = HttpClient::builder()
            .base_url(TEST_BASE)
            .retry(RetryPolicy::off())
            .build();
        let stubbed: Result<serde_json::Value, _> = stub_client.get("/stubbed").await;
        scenario.lines.update(|all| {
            all.push(format!(
                "stubbed {}",
                stubbed
                    .ok()
                    .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                    .unwrap_or_default()
            ))
        });
        done.set(true);
    });
    scenario.view()
}

#[test]
fn the_mock_answers_the_client_while_the_stub_answers_the_engine() {
    let mut rig = mock_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "mocked mocked"));
    assert!(common::shows_containing(&rig.app, "unknown true"));
    // The same URL went through the client's mock, so the stub never saw it.
    assert!(common::shows_containing(&rig.app, "stubbed stubbed"));
    let fixture = MOCK.get().expect("fixture");
    assert_eq!(
        fixture.extra.calls.load(Ordering::SeqCst),
        2,
        "mock saw both client calls"
    );
    let stubbed = rig
        .network
        .requests()
        .iter()
        .filter(|request| request.url.ends_with("/stubbed"))
        .count();
    assert_eq!(stubbed, 1, "the stub saw only its own route");
}

#[test]
fn a_fixed_mock_decodes_and_fails_classified() {
    let mut config = nsh_engine::EngineConfig::new(Root::of::<FixedMockApp>());
    config.clock = common::manual_clock();
    let mut app = nsh_testing::Headless::start(config).unwrap();
    app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&app, "fixed mocked true"));
    assert!(common::shows_containing(&app, "fixed failing true"));
}

#[component]
fn FixedMockApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let mocked = Arc::new(MockTransport::json(200, r#"{"name":"mocked"}"#));
    let failing = Arc::new(MockTransport::failing("the wifi is off"));
    let mocked_client = HttpClient::builder()
        .base_url(TEST_BASE)
        .transport(mocked.clone())
        .retry(RetryPolicy::off())
        .build();
    let failing_client = HttpClient::builder()
        .base_url(TEST_BASE)
        .transport(failing.clone())
        .retry(RetryPolicy::off())
        .build();
    spawn(async move {
        let decoded: Result<serde_json::Value, _> = mocked_client.get("/anything").await;
        scenario.lines.update(|all| {
            all.push(format!(
                "fixed mocked {}",
                decoded
                    .ok()
                    .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                    .map(|n| n == "mocked")
                    .unwrap_or(false)
            ))
        });
        let failed = failing_client.get::<serde_json::Value>("/anything").await;
        scenario.lines.update(|all| {
            all.push(format!(
                "fixed failing {}",
                matches!(failed, Err(Error::Network { .. }))
            ))
        });
        done.set(true);
    });
    scenario.view()
}
