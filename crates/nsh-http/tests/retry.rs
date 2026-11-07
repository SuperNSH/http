//! Behavior row 5: retries with backoff and jitter on the manual clock,
//! Retry-After in seconds and HTTP-date, idempotent methods only, POST never.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use nsh_core::platform::HttpRequest;
use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::{Error, RetryPolicy, format_http_date};
use nsh_testing::{StubHandler, StubReply, StubRoute};

use common::{Fixture, ORIGIN_MS, TEST_BASE, json, json_with_headers, route};

// --- pipeline behavior --------------------------------------------------------

struct Flaky;

static FLAKY: OnceLock<Fixture<Flaky>> = OnceLock::new();

/// Two 503s with `Retry-After: 1`, then success: three attempts, waits of
/// exactly 1000 ms each (Retry-After, no jitter).
fn flaky_rig() -> common::Rig {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let handler: StubHandler = Arc::new(move |_request: HttpRequest, reply: StubReply| {
        let hit = counter.fetch_add(1, Ordering::SeqCst);
        if hit < 2 {
            reply.send(json_with_headers(
                503,
                r#"{"error":"later"}"#,
                &[("retry-after", "1")],
            ));
        } else {
            reply.send(json(200, r#"{"ok":true}"#));
        }
    });
    Fixture::start(
        &FLAKY,
        vec![(
            format!("GET {TEST_BASE}/flaky"),
            StubRoute::Handler(handler),
        )],
        |builder| {
            builder
                .retry(RetryPolicy::new(3).with_base_delay_ms(10).with_jitter(0.0))
                .build()
        },
        Flaky,
        |_| Root::of::<FlakyApp>(),
    )
}

#[component]
fn FlakyApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = FLAKY
        .get()
        .expect("flaky_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let outcome = client.get::<serde_json::Value>("/flaky").await;
        scenario
            .lines
            .update(|all| all.push(format!("flaky {}", outcome.is_ok())));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn retries_honor_retry_after_seconds_and_then_succeed() {
    let mut rig = flaky_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "flaky true"));

    let events = rig.events.lock().unwrap();
    assert_eq!(events.len(), 3, "two retries after two 503s");
    // Retry-After: 1 is honored: each retry starts at least a second after
    // the attempt before it (the clock moves in frames, so waits quantize).
    let wait_1 = events[1].started_at_ms - events[0].started_at_ms;
    let wait_2 = events[2].started_at_ms - events[1].started_at_ms;
    assert!(wait_1 >= 1_000, "first retry waits Retry-After: {wait_1}");
    assert!(wait_2 >= 1_000, "second retry waits Retry-After: {wait_2}");
}

static DATED: OnceLock<Fixture<()>> = OnceLock::new();

fn dated_rig() -> common::Rig {
    let handler: StubHandler = Arc::new(|_request: HttpRequest, reply: StubReply| {
        // Retry-After as an HTTP-date two seconds after the manual clock's origin.
        let at = format_http_date(ORIGIN_MS as f64 + 2_000.0);
        reply.send(json_with_headers(
            503,
            "{}",
            &[("retry-after", at.as_str())],
        ));
    });
    Fixture::start(
        &DATED,
        vec![(
            format!("GET {TEST_BASE}/dated"),
            StubRoute::Handler(handler),
        )],
        |builder| {
            builder
                .retry(RetryPolicy::new(2).with_base_delay_ms(10).with_jitter(0.0))
                .build()
        },
        (),
        |_| Root::of::<DatedApp>(),
    )
}

#[component]
fn DatedApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = DATED.get().expect("fixture").client.clone();
    spawn(async move {
        // Both attempts answer 503 with the same future date: the retry waits
        // until then, then gives up with the status error.
        let outcome = client.get::<serde_json::Value>("/dated").await;
        scenario.lines.update(|all| {
            all.push(format!(
                "dated {}",
                matches!(outcome, Err(Error::HttpStatus { status: 503, .. }))
            ))
        });
        done.set(true);
    });
    scenario.view()
}

