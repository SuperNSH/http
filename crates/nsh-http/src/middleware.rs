//! Middleware that reads and changes requests and responses in a defined order:
//! the first installed runs first on the request and last on the response
//! (behavior row 6).

use std::future::Future;
use std::pin::Pin;

use crate::error::Error;

/// A boxed future, `'static` and single-threaded: everything in the client
/// runs on the engine's executor, so futures carry no `Send` bound.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + 'static>>;

/// A request as the middleware chain sees it, before the transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// Upper-case method (`GET`, `POST`, ...).
    pub method: String,
    /// Absolute URL, query included.
    pub url: String,
    /// Header names and values, in order; names may repeat.
    pub headers: Vec<(String, String)>,
    /// The request body's bytes (empty when there is none).
    pub body: Vec<u8>,
}

/// A response as the middleware chain sees it, before decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    /// The status code.
    pub status: u16,
    /// Header names and values, in order.
    pub headers: Vec<(String, String)>,
    /// The response body's bytes.
    pub body: Vec<u8>,
}

impl Response {
    /// The first header named `name` (case-insensitively).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// The rest of the chain after one [`Middleware`]: `next.run(request)` hands
/// the (changed) request on and awaits the (later) response.
pub struct Next(Box<dyn FnOnce(Request) -> BoxFuture<Result<Response, Error>>>);

impl Next {
    /// Sends `request` through the remaining chain and the transport.
    pub fn run(self, request: Request) -> BoxFuture<Result<Response, Error>> {
        (self.0)(request)
    }
}

impl std::fmt::Debug for Next {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Next(..)")
    }
}

/// One step of the chain. Runs once per attempt, so a retry re-runs every
/// middleware (and an auth middleware can re-stamp a replayed request).
pub trait Middleware: Send + Sync + 'static {
    /// Reads (and may change) `request`, passes it to `next`, and sees the
    /// response (or the error) on the way back.
    fn handle(&self, request: Request, next: Next) -> BoxFuture<Result<Response, Error>>;
}

impl<F> Middleware for F
where
    F: Fn(Request, Next) -> BoxFuture<Result<Response, Error>> + Send + Sync + 'static,
{
    fn handle(&self, request: Request, next: Next) -> BoxFuture<Result<Response, Error>> {
        self(request, next)
    }
}

/// Builds the chain `middleware` around `terminal` (the transport call), as
/// one function of a request. Middleware `[a, b]` runs `a(b(terminal))`.
pub(crate) fn chain(
    middleware: &[std::sync::Arc<dyn Middleware>],
    terminal: Box<dyn FnOnce(Request) -> BoxFuture<Result<Response, Error>>>,
) -> Box<dyn FnOnce(Request) -> BoxFuture<Result<Response, Error>>> {
    let mut next = terminal;
    for step in middleware.iter().rev() {
        let step = step.clone();
        let inner: Box<dyn FnOnce(Request) -> BoxFuture<Result<Response, Error>>> = next;
        next = Box::new(move |request| {
            Box::pin(async move { step.handle(request, Next(Box::new(inner))).await })
        });
    }
    next
}
