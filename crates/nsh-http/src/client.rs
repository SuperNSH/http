//! `HttpClient` and its builder: base URL, typed JSON decode, query encoding,
//! path params, per-client and per-call timeouts composed with the caller's
//! cancellation, retries, ordered middleware, the auth seam and the observer
//! emit points (behavior rows 1-2, 4, 7, 10).

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nsh_core::access::parse_url;
use nsh_core::platform::{HttpBody, HttpHead, HttpRequest};
use nsh_core::prelude::HttpResponse;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::auth::{Flight, LeadGuard, SingleFlight, TokenProvider, Waited};
use crate::error::Error;
use crate::middleware::{BoxFuture, Middleware, Request, Response, chain};
use crate::monitor::{NetworkEvent, Observer};
use crate::retry::{RetryPolicy, parse_retry_after};

/// The HTTP call behind every client request: NSH's own `fetch` by default
/// (docs/decision.md), or a [`crate::MockTransport`] in tests. The 0.4.0
/// transport resolves once, with the whole response.
pub trait Transport: Send + Sync + 'static {
    /// Sends the request; `Err` carries the engine's or the mock's failure
    /// message, which [`Error::classify`] sorts into the taxonomy.
    fn fetch(&self, request: HttpRequest) -> BoxFuture<Result<HttpResponse, String>>;
}

/// The default transport: [`nsh_core::prelude::fetch`], under the engine's
/// network stack and the app's `capabilities.network`.
pub struct NshTransport;

impl Transport for NshTransport {
    fn fetch(&self, request: HttpRequest) -> BoxFuture<Result<HttpResponse, String>> {
        Box::pin(nsh_core::prelude::fetch(request))
    }
}

/// Per-call settings: query, path params, extra headers, a timeout and retry
/// override. Everything is optional; the client's defaults apply otherwise.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CallOptions {
    /// Query parameters, percent-encoded into the URL in this order.
    pub query: Vec<(String, String)>,
    /// `:name` substitutions in the path.
    pub params: Vec<(String, String)>,
    /// Headers added to the client's (same name: the call's value wins).
    pub headers: Vec<(String, String)>,
    /// This call's deadline in milliseconds, over the client's.
    pub timeout_ms: Option<u64>,
    /// This call's retry policy, over the client's.
    pub retry: Option<RetryPolicy>,
}

impl CallOptions {
    /// No query, no params, no extra headers, no overrides.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a query parameter.
    #[must_use]
    pub fn query(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.query.push((name.into(), value.into()));
        self
    }

    /// Substitutes `:name` in the path.
    #[must_use]
    pub fn param(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.params.push((name.into(), value.into()));
        self
    }

    /// Adds a header for this call only.
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Overrides the client's timeout for this call.
    #[must_use]
    pub fn timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }

    /// Overrides the client's retry policy for this call.
    #[must_use]
    pub fn retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = Some(retry);
        self
    }
}

/// Ids the client stamps on its events; unique across clients in a process.
static NEXT_EVENT_ID: AtomicU64 = AtomicU64::new(1);

struct Inner {
    base_url: String,
    headers: Vec<(String, String)>,
    timeout: Option<Duration>,
    retry: RetryPolicy,
    middleware: Vec<Arc<dyn Middleware>>,
    observer: Option<Observer>,
    token: Option<Arc<dyn TokenProvider>>,
    transport: Arc<dyn Transport>,
    /// The 401 refresh: first requester leads, the rest follow one result.
    refresh: SingleFlight,
    /// Jitter state; advanced once per computed delay.
    noise: Mutex<u64>,
}

/// The nsh-http client: typed JSON calls over NSH's fetch, with timeouts,
/// retries, middleware, token refresh and monitoring. Clone it freely; every
/// clone shares the builder's settings. Methods are `async`: await them in a
/// task (`nsh_core::prelude::spawn`), and cancel by dropping that task.
#[derive(Clone)]
pub struct HttpClient(Arc<Inner>);

impl Default for HttpClient {
    fn default() -> Self {
        Self::builder().build()
    }
}