#[test]
fn retries_honor_retry_after_as_an_http_date() {
    let mut rig = dated_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "dated true"));

    let events = rig.events.lock().unwrap();
    // The date is two seconds out: each retry waits until then, and the
    // policy (2 retries) bounds the attempts at three.
    assert_eq!(events.len(), 3, "first try + 2 date-spaced retries");
    let wait_1 = events[1].started_at_ms - events[0].started_at_ms;
    let wait_2 = events[2].started_at_ms - events[1].started_at_ms;
    // The date is absolute: the first wait eats most of it and the retries
    // converge ON the named time (a frame or two of slop), never on the
    // 10 ms backoff.
    assert!(
        wait_1 >= 1_500,
        "the HTTP-date names the first retry: {wait_1}"
    );
    assert!(
        wait_1 + wait_2 <= 2_100,
        "the retries converge on the date: {wait_1} + {wait_2}"
    );
    assert!(
        events[2].started_at_ms <= ORIGIN_MS + 2_100,
        "the last attempt stands at the named date, not past it"
    );
}

static POSTS: OnceLock<Fixture<()>> = OnceLock::new();

/// A POST answered 503 with Retry-After: 1: retried methods that may change
/// state never go again by default.
fn posts_rig() -> common::Rig {
    let handler: StubHandler = Arc::new(|_request: HttpRequest, reply: StubReply| {
        reply.send(json_with_headers(503, "{}", &[("retry-after", "1")]));
    });
    Fixture::start(
        &POSTS,
        vec![(
            format!("POST {TEST_BASE}/charge"),
            StubRoute::Handler(handler),
        )],
        // Retries enabled: the method alone must stop them.
        |builder| {
            builder
                .retry(RetryPolicy::new(3).with_base_delay_ms(10).with_jitter(0.0))
                .build()
        },
        (),
        |_| Root::of::<PostsApp>(),
    )
}

#[component]
fn PostsApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = POSTS.get().expect("fixture").client.clone();
    spawn(async move {
        let outcome = client
            .post::<_, serde_json::Value>("/charge", &serde_json::json!({"amount": 1}))
            .await;
        scenario.lines.update(|all| {
            all.push(format!(
                "post {}",
                matches!(outcome, Err(Error::HttpStatus { status: 503, .. }))
            ))
        });
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_post_never_retries_by_default() {
    let mut rig = posts_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "post true"));
    assert_eq!(rig.network.requests().len(), 1, "one send, no retry");
}

static OFFLINE: OnceLock<Fixture<()>> = OnceLock::new();

/// A GET against a dead transport retries on backoff (10 ms base, no jitter)
/// until the policy runs out: three sends, then the network error stands.
fn offline_rig() -> common::Rig {
    Fixture::start(
        &OFFLINE,
        vec![route(
            &format!("GET {TEST_BASE}/offline"),
            common::failing("io: Connection refused (os error 61)"),
        )],
        |builder| {
            builder
                .retry(RetryPolicy::new(2).with_base_delay_ms(10).with_jitter(0.0))
                .build()
        },
        (),
        |_| Root::of::<OfflineApp>(),
    )
}

#[component]
fn OfflineApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = OFFLINE.get().expect("fixture").client.clone();
    spawn(async move {
        let outcome = client.get::<serde_json::Value>("/offline").await;
        scenario.lines.update(|all| {
            all.push(format!(
                "offline {}",
                matches!(outcome, Err(Error::Network { .. }))
            ))
        });
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_get_retries_on_backoff_until_the_policy_runs_out() {
    let mut rig = offline_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "offline true"));
    let events = rig.events.lock().unwrap();
    assert_eq!(events.len(), 3, "first try + 2 retries");
    let wait_1 = events[1].started_at_ms - events[0].started_at_ms;
    let wait_2 = events[2].started_at_ms - events[1].started_at_ms;
    assert!(wait_1 >= 10, "first backoff = base delay: {wait_1}");
    assert!(wait_2 >= 20, "second backoff = base * 2: {wait_2}");
    assert!(wait_2 > wait_1, "the backoff grows");
}

