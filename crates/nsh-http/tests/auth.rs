//! Behavior row 7: the token provider with single-flight refresh on 401 —
//! ten parallel requests with an expired token cause exactly one refresh and
//! all ten succeed.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use nsh_core::platform::HttpRequest;
use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::{BoxFuture, Error, TokenProvider};
use nsh_testing::{StubHandler, StubReply, StubRoute};

use common::{Fixture, TEST_BASE, json};

/// The provider the fixture hands its client: it holds `expired` until a
/// refresh lands, then `fresh` for every later call. The refresh takes 50 ms
/// on the manual clock, so the other 401'd requests genuinely wait on one
/// flight.
struct Gate {
    current: Mutex<String>,
    refreshes: Arc<AtomicUsize>,
}

impl TokenProvider for Gate {
    fn token(&self) -> BoxFuture<Result<String, String>> {
        let current = self
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        Box::pin(async move { Ok(current) })
    }

    fn refresh(&self, _expired: &str) -> BoxFuture<Result<String, String>> {
        let refreshes = self.refreshes.clone();
        Box::pin(async move {
            nsh_core::prelude::timer(std::time::Duration::from_millis(50)).await;
            refreshes.fetch_add(1, Ordering::SeqCst);
            Ok("fresh".to_owned())
        })
    }
}

struct GateHandle {
    refreshes: Arc<AtomicUsize>,
    unauthorized: Arc<AtomicUsize>,
}

static AUTH: OnceLock<Fixture<GateHandle>> = OnceLock::new();

fn auth_rig() -> common::Rig {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let unauthorized = Arc::new(AtomicUsize::new(0));
    let count_401 = unauthorized.clone();
    let handler: StubHandler = Arc::new(move |request: HttpRequest, reply: StubReply| {
        let bearer = request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .map(|(_, value)| value.as_str());
        match bearer {
            Some("Bearer fresh") => reply.send(json(200, r#"{"ok":true}"#)),
            _ => {
                count_401.fetch_add(1, Ordering::SeqCst);
                reply.send(json(401, r#"{"error":"expired"}"#));
            }
        }
    });
    let gate = Arc::new(Gate {
        current: Mutex::new("expired".to_owned()),
        refreshes: refreshes.clone(),
    });
    Fixture::start(
        &AUTH,
        vec![(
            format!("GET {TEST_BASE}/things"),
            StubRoute::Handler(handler),
        )],
        |builder| {
            builder
                .token_provider(gate)
                .retry(nsh_http::RetryPolicy::off())
                .build()
        },
        GateHandle {
            refreshes,
            unauthorized,
        },
        |_| Root::of::<AuthApp>(),
    )
}

#[component]
fn AuthApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = AUTH
        .get()
        .expect("auth_rig() builds the fixture before the app mounts")
        .client
        .clone();
    // Ten calls, each its own task: they run together on the engine, hit the
    // same expired token, and share the one refresh.
    let pending = Arc::new(AtomicUsize::new(10));
    for n in 0..10_u32 {
        let client = client.clone();
        let lines = scenario.lines;
        let pending = pending.clone();
        spawn(async move {
            let ok = client.get::<serde_json::Value>("/things").await.is_ok();
            lines.update(|all| all.push(format!("call {n} ok={ok}")));
            if pending.fetch_sub(1, Ordering::SeqCst) == 1 {
                done.set(true);
            }
        });
    }
    scenario.view()
}

fn bearer_of(request: &HttpRequest) -> &str {
    request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.as_str())
        .unwrap_or("")
}

#[test]
fn ten_parallel_requests_share_one_refresh_and_all_replay() {
    let mut rig = auth_rig();
    rig.app.wait_for("text:done").unwrap();
    let handle = AUTH.get().expect("fixture");
    for n in 0..10 {
        assert!(
            common::shows_containing(&rig.app, &format!("call {n} ok=true")),
            "call {n} succeeded"
        );
    }
    assert_eq!(
        handle.extra.refreshes.load(Ordering::SeqCst),
        1,
        "exactly one refresh"
    );
    assert_eq!(
        handle.extra.unauthorized.load(Ordering::SeqCst),
        10,
        "every call saw its own 401 before the refresh"
    );
    // Ten 401s + ten replays.
    assert_eq!(rig.network.requests().len(), 20);
    // The replays carried the fresh token.
    assert!(
        rig.network
            .requests()
            .iter()
            .filter(|request| bearer_of(request) == "Bearer fresh")
            .count()
            >= 10
    );
}

// --- a refresh that fails -----------------------------------------------------

static REFUSAL_REFRESHES: OnceLock<AtomicUsize> = OnceLock::new();

fn refusal_refreshes() -> &'static AtomicUsize {
    REFUSAL_REFRESHES.get_or_init(|| AtomicUsize::new(0))
}

struct RefusingGate;

impl TokenProvider for RefusingGate {
    fn token(&self) -> BoxFuture<Result<String, String>> {
        Box::pin(async { Ok("always-stale".to_owned()) })
    }

    fn refresh(&self, _expired: &str) -> BoxFuture<Result<String, String>> {
        refusal_refreshes().fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err("refresh endpoint down".to_owned()) })
    }
}

static REFUSING: OnceLock<Fixture<()>> = OnceLock::new();

