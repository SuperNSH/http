# Fail-once evidence — examples, docs and the echo server's /log route

Hard rule: every new test is seen to fail once, by breaking the code the tests
bind to on purpose, confirming the failure names the right thing, then
restoring. This log covers the tests added by the examples-and-docs area: the
echo server's `/log` route tests, the demo-ts unit/live/capture files, and the
demo-rs stub/live/capture files. Raw outputs (one file per break) live in
`raw/` next to this document. Method: one behavior broken at a time in code the
tests bind to, the bound file run, output captured, break reverted; after the
last break, the touched suites were re-run green and `grep -rn "BROKEN ON
PURPOSE"` over `examples/` and `tools/` came back empty.

## tools/echo-server tests/server.test.ts — the `/log` describe (5 tests)

- Break A (`src/server.ts` `handleLog`): the tail is ignored — every request
  returns the whole log. Failed 2 of 39 (raw/echo-breakA-tail-ignored.txt):
  `returns the last tail lines as parsed JSON, oldest first` and `default tail
  is 20; an empty log answers {lines: []}`. `tail beyond the log's length
  returns every line there is` stayed green, as expected: it asserts the
  no-more-than-exists bound, which returning everything satisfies either way.
- Break B (`createFetchHandler`): `quiet` forced to `false`, so `/log` writes
  its own start/end lines again. Failed 3 of 39
  (raw/echo-breakB-quiet-off.txt): `reading /log appends nothing to the log,
  so the next tail is stable`, plus the two exact-tail tests, which race the
  request's own lines once they are in the file — collateral that confirms the
  quiet contract is what keeps the tail deterministic.
