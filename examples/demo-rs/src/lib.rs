//! The nsh-http demo for Rust apps: fast and slow echo calls with their
//! observed timings, and three parallel requests on an expired token going
//! through the provider's single-flight refresh. The suite runs once on
//! mount and reports one line per outcome — the same flows as
//! `examples/demo-ts`. `tests/demo.rs` drives it on stubs, `tests/live.rs`
//! against the real echo server, and `tests/capture` photographs it on a
//! real target.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use nsh_base::theme;
use nsh_core::prelude::*;
use nsh_http::{BoxFuture, CallOptions, HttpClient, NetworkEvent, TokenProvider};
use serde::Deserialize;

#[native_module("demo-rs/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

#[derive(Deserialize)]
struct Fast {
    route: String,
}

#[derive(Deserialize)]
struct Slow {
    delay: u64,
}

#[derive(Deserialize)]
struct TokenOk {
    #[allow(dead_code)]
    ok: bool,
}

/// The echo server's port: `ECHO_PORT`, else the server's `.runtime.json`,
/// else the documented pinned default (README's Demo section).
fn echo_port() -> u16 {
    if let Ok(raw) = std::env::var("ECHO_PORT") {
        return raw.parse().expect("ECHO_PORT parses");
    }
    let runtime = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/echo-server/.runtime.json");
    if let Ok(raw) = std::fs::read_to_string(&runtime)
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw)
        && let Some(port) = value.get("port").and_then(|port| port.as_u64())
        && let Ok(port) = u16::try_from(port)
    {
        return port;
    }
    8123
}

/// Holds `expired` until its refresh lands, then `refreshed` for every later
/// call. The refresh takes 50 ms on the engine's clock, so concurrent 401s
/// genuinely overlap it and share one flight.
struct Gate {
    refreshes: Arc<AtomicUsize>,
}

impl TokenProvider for Gate {
    fn token(&self) -> BoxFuture<Result<String, String>> {
        Box::pin(async move { Ok("expired".to_owned()) })
    }

    fn refresh(&self, _expired: &str) -> BoxFuture<Result<String, String>> {
        let refreshes = self.refreshes.clone();
        Box::pin(async move {
            nsh_core::prelude::timer(Duration::from_millis(50)).await;
            refreshes.fetch_add(1, Ordering::SeqCst);
            Ok("refreshed".to_owned())
        })
    }
}

async fn run_suite(lines: Signal<Vec<String>>) {
    let base = format!("http://127.0.0.1:{}", echo_port());
    let refreshes = Arc::new(AtomicUsize::new(0));
    let client = HttpClient::builder()
        .base_url(&base)
        .retry(nsh_http::RetryPolicy::off())
        .token_provider(Arc::new(Gate {
            refreshes: refreshes.clone(),
        }))
        .observe(Arc::new(move |event: &NetworkEvent| {
            lines.update(|all| all.push(format!("event {} {}ms", event.path, event.duration_ms)));
        }))
        .build();
    lines.update(|all| all.push(format!("base {base}")));

    match client.get::<Fast>("/fast").await {
        Ok(fast) => lines.update(|all| all.push(format!("fast 200 {}", fast.route))),
        Err(error) => lines.update(|all| all.push(format!("fast err {error}"))),
    }
    match client
        .get_with::<Slow>("/slow", &CallOptions::new().query("delay", "1200"))
        .await
    {
        Ok(slow) => lines.update(|all| all.push(format!("slow 200 {}", slow.delay))),
        Err(error) => lines.update(|all| all.push(format!("slow err {error}"))),
    }

    // Three parallel posts on the expired token: one shared refresh, three
    // replays. Each call is its own task; the last one out reports.
    let pending = Arc::new(AtomicUsize::new(3));
    let done = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
    for _ in 0..3 {
        let client = client.clone();
        let pending = pending.clone();
        let done = done.clone();
        let failed = failed.clone();
        let refreshes = refreshes.clone();
        spawn(async move {
            if client
                .post::<serde_json::Value, TokenOk>("/token", &serde_json::Value::Null)
                .await
                .is_ok()
            {
                done.fetch_add(1, Ordering::SeqCst);
            } else {
                failed.fetch_add(1, Ordering::SeqCst);
            }
            if pending.fetch_sub(1, Ordering::SeqCst) == 1 {
                let (refreshed, ok, bad) = (
                    refreshes.load(Ordering::SeqCst),
                    done.load(Ordering::SeqCst),
                    failed.load(Ordering::SeqCst),
                );
                lines.update(move |all| {
                    all.push(format!("refresh {refreshed}"));
                    all.push(format!("done {ok}"));
                    all.push(format!("failed {bad}"));
                    all.push("DEMO-RS-DONE".to_owned());
                });
            }
        });
    }
}

/// The application's root component.
#[component]
pub fn App() -> impl IntoElement {
    let lines = signal(Vec::<String>::new());
    spawn(run_suite(lines));
    view()
        .flex_1()
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .child(view().flex_1().p_safe_area().child(each(
            lines,
            |line| line.clone(),
            |line, _index| text(move || line.get()).text_size(px(13.0)),
        )))
}
