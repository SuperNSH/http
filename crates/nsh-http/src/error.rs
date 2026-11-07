//! The six-case error taxonomy (behavior row 3): network, timeout, cancelled,
//! refused-by-capability, http-status (carrying the decoded body) and
//! decode-failure. Refused-by-capability stays distinct: `ERR_ACCESS_DENIED`
//! means something different from a failed request.

use std::fmt;

/// Why a request through [`crate::HttpClient`] did not give a decoded value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The request did not reach a response: offline, connection refused, a
    /// reset connection.
    Network {
        /// What the transport reported.
        message: String,
    },
    /// The request exceeded the deadline (the client's, or the call's).
    Timeout,
    /// The request was aborted before it finished.
    Cancelled,
    /// The app's `capabilities.network` does not grant the host, on the
    /// request itself or on a redirect hop. The engine refuses with
    /// `ERR_ACCESS_DENIED` (the message carries why and which URL).
    RefusedByCapability {
        /// What the engine reported, URL included.
        message: String,
    },
    /// A response arrived with a status outside 2xx, carrying its decoded
    /// (UTF-8) body and headers.
    HttpStatus {
        /// The status code.
        status: u16,
        /// The body decoded as text.
        body: String,
        /// The response headers, in order.
        headers: Vec<(String, String)>,
    },
    /// A 2xx response whose body did not decode into the requested type.
    Decode {
        /// What serde reported.
        message: String,
        /// The body decoded as text.
        body: String,
    },
}

impl Error {
    /// Sorts a transport's failure message into the taxonomy. The engine's
    /// refusal message names `capabilities.network` ("… is not granted: add
    /// `host` to capabilities.network in nsh.json"); abort and cancel names
    /// come from the transport or the platform.
    pub fn classify(message: String) -> Self {
        let lowered = message.to_ascii_lowercase();
        if lowered.contains("is not granted")
            || lowered.contains("capabilities.network")
            || lowered.contains("err_access_denied")
        {
            return Error::RefusedByCapability { message };
        }
        if lowered.contains("cancel") || lowered.contains("abort") {
            return Error::Cancelled;
        }
        Error::Network { message }
    }

    /// The statuses a retry may answer, and the failures worth retrying:
    /// the transport lost the request or the deadline passed.
    pub fn is_retryable(&self) -> bool {
        match self {
            Error::Network { .. } | Error::Timeout => true,
            Error::HttpStatus { status, .. } => {
                matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
            }
            Error::Cancelled | Error::RefusedByCapability { .. } | Error::Decode { .. } => false,
        }
    }

    /// The response headers when the error is an HTTP status, else empty.
    pub fn status_headers(&self) -> &[(String, String)] {
        match self {
            Error::HttpStatus { headers, .. } => headers,
            _ => &[],
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Network { message } => write!(f, "network: {message}"),
            Error::Timeout => write!(f, "timeout: the request passed its deadline"),
            Error::Cancelled => write!(f, "cancelled: the request was aborted"),
            Error::RefusedByCapability { message } => write!(f, "refused by capability: {message}"),
            Error::HttpStatus { status, body, .. } => write!(f, "http {status}: {body}"),
            Error::Decode { message, .. } => write!(f, "decode: {message}"),
        }
    }
}

impl std::error::Error for Error {}
