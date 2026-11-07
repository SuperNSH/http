//! Multipart/form-data, built and sent as bytes (behavior row 13).
//!
//! The encoder follows RFC 7578 as browsers write it: `--boundary` parts with
//! a `Content-Disposition` each, a `Content-Type` on file parts only, escaped
//! `name`/`filename` values, and a closing `--boundary--`. The generated
//! boundary is checked against every part's content — RFC 2046 forbids a
//! boundary that occurs inside it — so what [`MultipartForm::encode`] gives
//! back parses the way it went in. On 0.4.0 the body travels as one byte
//! buffer through the client pipeline (`HttpBody::Stream` is refused there;
//! see `docs/decision.md`, experiment 2).
//!
//! Note for 0.4.0: the client's `send_request` seam has to carry the
//! multipart `Content-Type` through to the wire; `MultipartForm::send` is
//! written against that seam, so it works wherever custom headers on a
//! `send_request` request are honored.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

use nsh_core::platform::HttpRequest;
use nsh_core::prelude::HttpResponse;

use crate::client::HttpClient;
use crate::error::Error;

/// Why a form could not be encoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MultipartError {
    /// `with_boundary` got something RFC 2046 does not allow.
    InvalidBoundary(String),
    /// The boundary occurs inside a part's content, so the encoded body
    /// would not parse; generated boundaries re-roll, fixed ones fail.
    BoundaryCollision,
}

impl fmt::Display for MultipartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBoundary(reason) => write!(f, "invalid boundary: {reason}"),
            Self::BoundaryCollision => {
                write!(f, "the boundary occurs inside a part's content")
            }
        }
    }
}

impl std::error::Error for MultipartError {}

/// One part of a [`MultipartForm`]: a field or a file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Part {
    name: String,
    filename: Option<String>,
    content_type: Option<String>,
    bytes: Vec<u8>,
}

/// A `multipart/form-data` body under construction.
///
/// ```no_run
/// # use nsh_http::multipart::MultipartForm;
/// # async fn example(client: &nsh_http::HttpClient) -> Result<(), nsh_http::Error> {
/// let form = MultipartForm::new()
///     .text("note", "hello")
///     .file("doc", "doc.txt", "text/plain", b"file body".to_vec());
/// let response = form.send(client, "http://127.0.0.1:8123/multipart").await?;
/// # let _ = response;
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone)]
pub struct MultipartForm {
    boundary: String,
    /// Generated boundaries re-roll on a content collision; fixed ones fail.
    generated: bool,
    parts: Vec<Part>,
}

impl Default for MultipartForm {
    fn default() -> Self {
        Self::new()
    }
}

impl MultipartForm {
    /// A form with a generated boundary.
    pub fn new() -> Self {
        Self {
            boundary: generate_boundary(),
            generated: true,
            parts: Vec::new(),
        }
    }

    /// A form with a fixed boundary, validated per RFC 2046 (1-70 characters
    /// of the allowed set, no trailing space).
    pub fn with_boundary(boundary: impl Into<String>) -> Result<Self, MultipartError> {
        let boundary = boundary.into();
        let reason = boundary_error(&boundary);
        if let Some(reason) = reason {
            return Err(MultipartError::InvalidBoundary(reason));
        }
        Ok(Self {
            boundary,
            generated: false,
            parts: Vec::new(),
        })
    }

    /// Adds a text field (no `Content-Type` on the wire, as browsers write).
    #[must_use]
    pub fn text(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        let value: String = value.into();
        self.parts.push(Part {
            name: name.into(),
            filename: None,
            content_type: None,
            bytes: value.into_bytes(),
        });
        self
    }

    /// Adds a file part with its filename and content type (a file without a
    /// content type is the server's guess, so this takes one).
    #[must_use]
    pub fn file(
        mut self,
        name: impl Into<String>,
        filename: impl Into<String>,
        content_type: impl Into<String>,
        bytes: Vec<u8>,
    ) -> Self {
        self.parts.push(Part {
            name: name.into(),
            filename: Some(filename.into()),
            content_type: Some(content_type.into()),
            bytes,
        });
        self
    }

    /// The boundary this form encodes with.
    pub fn boundary(&self) -> &str {
        &self.boundary
    }

    /// The `Content-Type` header value for this form.
    pub fn content_type(&self) -> String {
        format!("multipart/form-data; boundary={}", self.boundary)
    }

    /// Encodes the whole body. A generated boundary re-rolls when a part's
    /// content contains it; a fixed one fails with
    /// [`MultipartError::BoundaryCollision`].
    pub fn encode(&self) -> Result<Vec<u8>, MultipartError> {
        let mut boundary = self.boundary.clone();
        for _ in 0..8 {
            if parts_contain(&self.parts, &boundary) {
                if !self.generated {
                    return Err(MultipartError::BoundaryCollision);
                }
                boundary = generate_boundary();
                continue;
            }
            return Ok(encode_with(&self.parts, &boundary));
        }
        Err(MultipartError::BoundaryCollision)
    }

    /// Posts the form through the client pipeline to the absolute `url`:
    /// encoded bytes as the body, [`MultipartForm::content_type`] as the
    /// request's `Content-Type` (middleware, observation and the error
    /// taxonomy all apply — this rides `HttpClient::send_request`).
    pub async fn send(
        self,
        client: &HttpClient,
        url: impl AsRef<str>,
    ) -> Result<HttpResponse, Error> {
        let content_type = self.content_type();
        let body = self.encode().map_err(|error| Error::Network {
            message: error.to_string(),
        })?;
        let request = HttpRequest::new("POST", url.as_ref())
            .header("content-type", content_type)
            .body(body);
        client.send_request(request).await
    }
}

