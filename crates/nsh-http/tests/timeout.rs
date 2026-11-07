//! Behavior row 4: per-client and per-call timeouts, composed with the
//! caller's cancellation (dropping or cancelling the spawned task) on the
//! manual clock.

mod common;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::{CallOptions, Error, RetryPolicy};

use common::{Fixture, TEST_BASE, delayed, json, route};

struct Nothing;

static TIMEOUTS: OnceLock<Fixture<Nothing>> = OnceLock::new();

/// The stub answers after 1000 ms on the manual clock.
fn timeouts_rig() -> common::Rig {
    Fixture::start(
        &TIMEOUTS,
        vec![route(
            &format!("GET {TEST_BASE}/slow"),
            delayed(json(200, r#"{"ok":true}"#), Duration::from_millis(1_000)),
        )],
        // The client's deadline: 200 ms. One attempt per call: the taxonomy,
        // not retries, is the subject.
        |builder| builder.timeout_ms(200).retry(RetryPolicy::off()).build(),
        Nothing,
        |_| Root::of::<TimeoutApp>(),
    )
}

#[component]
fn TimeoutApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = TIMEOUTS
        .get()
        .expect("timeouts_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let deadline = client.get::<serde_json::Value>("/slow").await;
        scenario.lines.update(|all| {
            all.push(match deadline {
                Ok(_) => "client-deadline missed".to_owned(),
                Err(Error::Timeout) => "client-deadline timeout".to_owned(),
                Err(error) => format!("client-deadline other {error}"),
            })
        });

        // A per-call deadline shorter than the client's fires first.
        let call = client
            .get_with::<serde_json::Value>("/slow", &CallOptions::new().timeout_ms(50))
            .await;
        scenario.lines.update(|all| {
            all.push(match call {
                Ok(_) => "call-deadline missed".to_owned(),
                Err(Error::Timeout) => "call-deadline timeout".to_owned(),
                Err(error) => format!("call-deadline other {error}"),
            })
        });

        // A per-call deadline longer than the response's delay lets it land.
        let patient = client
            .get_with::<serde_json::Value>("/slow", &CallOptions::new().timeout_ms(5_000))
            .await;
        scenario.lines.update(|all| {
            all.push(match patient {
                Ok(_) => "patient ok".to_owned(),
                Err(error) => format!("patient err {error}"),
            })
        });
        done.set(true);
    });
    scenario.view()
}

#[test]
fn the_deadline_wins_over_a_slow_response_and_a_patient_call_lets_it_land() {
    let mut rig = timeouts_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(
        &rig.app,
        "client-deadline timeout"
    ));
    assert!(common::shows_containing(&rig.app, "call-deadline timeout"));
    assert!(common::shows_containing(&rig.app, "patient ok"));
    // Exactly three attempts, one event each.
    let events = rig.events.lock().unwrap();
    assert_eq!(events.len(), 3);
}

// --- the caller's cancel ------------------------------------------------------

static CANCEL_CLOCK: OnceLock<nsh_engine::Clock> = OnceLock::new();
static CANCEL_NETWORK: OnceLock<Arc<nsh_testing::StubNetwork>> = OnceLock::new();
static CANCEL_NOTE: OnceLock<Signal<Vec<String>>> = OnceLock::new();

// A `Spawned` task handle is `Rc`-held on the engine thread, so it lives in a
// thread_local, not a static.
thread_local! {
    static CANCEL_TASK: std::cell::RefCell<Option<Spawned<()>>> = const { std::cell::RefCell::new(None) };
}

fn cancel_clock() -> nsh_engine::Clock {
    CANCEL_CLOCK.get_or_init(common::manual_clock).clone()
}

fn cancel_network() -> Arc<nsh_testing::StubNetwork> {
    CANCEL_NETWORK
        .get_or_init(|| {
            Arc::new(
                nsh_testing::StubNetwork::new(vec![route(
                    &format!("GET {TEST_BASE}/slow"),
                    delayed(json(200, r#"{"ok":true}"#), Duration::from_millis(1_000)),
                )])
                .with_clock(cancel_clock()),
            )
        })
        .clone()
}

#[test]
fn cancelling_the_task_stops_a_request_in_flight() {
    let mut config = nsh_engine::EngineConfig::new(Root::of::<CancelApp>());
    config.clock = cancel_clock();
    config.network = Some(cancel_network());
    let mut app = nsh_testing::Headless::start(config).unwrap();
    app.wait_for("text:leave").unwrap();
    // Cancel before the clock moves: the response (delay 1000) is not due.
    app.press("text:leave").unwrap();
    app.run_for(Duration::from_millis(2_000)).unwrap();
    // The cancelled task never answered, even though the clock passed the
    // stub's delay; the cancel itself is visible.
    assert!(app.shows("abandoned"));
    assert!(!common::shows_containing(&app, "answered"));
}

#[component]
fn CancelApp() -> impl IntoElement {
    let lines = *CANCEL_NOTE.get_or_init(|| signal(Vec::<String>::new()));
    let answer = lines;
    let client = nsh_http::HttpClient::builder()
        .base_url(TEST_BASE)
        .retry(RetryPolicy::off())
        .build();
    let task = spawn(async move {
        let _ = client.get::<serde_json::Value>("/slow").await;
        answer.update(|all| all.push("answered".to_owned()));
    });
    CANCEL_TASK.with(|cell| *cell.borrow_mut() = Some(task));
    view()
        .child(text("leave").on_press(|| {
            CANCEL_TASK.with(|cell| {
                if let Some(task) = cell.borrow_mut().take() {
                    task.cancel();
                    if let Some(note) = CANCEL_NOTE.get() {
                        note.update(|all| all.push("abandoned".to_owned()));
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
