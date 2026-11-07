//! Behavior rows 1-2: client construction and the typed methods with query
//! encoding and path params, on stub routes and a manual clock.

mod common;

use std::sync::OnceLock;

use nsh_core::platform::HttpBody;
use nsh_core::prelude::*;
use nsh_engine::Root;
use nsh_http::{CallOptions, HttpClient};
use serde::{Deserialize, Serialize};

use common::{Fixture, TEST_BASE, json, route};
use nsh_testing::StubRoute;

#[derive(Debug, Deserialize, Serialize, PartialEq)]
struct User {
    name: String,
    id: u32,
}

#[derive(Debug, Deserialize)]
struct Echo {
    method: String,
}

struct CoreFixture;

static CORE: OnceLock<Fixture<CoreFixture>> = OnceLock::new();

fn core() -> &'static Fixture<CoreFixture> {
    CORE.get()
        .expect("core_rig() builds the fixture before the app mounts")
}

fn core_rig() -> common::Rig {
    Fixture::start(
        &CORE,
        vec![
            route(
                &format!("GET {TEST_BASE}/user"),
                json(200, r#"{"name":"ada","id":7}"#),
            ),
            route(
                &format!("GET {TEST_BASE}/users/42"),
                json(200, r#"{"name":"grace","id":42}"#),
            ),
            route(
                &format!("GET {TEST_BASE}/search?q=hello%20world&lang=ru"),
                json(200, r#"{"name":"query","id":1}"#),
            ),
            route(
                &format!("POST {TEST_BASE}/echo"),
                json(200, r#"{"method":"POST","body":{"name":"posted","id":3}}"#),
            ),
            route(
                &format!("PUT {TEST_BASE}/echo"),
                json(200, r#"{"method":"PUT","body":{"name":"put","id":4}}"#),
            ),
            route(
                &format!("PATCH {TEST_BASE}/echo"),
                json(
                    200,
                    r#"{"method":"PATCH","body":{"name":"patched","id":5}}"#,
                ),
            ),
            route(
                &format!("DELETE {TEST_BASE}/items/9"),
                json(200, r#"{"method":"DELETE","body":null}"#),
            ),
        ],
        |builder| builder.header("accept", "application/json").build(),
        CoreFixture,
        |_| Root::of::<CoreApp>(),
    )
}

#[component]
fn CoreApp() -> impl IntoElement {
    let scenario = common::scenario();
    let out = scenario.lines;
    let done = scenario.done;
    let client = core().client.clone();
    spawn(async move {
        let user: User = client.get("/user").await.unwrap();
        out.update(|all| all.push(format!("get {}", user.name)));

        let user: User = client
            .get_with("/users/:id", &CallOptions::new().param("id", "42"))
            .await
            .unwrap();
        out.update(|all| all.push(format!("param {}", user.name)));

        let user: User = client
            .get_with(
                "/search",
                &CallOptions::new()
                    .query("q", "hello world")
                    .query("lang", "ru"),
            )
            .await
            .unwrap();
        out.update(|all| all.push(format!("query {}", user.name)));

        let body = User {
            name: "posted".to_owned(),
            id: 3,
        };
        let echo: Echo = client.post("/echo", &body).await.unwrap();
        out.update(|all| all.push(format!("post {}", echo.method)));

        let body = User {
            name: "put".to_owned(),
            id: 4,
        };
        let echo: Echo = client.put("/echo", &body).await.unwrap();
        out.update(|all| all.push(format!("put {}", echo.method)));

        let body = User {
            name: "patched".to_owned(),
            id: 5,
        };
        let echo: Echo = client.patch("/echo", &body).await.unwrap();
        out.update(|all| all.push(format!("patch {}", echo.method)));

        client.delete::<Echo>("/items/9").await.unwrap();
        out.update(|all| all.push("deleted".to_owned()));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn typed_methods_decode_query_and_path_params() {
    let mut rig = core_rig();
    rig.app.wait_for("text:done").unwrap();

    assert!(common::shows_containing(&rig.app, "get ada"));
    assert!(common::shows_containing(&rig.app, "param grace"));
    assert!(common::shows_containing(&rig.app, "query query"));
    assert!(common::shows_containing(&rig.app, "post POST"));
    assert!(common::shows_containing(&rig.app, "put PUT"));
    assert!(common::shows_containing(&rig.app, "patch PATCH"));

    let requests = rig.network.requests();
    // The client's default header reached the transport, and each call hit
    // the exact URL (query percent-encoded, path param substituted).
    let get = &requests[0];
    assert_eq!(get.url, format!("{TEST_BASE}/user"));
    assert!(
        get.headers
            .iter()
            .any(|(n, v)| n == "accept" && v == "application/json")
    );
    assert_eq!(requests[1].url, format!("{TEST_BASE}/users/42"));
    assert_eq!(
        requests[2].url,
        format!("{TEST_BASE}/search?q=hello%20world&lang=ru")
    );

    // The JSON body and its content-type went out with the POST.
    let post = &requests[3];
    assert_eq!(post.method, "POST");
    assert_eq!(
        post.body,
        HttpBody::Bytes(br#"{"name":"posted","id":3}"#.to_vec())
    );
    assert!(
        post.headers
            .iter()
            .any(|(n, v)| n.eq_ignore_ascii_case("content-type") && v == "application/json")
    );
    assert_eq!(requests[4].method, "PUT");
    assert_eq!(requests[5].method, "PATCH");
    assert_eq!(requests[6].method, "DELETE");
    assert_eq!(requests[6].url, format!("{TEST_BASE}/items/9"));
}

#[test]
fn a_client_without_a_base_url_fails_its_calls_with_a_clear_network_error() {
    let mut config = nsh_engine::EngineConfig::new(Root::of::<NoBaseApp>());
    config.clock = common::manual_clock();
    let mut app = nsh_testing::Headless::start(config).unwrap();
    app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&app, "no base url"));
}

#[component]
fn NoBaseApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = HttpClient::builder().build();
    spawn(async move {
        let error = client.get::<User>("/user").await.unwrap_err();
        scenario.lines.update(|all| all.push(error.to_string()));
        done.set(true);
    });
    scenario.view()
}

// --- send_request: caller headers reach the wire, content-type survives -------

struct SeamFixture;

static SEAM: OnceLock<Fixture<SeamFixture>> = OnceLock::new();

fn seam_rig() -> common::Rig {
    Fixture::start(
        &SEAM,
        vec![(
            format!("POST {TEST_BASE}/seam*"),
            StubRoute::Response(json(200, r#"{"method":"POST","body":null}"#)),
        )],
        |builder| builder.retry(nsh_http::RetryPolicy::off()).build(),
        SeamFixture,
        |_| Root::of::<SeamApp>(),
    )
}

#[component]
fn SeamApp() -> impl IntoElement {
    let scenario = common::scenario();
    let done = scenario.done;
    let client = SEAM
        .get()
        .expect("seam_rig() builds the fixture before the app mounts")
        .client
        .clone();
    spawn(async move {
        // A caller-set content-type (multipart) and an extra header travel
        // with an exact request.
        let multipart = HttpRequest {
            method: "POST".to_owned(),
            url: format!("{TEST_BASE}/seam/multipart"),
            headers: vec![
                (
                    "content-type".to_owned(),
                    "multipart/form-data; boundary=xyz".to_owned(),
                ),
                ("x-seam".to_owned(), "from-caller".to_owned()),
            ],
            body: HttpBody::Bytes(b"--xyz".to_vec()),
            follow_redirects: true,
        };
        let sent = client.send_request(multipart).await.is_ok();
        scenario
            .lines
            .update(|all| all.push(format!("multipart {sent}")));

        // A JSON body without a content-type still gets the stamp.
        let json = HttpRequest {
            method: "POST".to_owned(),
            url: format!("{TEST_BASE}/seam/json"),
            headers: Vec::new(),
            body: HttpBody::Bytes(br#"{"k":1}"#.to_vec()),
            follow_redirects: true,
        };
        let stamped = client.send_request(json).await.is_ok();
        scenario
            .lines
            .update(|all| all.push(format!("json {stamped}")));
        done.set(true);
    });
    scenario.view()
}

#[test]
fn send_request_carries_caller_headers_and_preserves_a_content_type() {
    let mut rig = seam_rig();
    rig.app.wait_for("text:done").unwrap();
    assert!(common::shows_containing(&rig.app, "multipart true"));
    assert!(common::shows_containing(&rig.app, "json true"));

    let sent = rig.network.requests();
    assert_eq!(sent.len(), 2);
    let (multipart, json) = (&sent[0], &sent[1]);

    // The caller's headers reached the wire verbatim, content-type included.
    assert!(
        multipart
            .headers
            .iter()
            .any(|(n, v)| n == "content-type" && v == "multipart/form-data; boundary=xyz"),
        "the caller's content-type was clobbered: {:?}",
        multipart.headers
    );
    assert!(
        multipart
            .headers
            .iter()
            .any(|(n, v)| n == "x-seam" && v == "from-caller"),
        "the caller's extra header was dropped: {:?}",
        multipart.headers
    );

    // A JSON body with no content-type still gets the stamp.
    assert!(
        json.headers
            .iter()
            .any(|(n, v)| n.eq_ignore_ascii_case("content-type") && v == "application/json"),
        "the JSON stamp went missing: {:?}",
        json.headers
    );
}
