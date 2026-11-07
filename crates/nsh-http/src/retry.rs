//! Retry policy: backoff with jitter on a manual clock, `Retry-After` (seconds and
//! HTTP-date), idempotent methods only by default, never after a body stream started.
