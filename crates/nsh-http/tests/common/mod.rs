//! Shared harness for the nsh-http suite: a headless engine on a manual clock
//! (`Clock::manual`) with `StubNetwork` routes, and a client whose observer
//! collects every `NetworkEvent` (mirrors `~/fo/nsh-query`'s tests).

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use nsh_core::prelude::*;
use nsh_engine::{Clock, EngineConfig, Root};
use nsh_http::{HttpClient, HttpClientBuilder, NetworkEvent, Observer};
use nsh_testing::{Headless, StubNetwork, StubResponse, StubRoute};

/// Every stub URL sits on 127.0.0.1 so declared capabilities stay coherent.
pub const TEST_BASE: &str = "http://127.0.0.1:8123";

/// The manual clock's wall start, in milliseconds since the epoch.
pub const ORIGIN_MS: u64 = 1_767_258_000_000;

/// The app's clock: manual, so `run_for` moves it and every timer in the
/// client with it.
#[allow(dead_code)]
pub fn manual_clock() -> Clock {
    Clock::manual(SystemTime::UNIX_EPOCH + Duration::from_millis(ORIGIN_MS))
}

/// A JSON stub response (`StubResponse` is `#[non_exhaustive]`, so fields are
/// set on the `Default` rather than in a literal).
#[allow(dead_code)]
pub fn json(status: u16, body: &str) -> StubResponse {
    let mut response = StubResponse::default();
    response.status = status;
    response.headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    response.body = body.as_bytes().to_vec();
    response
}

/// A JSON response with extra headers (Retry-After, ETag, ...).
#[allow(dead_code)]
pub fn json_with_headers(status: u16, body: &str, headers: &[(&str, &str)]) -> StubResponse {
    let mut response = json(status, body);
    response.headers.extend(
        headers
            .iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned())),
    );
    response
}

/// A response that lands after `delay` on the app's clock.
#[allow(dead_code)]
pub fn delayed(response: StubResponse, delay: Duration) -> StubResponse {
    let mut response = response;
    response.delay = delay;
    response
}

/// A response whose request failed instead (offline, reset, refused).
#[allow(dead_code)]
pub fn failing(message: &str) -> StubResponse {
    let mut response = StubResponse::default();
    response.error = Some(message.to_owned());
    response
}

/// A route keyed `"<METHOD> <URL>"`, answering `response`.
#[allow(dead_code)]
pub fn route(key: &str, response: StubResponse) -> (String, StubRoute) {
    (key.to_owned(), StubRoute::Response(response))
}

/// The events collector and the observer that feeds it.
#[allow(dead_code)]
pub fn collector() -> (Arc<Mutex<Vec<NetworkEvent>>>, Observer) {
    let events: Arc<Mutex<Vec<NetworkEvent>>> = Arc::default();
    let sink = events.clone(); // Arc is not Copy; the observer holds one.

    let observer: Observer = Arc::new(move |event| {
        sink.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(event.clone());
    });
    (events, observer)
}

/// What one test owns: the running app, its stub network (for the requests
/// the client actually sent), the observed events, and the client itself.
pub struct Rig {
    pub app: Headless,
    // Each test binary reads only the fields its own assertions need.
    #[allow(dead_code)]
    pub network: Arc<StubNetwork>,
    #[allow(dead_code)]
    pub events: Arc<Mutex<Vec<NetworkEvent>>>,
}

/// A test's lazily built fixture, stored in a per-test `OnceLock` and read by
/// its component on the engine thread (one fixture per test, as nsh-query's
/// per-test statics are).
pub struct Fixture<R> {
    /// One clock for the app AND its stub network: the stub's delays and the
    /// client's timers must move together.
    #[allow(dead_code)]
    pub clock: Clock,
    #[allow(dead_code)]
    pub network: Arc<StubNetwork>,
    #[allow(dead_code)]
    pub events: Arc<Mutex<Vec<NetworkEvent>>>,
    pub client: HttpClient,
    #[allow(dead_code)]
    pub extra: R,
}

