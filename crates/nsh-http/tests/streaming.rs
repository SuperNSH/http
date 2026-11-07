//! Behavior row 13, the Rust half: response bodies, download progress, upload
//! progress — with the honest 0.4.0 limits (docs/decision.md, experiment 2)
//! asserted, not just documented: progress fires exactly once, when the whole
//! body is in, because that is the only moment the transport observes.
//!
//! The stub cannot stream a body in pieces (`StubNetwork` answers whole) —
//! which is the same shape the production Rust transport gives, so these
//! tests exercise the real contract. The wire-level proof (a real server
//! dripping chunks, a real `Content-Length` on `/bytes/:n`) lives in
//! `tests/live_streams.rs`.

mod common;

use std::sync::{Arc, Mutex, OnceLock};

use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::streaming::{self, Progress};
use nsh_http::{CallOptions, Error, RetryPolicy};

use common::{Fixture, TEST_BASE, json, route};

/// A collector for progress reports and the sink that feeds it.
fn progress_collector() -> (Arc<Mutex<Vec<Progress>>>, streaming::ProgressSink) {
    let seen: Arc<Mutex<Vec<Progress>>> = Arc::default();
    let sink = seen.clone();
    let sink: streaming::ProgressSink = Arc::new(move |progress| {
        sink.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(*progress);
    });
    (seen, sink)
}

// --- download ------------------------------------------------------------------

static FILE: OnceLock<Fixture<()>> = OnceLock::new();

/// An 8-byte body with an honest `Content-Length`.
fn file_rig() -> common::Rig {
    let mut response = json(200, "the-body");
    response
        .headers
        .push(("content-length".to_owned(), "8".to_owned()));
    Fixture::start(
        &FILE,
        vec![route(&format!("GET {TEST_BASE}/file"), response)],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<DownloadApp>(),
    )
}

#[component]
fn DownloadApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = FILE
        .get()
        .expect("file_rig() builds the fixture")
        .client
        .clone();
    let (progress, sink) = progress_collector();
    spawn(async move {
        let outcome = streaming::download(&client, "/file", &CallOptions::new(), Some(sink)).await;
        match outcome {
            Ok(file) => {
                let all = progress
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|p| format!("{} of {:?}", p.bytes, p.total))
                    .collect::<Vec<_>>()
                    .join(";");
                scenario.lines.update(|lines| {
                    lines.push(format!(
                        "file {} total={:?} reports=[{all}]",
                        String::from_utf8_lossy(&file.bytes),
                        file.total
                    ))
                });
            }
            Err(error) => scenario
                .lines
                .update(|lines| lines.push(format!("file err {error}"))),
        }
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_download_reports_the_whole_body_once_with_the_content_length_total() {
    let mut rig = file_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(
        common::shows_containing(
            &rig.app,
            "file the-body total=Some(8) reports=[8 of Some(8)]"
        ),
        "one report, at completion: {:?}",
        rig.app.screen().texts()
    );
    // The event's response_bytes agree with the transport's single resolution.
    let events = rig.events.lock().unwrap();
    assert_eq!(events[0].response_bytes, Some(8));
    assert_eq!(
        events[0].ttfb_ms, None,
        "no honest TTFB on the Rust transport"
    );
}

static LENGTHLESS: OnceLock<Fixture<()>> = OnceLock::new();

fn lengthless_rig() -> common::Rig {
    Fixture::start(
        &LENGTHLESS,
        vec![route(
            &format!("GET {TEST_BASE}/file"),
            json(200, "no length here"),
        )],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<LengthlessApp>(),
    )
}

#[component]
fn LengthlessApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = LENGTHLESS.get().expect("fixture").client.clone();
    let (progress, sink) = progress_collector();
    spawn(async move {
        let outcome = streaming::download(&client, "/file", &CallOptions::new(), Some(sink)).await;
        let note = match outcome {
            Ok(file) => format!(
                "lenless bytes={} total={:?} reports={}",
                file.bytes.len(),
                file.total,
                progress.lock().unwrap().len()
            ),
            Err(error) => format!("lenless err {error}"),
        };
        scenario.lines.update(|lines| lines.push(note));
        done.set(true);
    });
    scenario.view()
}

/// No `Content-Length`: the total is `None` and the (complete) byte count is
/// what progress reports — the body itself is still whole.
#[test]
fn without_a_content_length_the_total_is_none_and_the_byte_count_stands() {
    let mut rig = lengthless_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(
        &rig.app,
        "lenless bytes=14 total=None reports=1"
    ));
}

// --- a failed download fires no progress ---------------------------------------

static FAILED_FILE: OnceLock<Fixture<()>> = OnceLock::new();

fn failed_file_rig() -> common::Rig {
    Fixture::start(
        &FAILED_FILE,
        vec![route(&format!("GET {TEST_BASE}/file"), json(500, "no"))],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<FailedFileApp>(),
    )
}

#[component]
fn FailedFileApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = FAILED_FILE.get().expect("fixture").client.clone();
    let (progress, sink) = progress_collector();
    spawn(async move {
        let outcome = streaming::download(&client, "/file", &CallOptions::new(), Some(sink)).await;
        let note = match outcome {
            Err(Error::HttpStatus { status, .. }) => {
                format!(
                    "failed status={status} reports={}",
                    progress.lock().unwrap().len()
                )
            }
            _ => "failed missed".to_owned(),
        };
        scenario.lines.update(|lines| lines.push(note));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_non_2xx_download_is_a_status_error_and_never_reports_progress() {
    let mut rig = failed_file_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(
        &rig.app,
        "failed status=500 reports=0"
    ));
}

// --- upload ---------------------------------------------------------------------

static UPLOAD: OnceLock<Fixture<()>> = OnceLock::new();

fn upload_rig() -> common::Rig {
    Fixture::start(
        &UPLOAD,
        vec![(
            format!("POST {TEST_BASE}/upload"),
            json(201, r#"{"stored":true}"#).into(),
        )],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<UploadApp>(),
    )
}

#[component]
fn UploadApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = UPLOAD.get().expect("fixture").client.clone();
    let (progress, sink) = progress_collector();
    spawn(async move {
        let payload = vec![0xAB_u8; 64];
        let outcome = streaming::upload(
            &client,
            format!("{TEST_BASE}/upload"),
            "POST",
            Some("application/octet-stream"),
            payload,
            Some(sink),
        )
        .await;
        let note = match outcome {
            Ok(response) => format!("upload status={}", response.status()),
            Err(error) => format!("upload err {error}"),
        };
        let reports: Vec<String> = progress
            .lock()
            .unwrap()
            .iter()
            .map(|p| format!("{} of {:?}", p.bytes, p.total))
            .collect();
        scenario
            .lines
            .update(|lines| lines.push(format!("{note} reports=[{}]", reports.join(";"))));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn an_upload_sends_its_whole_body_and_reports_the_exact_size_once() {
    let mut rig = upload_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(
        &rig.app,
        "upload status=201 reports=[64 of Some(64)]"
    ));
    // What went out is exactly what was built, with the content type the call named.
    let requests = rig.network.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].body,
        nsh_core::platform::HttpBody::Bytes(vec![0xAB_u8; 64])
    );
    let content_type = requests[0]
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.as_str());
    assert_eq!(
        content_type,
        Some("application/octet-stream"),
        "the upload's content type reaches the wire"
    );
    // The event's request_bytes is the exact built size (docs/decision.md).
    let events = rig.events.lock().unwrap();
    assert_eq!(events[0].request_bytes, Some(64));
}
