//! Behavior row 13, multipart half: the encoder's exact wire format lives in
//! unit tests inside `src/multipart.rs`; here a form rides the client
//! pipeline on stubs — content type, exact bytes, and the error a collision
//! raises before anything goes out. The wire-level proof (the echo server's
//! `POST /multipart` really parsing the parts) lives in `tests/live_streams.rs`.

mod common;

use std::sync::{Arc, OnceLock};

use nsh_core::platform::HttpRequest;
use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::multipart::MultipartForm;
use nsh_http::{Error, RetryPolicy};
use nsh_testing::{StubHandler, StubReply, StubRoute};

use common::{Fixture, TEST_BASE, json};

#[derive(Clone)]
struct SeenRequest {
    content_type: Option<String>,
    body: Vec<u8>,
}

/// What the transport actually saw, read back from the stub network's log.
fn seen(rig: &common::Rig) -> SeenRequest {
    let requests = rig.network.requests();
    assert_eq!(requests.len(), 1, "exactly one POST");
    SeenRequest {
        content_type: requests[0]
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
            .map(|(_, value)| value.clone()),
        body: match &requests[0].body {
            nsh_core::platform::HttpBody::Bytes(bytes) => bytes.clone(),
            _ => Vec::new(),
        },
    }
}

static POST: OnceLock<Fixture<()>> = OnceLock::new();

/// The stub answers JSON; what the pipeline put on the wire is asserted from
/// the network's request log.
fn post_rig() -> common::Rig {
    let handler: StubHandler = Arc::new(move |_request: HttpRequest, reply: StubReply| {
        reply.send(json(200, r#"{"received":true}"#));
    });
    Fixture::start(
        &POST,
        vec![(
            format!("POST {TEST_BASE}/multipart"),
            StubRoute::Handler(handler),
        )],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<PostApp>(),
    )
}

fn form() -> MultipartForm {
    MultipartForm::with_boundary("nsh-test-boundary")
        .unwrap()
        .text("note", "hello")
        .file("doc", "doc.txt", "text/plain", b"file body".to_vec())
}

#[component]
fn PostApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = POST
        .get()
        .expect("post_rig() builds the fixture")
        .client
        .clone();
    spawn(async move {
        let outcome = form().send(&client, format!("{TEST_BASE}/multipart")).await;
        match outcome {
            Ok(response) => scenario.lines.update(|lines| {
                lines.push(format!(
                    "posted status={} body={}",
                    response.status(),
                    response.text()
                ))
            }),
            Err(error) => scenario
                .lines
                .update(|lines| lines.push(format!("posted err {error}"))),
        }
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_form_posts_its_content_type_and_exact_bytes_through_the_client() {
    let mut rig = post_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(
        common::shows_containing(&rig.app, r#"posted status=200 body={"received":true}"#),
        "{:?}",
        rig.app.screen().texts()
    );
    // What reached the transport is the form, byte for byte, named as multipart.
    let wire = seen(&rig);
    assert_eq!(
        wire.content_type.as_deref(),
        Some(form().content_type().as_str())
    );
    assert_eq!(wire.body, form().encode().unwrap());
}

// --- an encoding failure never reaches the wire ---------------------------------

static COLLISION: OnceLock<Fixture<()>> = OnceLock::new();

fn collision_rig() -> common::Rig {
    Fixture::start(
        &COLLISION,
        vec![(
            format!("POST {TEST_BASE}/multipart"),
            json(200, r#"{"received":true}"#).into(),
        )],
        |builder| builder.retry(RetryPolicy::off()).build(),
        (),
        |_| Root::of::<CollisionApp>(),
    )
}

#[component]
fn CollisionApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = COLLISION.get().expect("fixture").client.clone();
    spawn(async move {
        // The fixed boundary occurs inside the field's content: encoding
        // fails before any request is built.
        let form = MultipartForm::with_boundary("X")
            .unwrap()
            .text("field", "X marks");
        let outcome = form.send(&client, format!("{TEST_BASE}/multipart")).await;
        let note = match outcome {
            Err(Error::Network { message }) => {
                format!("collision {}", message.contains("boundary"))
            }
            _ => "collision missed".to_owned(),
        };
        scenario.lines.update(|lines| lines.push(note));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_boundary_collision_fails_before_any_request_goes_out() {
    let mut rig = collision_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "collision true"));
    assert!(
        rig.network.requests().is_empty(),
        "an unencodable form sends nothing"
    );
}
