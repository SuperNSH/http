//! Behavior row 9: ETag and Cache-Control helpers feeding nsh-query —
//! conditional requests with If-None-Match and 304 handling, plus the
//! max-age arithmetic a query cache reads.

mod common;

use std::sync::{Arc, OnceLock};

use nsh_core::platform::HttpRequest;
use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::{CallOptions, ConditionalGet, etag_of, max_age_ms};
use nsh_testing::{StubHandler, StubReply, StubRoute};

use common::{Fixture, TEST_BASE, json, json_with_headers};

struct Nothing;

static ETAG: OnceLock<Fixture<Nothing>> = OnceLock::new();

/// `/etag`: `v1` until the request carries `If-None-Match: "v1"`, then 304.
fn etag_rig() -> common::Rig {
    let handler: StubHandler = Arc::new(|request: HttpRequest, reply: StubReply| {
        let conditional = request
            .headers
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("if-none-match") && value == "\"v1\"");
        if conditional {
            reply.send(common::json(304, ""));
        } else {
            reply.send(json_with_headers(
                200,
                r#"{"name":"fresh"}"#,
                &[("etag", "\"v1\"")],
            ));
        }
    });
    Fixture::start(
        &ETAG,
        vec![(format!("GET {TEST_BASE}/etag"), StubRoute::Handler(handler))],
        |builder| builder.retry(nsh_http::RetryPolicy::off()).build(),
        Nothing,
        |_| Root::of::<EtagApp>(),
    )
}

#[component]
fn EtagApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = ETAG
        .get()
        .expect("etag_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        // First call: a full response; the query layer stores its ETag.
        let mut conditional = ConditionalGet::new();
        let first = client.execute("GET", "/etag", &CallOptions::new()).await;
        let mut stored = String::new();
        if let Ok(response) = &first {
            if let Some(etag) = etag_of(response) {
                stored = etag.to_owned();
            }
            conditional.observe(response);
        }
        scenario
            .lines
            .update(|all| all.push(format!("first {stored}")));

        // Second call: conditional; the server answers 304, the cache keeps
        // the value it already has.
        let options = CallOptions::new().header("if-none-match", &stored);
        let second = client.execute("GET", "/etag", &options).await;
        match second {
            Ok(response) => {
                let not_modified = conditional.was_not_modified(&response);
                let body_empty = response.body.is_empty();
                scenario.lines.update(|all| {
                    all.push(format!("second 304={not_modified} empty={body_empty}"))
                });
            }
            Err(error) => scenario
                .lines
                .update(|all| all.push(format!("second err {error}"))),
        }
        done.set(true);
    });
    scenario.view()
}

#[test]
fn a_conditional_request_gets_a_304_and_the_helper_sees_it() {
    let mut rig = etag_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(
        common::shows_containing(&rig.app, "first \"v1\""),
        "the ETag was stored"
    );
    assert!(common::shows_containing(
        &rig.app,
        "second 304=true empty=true"
    ));

    // The conditional header actually went out.
    let sent = rig.network.requests();
    assert_eq!(sent.len(), 2);
    assert!(
        !sent[0]
            .headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("if-none-match"))
    );
    assert!(
        sent[1]
            .headers
            .iter()
            .any(|(n, v)| n.eq_ignore_ascii_case("if-none-match") && v == "\"v1\"")
    );
}

#[test]
fn apply_to_stamps_the_stored_etag_and_304_recognition() {
    let response = common::as_http(&json_with_headers(200, "{}", &[("etag", "\"abc\"")]));
    let mut conditional = ConditionalGet::new();
    conditional.observe(&response);
    assert_eq!(conditional.etag(), Some("\"abc\""));

    let mut request = HttpRequest::get(format!("{TEST_BASE}/etag"));
    conditional.apply_to(&mut request);
    assert!(
        request
            .headers
            .iter()
            .any(|(n, v)| n.eq_ignore_ascii_case("if-none-match") && v == "\"abc\"")
    );
    // Applying twice replaces, never duplicates.
    conditional.apply_to(&mut request);
    assert_eq!(
        request
            .headers
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case("if-none-match"))
            .count(),
        1
    );

    // Nothing stored: nothing stamped.
    let empty = ConditionalGet::new();
    let mut bare = HttpRequest::get(format!("{TEST_BASE}/etag"));
    empty.apply_to(&mut bare);
    assert!(bare.headers.is_empty());

    // A 304 against a stored ETag is recognized; a 200 is not.
    let not_modified = common::as_http(&json(304, ""));
    assert!(conditional.was_not_modified(&not_modified));
    assert!(!conditional.was_not_modified(&response));
    // A response without an ETag leaves the stored one alone.
    conditional.observe(&common::as_http(&json(200, "{}")));
    assert_eq!(conditional.etag(), Some("\"abc\""));
}

#[test]
fn max_age_reads_the_fresh_window_and_refuses_to_cache_stories_that_ban_it() {
    assert_eq!(max_age_ms("max-age=60"), Some(60_000));
    assert_eq!(max_age_ms("public, max-age=3600"), Some(3_600_000));
    assert_eq!(
        max_age_ms("s-maxage=30, max-age=10"),
        Some(30_000),
        "shared first, like caches do"
    );
    assert_eq!(max_age_ms("no-store"), None);
    assert_eq!(
        max_age_ms("no-cache, max-age=60"),
        None,
        "revalidate every time"
    );
    assert_eq!(max_age_ms("must-revalidate"), None);
    assert_eq!(max_age_ms("max-age=nope"), None);
    assert_eq!(max_age_ms(""), None);
}