impl HttpClient {
    /// Configures a client: base URL, headers, timeout, retries, middleware,
    /// observer, token provider and transport, then `build`.
    pub fn builder() -> HttpClientBuilder {
        HttpClientBuilder {
            base_url: String::new(),
            headers: Vec::new(),
            timeout_ms: None,
            retry: RetryPolicy::default(),
            middleware: Vec::new(),
            observer: None,
            token: None,
            transport: Arc::new(NshTransport),
        }
    }

    /// A `GET` of `path`, decoded into `T`.
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, Error> {
        self.get_with(path, &CallOptions::new()).await
    }

    /// A `GET` of `path` with per-call settings, decoded into `T`.
    pub async fn get_with<T: DeserializeOwned>(
        &self,
        path: &str,
        options: &CallOptions,
    ) -> Result<T, Error> {
        self.decode(self.execute("GET", path, options).await?)
    }

    /// A `POST` of `body` (JSON), decoding the response into `T`.
    pub async fn post<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, Error> {
        self.method_with_body("POST", path, body, &CallOptions::new())
            .await
    }

    /// A `POST` of `body` (JSON) with per-call settings.
    pub async fn post_with<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
        options: &CallOptions,
    ) -> Result<T, Error> {
        self.method_with_body("POST", path, body, options).await
    }

    /// A `PUT` of `body` (JSON), decoding the response into `T`.
    pub async fn put<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, Error> {
        self.method_with_body("PUT", path, body, &CallOptions::new())
            .await
    }

    /// A `PUT` of `body` (JSON) with per-call settings.
    pub async fn put_with<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
        options: &CallOptions,
    ) -> Result<T, Error> {
        self.method_with_body("PUT", path, body, options).await
    }

    /// A `PATCH` of `body` (JSON), decoding the response into `T`.
    pub async fn patch<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, Error> {
        self.method_with_body("PATCH", path, body, &CallOptions::new())
            .await
    }

    /// A `PATCH` of `body` (JSON) with per-call settings.
    pub async fn patch_with<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
        options: &CallOptions,
    ) -> Result<T, Error> {
        self.method_with_body("PATCH", path, body, options).await
    }

    /// A `DELETE` of `path`, decoding the response into `T`.
    pub async fn delete<T: DeserializeOwned>(&self, path: &str) -> Result<T, Error> {
        self.decode(self.execute("DELETE", path, &CallOptions::new()).await?)
    }

    /// A `DELETE` of `path` with per-call settings.
    pub async fn delete_with<T: DeserializeOwned>(
        &self,
        path: &str,
        options: &CallOptions,
    ) -> Result<T, Error> {
        self.decode(self.execute("DELETE", path, options).await?)
    }

    /// Sends one request through the whole pipeline — URL building, auth,
    /// middleware, timeout, retries and one 401 replay — and gives the raw
    /// response. A status outside 2xx is an [`Error::HttpStatus`].
    pub async fn execute(
        &self,
        method: &str,
        path: &str,
        options: &CallOptions,
    ) -> Result<HttpResponse, Error> {
        self.run(method, path, None, options, false, None).await
    }

    async fn method_with_body<B: Serialize, T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: &B,
        options: &CallOptions,
    ) -> Result<T, Error> {
        let bytes = serde_json::to_vec(body).map_err(|e| Error::Decode {
            message: e.to_string(),
            body: String::new(),
        })?;
        let response = self
            .run(method, path, Some(bytes), options, false, None)
            .await?;
        self.decode(response)
    }

    /// The pipeline's driver: an inner retry loop over attempts, then — when a
    /// 401 answered and a provider is set — one replay with a refreshed token.
    /// `replayed` is true only on that second pass, so a still-401 response
    /// surfaces instead of refreshing forever.
    async fn run(
        &self,
        method: &str,
        path: &str,
        body: Option<Vec<u8>>,
        options: &CallOptions,
        replayed: bool,
        forced_token: Option<String>,
    ) -> Result<HttpResponse, Error> {
        let client = &self.0;
        // Guarded before the transport: `fetch` acts on the engine's context,
        // which only exists inside a component's task.
        if client.base_url.is_empty() {
            return Err(Error::Network {
                message: "no base url is set on this client (HttpClient::builder().base_url(..))"
                    .to_owned(),
            });
        }
        let url = build_url(&client.base_url, path, &options.params, &options.query);
        let body = body.map_or(HttpBody::Empty, HttpBody::Bytes);
        self.run_url(method, &url, body, options, replayed, forced_token)
            .await
    }

    /// Sends one exact request through the whole pipeline — auth, middleware,
    /// timeout, retries, observation — with no base URL joined: `request.url`
    /// must be absolute. A streamed body is refused loudly, never silently
    /// downgraded to an empty send (docs/decision.md, experiment 2).
    pub async fn send_request(&self, request: HttpRequest) -> Result<HttpResponse, Error> {
        let HttpRequest {
            method,
            url,
            headers,
            body,
            follow_redirects: _,
        } = request;
        let options = CallOptions {
            headers,
            ..CallOptions::default()
        };
        self.run_url(&method, &url, body, &options, false, None)
            .await
    }

    /// The pipeline's driver over an absolute URL: an inner retry loop over
    /// attempts, then — when a 401 answered and a provider is set — one
    /// replay with a refreshed token. `replayed` is true only on that second
    /// pass, so a still-401 response surfaces instead of refreshing forever.
    async fn run_url(
        &self,
        method: &str,
        url: &str,
        body: HttpBody,
        options: &CallOptions,
        replayed: bool,
        forced_token: Option<String>,
    ) -> Result<HttpResponse, Error> {
        // Before any attempt: a caller mistake must not burn the retry
        // budget (docs/decision.md, experiment 2).
        if body == HttpBody::Stream {
            return Err(stream_unsupported());
        }
        let bytes = match body {
            HttpBody::Bytes(bytes) => Some(bytes),
            HttpBody::Empty | HttpBody::Stream => None,
        };
        let client = &self.0;
        let retry = options
            .retry
            .clone()
            .unwrap_or_else(|| client.retry.clone());
        let timeout = options
            .timeout_ms
            .map(Duration::from_millis)
            .or(client.timeout);
        let mut attempts_done = 0_u32;
        loop {
            // One send: attempt, classify, observe.
            let sent = self
                .attempt(
                    method,
                    url,
                    bytes.clone(),
                    options,
                    timeout,
                    forced_token.clone(),
                )
                .await;
            attempts_done += 1;
            let (outcome, sent_token) = sent;
            // A status outside 2xx (and a 304, the conditional request's
            // success) is an error the retry and replay logic reasons about;
            // the rest is the answer.
            let outcome = outcome.and_then(|response| {
                if (200..300).contains(&response.status) || response.status == 304 {
                    Ok(response)
                } else {
                    Err(Error::HttpStatus {
                        status: response.status,
                        body: String::from_utf8_lossy(&response.body).into_owned(),
                        headers: response.headers,
                    })
                }
            });
            match outcome {
                Ok(response) => {
                    return Ok(HttpResponse {
                        head: HttpHead {
                            status: response.status,
                            headers: response.headers,
                            ..HttpHead::default()
                        },
                        body: response.body,
                    });
                }
                Err(error) => {
                    if retry.should_retry(method, &error, false, attempts_done) {
                        let after = retry_after_of(&error);
                        let delay = {
                            let mut noise = client
                                .noise
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            retry.delay_ms(attempts_done, after, &mut noise)
                        };
                        nsh_core::prelude::timer(Duration::from_millis(delay)).await;
                        continue;
                    }
                    // Exactly one replay: a refreshed token, shared with every
                    // other 401'd request through the single flight.
                    if let (
                        Error::HttpStatus { status: 401, .. },
                        true,
                        Some(provider),
                        Some(expired),
                    ) = (
                        &error,
                        !replayed,
                        client.token.as_ref(),
                        sent_token.as_deref(),
                    ) {
                        let fresh = match client.refresh.begin() {
                            Flight::Lead(guard) => {
                                refresh_and_publish(guard, provider, expired).await
                            }
                            // The lead may die before publishing (its task
                            // cancelled mid-refresh); then the followers wake
                            // abandoned and claim the flight again. Each
                            // round moves one waiter into the lead's seat, so
                            // this terminates without polling.
                            Flight::Follow => {
                                await_refresh(&client.refresh, provider, expired).await
                            }
                        };
                        match fresh {
                            Ok(fresh) => {
                                return Box::pin(self.run_url(
                                    method,
                                    url,
                                    bytes.map_or(HttpBody::Empty, HttpBody::Bytes),
                                    options,
                                    true,
                                    Some(fresh),
                                ))
                                .await;
                            }
                            Err(message) => return Err(Error::Network { message }),
                        }
                    }
                    return Err(error);
                }
            }
        }
    }

    /// One attempt: token, headers, middleware chain, transport raced against
    /// the deadline, the event observed either way.
    async fn attempt(
        &self,
        method: &str,
        url: &str,
        body: Option<Vec<u8>>,
        options: &CallOptions,
        timeout: Option<Duration>,
        forced_token: Option<String>,
    ) -> (Result<Response, Error>, Option<String>) {
        let client = &self.0;
        let token = match forced_token {
            Some(token) => Some(token),
            None => match &client.token {
                Some(provider) => match provider.token().await {
                    Ok(token) => Some(token),
                    Err(message) => {
                        let error = Error::Network { message };
                        return (Err(error), None);
                    }
                },
                None => None,
            },
        };

        let mut headers = client.headers.clone();
        for (name, value) in &options.headers {
            set_header(&mut headers, name, value);
        }
        // The JSON stamp yields to a caller-set content-type (a multipart
        // body must reach the wire as multipart).
        if body.as_ref().is_some_and(|b| !b.is_empty())
            && !headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        {
            set_header(&mut headers, "content-type", "application/json");
        }
        if let Some(token) = &token {
            set_header(&mut headers, "authorization", &format!("Bearer {token}"));
        }
        let request = HttpRequest {
            method: method.to_owned(),
            url: url.to_owned(),
            headers,
            body: body.map_or(HttpBody::Empty, HttpBody::Bytes),
            follow_redirects: true,
        };

        let started_at_ms = nsh_core::time::unix_ms();
        let t0 = nsh_core::time::now();
        let id = format!("nsh-http-{}", NEXT_EVENT_ID.fetch_add(1, Ordering::Relaxed));

        let transport = client.transport.clone();
        let middleware = client.middleware.clone();
        let outcome = send(&middleware, transport, request.clone(), timeout).await;

        if let Some(observer) = &client.observer {
            observer(&network_event(&id, &request, &outcome, started_at_ms, t0));
        }
        (outcome, token)
    }

    /// Decodes a 2xx response's JSON body into `T`. A 304 answers a
    /// conditional call (`execute`), not a typed one: the caller's cache
    /// still holds the value, so the typed error names the status.
    fn decode<T: DeserializeOwned>(&self, response: HttpResponse) -> Result<T, Error> {
        if response.status() == 304 {
            return Err(Error::HttpStatus {
                status: 304,
                body: String::new(),
                headers: response.head.headers,
            });
        }
        serde_json::from_slice::<T>(&response.body).map_err(|message| Error::Decode {
            message: message.to_string(),
            body: String::from_utf8_lossy(&response.body).into_owned(),
        })
    }
}

