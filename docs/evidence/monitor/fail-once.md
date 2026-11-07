# Monitor (Rust): every new test seen to fail once



Each test in `crates/nsh-http/tests/monitor.rs` was run against a deliberate
break in `crates/nsh-http/src/monitor.rs` (the code, never the test), the
failure captured, and the break reverted. After all ten reverts the suite is
green again (`10 passed; 0 failed`, 2026-11-07).

| # | Test | Deliberate break in monitor.rs | Observed failure |
|---|---|---|---|
| 1 | `ring_buffer_evicts_oldest_past_capacity` | eviction loop (`while len > capacity { pop_front }`) deleted | `assertion left == right failed: the oldest events leave first` |
| 2 | `aggregates_use_nearest_rank_percentiles` | `.ceil()` dropped from the nearest-rank computation | `left: Some(20), right: Some(30)` (rank truncated); also caught by `client_attempts_feed_...` (p95 160 instead of 320) |
| 3 | `client_attempts_feed_host_and_path_aggregates_on_the_manual_clock` | error events skipped when grouping | `left: (5, 0), right: (6, 1)` — count and errors wrong |
| 4 | `a_token_in_the_url_never_reaches_a_recorded_event` | `accesstoken` replaced by a dummy in `SECRET_QUERY_KEYS` | masked-url assertion failed at tests/monitor.rs:272 (token survives in the recorded URL) |
| 5 | `header_tokens_never_reach_a_recorded_event` | `cookie` replaced by a dummy in `SECRET_HEADER_NAMES` | `criterion 8: COOKIE-SECRET-7 leaked into {"id":"nsh-http-2",...}` — the serialized event carries the cookie session value |
| 6 | `redaction_is_on_by_default_and_the_opt_out_records_raw` | builder default `redact: false` | default-monitor assertion failed at tests/monitor.rs:392 (the default must redact) |
| 7 | `sampling_keeps_every_nth_attempt` | `seen % n` instead of `(seen - 1) % n` | `left: ["e2", "e5"], right: ["e0", "e3", "e6"]` |
| 8 | `sampling_rate_bounds_hold_exactly` | `Rate(_)` made always-true | `rate 0.0 keeps nothing` assertion failed at tests/monitor.rs:437 |
| 9 | `the_recorded_event_serializes_to_the_frozen_wire_shape` | `#[serde(skip)]` on `initiator` | fixture equality failed at tests/monitor.rs:478; also the frozen-key-set check at :213 |
| 10 | `the_instrumented_fetch_records_each_attempt` | `fetch()` no longer calls `record` | `one event per fetch: left: 0, right: 3` |

Two real defects were found by the tests before any mutation: the missing
`.ceil()` in `nearest_rank` (fractional ranks truncated, breaking p50/p95) and
a non-idempotent redaction mask (the `[redacted]` placeholder was truncated by
its own `]` stop character, leaving `?token=[redacted]]`). Both were fixed in
monitor.rs, not in the tests.

---

# Monitor (TypeScript): every new test seen to fail once

Each test in `packages/nsh-http/tests/unit/monitor.test.ts` (breaks in
`packages/nsh-http/src/monitor.ts`) and
`examples/monitor-app/tests/{unit/ready.test.ts,capture/ready.capture.test.ts}`
(breaks in `examples/monitor-app/App.tsx`) was run against a deliberate break,
the failure captured, and the break reverted. After the reverts both suites are
green again (`8 passed` package monitor, `4 passed` app, 2026-11-07).

| # | Test | Deliberate break | Observed failure |
|---|---|---|---|
| T1 | `the ring buffer keeps the newest attempts up to its capacity...` | ring eviction deleted in `record` | `expected ["0","1","2","3","4"] to equal ["2","3","4"]` |
| T2 | `aggregates per host and path give count, error rate, p50 and p95` | nearest rank `Math.ceil` → truncated `Math.floor` | `p95Ms: 300` instead of `400` (rank fell to the 3rd of 4 durations) |
| T3 | `a token in the URL and secrets in headers never appear in a recorded event` (criterion 8) | `"token"` replaced by `"tok3n"` in `SECRET_PARTS` | serialized event contains `?token=super-secret-token` — the criterion-8 assertion fired; also caught by the helpers test and the instrumented-fetch redaction test (`leaky-token`) |
| T4 | `redaction covers secret query names on url and path helpers...` | `redactHeaders` returned its input unchanged | `{authorization: "Bearer x", cookie: "sid=1", ...}` not redacted |
| T5 | `sampleRate keeps a deterministic fraction of attempts` | sampling gate short-circuited to always record | `["s0","s1","s2","s3"]` instead of `["s0","s2"]` |
| T6 | `a recorded attempt keeps the exact frozen wire shape` | `record` attached an `extra` field to the kept event | key set gained `"extra"` — frozen-shape equality failed |
| T7 | `the instrumented fetch records the frozen event per attempt...` | `responseBytes` pinned to `null` (Content-Length ignored) | `expected null to be 13` |
| T8 | `the instrumented fetch records a failed attempt and rethrows...` | failure path threw without emitting the event | `expected [] to have length 1` |
| T9 | app `start records slow and fast, slow on top...` + live capture (macos) | sort comparator inverted to ascending | unit: `expected 13 to be less than 9`; live capture on macos: `expected 13 to be less than 5` — slow no longer on top in both |
| T10 | app `start records...` and `the filter narrows...` | `aggregates()` pinned to `[]` | `text:/3 calls/` and `text:/1 call · 100% errors/` never shown (`expected false to be true`) |
| T11 | app `the filter narrows the calls by host or path` | filter dropped its predicate (returned all rows) | `/slow` still shown under `fast`: `expected true to be false` |
| T12 | app `when no echo server answers...` | `base.set(null)` deleted after the probe loop | `No echo server answered` never appeared (waitFor timed out on "Looking for the echo server…") |

## Audit fix round (2026-11-07): tests against the pre-fix code

The two tests added for the audit findings ran against the unfixed
`src/monitor.ts` first; their failures are the observed-before-fixed evidence.

| # | Test | Missing behavior in the pre-fix code | Observed failure |
|---|---|---|---|
| A1 | `secrets echoed in error and initiator free text never reach the recorded event (criterion 8)` | `record` masked only `url` and `path`; `error`/`initiator` free text was stored raw | serialized events contained `?token=echo-secret`, `sk-header-echo` and `sid=cookie-echo` verbatim (`not to contain "echo-secret"` fired) |
| A2 | `path aggregates group by the path without its query, like the Rust path_stats` | `byPath` keyed on the path including its query | `expected ["/slow?delay=1200","/slow"] to equal ["/slow"]` |

Both pass after the fix (10/10 in `monitor.test.ts`). The `List`-experiment
variants re-run for the evidence file are captured in
[list-experiment.md](list-experiment.md); they are measurements, not tests, and
are expected to fail while `Each` is the shipped design.
