//! LIVE: these tests run the demo against the real echo server
//! (`tools/echo-server`, port from its `.runtime.json`) over `UreqNetwork`,
//! not the stubs. They cover what stubs cannot express: real route latency
//! in the observed events, and the 401/refresh/replay flow against a server
//! that actually checks the bearer. Run with `cargo test -- --ignored`
//! while the echo server is up; they fail loudly when the port file is
//! missing.

use std::path::Path;
use std::sync::Arc;

use nsh_engine::{Clock, EngineConfig, Root};
use nsh_testing::{Headless, UreqNetwork};

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

fn live_rig() -> Headless {
    // Only a loud gate: the app resolves the same file itself, so a missing
    // server fails here, naming the file, before any request can mis-probe.
    let _port = echo_port();
    let mut config = EngineConfig::new(Root::of::<nsh_app_demo_rs::App>());
    // Real network latency: the app runs on the system clock, so wait_for
    // waits in real time.
    config.clock = Clock::system();
    config.network = Some(Arc::new(UreqNetwork::new()));
    Headless::start(config).unwrap()
}

#[test]
#[ignore = "LIVE: needs the echo server up (cargo test -- --ignored)"]
fn the_demo_lands_on_the_real_echo_server() {
    let mut app = live_rig();
    app.wait_for("text:DEMO-RS-DONE").unwrap();
    let texts = app.screen().texts().join("\n");
    assert!(
        texts.contains("fast 200 fast"),
        "the fast call reached the server: {texts}"
    );
    assert!(
        texts.contains("slow 200 1200"),
        "the slow call decoded its echoed delay: {texts}"
    );
    assert!(
        texts.contains("refresh 1"),
        "three parallel 401s caused one refresh: {texts}"
    );
    assert!(
        texts.contains("done 3"),
        "all three replays succeeded: {texts}"
    );
    assert!(texts.contains("failed 0"), "none failed: {texts}");
    // The observed slow event carries real latency (the route sleeps 1200 ms).
    let slow_event = texts
        .lines()
        .find(|line| line.starts_with("event /slow ") && line.ends_with("ms"))
        .expect("the slow attempt was observed");
    let ms: u64 = slow_event
        .trim_start_matches("event /slow ")
        .trim_end_matches("ms")
        .parse()
        .expect("the duration parses");
    assert!(
        ms >= 1100,
        "the observed duration is the real route latency: {slow_event}"
    );
}