/// Sends `request` through the middleware chain around the transport, raced
/// against the deadline (`Err(())`: the deadline won).
async fn send(
    middleware: &[Arc<dyn Middleware>],
    transport: Arc<dyn Transport>,
    request: HttpRequest,
    timeout: Option<Duration>,
) -> Result<Response, Error> {
    let terminal = Box::new(
        move |request: Request| -> BoxFuture<Result<Response, Error>> {
            Box::pin(async move {
                let http = HttpRequest {
                    method: request.method,
                    url: request.url,
                    headers: request.headers,
                    body: if request.body.is_empty() {
                        HttpBody::Empty
                    } else {
                        HttpBody::Bytes(request.body)
                    },
                    follow_redirects: true,
                };
                match Timed::new(transport.fetch(http), timeout).await {
                    Ok(Ok(response)) => Ok(Response {
                        status: response.status(),
                        headers: response.head.headers,
                        body: response.body,
                    }),
                    Ok(Err(message)) => Err(Error::classify(message)),
                    Err(()) => Err(Error::Timeout),
                }
            })
        },
    );
    let whole = chain(middleware, terminal);
    // The middleware chain sees the request before it is an HttpRequest, so
    // its changes (a rewritten URL, an extra header) reach the transport.
    let request = Request {
        method: request.method,
        url: request.url,
        headers: request.headers,
        // Stream cannot appear here: run_url rejected it before any attempt.
        body: match request.body {
            HttpBody::Empty => Vec::new(),
            HttpBody::Bytes(bytes) => bytes,
            HttpBody::Stream => Vec::new(),
        },
    };
    whole(request).await
}

