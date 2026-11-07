//! LIVE: these tests run against the real echo server (`tools/echo-server`,
//! port from its `.runtime.json`) over `UreqNetwork`, not the stubs.
//!
//! They CANNOT prove capability refusal: on 0.4.0 the headless runner never
//! attaches a rust root's capabilities (`nsh-testing/src/runner.rs:224`,
//! `Reply::Root => Built::Rust(root())` with no `capabilities_json`), and the
//! engine short-circuits its `capabilities.network` check when the access is
//! unrestricted (`nsh-engine/src/lib.rs:2248`, `is_unrestricted`). So a
//! headless refusal here would be a FALSE PASS. What they do cover: the
//! whole client pipeline against a real server (decode, redirect following),
//! and — asserted, as documentation of the upstream gap — that the Rust path
//! does NOT refuse the undeclared redirect hop where the TSX path does.
//! Run with `cargo test -- --ignored` while the echo server is up; they fail
//! loudly when the port file is missing. The real-target proof lives in
//! `tests/capability-app/` (`nsh test --target macos`).

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
        |_| Root::of::<LiveApp>(),
    )
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
        // The redirect the TSX app is refused on: where does the Rust path land?
        let refused = client
            .execute("GET", "/redirect/refused", &CallOptions::new())
            .await;
        scenario.lines.update(|all| match &refused {
            Ok(response) => all.push(format!("redirect status={}", response.status())),
            Err(Error::RefusedByCapability { .. }) => all.push("redirect refused".to_owned()),
            Err(error) => all.push(format!("redirect err {error}")),
        });
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
fn the_undeclared_redirect_hop_is_documented_not_refused_on_0_4_0() {
    let mut rig = live_rig();
    rig.app.wait_for("text:done").unwrap();
    // Upstream gap (docs/decision.md, experiment 3b): the engine's
    // `is_unrestricted` short-circuit lets a rust root follow the redirect to
    // refused.invalid. The TSX path refuses; this one cannot. If a future nsh
    // starts refusing here, the assertion below flips to prove it.
    assert!(
        !common::shows_containing(&rig.app, "redirect refused"),
        "refusal fired: the engine now enforces capabilities on the Rust path — flip this test"
    );
    assert!(
        common::shows_containing(&rig.app, "redirect status=")
            || common::shows_containing(&rig.app, "redirect err"),
        "the redirect outcome was recorded"
    );
}