- Break C, first attempt (`handleLog`'s catch): a missing log file returned a
  placeholder line. FAILED TO FAIL — 39 pass — because the test truncates the
  log file rather than deleting it, so the catch (missing file) is never the
  path under test. Recorded with the output in raw/echo-breakC-empty-branch.txt's
  history; the break was rewritten to bind the real path.
- Break C', second attempt (`handleLog`): an empty parse result gets a
  placeholder line appended. Failed 1 of 39 (raw/echo-breakC-empty-branch.txt):
  `default tail is 20; an empty log answers {lines: []}`.
- Break D (routing): the `/log` method check removed. Failed 1 of 39
  (raw/echo-breakD-method-check.txt): `wrong method -> 405`.
- Restored: 39 pass, 0 fail.

## examples/demo-ts tests/unit/demo.test.ts (3 tests)

- Break E (`App.tsx` `EchoScreen`): the client's `observe` not wired, so no
  `NetworkEvent` ever arrives. Failed 1 of 3
  (raw/demo-ts-breakE-no-observe.txt): the echo test died on its first
  assertion (`fast-info status 200 ..` never shown); query and auth tests
  stayed green — they bind no timings.
- Break F (`App.tsx` `QueryScreen.replace`): the topic bump dropped, so the
  query never moves to a new key. Failed 1 of 3
  (raw/demo-ts-breakF-no-new-key.txt): `text:query-topic 2` never shown; the
  screen held `query-topic 1`, `query-status idle` (the cancel's doing).
- Break G (`App.tsx` `AuthScreen` provider): `token()` always returns
  `expired`, so no replay can carry the fresh token. Failed 1 of 3
  (raw/demo-ts-breakG-stale-token-unit.txt): `text:done 3` never shown; the
  screen held `refreshes 1`, `done 0`, `failed 3` — one refresh, three dead
  replays, which is exactly the behavior the test forbids.

## examples/demo-ts tests/live/demo.test.ts (2 tests) and tests/capture (1 test)

- Break G again (same edit): the live auth test failed the same way
  (raw/demo-ts-breakG-stale-token-live.txt) — the live suite binds the same
  screen lines; the live timings test stayed green.
- Break H (`App.tsx` `loadSlow`): the slow call asks for `delay=600` instead
  of 1200. Failed three files, each at its slow binding
  (raw/demo-ts-breakH-slow-600-{unit,live,capture}.txt): the unit echo test's
  `slow slow 1200` waitUntil, the live timings test's same condition, and the
  capture test's — each screen showed `slow slow 600`. The fast halves and the
  auth test stayed green.
- Restored: `nsh test examples/demo-ts` 7/7 green (loud SKIPs excluded below).

## examples/demo-ts tests/live/abort.test.ts (1 test, real target only)

- Break I (`App.tsx` `QueryScreen.replace`): `queryClient.cancel` dropped, so
  the old load's signal never fires. Run on `--target macos` (the abort proof
  skips on the headless runner by design — see abort-runner-gap.md): failed at
  `text:log-abort yes`, screen showed `log-abort no`
  (raw/demo-ts-breakI-no-cancel-target.txt) — the server never logged the
  abort because none happened.
- Restored: 1/1 green on `--target macos`.

## examples/demo-rs tests/demo.rs (1 test), tests/live.rs (1 test), tests/capture (1 test)

- Break J (`src/lib.rs` `Gate::refresh`): publishes `"expired"` instead of
  `"refreshed"`. Failed the stub test at `all three posts succeeded`
  (raw/demo-rs-breakJ-stale-refresh.txt) — done 0, failed 3.
- Break K (`src/lib.rs` `run_suite`): the slow call asks for `delay=120`.
  Failed the LIVE test at `the slow call decoded its echoed delay`
  (raw/demo-rs-breakK-wrong-delay-live.txt).
- Break L (`src/lib.rs`): the done marker renamed `DEMO-RS-STOP`. Failed the
  capture test headless at `wait_for("text:DEMO-RS-DONE")` — the screen's last
  line was `DEMO-RS-STOP` (raw/demo-rs-breakL-no-marker-capture.txt) — and,
  run in the same broken state, the stub test at the same wait_for: both bind
  the marker.
- Restored: `cargo test --manifest-path examples/demo-rs/Cargo.toml` green
  (1 stub test passed, 1 LIVE ignored); residue grep clean.

# Audit fix round — port-window discovery (2026-11-07)

The audit's high finding made the demo path fail whenever 8123 was already
bound. Fixes: the echo server falls through the window 8123..8132 on
EADDRINUSE; examples/demo-ts probes that window (127.0.0.1, then 10.0.2.2, 500
ms per candidate, first responder wins). New/changed tests, each seen to fail
once; raw outputs in `raw/`.

## tools/echo-server tests/server.test.ts — new start-up contract test

- The new test (two pinned servers spawned with ECHO_PORT=8123; the second must
  land on a distinct window port and each runtime file must name its own
  server) was written and run against the pre-fix code first: FAILED — the
  second server died EADDRINUSE, its runtime file never appeared
  (`expect(b).not.toBeNull()` at raw/echo-breakF-no-fallback.txt). The thrown
  error text captured in the same round ("Failed to start server. Is port 8123
  in use?") shaped `isAddressInUse`.
- Restored (fix implemented): 40 pass, 0 fail (raw/echo-fallback-restored.txt),
  including a live rehearsal with the repo's pinned server holding 8123: a
  second `ECHO_PORT=8123` start landed on 8124, answered `/health` there, and
  its runtime file recorded `{"port":8124,...}`; the temp server was stopped
  afterwards and the pinned server was untouched.

## examples/demo-ts tests/unit/demo.test.ts — base discovery (2 new tests, all tests re-bound)

- Break G2 (`App.tsx`): `WINDOW_START` moved to 8124 (the pinned default
  skipped). Failed 4 of 4 (raw/demo-ts-breakG2-window-8124.txt): every test
  that waits for `text:base http://127.0.0.1:8123` timed out and the none test
  saw `none (ports 8124..8132)` — the probe no longer finds a server on the
  pinned port, which is the auditor's failure from the other side.
- Break H2 (`App.tsx`): the none message drifted (`8123..8131`). Failed 1 of 4
  (raw/demo-ts-breakH2-none-message-drift.txt): the new none-path test only —
  this string is also the live tests' skip detection.
- Break I2 (`App.tsx`): the probe reduced to the pinned port only. Failed 1 of
  5 (raw/demo-ts-breakI2-pinned-only.txt): the new deeper-window test (`base
  http://127.0.0.1:8125`, the 8123-already-taken case) — base stayed none.
- Restored: 5/5 green; residue grep clean.

# Device-lane fix round — CORS and the web capture (2026-11-07)

## tools/echo-server tests/server.test.ts — new CORS describe (3 tests)

- The three CORS tests were written and run against the pre-fix server first:
  all 3 FAILED (raw/echo-breakK-no-cors.txt) — no `access-control-*` headers on
  answers, no 204 preflight, preflight logging untested-against. Then CORS was
  implemented (permissive headers on every response; `OPTIONS` answered 204
  before routing and kept out of the log). Restored: 43 pass, 0 fail, verified
  live on the restarted pinned server (curl shows the headers; preflight 204).

## examples/demo-ts tests/capture/demo.test.ts — the web leg

- The operator's failing web run was reproduced first (raw/demo-ts-web-fail.log
  content: `no pressable view matches id:open-Echo; on screen: []`, twice
  identically). Diagnosis (not a break): instrumented the app, then ran a
  name-by-name import bisect on minimal apps — the root cause is upstream
  (`lifecycle` missing from the web test page's `nsh` module; full account in
  docs/upstream-issues.md, entry 5, evidence web-missing-lifecycle.png +
  raw/web-name-probes.md). Not fixable in this repository's files: the demo
  must keep nsh-query (behavior row 15), and dynamic import does not split.
- Change made: the capture test detects the never-rendering page (nothing
  matches `text:/^base /` within 8 s) and SKIPs loudly naming the upstream
  entry, instead of failing with the unexplained empty screen. Its fail-once is
  the pre-change failing run itself (raw/demo-ts-web-fail.log); the same guard
  was added to the live tests' shared `show()` helper. Restored: macos capture
  still passes and saves the PNGs (re-run after the change).

## examples/demo-ts tests/live/demo.test.ts and tests/live/abort.test.ts

- Changed `show()` helpers (no-render guard added; skip reasons centralized).
  Bindings unchanged: the macos-target abort proof was re-run after the change
  and still passes (2.1s), the headless gate re-run shows 9/9 with the same
  loud SKIPs.

# Vision-judge fix round — restyle and the query-capture leg (2026-11-07)

The restyle (theme.json tokens, card/button vocabulary matching
examples/monitor-app) changed the demo's node texts, so the demo-ts tests'
assertions were re-bound to the new value-only nodes. The capture test gained a
new step: the query screen's log check must run (and show `yes …`) before its
PNG is taken, so the picture proves the criterion-9 outcome.

- Break J2 (tests/capture): the `press("id:check-log")` step removed. Run on
  `--target macos`: FAILED at `text:/^yes/` — the screen showed
  `Server log check: not checked` (raw/demo-ts-breakJ2-no-log-check.txt). This
  is the new step's fail-once, and it shows the restyled Query screen live.
- Break L2 (App.tsx EchoScreen): the fast route's value set to a wrong string.
  FAILED 1 of 5 (raw/demo-ts-breakL2-restyle-value.txt) — `text:fast` never
  shown; the screen held the broken value in the new Fast-route card. Proves
  the re-bound value bindings.
- Break L3 (App.tsx EchoScreen): the observer not wired. FAILED 1 of 5
  (raw/demo-ts-breakL3-no-observe.txt) — the observed cards stayed at
  `no call observed yet`. Proves the re-bound timings bindings.
- Break L4 (App.tsx infoFor): the observed duration replaced by a constant.
  FAILED the LIVE timings test (raw/demo-ts-breakL4-timing-lost.txt): the
  parsed duration was 0 ms against the real ~1200 ms route. Proves the
  re-bound live timing parse.
- Restored: unit 5/5, full demo-ts gate 9/9, residue grep clean.