/// A race between one future and the deadline, on the engine's clock: the
/// client's timeouts are `timer` awaits, so a manual test clock moves them.
/// Losing the race drops the fetch future, which is the cancellation.
struct Timed<F> {
    fut: F,
    delay: Option<nsh_core::prelude::Delay>,
}

impl<F> Timed<F>
where
    F: Future + Unpin,
{
    fn new(fut: F, timeout: Option<Duration>) -> Self {
        Self {
            fut,
            delay: timeout.map(nsh_core::prelude::timer),
        }
    }
}

impl<F: Future + Unpin> Future for Timed<F> {
    type Output = Result<F::Output, ()>;

    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        use std::task::Poll;
        if let Poll::Ready(value) = Pin::new(&mut self.fut).poll(cx) {
            return Poll::Ready(Ok(value));
        }
        if let Some(delay) = &mut self.delay
            && let Poll::Ready(()) = Pin::new(delay).poll(cx)
        {
            return Poll::Ready(Err(()));
        }
        Poll::Pending
    }
}

/// The error a streamed request body gets (docs/decision.md, experiment 2:
/// on 0.4.0 the Rust transport resolves once, with the whole response, and
/// only the JS host drives a streamed send).
fn stream_unsupported() -> Error {
    Error::Network {
        message: "the Rust transport cannot stream a request body on 0.4.0 (docs/decision.md, experiment 2): send bytes instead".to_owned(),
    }
}

