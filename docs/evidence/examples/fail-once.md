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
