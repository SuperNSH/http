//! A mock transport for tests, answering from a closure or a fixed response.
//! It sits at the client's transport seam, so it runs beside NSH's own stubs
//! (`StubNetwork` under the engine), not instead of them (behavior row 8).

use std::sync::{Arc, Mutex};

use nsh_core::platform::{HttpHead, HttpRequest};
use nsh_core::prelude::HttpResponse;

use crate::client::Transport;
use crate::middleware::BoxFuture;

/// A transport that asks `handler` for each response and records what it was
/// asked. Shared in an `Arc` (the builder takes `Arc<dyn Transport>`); read
/// `requests()` back to assert what the client actually sent.
pub struct MockTransport {
    handler: Arc<dyn Fn(HttpRequest) -> Result<HttpResponse, String> + Send + Sync>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl MockTransport {
    /// Answers every request with what `handler` gives (`Err`: the message
    /// [`crate::Error::classify`] sorts into the taxonomy).
    pub fn new(
        handler: impl Fn(HttpRequest) -> Result<HttpResponse, String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            handler: Arc::new(handler),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// Answers every request with `status` and `body` (an `application/json`
    /// response).
    pub fn json(status: u16, body: impl Into<Vec<u8>>) -> Self {
        let body = body.into();
        Self::new(move |_| {
            Ok(HttpResponse {
                head: HttpHead {
                    status,
                    headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                    ..HttpHead::default()
                },
                body: body.clone(),
            })
        })
    }

    /// Fails every request with `message`, as a transport that cannot reach
    /// the network would.
    pub fn failing(message: impl Into<String>) -> Self {
        let message = message.into();
        Self::new(move |_| Err(message.clone()))
    }

    /// The requests this transport was asked, in order.
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl Transport for MockTransport {
    fn fetch(&self, request: HttpRequest) -> BoxFuture<Result<HttpResponse, String>> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(request.clone());
        let answer = (self.handler)(request);
        Box::pin(async move { answer })
    }
}