/// Waits for the flight's outcome, claiming the lead's seat when the
/// previous lead abandoned it.
async fn await_refresh(
    flight: &SingleFlight,
    provider: &Arc<dyn TokenProvider>,
    expired: &str,
) -> Result<String, String> {
    loop {
        match flight.wait().await {
            Waited::Result(result) => return result,
            Waited::Abandoned => {
                if let Flight::Lead(guard) = flight.begin() {
                    return refresh_and_publish(guard, provider, expired).await;
                }
            }
        }
    }
}

/// The lead publishes the refresh's outcome, releasing its followers.
async fn refresh_and_publish(
    guard: LeadGuard<'_>,
    provider: &Arc<dyn TokenProvider>,
    expired: &str,
) -> Result<String, String> {
    let result = provider.refresh(expired).await;
    guard.finish(result.clone());
    result
}

/// Percent-encodes a query value: unreserved characters stay, everything
/// else goes byte by byte (`%XX`, UTF-8).
fn encode_query(value: &str) -> String {
    encode(value, false)
}

/// Percent-encodes a path-param value; `/` survives so a param can carry a
/// path segment.
fn encode_param(value: &str) -> String {
    encode(value, true)
}

fn encode(value: &str, allow_slash: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'.' | b'_' | b'~')
            || (allow_slash && byte == b'/');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The absolute URL of a call: `:params` substituted, the base joined, the
/// query appended in order.
fn build_url(
    base: &str,
    path: &str,
    params: &[(String, String)],
    query: &[(String, String)],
) -> String {
    let mut path = path.to_owned();
    for (name, value) in params {
        path = path.replace(&format!(":{name}"), &encode_param(value));
    }
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    let mut url = if base.is_empty() {
        format!("/{path}")
    } else {
        format!("{base}/{path}")
    };
    if !query.is_empty() {
        let pairs: Vec<String> = query
            .iter()
            .map(|(name, value)| format!("{}={}", encode_query(name), encode_query(value)))
            .collect();
        url.push('?');
        url.push_str(&pairs.join("&"));
    }
    url
}

/// Replaces the first header named `name` (case-insensitively) or appends it.
fn set_header(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    if let Some(existing) = headers
        .iter_mut()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
    {
        existing.1 = value.to_owned();
    } else {
        headers.push((name.to_owned(), value.to_owned()));
    }
}

/// `Retry-After` of a retryable status error, against the app's wall clock.
fn retry_after_of(error: &Error) -> Option<Duration> {
    let value = error
        .status_headers()
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("retry-after"))
        .map(|(_, value)| value.clone())?;
    parse_retry_after(&value, nsh_core::time::unix_ms())
}

