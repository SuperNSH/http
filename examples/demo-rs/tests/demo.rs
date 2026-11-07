//! Headless: the demo suite on `StubNetwork` and a manual clock — the stub
//! `/slow` answers after 50 manual milliseconds and the refresh timer moves
//! with the clock. No server, no real time. The routes' base mirrors the
//! app's own port resolution (`ECHO_PORT`, else `.runtime.json`, else 8123),
//! so the tests hold wherever the pinned server is.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use nsh_core::platform::HttpRequest;
use nsh_engine::{Clock, EngineConfig, Root};
use nsh_testing::{Headless, StubHandler, StubNetwork, StubReply, StubResponse, StubRoute};

/// The port the app under test resolves, by the same steps as
/// `nsh_app_demo_rs`'s private `echo_port`.
fn echo_base() -> String {
    if let Ok(raw) = std::env::var("ECHO_PORT") {
        return format!("http://127.0.0.1:{raw}");
    }
    let runtime = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/echo-server/.runtime.json");
    if let Ok(raw) = std::fs::read_to_string(&runtime)
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw)
        && let Some(port) = value.get("port").and_then(|port| port.as_u64())
    {
        return format!("http://127.0.0.1:{port}");
    }
    "http://127.0.0.1:8123".to_owned()
}

fn json(status: u16, body: &str) -> StubResponse {
    let mut response = StubResponse::default();
    response.status = status;
    response.headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    response.body = body.as_bytes().to_vec();
    response
}

fn delayed(mut response: StubResponse, delay: Duration) -> StubResponse {
    response.delay = delay;
    response
}

struct Rig {
    app: Headless,
    network: Arc<StubNetwork>,
}

fn rig() -> Rig {
    let base = echo_base();
    // The stub /token speaks the echo server's contract: only `Bearer
    // refreshed` passes, so every send 401s until the refresh replays.
    let token: StubHandler = Arc::new(move |request: HttpRequest, reply: StubReply| {
        let bearer = request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .map(|(_, value)| value.as_str());
        if bearer == Some("Bearer refreshed") {
            reply.send(json(200, r#"{"ok":true}"#));
        } else {
            reply.send(json(401, r#"{"error":"expired"}"#));
        }
    });
    let routes = vec![
        (
            format!("GET {base}/fast"),
            StubRoute::Response(json(200, r#"{"route":"fast"}"#)),
        ),
        (
            format!("GET {base}/slow?delay=1200"),
            StubRoute::Response(delayed(
                json(200, r#"{"route":"slow","delay":1200}"#),
                Duration::from_millis(50),
            )),
        ),
        (format!("POST {base}/token"), StubRoute::Handler(token)),
    ];
    let network = Arc::new(StubNetwork::new(routes));
    let mut config = EngineConfig::new(Root::of::<nsh_app_demo_rs::App>());
    config.clock = Clock::manual(SystemTime::UNIX_EPOCH + Duration::from_millis(1_767_258_000_000));
    config.network = Some(network.clone());
    Rig {
        app: Headless::start(config).unwrap(),
        network,
    }
}

fn shows_containing(app: &Headless, needle: &str) -> bool {
    app.screen()
        .texts()
        .iter()
        .any(|text| text.contains(needle))
}

#[test]
fn the_demo_runs_fast_slow_and_one_shared_refresh_on_stubs() {
    let mut rig = rig();
    rig.app.wait_for("text:DEMO-RS-DONE").unwrap();
    assert!(
        shows_containing(&rig.app, "fast 200 fast"),
        "the fast call decoded"
    );
    assert!(
        shows_containing(&rig.app, "slow 200 1200"),
        "the slow call decoded"
    );
    assert!(
        shows_containing(&rig.app, "refresh 1"),
        "exactly one refresh"
    );
    assert!(
        shows_containing(&rig.app, "done 3"),
        "all three posts succeeded"
    );
    assert!(shows_containing(&rig.app, "failed 0"), "none failed");
    // Three sends plus three replays, every replay carrying the fresh token.
    let requests = rig.network.requests();
    let posts: Vec<_> = requests
        .iter()
        .filter(|request| request.method == "POST")
        .collect();
    assert_eq!(posts.len(), 6, "three sends plus three replays");
    assert_eq!(
        posts
            .iter()
            .filter(|request| request
                .headers
                .iter()
                .any(|(name, value)| name.eq_ignore_ascii_case("authorization")
                    && value == "Bearer refreshed"))
            .count(),
        3,
        "the replays carried the refreshed token"
    );
    // The observer stamped each attempt with its duration.
    assert!(
        shows_containing(&rig.app, "event /slow "),
        "the slow attempt was observed"
    );
}
