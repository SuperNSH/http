//! Behavior row 6: middleware reads and changes requests and responses, and
//! the order — first installed first on the request, last on the response —
//! is the thing the test proves.

mod common;

use std::sync::{Arc, Mutex, OnceLock};

use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::{BoxFuture, Error, Middleware, Next, Request, Response, RetryPolicy};

use common::{Fixture, TEST_BASE, json, route};

type Log = Arc<Mutex<Vec<String>>>;

fn note(log: &Log, event: &str) {
    log.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(event.to_owned());
}

/// A middleware as a closure, through the `Fn` blanket impl: logs its side on
/// the way in and on the way out.
fn trace(name: &'static str, log: Log) -> Arc<dyn Middleware> {
    Arc::new(
        move |request: Request, next: Next| -> BoxFuture<Result<Response, Error>> {
            let log = log.clone();
            Box::pin(async move {
                note(&log, &format!("{name}-req"));
                let response = next.run(request).await;
                note(
                    &log,
                    &match &response {
                        Ok(_) => format!("{name}-resp"),
                        Err(_) => format!("{name}-err"),
                    },
                );
                response
            })
        },
    )
}

static ORDER: OnceLock<Fixture<Log>> = OnceLock::new();

fn order_rig() -> common::Rig {
    let log: Log = Arc::default();
    let outer = log.clone();
    let inner = log.clone();
    Fixture::start(
        &ORDER,
        vec![route(
            &format!("GET {TEST_BASE}/order"),
            json(200, r#"{"name":"origin"}"#),
        )],
        |builder| {
            builder
                .middleware(trace("outer", outer))
                .middleware(trace("inner", inner))
                .retry(RetryPolicy::off())
                .build()
        },
        log.clone(),
        |_| Root::of::<OrderApp>(),
    )
}

#[component]
fn OrderApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = ORDER
        .get()
        .expect("order_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let outcome = client.get::<serde_json::Value>("/order").await;
        scenario
            .lines
            .update(|all| all.push(format!("order {}", outcome.is_ok())));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn middleware_runs_first_installed_first_on_the_request_and_last_on_the_response() {
    let mut rig = order_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "order true"));
    let log = ORDER.get().expect("fixture").extra.lock().unwrap();
    assert_eq!(
        *log,
        vec![
            "outer-req".to_owned(),
            "inner-req".to_owned(),
            "inner-resp".to_owned(),
            "outer-resp".to_owned(),
        ]
    );
}

static MUTATE: OnceLock<Fixture<()>> = OnceLock::new();

/// Stamps every request with `x-trace` and rewrites every response body, so
/// the decoded value proves the change went through both directions.
fn mutate_middleware() -> Arc<dyn Middleware> {
    Arc::new(
        move |mut request: Request, next: Next| -> BoxFuture<Result<Response, Error>> {
            Box::pin(async move {
                request
                    .headers
                    .push(("x-trace".to_owned(), "from-middleware".to_owned()));
                let mut response = next.run(request).await?;
                response.body = br#"{"name":"changed"}"#.to_vec();
                Ok(response)
            })
        },
    )
}

fn mutate_rig() -> common::Rig {
    Fixture::start(
        &MUTATE,
        vec![route(
            &format!("GET {TEST_BASE}/mutate"),
            json(200, r#"{"name":"origin"}"#),
        )],
        |builder| {
            builder
                .middleware(mutate_middleware())
                .retry(RetryPolicy::off())
                .build()
        },
        (),
        |_| Root::of::<MutateApp>(),
    )
}

#[component]
fn MutateApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = MUTATE.get().expect("fixture").client.clone();
    spawn(async move {
        let decoded: Result<serde_json::Value, _> = client.get("/mutate").await;
        let name = decoded
            .ok()
            .and_then(|value| {
                value
                    .get("name")
                    .and_then(|n| n.as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "undecoded".to_owned());
        scenario
            .lines
            .update(|all| all.push(format!("mutated {name}")));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn middleware_changes_reach_the_transport_and_the_decode() {
    let mut rig = mutate_rig();
    rig.app.wait_for("text:done").unwrap();
    // The rewritten body is what the client decoded.
    assert!(common::shows_containing(&rig.app, "mutated changed"));
    // The stamped header is what the transport sent.
    let sent = rig.network.requests();
    assert_eq!(sent.len(), 1);
    assert!(
        sent[0]
            .headers
            .iter()
            .any(|(n, v)| n == "x-trace" && v == "from-middleware")
    );
}

static PASSTHROUGH: OnceLock<Fixture<()>> = OnceLock::new();

fn passthrough_rig() -> common::Rig {
    Fixture::start(
        &PASSTHROUGH,
        vec![route(
            &format!("GET {TEST_BASE}/down"),
            common::failing("io: connection lost"),
        )],
        |builder| {
            builder
                .middleware(trace("watcher", Arc::new(Mutex::new(vec![]))))
                .retry(RetryPolicy::off())
                .build()
        },
        (),
        |_| Root::of::<PassthroughApp>(),
    )
}

#[component]
fn PassthroughApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = PASSTHROUGH.get().expect("fixture").client.clone();
    spawn(async move {
        let outcome = client.get::<serde_json::Value>("/down").await;
        scenario.lines.update(|all| {
            all.push(format!(
                "down {}",
                matches!(outcome, Err(Error::Network { .. }))
            ))
        });
        done.set(true);
    });
    scenario.view()
}

#[test]
fn an_error_flows_back_through_the_chain_untouched() {
    let mut rig = passthrough_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(
        common::shows_containing(&rig.app, "down true"),
        "the network error surfaced"
    );
    let events = rig.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].error.as_deref(),
        Some("network: io: connection lost"),
        "the observer saw the classified error"
    );
}
