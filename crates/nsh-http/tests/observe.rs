//! Behavior row 10: the observer emit points — one NetworkEvent per request
//! attempt, honest timings (duration real, ttfbMs null on the Rust side),
//! on success and on failure, retries included.

mod common;

use std::sync::OnceLock;
use std::time::Duration;

use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::RetryPolicy;

use common::{Fixture, ORIGIN_MS, TEST_BASE, delayed, json, route};

struct Nothing;

static OBSERVE: OnceLock<Fixture<Nothing>> = OnceLock::new();

/// A fast route and a slow route, one GET that fails at the transport, and a
/// flaky route whose retry is its own attempt.
fn observe_rig() -> common::Rig {
    Fixture::start(
        &OBSERVE,
        vec![
            route(
                &format!("GET {TEST_BASE}/fast"),
                json(200, r#"{"route":"fast"}"#),
            ),
            route(
                &format!("GET {TEST_BASE}/slow"),
                delayed(json(200, r#"{"route":"slow"}"#), Duration::from_millis(120)),
            ),
            route(
                &format!("GET {TEST_BASE}/dead"),
                common::failing("io: connection reset"),
            ),
        ],
        |builder| {
            builder
                .retry(RetryPolicy::new(1).with_base_delay_ms(10).with_jitter(0.0))
                .build()
        },
        Nothing,
        |_| Root::of::<ObserveApp>(),
    )
}

#[component]
fn ObserveApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = OBSERVE
        .get()
        .expect("observe_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let _ = client.get::<serde_json::Value>("/fast").await;
        let _ = client.get::<serde_json::Value>("/slow").await;
        let _ = client.get::<serde_json::Value>("/dead").await;
        done.set(true);
    });
    scenario.view()
}

#[test]
fn every_attempt_emits_one_honest_event() {
    let mut rig = observe_rig();
    // Mount first, then move the manual clock past the slow route's delay
    // (120 ms) and the retry's backoff (10 ms).
    rig.app.wait_for("text:waiting").unwrap();
    rig.app.run_for(Duration::from_millis(300)).unwrap();
    rig.app.wait_for("text:done").unwrap();

    let events = rig.events.lock().unwrap();
    // 3 routes, but /dead retries once: 4 attempts, 4 events.
    assert_eq!(events.len(), 4);

    // The frozen wire shape: ids unique, camelCase lives in the serde names
    // (asserted through the struct's fields here), and the timing fields are
    // honest.
    for (first, second) in events.iter().zip(events.iter().skip(1)) {
        assert_ne!(first.id, second.id, "each attempt has its own id");
    }

    let fast = &events[0];
    assert_eq!(fast.method, "GET");
    assert_eq!(fast.url, format!("{TEST_BASE}/fast"));
    assert_eq!(fast.host, "127.0.0.1");
    assert_eq!(fast.path, "/fast");
    assert_eq!(fast.status, Some(200));
    assert_eq!(
        fast.ttfb_ms, None,
        "the Rust transport resolves once: no honest TTFB"
    );
    assert_eq!(fast.request_bytes, Some(0), "a GET sends no body");
    assert_eq!(
        fast.response_bytes,
        Some(16),
        "the whole body, after the fact"
    );
    assert_eq!(fast.error, None);
    assert!(
        fast.started_at_ms >= ORIGIN_MS,
        "the manual clock's wall time"
    );
    assert!(
        fast.duration_ms < 120,
        "the fast route finished before the slow one"
    );

    let slow = &events[1];
    assert_eq!(slow.path, "/slow");
    assert!(
        slow.duration_ms >= 120,
        "duration covers the stub's whole delay: {}",
        slow.duration_ms
    );
    assert_eq!(slow.response_bytes, Some(16));

    let dead = &events[2];
    assert_eq!(dead.status, None, "no response arrived");
    assert_eq!(dead.response_bytes, None);
    assert!(
        dead.error
            .as_deref()
            .is_some_and(|message| message.contains("network: io: connection reset")),
        "the classified error: {:?}",
        dead.error
    );

    let retry = &events[3];
    assert_eq!(
        retry.path, "/dead",
        "the retry is its own attempt and its own event"
    );
    assert!(
        retry.started_at_ms - dead.started_at_ms >= 10,
        "it started after the backoff"
    );

    // startedAtMs runs on the app's clock and durationMs measures it: the
    // retry cannot finish before the attempt it follows.
    assert!(
        events
            .windows(2)
            .all(|pair| pair[1].started_at_ms >= pair[0].started_at_ms)
    );
}

#[test]
fn the_event_serializes_with_the_frozen_camel_case_names() {
    // The wire shape nsh-firebase consumes: serde renames every field.
    let event = nsh_http::NetworkEvent {
        id: "e1".to_owned(),
        method: "GET".to_owned(),
        url: "http://127.0.0.1:8123/fast".to_owned(),
        host: "127.0.0.1".to_owned(),
        path: "/fast".to_owned(),
        status: Some(200),
        started_at_ms: 1,
        duration_ms: 2,
        ttfb_ms: None,
        request_bytes: Some(0),
        response_bytes: Some(16),
        error: None,
        initiator: None,
    };
    let wire = serde_json::to_value(&event).unwrap();
    for key in [
        "id",
        "method",
        "url",
        "host",
        "path",
        "status",
        "startedAtMs",
        "durationMs",
        "ttfbMs",
        "requestBytes",
        "responseBytes",
        "error",
        "initiator",
    ] {
        assert!(wire.get(key).is_some(), "missing frozen key {key}");
    }
    assert_eq!(wire.get("startedAtMs"), Some(&serde_json::json!(1)));
    assert_eq!(wire.get("ttfbMs"), Some(&serde_json::Value::Null));
}