/// Why `boundary` is not a legal RFC 2046 boundary, if it is not one.
fn boundary_error(boundary: &str) -> Option<String> {
    let len = boundary.len();
    if len == 0 || len > 70 {
        return Some(format!("must be 1-70 characters, got {len}"));
    }
    if !boundary.is_ascii() {
        return Some("must be ASCII".to_owned());
    }
    for (index, character) in boundary.char_indices() {
        let allowed = character.is_ascii_alphanumeric()
            || matches!(
                character,
                '\'' | '(' | ')' | '+' | '_' | ',' | '-' | '.' | '/' | ':' | '=' | '?'
            )
            || (character == ' ' && index + 1 != len);
        if !allowed {
            return Some(format!("{character:?} is outside the RFC 2046 set"));
        }
    }
    None
}

static NEXT_BOUNDARY: AtomicU64 = AtomicU64::new(1);

/// A fresh boundary: the clock and a counter, both legal boundary characters.
fn generate_boundary() -> String {
    let counter = NEXT_BOUNDARY.fetch_add(1, Ordering::Relaxed);
    let at = nsh_core::time::unix_ms() as u64;
    format!("nsh-http-{at:x}-{counter:x}")
}

/// Whether any part's content or header values contain the boundary — the
/// collision RFC 2046 forbids.
fn parts_contain(parts: &[Part], boundary: &str) -> bool {
    let needle = boundary.as_bytes();
    parts.iter().any(|part| {
        contains(part.name.as_bytes(), needle)
            || part
                .filename
                .as_ref()
                .is_some_and(|name| contains(name.as_bytes(), needle))
            || contains(&part.bytes, needle)
    })
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// The wire bytes: `--boundary` + headers + content per part, then the close.
fn encode_with(parts: &[Part], boundary: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        let mut disposition = format!(
            "Content-Disposition: form-data; name=\"{}\"",
            escape(&part.name)
        );
        if let Some(filename) = &part.filename {
            disposition.push_str(&format!("; filename=\"{}\"", escape(filename)));
        }
        body.extend_from_slice(disposition.as_bytes());
        body.extend_from_slice(b"\r\n");
        if let Some(content_type) = &part.content_type {
            body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
        } else {
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(&part.bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// Escapes a `name`/`filename` for `Content-Disposition`, per the HTML
/// form-encoding algorithm: `"` -> `%22`, CR -> `%0D`, LF -> `%0A`.
fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => out.push_str("%22"),
            '\r' => out.push_str("%0D"),
            '\n' => out.push_str("%0A"),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form() -> MultipartForm {
        MultipartForm::with_boundary("nsh-test-boundary")
            .unwrap()
            .text("note", "hello")
            .file("doc", "doc.txt", "text/plain", b"file body".to_vec())
    }

    #[test]
    fn the_wire_format_is_exact_parts_in_order_with_a_close() {
        let body = String::from_utf8(form().encode().unwrap()).unwrap();
        assert_eq!(
            body,
            "--nsh-test-boundary\r\n\
             Content-Disposition: form-data; name=\"note\"\r\n\
             \r\n\
             hello\r\n\
             --nsh-test-boundary\r\n\
             Content-Disposition: form-data; name=\"doc\"; filename=\"doc.txt\"\r\n\
             Content-Type: text/plain\r\n\
             \r\n\
             file body\r\n\
             --nsh-test-boundary--\r\n"
        );
    }

    /// Text parts carry no Content-Type; only the file part does.
    #[test]
    fn only_file_parts_carry_a_content_type() {
        let body = String::from_utf8(form().encode().unwrap()).unwrap();
        assert_eq!(body.matches("Content-Type:").count(), 1);
        assert!(body.contains("Content-Type: text/plain"));
    }

    #[test]
    fn names_and_filenames_are_escaped() {
        let form = MultipartForm::with_boundary("b1")
            .unwrap()
            .text("quo\"te\r\nx", "value");
        let body = String::from_utf8(form.encode().unwrap()).unwrap();
        assert!(body.contains("name=\"quo%22te%0D%0Ax\""), "{body}");
    }

    #[test]
    fn the_content_type_names_the_boundary() {
        assert_eq!(
            form().content_type(),
            "multipart/form-data; boundary=nsh-test-boundary"
        );
    }

    #[test]
    fn boundaries_outside_the_rfc_set_are_rejected() {
        assert!(MultipartForm::with_boundary("").is_err());
        assert!(MultipartForm::with_boundary("x".repeat(71)).is_err());
        assert!(MultipartForm::with_boundary("bad!exclaim").is_err());
        assert!(MultipartForm::with_boundary("trailing ").is_err());
        // Interior spaces and the RFC punctuation are fine.
        assert!(MultipartForm::with_boundary("a b=c:d.e?f(g)h'i+j,k/l_m-n").is_ok());
    }

    /// A fixed boundary that appears in the content fails; a generated one
    /// re-rolls so the body still parses.
    #[test]
    fn boundary_collisions_fail_fixed_and_reroll_generated() {
        let fixed = MultipartForm::with_boundary("X")
            .unwrap()
            .text("a", "X marks");
        assert_eq!(fixed.encode(), Err(MultipartError::BoundaryCollision));
        let generated = MultipartForm::new().text("a", MultipartForm::new().boundary().to_owned());
        let body = generated.encode().unwrap();
        assert!(body.starts_with(b"--"), "re-rolled into a parseable body");
        assert!(!generated.boundary().is_empty());
    }

    #[test]
    fn generated_boundaries_are_legal_and_distinct() {
        let first = MultipartForm::new();
        let second = MultipartForm::new();
        assert_ne!(first.boundary(), second.boundary());
        assert_eq!(boundary_error(first.boundary()), None);
    }
}
