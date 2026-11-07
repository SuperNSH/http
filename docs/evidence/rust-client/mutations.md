# Mutation round: every new test seen to fail once (2026-11-07)

Per docs/PROMPT.md §Hard rules, each behavior's test was made to fail against a
deliberate break in `crates/nsh-http/src`, the failure was confirmed to name the
right thing, and the code was restored. The full suite is green after restore.

| # | Mutation (file: break) | Test that caught it | Failure observed |
|---|---|---|---|
| 1 | error.rs: all three refusal markers disabled (`is not granted`, `capabilities.network`, `ERR_ACCESS_DENIED`) | errors.rs | `refusal_is_a_different_error_from_a_network_failure`: `matches!(refused, Error::RefusedByCapability)` failed; `every_error_lands_in_its_own_case` failed on `refused:refused`. (A first attempt mutating only the first marker passed — the message carries a second marker; all three had to go.) |
| 2 | client.rs: the 401 replay branch keyed on status 402 | auth.rs | both tests failed: refresh count 0, `refresh-failed true` never shown |
| 3 | client.rs: `Timed` never polls the deadline | timeout.rs | `client-deadline timeout` never shown ("missed") |
| 4 | retry.rs: `idempotent_only` check dropped (`|| false`) | retry.rs | `a_post_never_retries_by_default`: 2 sends; policy unit test: `should_retry("POST", ..)` returned true |
| 5 | retry.rs: `Retry-After` ignored (backoff used) | retry.rs | flaky seconds test waits collapsed; unit test: Retry-After cap assertion failed (130) |
| 6 | middleware.rs: chain folded without `.rev()` | middleware.rs | order log became `[inner-req, outer-req, outer-resp, inner-resp]` |
| 7 | client.rs: event `ttfb_ms: Some(1)` (invented) | observe.rs | `Some(1) != None` ("no honest TTFB"); serde key `ttfbMs` no longer null |
| 8 | client.rs: 304 no longer passes through `execute` | etag.rs | `second 304=true empty=true` never shown |
| 9 | client.rs: query values not percent-encoded | core.rs | stub miss (route keyed with `q=hello%20world`); test panicked |
| 10 | client.rs: `:params` substitution dropped | core.rs | stub miss on `/users/42` route |
| 11 | etag.rs: `apply_to` never stamps | etag.rs | If-None-Match header assertion failed |
| 12 | client.rs: base-url guard removed | core.rs | no-base call no longer fails with "no base url" |
| 13 | client.rs: builder's transport ignored (always `NshTransport`) | mock.rs | both mock tests failed (mock never consulted) |
| 14 | client.rs: decode failures classified as `Network` | errors.rs | `every_error_lands_in_its_own_case` failed on `decode:decode` (an earlier attempt swapping the variant kept the `body` field and failed to compile instead — not a behavioral mutation) |

## Audit-fix round (2026-11-07): findings 1-2 of the core audit

| # | Mutation (file: break) | Test that caught it | Failure observed |
|---|---|---|---|
| 15 | auth.rs: `LeadGuard::drop` releases nobody (the pre-fix behavior — no wake-on-abandon) | auth.rs `a_dropped_lead_releases_the_followers_instead_of_hanging_them` | FAILED: the follower stayed parked on the abandoned flight, "follower true" never shown |
| 16 | client.rs: `send_request` silently downgrades `HttpBody::Stream` to an empty send (the pre-fix behavior) | errors.rs `a_streamed_request_body_fails_loudly_instead_of_sending_empty` | FAILED: `stream loud=false` — the request went through instead of erroring |

## Audit round 2 (2026-11-07): residual findings 1-2

| # | Mutation (file: break) | Test that caught it | Failure observed |
|---|---|---|---|
| 17 | client.rs: the Stream guard moved back to per-attempt `send()` (inside run_url's retry loop) instead of the pre-loop hoist | errors.rs `a_streamed_request_body_fails_loudly_instead_of_sending_empty` | FAILED: with the default retry policy the refusal burned attempts (mock called, events recorded) instead of surfacing in one attempt with zero events. (A first mutation attempt was a behavioral no-op — a stale-string bug wrote back the hoisted guard alongside the per-attempt one — and passed; redone consistently.) |

## Post-completion seam round (2026-11-07): send_request headers + content-type stamp

| # | Mutation (file: break) | Test that caught it | Failure observed |
|---|---|---|---|
| 18 | client.rs: `send_request` drops `request.headers` again (the pre-fix behavior) | core.rs `send_request_carries_caller_headers_and_preserves_a_content_type` | FAILED: `the caller's content-type was clobbered: [("content-type", "application/json")]` — both caller headers gone |
| 19 | client.rs: the application/json stamp unconditional again (clobbers a caller content-type) | core.rs `send_request_carries_caller_headers_and_preserves_a_content_type` | FAILED: `the caller's content-type was clobbered: [("content-type", "application/json"), ("x-seam", "from-caller")]` — headers carried but the multipart type overwritten |
