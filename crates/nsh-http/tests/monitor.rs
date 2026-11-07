//! Behavior rows 11-12 (monitor): ring-buffer eviction, aggregates math
//! (count, error rate, p50, p95) on the manual clock, redaction — a token in
//! a URL or a header never appears in a recorded event (criterion 8) —
//! sampling, the client's observer seam, the standalone instrumented fetch,
//! and the frozen NetworkEvent wire shape. No real network: stubs and the
//! manual clock only.

mod common;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use nsh_core::platform::HttpRequest;
use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::monitor::{Monitor, Sampling};
use nsh_http::{BoxFuture, CallOptions, NetworkEvent, RetryPolicy, Transport};

use common::{Fixture, ORIGIN_MS, TEST_BASE, delayed, json, route, shows_containing};

/// One hand-built attempt for the pure-unit tests: GET `https://{host}{path}`,
/// the given duration, everything else fixed.
fn event(id: &str, host: &str, path: &str, duration_ms: u64, error: Option<&str>) -> NetworkEvent {
    NetworkEvent {
        id: id.to_owned(),
        method: "GET".to_owned(),
        url: format!("https://{host}{path}"),
        host: host.to_owned(),
        path: path.to_owned(),
        status: error.is_none().then_some(200),
        started_at_ms: ORIGIN_MS,
        duration_ms,
        ttfb_ms: None,
        request_bytes: Some(0),
        response_bytes: Some(64),
        error: error.map(str::to_owned),
        initiator: None,
    }
}

// --- Row 11: ring buffer and aggregates -------------------------------------

#[test]
fn ring_buffer_evicts_oldest_past_capacity() {
    let monitor = Monitor::builder().capacity(3).build();
    for i in 0..5 {
        monitor.record(&event(&format!("e{i}"), "h.test", "/p", 10, None));
    }
    let ids: Vec<String> = monitor.events().iter().map(|e| e.id.clone()).collect();
    assert_eq!(ids, ["e2", "e3", "e4"], "the oldest events leave first");
    assert_eq!(
        monitor.host_stats()["h.test"].count,
        3,
        "aggregates cover the retained events only"
    );
}

#[test]
fn aggregates_use_nearest_rank_percentiles() {
    let monitor = Monitor::new();
    // Durations shuffled on purpose; the monitor must sort them itself.
    monitor.record(&event("e0", "h.test", "/a", 10, None));
    monitor.record(&event("e1", "h.test", "/a", 30, None));
    monitor.record(&event("e2", "h.test", "/a", 20, Some("network: io: reset")));
    monitor.record(&event("e3", "h.test", "/b", 40, None));
    monitor.record(&event("e4", "h.test", "/b", 50, None));

    let host = &monitor.host_stats()["h.test"];
    assert_eq!((host.count, host.errors), (5, 1));
    assert!((host.error_rate - 0.2).abs() < 1e-9);
    // Sorted [10,20,30,40,50]: p50 is the 3rd, p95 the 5th.
    assert_eq!(host.p50_ms, Some(30));
    assert_eq!(host.p95_ms, Some(50));

    let paths = monitor.path_stats();
    let a = &paths["/a"];
    assert_eq!((a.count, a.errors), (3, 1));
    assert!((a.error_rate - 1.0 / 3.0).abs() < 1e-9);
    // Sorted [10,20,30]: p50 is the 2nd, p95 the 3rd.
    assert_eq!((a.p50_ms, a.p95_ms), (Some(20), Some(30)));
    let b = &paths["/b"];
    assert_eq!((b.count, b.errors), (2, 0));
    assert_eq!(b.error_rate, 0.0);
    // Sorted [40,50]: p50 is the 1st, p95 the 2nd.
    assert_eq!((b.p50_ms, b.p95_ms), (Some(40), Some(50)));

    // Even sizes: sorted [3,5,7,9] — p50 the 2nd, p95 the 4th. One attempt:
    // both percentiles are the attempt itself.
    let even = Monitor::new();
    even.record(&event("x0", "h.test", "/x", 7, None));
    even.record(&event("x1", "h.test", "/x", 3, None));
    even.record(&event("x2", "h.test", "/x", 9, None));
    even.record(&event("x3", "h.test", "/x", 5, None));
    let x = &even.path_stats()["/x"];
    assert_eq!((x.p50_ms, x.p95_ms), (Some(5), Some(9)));
    let single = Monitor::new();
    single.record(&event("s0", "h.test", "/s", 42, None));
    let s = &single.path_stats()["/s"];
    assert_eq!((s.p50_ms, s.p95_ms), (Some(42), Some(42)));
}