/// The event one attempt emits, honest by construction: `ttfb_ms` is `None`
/// on the Rust side (docs/decision.md: the transport resolves once, at end of
/// body), bytes come from what the client built and what came back.
fn network_event(
    id: &str,
    request: &HttpRequest,
    outcome: &Result<Response, Error>,
    started_at_ms: f64,
    t0: nsh_core::time::Instant,
) -> NetworkEvent {
    let (host, path) = parse_url(&request.url).map_or_else(
        || (request.url.clone(), "/".to_owned()),
        |parts| {
            (
                parts.host.clone(),
                parts.path.split('?').next().unwrap_or("/").to_owned(),
            )
        },
    );
    NetworkEvent {
        id: id.to_owned(),
        method: request.method.clone(),
        url: request.url.clone(),
        host,
        path,
        status: outcome.as_ref().ok().map(|response| response.status),
        started_at_ms: started_at_ms.max(0.0) as u64,
        duration_ms: nsh_core::time::now().duration_since(t0).as_millis() as u64,
        ttfb_ms: None,
        request_bytes: Some(request_bytes_of(request) as u64),
        response_bytes: outcome
            .as_ref()
            .ok()
            .map(|response| response.body.len() as u64),
        error: outcome.as_ref().err().map(|error| error.to_string()),
        initiator: None,
    }
}

/// What the client would put on the wire (the 0.4.0 Rust path never streams).
fn request_bytes_of(request: &HttpRequest) -> usize {
    match &request.body {
        HttpBody::Empty | HttpBody::Stream => 0,
        HttpBody::Bytes(bytes) => bytes.len(),
    }
}

/// Builds an [`HttpClient`]. Every field defaults: no base URL (calls fail
/// with a network error naming it), no headers, no timeout, the default
/// retry policy, no middleware, no observer, no token provider, and
/// [`NshTransport`].
pub struct HttpClientBuilder {
    base_url: String,
    headers: Vec<(String, String)>,
    timeout_ms: Option<u64>,
    retry: RetryPolicy,
    middleware: Vec<Arc<dyn Middleware>>,
    observer: Option<Observer>,
    token: Option<Arc<dyn TokenProvider>>,
    transport: Arc<dyn Transport>,
}

impl HttpClientBuilder {
    /// Every call's URL is `base_url` + the call's path.
    #[must_use]
    pub fn base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    /// A default header; a later call with the same name replaces the earlier.
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        let (name, value) = (name.into(), value.into());
        set_header(&mut self.headers, &name, &value);
        self
    }

    /// Every call's deadline in milliseconds, unless a call overrides it.
    #[must_use]
    pub fn timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }

    /// No deadline unless a call sets one.
    #[must_use]
    pub fn without_timeout(mut self) -> Self {
        self.timeout_ms = None;
        self
    }

    /// The retry policy (the default retries idempotent methods twice).
    #[must_use]
    pub fn retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    /// Adds one middleware. Installation order is run order: first installed
    /// sees the request first and the response last.
    #[must_use]
    pub fn middleware(mut self, middleware: Arc<dyn Middleware>) -> Self {
        self.middleware.push(middleware);
        self
    }

    /// Observes every finished attempt (a retry is its own attempt).
    #[must_use]
    pub fn observe(mut self, observer: Observer) -> Self {
        self.observer = Some(observer);
        self
    }

    /// The bearer token provider with single-flight 401 refresh.
    #[must_use]
    pub fn token_provider(mut self, token: Arc<dyn TokenProvider>) -> Self {
        self.token = Some(token);
        self
    }

    /// The transport behind the client; a mock for tests, else NSH's fetch.
    #[must_use]
    pub fn transport(mut self, transport: Arc<dyn Transport>) -> Self {
        self.transport = transport;
        self
    }

    /// Makes the client.
    #[must_use]
    pub fn build(self) -> HttpClient {
        HttpClient(Arc::new(Inner {
            base_url: self.base_url,
            headers: self.headers,
            timeout: self.timeout_ms.map(Duration::from_millis),
            retry: self.retry,
            middleware: self.middleware,
            observer: self.observer,
            token: self.token,
            transport: self.transport,
            refresh: SingleFlight::default(),
            noise: Mutex::new(0x853c_49e6_748f_ea9b),
        }))
    }
}