fn refusing_rig() -> common::Rig {
    Fixture::start(
        &REFUSING,
        vec![(
            format!("GET {TEST_BASE}/locked"),
            StubRoute::Response(json(401, r#"{"error":"no"}"#)),
        )],
        |builder| {
            builder
                .token_provider(Arc::new(RefusingGate))
                .retry(nsh_http::RetryPolicy::off())
                .build()
        },
        (),
        |_| Root::of::<RefusingApp>(),
    )
}

#[component]
fn RefusingApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = REFUSING
        .get()
        .expect("refusing_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let outcome = client.get::<serde_json::Value>("/locked").await;
        // A provider failure becomes a network error carrying its message.
        let failed = match outcome {
            Err(Error::Network { message }) => message.contains("refresh endpoint down"),
            _ => false,
        };
        scenario
            .lines
            .update(|all| all.push(format!("refresh-failed {failed}")));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_failing_refresh_fails_the_request_without_looping() {
    let mut rig = refusing_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "refresh-failed true"));
    assert_eq!(
        refusal_refreshes().load(Ordering::SeqCst),
        1,
        "one refresh attempt"
    );
    assert_eq!(
        rig.network.requests().len(),
        1,
        "no replay after the failed refresh"
    );
}

// --- a lead that dies mid-refresh ---------------------------------------------

struct RecoverHandle {
    refreshes: Arc<AtomicUsize>,
    unauthorized: Arc<AtomicUsize>,
}

/// The first refresh never resolves (its lead gets cancelled mid-flight);
/// every later refresh lands after 50 ms on the manual clock.
struct RecoveringGate {
    current: Arc<Mutex<String>>,
    refreshes: Arc<AtomicUsize>,
}

impl TokenProvider for RecoveringGate {
    fn token(&self) -> BoxFuture<Result<String, String>> {
        let current = self
            .current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        Box::pin(async move { Ok(current) })
    }

    fn refresh(&self, _expired: &str) -> BoxFuture<Result<String, String>> {
        let refreshes = self.refreshes.clone();
        let current = self.current.clone();
        Box::pin(async move {
            if refreshes.fetch_add(1, Ordering::SeqCst) == 0 {
                // Parked forever: nobody publishes this flight; its lead is
                // abandoned.
                return std::future::pending::<Result<String, String>>().await;
            }
            nsh_core::prelude::timer(std::time::Duration::from_millis(50)).await;
            *current
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = "fresh".to_owned();
            Ok("fresh".to_owned())
        })
    }
}

static RECOVER: OnceLock<Fixture<RecoverHandle>> = OnceLock::new();

fn recover_rig() -> common::Rig {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let unauthorized = Arc::new(AtomicUsize::new(0));
    let count_401 = unauthorized.clone();
    let handler: StubHandler = Arc::new(move |request: HttpRequest, reply: StubReply| {
        let bearer = request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .map(|(_, value)| value.as_str());
        match bearer {
            Some("Bearer fresh") => reply.send(json(200, r#"{"ok":true}"#)),
            _ => {
                count_401.fetch_add(1, Ordering::SeqCst);
                reply.send(json(401, r#"{"error":"expired"}"#));
            }
        }
    });
    let gate = Arc::new(RecoveringGate {
        current: Arc::new(Mutex::new("expired".to_owned())),
        refreshes: refreshes.clone(),
    });
    Fixture::start(
        &RECOVER,
        vec![(
            format!("GET {TEST_BASE}/things"),
            StubRoute::Handler(handler),
        )],
        |builder| {
            builder
                .token_provider(gate)
                .retry(nsh_http::RetryPolicy::off())
                .build()
        },
        RecoverHandle {
            refreshes,
            unauthorized,
        },
        |_| Root::of::<RecoverApp>(),
    )
}

#[component]
fn RecoverApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let lines = scenario.lines;
    let client = RECOVER
        .get()
        .expect("recover_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        // The lead claims the flight, then parks in a refresh that never
        // resolves.
        let lead_client = client.clone();
        let lead_lines = lines;
        let lead = spawn(async move {
            let _ = lead_client.get::<serde_json::Value>("/things").await;
            lead_lines.update(|all| all.push("lead-done".to_owned()));
        });
        // A tick: the lead reaches its 401 and claims the flight before the
        // follower starts.
        nsh_core::prelude::timer(std::time::Duration::from_millis(10)).await;
        let follower_client = client.clone();
        spawn(async move {
            let ok = follower_client
                .get::<serde_json::Value>("/things")
                .await
                .is_ok();
            lines.update(|all| all.push(format!("follower {ok}")));
        });
        // Another tick: the follower is parked on the lead's flight.
        nsh_core::prelude::timer(std::time::Duration::from_millis(10)).await;
        // The lead's task dies mid-refresh. Its guard must release the
        // follower, which claims the flight, refreshes for real, and replays.
        lead.cancel();
        nsh_core::prelude::timer(std::time::Duration::from_millis(500)).await;
        lines.update(|all| all.push("recovered".to_owned()));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_dropped_lead_releases_the_followers_instead_of_hanging_them() {
    let mut rig = recover_rig();
    rig.app.wait_for("text:done").unwrap();
    let handle = RECOVER.get().expect("fixture");
    assert!(
        common::shows_containing(&rig.app, "follower true"),
        "the follower recovered and replayed"
    );
    assert!(common::shows_containing(&rig.app, "recovered"));
    assert!(
        !rig.app.shows("lead-done"),
        "the cancelled lead never finished"
    );
    assert_eq!(
        handle.extra.refreshes.load(Ordering::SeqCst),
        2,
        "the abandoned refresh + the recovery one"
    );
    assert_eq!(
        handle.extra.unauthorized.load(Ordering::SeqCst),
        2,
        "one 401 each"
    );
    // Lead's 401 + follower's 401 + the follower's replay.
    assert_eq!(rig.network.requests().len(), 3);
}
