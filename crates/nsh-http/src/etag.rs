//! ETag and `Cache-Control` helpers feeding `nsh-query`: conditional requests
//! with `If-None-Match` and 304 handling (behavior row 9). A query layer keeps
//! one of these per key, revalidates with it, and reads its `max_age_ms` for
//! the fresh window.

use nsh_core::platform::HttpRequest;
use nsh_core::prelude::HttpResponse;

/// One resource's revalidation state: the `ETag` of the last full response,
/// sent back as `If-None-Match` so the server can answer 304 and save the
/// body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConditionalGet {
    etag: Option<String>,
}

impl ConditionalGet {
    /// Nothing seen yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The stored ETag, if any.
    pub fn etag(&self) -> Option<&str> {
        self.etag.as_deref()
    }

    /// Adds `If-None-Match` to `request` when an ETag is stored. Replaces an
    /// existing header: a stale one would defeat the revalidation.
    pub fn apply_to(&self, request: &mut HttpRequest) {
        if let Some(etag) = &self.etag {
            if let Some(existing) = request
                .headers
                .iter_mut()
                .find(|(name, _)| name.eq_ignore_ascii_case("if-none-match"))
            {
                existing.1 = etag.clone();
            } else {
                request
                    .headers
                    .push(("if-none-match".to_owned(), etag.clone()));
            }
        }
    }

    /// Remembers the response's `ETag` (2xx responses only: a 304 names the
    /// body the stored one already describes).
    pub fn observe(&mut self, response: &HttpResponse) {
        if (200..300).contains(&response.status())
            && let Some(etag) = header_of(&response.head.headers, "etag")
        {
            self.etag = Some(etag.to_owned());
        }
    }

    /// Whether `response` is a 304: the stored value is still the truth, so a
    /// query layer keeps serving its cached entry.
    pub fn was_not_modified(&self, response: &HttpResponse) -> bool {
        response.status() == 304
    }
}

/// The first header named `name` (case-insensitively).
fn header_of<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// The response's `ETag`, if it has one.
pub fn etag_of(response: &HttpResponse) -> Option<&str> {
    header_of(&response.head.headers, "etag")
}

/// How long a `Cache-Control` response header says the response stays fresh,
/// in milliseconds: `max-age` (or `s-maxage`) as seconds. `None` when the
/// header is absent, unparsable, or says `no-store` / `no-cache` (revalidate
/// every time instead).
pub fn max_age_ms(cache_control: &str) -> Option<u64> {
    let lowered = cache_control.to_ascii_lowercase();
    if lowered.split(',').any(|directive| {
        let directive = directive.trim();
        directive == "no-store" || directive == "no-cache"
    }) {
        return None;
    }
    lowered.split(',').find_map(|directive| {
        let directive = directive.trim();
        for name in ["max-age", "s-maxage"] {
            if let Some(value) = directive
                .strip_prefix(name)
                .and_then(|rest| rest.strip_prefix('='))
            {
                return value
                    .trim()
                    .parse::<u64>()
                    .ok()
                    .map(|seconds| seconds * 1000);
            }
        }
        None
    })
}