#[component]
fn WiringApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = WIRING
        .get()
        .expect("wiring_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        for path in ["/d0", "/d40", "/d80", "/d160", "/d320"] {
            let _ = client.get::<serde_json::Value>(path).await;
        }
        let _ = client.get::<serde_json::Value>("/dead").await;
        done.set(true);
    });
    scenario.view()
}

static WIRING: OnceLock<Fixture<Arc<Monitor>>> = OnceLock::new();

/// Six client attempts on the manual clock: delays 0/40/80/160/320 ms and one
/// transport failure (no retries), all fed to the monitor through its observer.
fn wiring_rig() -> common::Rig {
    let monitor = Arc::new(Monitor::new());
    Fixture::start(
        &WIRING,
        vec![
            route(&format!("GET {TEST_BASE}/d0"), json(200, r#"{"d":0}"#)),
            route(
                &format!("GET {TEST_BASE}/d40"),
                delayed(json(200, r#"{"d":40}"#), Duration::from_millis(40)),
            ),
            route(
                &format!("GET {TEST_BASE}/d80"),
                delayed(json(200, r#"{"d":80}"#), Duration::from_millis(80)),
            ),
            route(
                &format!("GET {TEST_BASE}/d160"),
                delayed(json(200, r#"{"d":160}"#), Duration::from_millis(160)),
            ),
            route(
                &format!("GET {TEST_BASE}/d320"),
                delayed(json(200, r#"{"d":320}"#), Duration::from_millis(320)),
            ),
            route(
                &format!("GET {TEST_BASE}/dead"),
                common::failing("io: connection reset"),
            ),
        ],
        {
            let monitor = monitor.clone();
            move |builder| {
                builder
                    .retry(RetryPolicy::new(0))
                    .observe(monitor.observer())
                    .build()
            }
        },
        monitor,
        |_| Root::of::<WiringApp>(),
    )
}

#[test]
fn client_attempts_feed_host_and_path_aggregates_on_the_manual_clock() {
    let mut rig = wiring_rig();
    rig.app.wait_for("text:waiting").unwrap();
    rig.app.run_for(Duration::from_millis(1_000)).unwrap();
    rig.app.wait_for("text:done").unwrap();

    let monitor = WIRING.get().unwrap().extra.clone();
    assert_eq!(
        monitor.events().len(),
        6,
        "one event per attempt, no retries"
    );

    // Sorted durations ≈ [0, 0, 40, 80, 160, 320]: p50 is the 3rd (the 40 ms
    // attempt), p95 the 6th (the 320 ms attempt); the manual clock keeps the
    // attempts at their delays, so tight bounds around the exact values hold.
    let host = &monitor.host_stats()["127.0.0.1"];
    assert_eq!((host.count, host.errors), (6, 1));
    assert!((host.error_rate - 1.0 / 6.0).abs() < 1e-9);
    assert!(
        (35..=60).contains(&host.p50_ms.unwrap()),
        "p50 {:?} should sit at the 40 ms attempt",
        host.p50_ms
    );
    assert!(
        (300..=340).contains(&host.p95_ms.unwrap()),
        "p95 {:?} should sit at the 320 ms attempt",
        host.p95_ms
    );

    let paths = monitor.path_stats();
    let d40 = &paths["/d40"];
    assert_eq!(d40.count, 1);
    assert!(
        (35..=55).contains(&d40.p50_ms.unwrap()),
        "p50 {:?} should sit at the route's 40 ms delay",
        d40.p50_ms
    );
    assert_eq!(
        d40.p50_ms, d40.p95_ms,
        "one attempt: both percentiles are it"
    );
    assert!(
        (300..=335).contains(&paths["/d320"].p50_ms.unwrap()),
        "the slow route's own percentile"
    );
    let dead = &paths["/dead"];
    assert_eq!((dead.count, dead.errors), (1, 1));
    assert_eq!(dead.error_rate, 1.0);

    // A live client-fed event carries exactly the frozen keys, no extras.
    let wire = serde_json::to_value(&monitor.events()[0]).unwrap();
    let mut keys: Vec<&str> = wire
        .as_object()
        .expect("the event serializes to an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "durationMs",
            "error",
            "host",
            "id",
            "initiator",
            "method",
            "path",
            "requestBytes",
            "responseBytes",
            "startedAtMs",
            "status",
            "ttfbMs",
            "url",
        ]
    );
}

// --- Row 12: redaction (criterion 8), sampling, standalone fetch -------------

#[component]
fn UrlApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = URL_SECRET
        .get()
        .expect("url_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let options = CallOptions::new()
            .query("access_token", "URL-SECRET-99")
            .query("keep", "1");
        let _ = client.get_with::<serde_json::Value>("/get", &options).await;
        done.set(true);
    });
    scenario.view()
}

static URL_SECRET: OnceLock<Fixture<Arc<Monitor>>> = OnceLock::new();

fn url_rig() -> common::Rig {
    let monitor = Arc::new(Monitor::new());
    Fixture::start(
        &URL_SECRET,
        vec![route(
            &format!("GET {TEST_BASE}/get?access_token=URL-SECRET-99&keep=1"),
            json(200, r#"{"ok":true}"#),
        )],
        {
            let monitor = monitor.clone();
            move |builder| builder.observe(monitor.observer()).build()
        },
        monitor,
        |_| Root::of::<UrlApp>(),
    )
}

#[test]
fn a_token_in_the_url_never_reaches_a_recorded_event() {
    let mut rig = url_rig();
    // No delayed route: the scenario completes on its own pump.
    rig.app.wait_for("text:done").unwrap();

    let monitor = URL_SECRET.get().unwrap().extra.clone();
    let events = monitor.events();
    assert_eq!(events.len(), 1);
    let recorded = &events[0];
    assert_eq!(
        recorded.url,
        format!("{TEST_BASE}/get?access_token=[redacted]&keep=1"),
        "the pair keeps its shape, the value is gone"
    );
    assert_eq!(recorded.host, "127.0.0.1");
    assert_eq!(recorded.path, "/get");
    assert_eq!(
        recorded.status,
        Some(200),
        "redaction never blocks the call"
    );
    let wire = serde_json::to_string(recorded).unwrap();
    assert!(
        !wire.contains("URL-SECRET-99"),
        "criterion 8: the token leaked into {wire}"
    );
}

/// A transport whose failure echoes the request's headers, as stacks that
/// debug-print the request do: tuple-debug and `name: value` shapes.
struct EchoTransport;

impl Transport for EchoTransport {
    fn fetch(
        &self,
        request: HttpRequest,
    ) -> BoxFuture<Result<nsh_core::prelude::HttpResponse, String>> {
        Box::pin(async move {
            Err(format!(
                "io: send failed for {} {} (\"authorization\", \"Bearer HDR-SECRET-456\") \
                 cookie: session=COOKIE-SECRET-7 (\"x-api-key\", \"API-SECRET-10\") \
                 set-cookie: sid=SET-SECRET-8",
                request.method, request.url
            ))
        })
    }
}

#[component]
fn HeaderApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = HEADER_SECRET
        .get()
        .expect("header_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let _ = client.get::<serde_json::Value>("/private").await;
        done.set(true);
    });
    scenario.view()
}

static HEADER_SECRET: OnceLock<Fixture<Arc<Monitor>>> = OnceLock::new();

fn header_rig() -> common::Rig {
    let monitor = Arc::new(Monitor::new());
    Fixture::start(
        &HEADER_SECRET,
        vec![],
        {
            let monitor = monitor.clone();
            move |builder| {
                builder
                    .retry(RetryPolicy::new(0))
                    .observe(monitor.observer())
                    .transport(Arc::new(EchoTransport))
                    .build()
            }
        },
        monitor,
        |_| Root::of::<HeaderApp>(),
    )
}

#[test]
fn header_tokens_never_reach_a_recorded_event() {
    let mut rig = header_rig();
    rig.app.wait_for("text:done").unwrap();

    let monitor = HEADER_SECRET.get().unwrap().extra.clone();
    let events = monitor.events();
    assert_eq!(events.len(), 1);
    let recorded = &events[0];
    assert_eq!(recorded.status, None);
    assert!(
        recorded
            .error
            .as_deref()
            .is_some_and(|message| message.contains("[redacted]")),
        "the masked message keeps a placeholder: {:?}",
        recorded.error
    );
    let wire = serde_json::to_string(recorded).unwrap();
    for secret in [
        "HDR-SECRET-456",
        "COOKIE-SECRET-7",
        "API-SECRET-10",
        "SET-SECRET-8",
    ] {
        assert!(
            !wire.contains(secret),
            "criterion 8: {secret} leaked into {wire}"
        );
    }
}

#[test]
fn redaction_is_on_by_default_and_the_opt_out_records_raw() {
    let leak = NetworkEvent {
        id: "leak".to_owned(),
        method: "GET".to_owned(),
        url: "https://h.test/p?access_token=OPTOUT-SECRET-1".to_owned(),
        host: "h.test".to_owned(),
        path: "/p".to_owned(),
        status: None,
        started_at_ms: ORIGIN_MS,
        duration_ms: 5,
        ttfb_ms: None,
        request_bytes: Some(0),
        response_bytes: None,
        error: Some("refused: authorization: Bearer OPTOUT-SECRET-2 not granted".to_owned()),
        initiator: Some("cookie: session=OPTOUT-SECRET-3".to_owned()),
    };
    let on = Monitor::new();
    on.record(&leak);
    let off = Monitor::builder().redact(false).build();
    off.record(&leak);

    let masked = &on.events()[0];
    assert_eq!(masked.url, "https://h.test/p?access_token=[redacted]");
    let masked_wire = serde_json::to_string(masked).unwrap();
    for secret in ["OPTOUT-SECRET-1", "OPTOUT-SECRET-2", "OPTOUT-SECRET-3"] {
        assert!(
            !masked_wire.contains(secret),
            "the default redacts {secret}: {masked_wire}"
        );
    }

    let raw = &off.events()[0];
    assert!(
        raw.url.contains("OPTOUT-SECRET-1")
            && raw
                .error
                .as_deref()
                .is_some_and(|e| e.contains("OPTOUT-SECRET-2"))
            && raw
                .initiator
                .as_deref()
                .is_some_and(|i| i.contains("OPTOUT-SECRET-3")),
        "redact(false) records raw, by contract"
    );
}

#[test]
fn sampling_keeps_every_nth_attempt() {
    let monitor = Monitor::builder().sampling(Sampling::Every(3)).build();
    for i in 0..7 {
        monitor.record(&event(&format!("e{i}"), "h.test", "/p", 10, None));
    }
    let ids: Vec<String> = monitor.events().iter().map(|e| e.id.clone()).collect();
    assert_eq!(ids, ["e0", "e3", "e6"], "the first, then every third");
    assert_eq!(monitor.host_stats()["h.test"].count, 3);
    assert_eq!(
        monitor.events()[0].id,
        "e0",
        "the first attempt is always kept"
    );
}

#[test]
fn sampling_rate_bounds_hold_exactly() {
    let none = Monitor::builder().sampling(Sampling::Rate(0.0)).build();
    let all = Monitor::builder().sampling(Sampling::Rate(1.0)).build();
    for i in 0..8 {
        let attempt = event(&format!("e{i}"), "h.test", "/p", 10, None);
        none.record(&attempt);
        all.record(&attempt);
    }
    assert!(none.events().is_empty(), "rate 0.0 keeps nothing");
    assert_eq!(all.events().len(), 8, "rate 1.0 keeps everything");
}

#[test]
fn the_recorded_event_serializes_to_the_frozen_wire_shape() {
    let monitor = Monitor::new();
    monitor.record(&NetworkEvent {
        id: "w-ok".to_owned(),
        method: "GET".to_owned(),
        url: "https://api.example.com/v1/things?page=2".to_owned(),
        host: "api.example.com".to_owned(),
        path: "/v1/things".to_owned(),
        status: Some(200),
        started_at_ms: 1_767_258_000_123,
        duration_ms: 42,
        ttfb_ms: None,
        request_bytes: Some(0),
        response_bytes: Some(357),
        error: None,
        initiator: None,
    });
    monitor.record(&NetworkEvent {
        id: "w-fail".to_owned(),
        method: "POST".to_owned(),
        url: "https://api.example.com/v1/things".to_owned(),
        host: "api.example.com".to_owned(),
        path: "/v1/things".to_owned(),
        status: None,
        started_at_ms: 1_767_258_001_000,
        duration_ms: 1_004,
        ttfb_ms: None,
        request_bytes: Some(24),
        response_bytes: None,
        error: Some("network: io: connection reset".to_owned()),
        initiator: Some("pull-to-refresh".to_owned()),
    });

    // Whole-object equality: the frozen keys, nothing missing, nothing extra,
    // nulls exactly where the shape says (`ttfbMs` is null on Rust,
    // docs/decision.md).
    assert_eq!(
        serde_json::to_value(&monitor.events()[0]).unwrap(),
        serde_json::json!({
            "id": "w-ok",
            "method": "GET",
            "url": "https://api.example.com/v1/things?page=2",
            "host": "api.example.com",
            "path": "/v1/things",
            "status": 200,
            "startedAtMs": 1_767_258_000_123_u64,
            "durationMs": 42,
            "ttfbMs": null,
            "requestBytes": 0,
            "responseBytes": 357,
            "error": null,
            "initiator": null,
        })
    );
    assert_eq!(
        serde_json::to_value(&monitor.events()[1]).unwrap(),
        serde_json::json!({
            "id": "w-fail",
            "method": "POST",
            "url": "https://api.example.com/v1/things",
            "host": "api.example.com",
            "path": "/v1/things",
            "status": null,
            "startedAtMs": 1_767_258_001_000_u64,
            "durationMs": 1_004,
            "ttfbMs": null,
            "requestBytes": 24,
            "responseBytes": null,
            "error": "network: io: connection reset",
            "initiator": "pull-to-refresh",
        })
    );
}

#[component]
fn StandaloneApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let lines = scenario.lines;
    let monitor = STANDALONE
        .get()
        .expect("standalone_rig() builds the fixture before the app mounts")
        .extra
        .clone();
    spawn(async move {
        let ok = monitor.fetch(format!("{TEST_BASE}/alone")).await;
        let keyed = monitor
            .fetch(HttpRequest::get(format!(
                "{TEST_BASE}/keyed?token=FETCH-SECRET-3"
            )))
            .await;
        let dead = monitor.fetch(format!("{TEST_BASE}/gone")).await;
        lines.update(|lines| {
            lines.push(format!(
                "ok={}",
                ok.as_ref().map(|r| r.status()).unwrap_or(0)
            ));
            lines.push(format!("keyed={}", keyed.is_ok()));
            lines.push(format!("dead={:?}", dead.err().map(|e| e.to_string())));
        });
        done.set(true);
    });
    scenario.view()
}

static STANDALONE: OnceLock<Fixture<Arc<Monitor>>> = OnceLock::new();

fn standalone_rig() -> common::Rig {
    let monitor = Arc::new(Monitor::new());
    Fixture::start(
        &STANDALONE,
        vec![
            route(
                &format!("GET {TEST_BASE}/alone"),
                json(200, r#"{"route":"alone"}"#),
            ),
            route(
                &format!("GET {TEST_BASE}/keyed?token=FETCH-SECRET-3"),
                json(200, "{}"),
            ),
            route(
                &format!("GET {TEST_BASE}/gone"),
                common::failing("io: connection reset"),
            ),
        ],
        // No observer on the client: the monitor records its own fetches.
        |builder| builder.build(),
        monitor,
        |_| Root::of::<StandaloneApp>(),
    )
}

#[test]
fn the_instrumented_fetch_records_each_attempt() {
    let mut rig = standalone_rig();
    rig.app.wait_for("text:done").unwrap();

    assert!(
        shows_containing(&rig.app, "ok=200"),
        "the instrumented fetch returns the response itself"
    );
    assert!(shows_containing(&rig.app, "keyed=true"));
    assert!(
        shows_containing(&rig.app, "network: io: connection reset"),
        "failures come back classified, not raw"
    );

    let monitor = STANDALONE.get().unwrap().extra.clone();
    let events = monitor.events();
    assert_eq!(events.len(), 3, "one event per fetch");

    let ok = &events[0];
    assert_eq!(ok.url, format!("{TEST_BASE}/alone"));
    assert_eq!((ok.status, ok.ttfb_ms), (Some(200), None));
    assert_eq!(ok.response_bytes, Some(17));
    assert_eq!(ok.error, None);
    assert!(
        ok.started_at_ms >= ORIGIN_MS,
        "the manual clock's wall time"
    );

    let keyed = &events[1];
    assert_eq!(
        keyed.url,
        format!("{TEST_BASE}/keyed?token=[redacted]"),
        "the instrumented path redacts too"
    );
    assert!(
        !serde_json::to_string(keyed)
            .unwrap()
            .contains("FETCH-SECRET-3"),
        "criterion 8 holds on the standalone path"
    );

    let dead = &events[2];
    assert_eq!(dead.status, None);
    assert_eq!(dead.response_bytes, None);
    assert_eq!(
        dead.error.as_deref(),
        Some("network: io: connection reset"),
        "classified through the same taxonomy as the client"
    );
    assert!(
        events
            .windows(2)
            .all(|pair| pair[1].started_at_ms >= pair[0].started_at_ms)
    );
}
