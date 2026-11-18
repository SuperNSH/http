//! LIVE: these tests run against the real echo server (`tools/echo-server`,
//! port from its `.runtime.json`) over `UreqNetwork`, not the stubs.
//!
//! The root declares `capabilities.network` for `127.0.0.1` only
//! (`Root::capabilities_json`, what nsh's generated code does from
//! `nsh.json`); since 0.5 the engine checks a Rust root's requests against
//! it, so an undeclared host and an undeclared redirect hop are refused
//! through the client as `Error::RefusedByCapability`.
//! Run with `cargo test -- --ignored` while the echo server is up; they fail
//! loudly when the port file is missing.

mod common;

use std::path::Path;
use std::sync::OnceLock;

use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::{CallOptions, Error};

use common::Fixture;

/// The echo server's port, read fresh: no file, no test.
fn echo_port() -> u16 {
    let path = Path::new("../../tools/echo-server/.runtime.json");
    let raw = std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!(
            "the echo server's {} is missing ({error}); start the server first",
            path.display()
        )
    });
    let value: serde_json::Value = serde_json::from_str(&raw).expect("the runtime file parses");
    let port = value
        .get("port")
        .and_then(|port| port.as_u64())
        .expect("the runtime file names its port");
    u16::try_from(port).expect("the port fits u16")
}

struct Live;

static LIVE: OnceLock<Fixture<Live>> = OnceLock::new();

fn live_rig() -> common::Rig {
    let port = echo_port();
    let base_url = format!("http://127.0.0.1:{port}");
    common::start_live(
        &LIVE,
        |builder| {
            builder
                .base_url(base_url)
                .retry(nsh_http::RetryPolicy::off())
                .build()
        },
        Live,
        |_| Root::of::<LiveApp>().capabilities_json(r#"{"network":{"hosts":["127.0.0.1"]}}"#),
    )
}

/// One line per outcome: `<label> refused`, `<label> status=N` or `<label> err ...`.
fn record<T: std::fmt::Debug>(lines: Signal<Vec<String>>, label: &str, outcome: &Result<T, Error>) {
    lines.update(|all| match outcome {
        Ok(response) => all.push(format!("{label} ok {response:?}")),
        Err(Error::RefusedByCapability { .. }) => all.push(format!("{label} refused")),
        Err(error) => all.push(format!("{label} err {error}")),
    });
}

#[component]
fn LiveApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = LIVE
        .get()
        .expect("live_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        let fast = client.get::<serde_json::Value>("/fast").await;
        scenario.lines.update(|all| {
            all.push(format!(
                "fast {}",
                fast.ok()
                    .and_then(|value| value
                        .get("route")
                        .and_then(|route| route.as_str())
                        .map(str::to_owned))
                    .unwrap_or_else(|| "undecoded".to_owned())
            ))
        });
        let refused = client
            .execute("GET", "/redirect/refused", &CallOptions::new())
            .await;
        record(scenario.lines, "redirect", &refused);
        let other_host = client
            .execute(
                "GET",
                &format!("http://localhost:{}/fast", echo_port()),
                &CallOptions::new(),
            )
            .await;
        record(scenario.lines, "direct", &other_host);
        done.set(true);
    });
    scenario.view()
}

#[test]
#[ignore = "LIVE: needs the echo server up (cargo test -- --ignored)"]
fn the_pipeline_reaches_the_real_echo_server_and_decodes() {
    let mut rig = live_rig();
    // Real network latency: the app runs on the system clock, so wait_for
    // waits in real time.
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "fast fast"));
}

#[test]
#[ignore = "LIVE: needs the echo server up (cargo test -- --ignored)"]
fn an_undeclared_redirect_hop_and_an_undeclared_host_are_refused() {
    let mut rig = live_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(
        common::shows_containing(&rig.app, "redirect refused"),
        "the hop to an undeclared host is refused: {:?}",
        rig.app.screen().texts()
    );
    assert!(
        common::shows_containing(&rig.app, "direct refused"),
        "an undeclared host on the first request is refused: {:?}",
        rig.app.screen().texts()
    );
}
