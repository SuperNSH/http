//! The capability-refusal probe: what the 0.4.0 engine actually does with a
//! rust root whose nsh.json declares only `127.0.0.1`. Three outcomes land in
//! `lines`; the TSX test reads them. Port comes from ECHO_PORT, else the echo
//! server's `.runtime.json`.

use nsh_core::prelude::*;
use nsh_base::theme;
use nsh_http::{CallOptions, HttpClient};

#[native_module("capability-app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

fn echo_port() -> u16 {
    // The test sets ECHO_PORT; otherwise the echo server's runtime file,
    // four levels up from this app's src/ directory.
    if let Ok(raw) = std::env::var("ECHO_PORT") {
        return raw.parse().expect("ECHO_PORT parses");
    }
    let raw = std::fs::read_to_string(std::path::Path::new(
        "../../../../tools/echo-server/.runtime.json",
    ))
    .expect("ECHO_PORT unset and the echo server's .runtime.json unreadable");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("the runtime file parses");
    value
        .get("port")
        .and_then(|port| port.as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .expect("the runtime file names a port")
}

fn echo_base() -> String {
    format!("http://127.0.0.1:{}", echo_port())
}

async fn note(lines: &Signal<Vec<String>>, line: String) {
    lines.update(|all| all.push(line));
}

async fn run_suite(lines: Signal<Vec<String>>) {
    let base = echo_base();
    let port = echo_port();
    let client = HttpClient::builder()
        .base_url(&base)
        .retry(nsh_http::RetryPolicy::off())
        .build();

    // D1: a declared host (127.0.0.1) — the baseline that must work.
    match client.get::<serde_json::Value>("/fast").await {
        Ok(value) => {
            let route = value.get("route").and_then(|r| r.as_str()).unwrap_or("?");
            note(&lines, format!("D1 declared: status ok route={route}")).await;
        }
        Err(error) => note(&lines, format!("D1 declared: Err {error}")).await,
    }

    // D2: an undeclared host (localhost is not in the declaration). Where the
    // host enforces grants, this is refused (ERR_ACCESS_DENIED).
    let undeclared = format!("http://localhost:{port}/health");
    match fetch(HttpRequest::get(undeclared.clone())).await {
        Ok(response) => {
            note(&lines, format!("D2 undeclared-host: NOT REFUSED status={}", response.status())).await
        }
        Err(message) => note(&lines, format!("D2 undeclared-host: Err {message}")).await,
    }

    // D3: the redirect hop — /redirect/refused answers 302 to
    // http://refused.invalid/next, a host no test app declares. The engine
    // re-checks every hop where it enforces grants.
    match client.execute("GET", "/redirect/refused", &CallOptions::new()).await {
        Ok(response) => {
            note(&lines, format!("D3 redirect-hop: NOT REFUSED status={}", response.status())).await
        }
        Err(error) => match error {
            nsh_http::Error::RefusedByCapability { message } => {
                note(&lines, format!("D3 redirect-hop: REFUSED {message}")).await
            }
            other => note(&lines, format!("D3 redirect-hop: Err {other}")).await,
        },
    }

    note(&lines, "CAPABILITY-RS-DONE".to_owned()).await;
}

/// The application's root component.
#[component]
pub fn App() -> impl IntoElement {
    let lines = signal(Vec::<String>::new());
    spawn(run_suite(lines.clone()));
    view()
        .flex_1()
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .child(
            view()
                .flex_1()
                .p_safe_area()
                .child(each(
                    lines,
                    |line| line.clone(),
                    |line, _index| text(move || line.get()).text_size(px(13.0)),
                )),
        )
}
