# Behavior

The canonical behavior list for nsh-http. The Rust crate (`crates/nsh-http`) and the
TypeScript package (`packages/nsh-http`) cover every row, one test per row in the file
named below; the two suites stay 1:1. Rows 15-16 run against the local echo server
(`tools/echo-server`): Rust live files carry `#[ignore]`, read the port from
`tools/echo-server/.runtime.json` and fail loudly when it is missing, and run with
`cargo test -- --ignored` while the server is up; TypeScript live files carry a header
comment starting with `LIVE:` and state the reason.

Predetermined test file names:

- Rust, `crates/nsh-http/tests/`: `core.rs`, `errors.rs`, `timeout.rs`, `retry.rs`,
  `middleware.rs`, `auth.rs`, `mock.rs`, `etag.rs`, `observe.rs`, `monitor.rs`,
  `streaming.rs`, `sse.rs`, `multipart.rs`, `live_capability.rs`, `live_streams.rs`.
- TypeScript unit, `packages/nsh-http/tests/unit/`: `client.test.ts`, `errors.test.ts`,
  `timeout.test.ts`, `retry.test.ts`, `middleware.test.ts`, `auth.test.ts`,
  `mock.test.ts`, `etag.test.ts`, `observe.test.ts`, `monitor.test.ts`,
  `streaming.test.ts`, `sse.test.ts`, `upload.test.ts`.
- TypeScript live, `packages/nsh-http/tests/live/`: `capability.test.ts`,
  `streaming.test.ts`, `sse.test.ts`.

| # | Behavior | Rust test | TypeScript test | Owner |
|---|---|---|---|---|
| 1 | Client construction: `createClient({ baseUrl, headers, timeoutMs, retry, middleware })` in TS; `HttpClient::builder()` in Rust. | `tests/core.rs` | `tests/unit/client.test.ts` | rust+ts core |
| 2 | Methods with typed decode: get/post/put/patch/delete with generic JSON decoding (serde in Rust), query encoding, path params. | `tests/core.rs` | `tests/unit/client.test.ts` | rust+ts core |
| 3 | Typed error taxonomy with six distinct cases: network, timeout, cancelled, refused-by-capability, http-status (carrying the decoded body), decode-failure. Refused-by-capability stays distinct from network failure (`ERR_ACCESS_DENIED` means something different). | `tests/errors.rs` | `tests/unit/errors.test.ts` | rust+ts core |
| 4 | Timeouts per client and per call, composed with the caller's cancellation (AbortSignal / cancel token). | `tests/timeout.rs` | `tests/unit/timeout.test.ts` | rust+ts core |
| 5 | Retries with backoff and jitter on a manual clock, honoring `Retry-After` (seconds and HTTP-date), only idempotent methods by default, POST never retried by default, never after a body stream started. | `tests/retry.rs` | `tests/unit/retry.test.ts` | rust+ts core |
| 6 | Middleware that reads and changes requests and responses in a defined order; the order is tested. | `tests/middleware.rs` | `tests/unit/middleware.test.ts` | rust+ts core |
| 7 | Auth seam: token provider with single-flight refresh on 401 — ten parallel requests with an expired token cause exactly one refresh and all ten succeed. | `tests/auth.rs` | `tests/unit/auth.test.ts` | rust+ts core |
| 8 | A mock adapter transport for tests, working alongside NSH's own stubs (not instead of them). | `tests/mock.rs` | `tests/unit/mock.test.ts` | rust+ts core |
| 9 | ETag and `Cache-Control` helpers that feed nsh-query: conditional requests with `If-None-Match`, 304 handling. | `tests/etag.rs` | `tests/unit/etag.test.ts` | rust+ts core |
| 10 | Observer emit points on the client: one NetworkEvent per request attempt, with honest timings (ttfbMs exactly as `docs/decision.md` allows). | `tests/observe.rs` | `tests/unit/observe.test.ts` | rust+ts core |
| 11 | Ring buffer with a set capacity; aggregates per host and per path (count, error rate, p50, p95). | `tests/monitor.rs` | `tests/unit/monitor.test.ts` | monitor |
| 12 | Redaction of secrets in URLs and headers by default; a sampling option; a standalone instrumented fetch. | `tests/monitor.rs` | `tests/unit/monitor.test.ts` | monitor |
| 13 | Multipart upload; streaming request bodies; streaming response bodies; download progress where the runtime gives it; upload progress with the honest limit documented. | `tests/streaming.rs`, `tests/multipart.rs` | `tests/unit/streaming.test.ts`, `tests/unit/upload.test.ts` | streaming |
| 14 | SSE with reconnect and `Last-Event-ID`. | `tests/sse.rs` | `tests/unit/sse.test.ts` | streaming |
| 15 | nsh-query integration: query cancellation flows to the request; the local server's log proves it (live). | `tests/live_streams.rs` | `examples/demo-ts/tests/live/` | examples-and-docs |
| 16 | A request the app's `capabilities.network` does not allow is refused through the client as refused-by-capability, including on a redirect hop (live). | `tests/live_capability.rs` | `tests/live/capability.test.ts` | rust+ts core |