// --- policy math (no engine involved) -----------------------------------------

#[test]
fn the_policy_only_retries_idempotent_methods_by_default_and_never_a_started_stream() {
    let policy = RetryPolicy::new(2);
    let network = Error::Network {
        message: "io: down".to_owned(),
    };
    assert!(policy.should_retry("GET", &network, false, 1));
    assert!(policy.should_retry("DELETE", &network, false, 2));
    assert!(
        !policy.should_retry("GET", &network, false, 3),
        "retries exhausted"
    );
    assert!(!policy.should_retry("POST", &network, false, 1));
    assert!(!policy.should_retry("PATCH", &network, false, 1));
    assert!(
        !policy.should_retry("GET", &network, true, 1),
        "a started body stream never retries"
    );
    assert!(
        RetryPolicy::new(2)
            .for_all_methods()
            .should_retry("POST", &network, false, 1),
        "an explicit all-methods policy may retry a POST"
    );
    // Refusals and decode failures are final even for a GET.
    assert!(!policy.should_retry(
        "GET",
        &Error::RefusedByCapability {
            message: "no".to_owned()
        },
        false,
        1
    ));
    assert!(!policy.should_retry(
        "GET",
        &Error::Decode {
            message: "bad".to_owned(),
            body: String::new()
        },
        false,
        1
    ));
}

#[test]
fn backoff_grows_and_jitter_stays_inside_the_policy() {
    let exact = RetryPolicy::new(3)
        .with_base_delay_ms(100)
        .with_max_delay_ms(1_000)
        .with_jitter(0.0);
    let mut noise = 7_u64;
    assert_eq!(exact.delay_ms(1, None, &mut noise), 100);
    assert_eq!(exact.delay_ms(2, None, &mut noise), 200);
    assert_eq!(exact.delay_ms(3, None, &mut noise), 400);
    assert_eq!(exact.delay_ms(4, None, &mut noise), 800);
    assert_eq!(exact.delay_ms(5, None, &mut noise), 1_000, "capped at max");

    // Jitter of ±50% keeps every sampled delay within half of the backoff.
    let jittery = RetryPolicy::new(3)
        .with_base_delay_ms(100)
        .with_max_delay_ms(1_000)
        .with_jitter(0.5);
    let mut noise = 1_u64;
    for attempt in 1..=6_u32 {
        let delay = jittery.delay_ms(attempt, Some(Duration::from_millis(7_000)), &mut noise);
        assert_eq!(delay, 1_000, "Retry-After is honored, capped at the max");
        let delay = jittery.delay_ms(attempt, None, &mut noise);
        let backoff = (100_u64 << (attempt - 1).min(16)).min(1_000);
        assert!(
            delay >= backoff / 2 && delay <= backoff * 3 / 2,
            "attempt {attempt}: {delay} within ±50% of {backoff}"
        );
    }
    assert_eq!(RetryPolicy::off().max_retries(), 0, "off() retries nothing");
}

#[test]
fn retry_after_parses_seconds_and_http_dates() {
    assert_eq!(
        nsh_http::parse_retry_after("120", ORIGIN_MS as f64),
        Some(Duration::from_secs(120))
    );
    // A date in the past waits nothing.
    let past = format_http_date(ORIGIN_MS as f64 - 60_000.0);
    assert_eq!(
        nsh_http::parse_retry_after(&past, ORIGIN_MS as f64),
        Some(Duration::ZERO)
    );
    let round_trip = format_http_date(ORIGIN_MS as f64);
    assert_eq!(
        nsh_http::parse_http_date(&round_trip),
        Some(ORIGIN_MS as f64),
        "{round_trip} parses back to its own ms"
    );
    assert_eq!(nsh_http::parse_retry_after("soon", ORIGIN_MS as f64), None);
    assert!(nsh_http::is_idempotent("GET"));
    assert!(!nsh_http::is_idempotent("POST"));
    assert!(!nsh_http::is_idempotent("patch"));
    assert!(nsh_http::is_idempotent("put"));
}