pub fn fixture<R>(
    routes: Vec<(String, StubRoute)>,
    client: impl FnOnce(HttpClientBuilder) -> HttpClient,
    extra: R,
) -> Fixture<R> {
    let clock = manual_clock();
    let network = Arc::new(StubNetwork::new(routes).with_clock(clock.clone()));
    let (events, observer) = collector();
    let client = client(HttpClient::builder().base_url(TEST_BASE).observe(observer));
    Fixture {
        clock,
        network,
        events,
        client,
        extra,
    }
}

impl<R> Fixture<R> {
    /// Builds the fixture in a `OnceLock` and starts its app: `make_root`
    /// sees the fixture (for the client its component uses) and gives the
    /// root component. Some test binaries use only [`start_live`].
    #[allow(dead_code)]
    pub fn start(
        cell: &'static OnceLock<Fixture<R>>,
        routes: Vec<(String, StubRoute)>,
        client: impl FnOnce(HttpClientBuilder) -> HttpClient,
        extra: R,
        make_root: impl FnOnce(&Fixture<R>) -> Root,
    ) -> Rig {
        let fixture = cell.get_or_init(|| fixture(routes, client, extra));
        let mut config = EngineConfig::new(make_root(fixture));
        config.clock = fixture.clock.clone();
        config.network = Some(fixture.network.clone());
        Rig {
            app: Headless::start(config).unwrap(),
            network: fixture.network.clone(),
            events: fixture.events.clone(),
        }
    }
}

/// The signals one scenario writes: lines to assert with `shows`, and `done`
/// for `wait_for("text:done")` (a text selector matches the node's whole
/// content, so the marker is its own node).
pub struct Scenario {
    pub lines: Signal<Vec<String>>,
    pub done: Signal<bool>,
}

/// A fresh scenario: no lines, not done.
#[allow(dead_code)]
pub fn scenario() -> Scenario {
    Scenario {
        lines: signal(Vec::<String>::new()),
        done: signal(false),
    }
}

impl Scenario {
    /// Renders one text node per line (`shows` matches a node's whole text,
    /// never a substring) and the done marker for `wait_for("text:done")`.
    /// Consumes the scenario: its signals move into the view.
    pub fn view(self) -> impl IntoElement {
        let done = self.done;
        view()
            .child(each(
                self.lines,
                |line| line.clone(),
                |line, _index| text(move || line.get()),
            ))
            .child(text(move || if done.get() { "done" } else { "waiting" }))
    }
}

/// Whether any node's on-screen text contains `needle` (`Screen::shows`
/// matches whole nodes, so long lines need this).
#[allow(dead_code)]
pub fn shows_containing(app: &Headless, needle: &str) -> bool {
    app.screen()
        .texts()
        .iter()
        .any(|text| text.contains(needle))
}

/// The same response as the transport sees it, for helpers that read an
/// `HttpResponse` directly.
#[allow(dead_code)]
pub fn as_http(response: &StubResponse) -> nsh_core::prelude::HttpResponse {
    nsh_core::prelude::HttpResponse {
        head: nsh_core::platform::HttpHead {
            status: response.status,
            headers: response.headers.clone(),
            ..nsh_core::platform::HttpHead::default()
        },
        body: response.body.clone(),
    }
}

/// The LIVE variant of [`Fixture::start`]: the system's clock (real network
/// latency) and a real network stack, for the `#[ignore]` LIVE tests. The
/// fixture's routes are unused — nothing here is stubbed.
#[allow(dead_code)]
pub fn start_live<R>(
    cell: &'static OnceLock<Fixture<R>>,
    client: impl FnOnce(HttpClientBuilder) -> HttpClient,
    extra: R,
    make_root: impl FnOnce(&Fixture<R>) -> Root,
) -> Rig {
    let fixture = cell.get_or_init(|| fixture(vec![], client, extra));
    let mut config = EngineConfig::new(make_root(fixture));
    config.clock = Clock::system();
    config.network = Some(Arc::new(nsh_testing::UreqNetwork::new()));
    Rig {
        app: Headless::start(config).unwrap(),
        network: fixture.network.clone(),
        events: fixture.events.clone(),
    }
}
