# nsh-http build status

Final state of the build, 2026-11-07. Every satisfaction criterion from `docs/PROMPT.md`
is mapped to the work that covered it and the evidence that proves it; anything without
evidence is listed as unverified, with the reason.

## State of the build

nsh-http exists as a Rust crate (`crates/nsh-http`) and a TypeScript package
(`packages/nsh-http`) with the same behavior, decided by experiments actually run on nsh
0.4.0 and written up in `docs/decision.md`: **both clients are thin wrappers over the
platform's own fetch** — TSX over the global `fetch`, Rust over `nsh_core::prelude::fetch`.
Direct crates (reqwest/ureq) bypass capabilities, stubs and the web target; npm clients
(ky/ofetch/axios) run on QuickJS but only add weight over `fetch`. The whole tree passed
the final smoke gate in one round (all gates green; tally below). An echo server
(`tools/echo-server`, pinned port contract 8123 with a documented 8123..8132 fallback
window) served as the local sandbox; demo apps live in `examples/`.

## Satisfaction criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `docs/decision.md` records each option with a run result, states choice and why | **verified** | [docs/decision.md](decision.md) — six experiments with cited run outputs in [docs/evidence/decision/](evidence/decision/) (7 files incl. `exp3-stub-bypass-run.txt`, `exp5-ttfb.md`); audit round 1 found 2 findings (a claim without run evidence; a figure mismatch), both fixed with real runs; round 2 clean |
| 2 | Gates pass for crate and package; same behavior list in `docs/behavior.md` | **verified** | `docs/behavior.md` 16 rows mapping 1:1 to predetermined test files on both sides. Final smoke, one round, all green: cargo fmt ✓, clippy `-D warnings` 0 findings, cargo test **68 passed / 0 failed** (+7 live with `--ignored`), wasm32 check ✓; `nsh check` ✓ + `nsh build` **zero warnings** + tests: package **66/66** (incl. live suites), monitor-app 4/4, demo-ts 9/9; `bun --cwd tools/echo-server test` **43/43**; demo-rs fmt/clippy/test ✓ + live 1/1 |
| 3 | Ten parallel requests, expired token → exactly one refresh, all succeed (test) | **verified both sides** | Rust `crates/nsh-http/tests/auth.rs` (ten parallel 401s → 1 refresh, all replay with the fresh bearer; plus a dropped-lead recovery test); TS `packages/nsh-http/tests/unit/auth.test.ts`; demo screens show `Refreshes 1 / Succeeded 3 / Failed 0` live (`docs/evidence/examples/demo-ts-auth.png`, vision-passed) |
| 4 | Retry honors `Retry-After` on a manual clock; POST does not retry by default | **verified both sides** | Rust `tests/retry.rs` (seconds AND HTTP-date on `Clock::manual`; idempotent-only; POST never; never after a stream started); TS `tests/unit/retry.test.ts` (same, jitter follows the injected random) |
| 5 | Timeout, caller cancel, refused capability each give their own error (test) | **verified both sides** | Rust `tests/timeout.rs` (per-client/per-call deadlines raced against caller cancellation via `Spawned::cancel`) + `tests/errors.rs` six-case taxonomy; TS `tests/unit/timeout.test.ts` ("the caller's cancel wins over the timeout and reads as cancelled") + `tests/unit/errors.test.ts` |
| 6 | Request outside `capabilities.network` refused through the client, incl. redirect hop | **verified on both paths on 0.6.0 (the Rust path was upstream-blocked on 0.4.0)** | 0.6.0 re-audit: Rust `tests/errors.rs` `an_undeclared_host_and_an_undeclared_redirect_hop_are_refused_by_the_engine` (stub network, root declares `127.0.0.1`) and `tests/live_capability.rs` (echo server; direct host and redirect hop) both give `RefusedByCapability`; output `docs/evidence/rust-client/capability-0.6.0-run.txt`; each fails once with the declaration removed. TSX evidence from the 0.4.0 build, unchanged: TSX: unit refusal (`errors.test.ts` — the headless capability gate refuses an undeclared-host stub) + live refusal incl. the redirect hop (`tests/live/capability.test.ts` vs echo `/redirect/refused`, runs for real, 66/66 suite). On 0.4.0 the Rust path could not be enforced at all (upstream issue 1, fixed on 0.6.0).  |
| 7 | Monitor records real slow/fast timings on macos, ios, android, web; slow sorts on top; screenshots saved and looked at | **verified — all four targets captured and vision-passed** | `docs/evidence/monitor/{macos,macos-light,ios,android,web}-ready.png`. Vision judge viewed all five and passed them: slow (1204-1228 ms) sorts above fast/health on every target; filter field + per-host aggregates visible; styled and legible. Android answered via `10.0.2.2:8123` (the app's cross-target probe working as designed); web needed the echo server's CORS fix (now in). Honest caveat: Android's fast-route timings are elevated (emulator NAT + contention with the in-flight slow request) — real timings, sort unaffected |
| 8 | Redaction: token in URL or header never appears in a recorded event (test) | **verified both sides, audit clean** | Rust `tests/monitor.rs`: serialized-event scans prove tokens in URLs, secret headers, and free-text (error/initiator) echoes never appear; `[redacted]` masking idempotent. TS `tests/unit/monitor.test.ts`: mirrored semantics (normalized secret query/header lists matching the Rust reference), criterion-8 test incl. a quoted JSON set-cookie echo |
| 9 | `nsh-query` example cancels its request when the query is replaced; server log proves it | **verified — wire proof on a real target** | `examples/demo-ts` replaces the query while `/slow` is in flight; the live test reads the server log over the network (GET `/log`) and asserts the aborted line; on `--target macos` the aborted line (start + aborted, no end) is proven in `docs/evidence/examples/abort-runner-gap.md`; the capture `demo-ts-query.png` (vision-passed) shows "Server log check: yes · the aborted request is in the log". Headless SKIP is loud and documented (upstream issue 2: headless UreqNetwork never cancels server-side) |
| 10 | README gets a person from clean clone to running demo | **verified by literal clean-clone walks** | `README.md` (nsh-query shape: pitch, two-versions table, why-two-versions, both usages, behavior table → docs/behavior.md, exact Test commands, Demo section). Auditors walked the README in fresh /tmp copies twice: round 1 found the 8123-taken collision (fixed: server falls through the documented 8123..8132 window, `.runtime.json` records the real port, demo apps probe the same window; rehearsed live with the repo's server holding 8123); round 2 walked the Demo section in a fresh clone and found no failing step |

## Re-audit on 0.6.0 (2026-11-19)

Run on `nsh 0.6.0` with the echo server up on 8123. What changed and how it was verified:

- **Rust capability refusal now works** (was upstream issue 1). New hermetic test in `crates/nsh-http/tests/errors.rs`
  and rewritten `tests/live_capability.rs`; both fail when the root's declaration is removed. This exposed a Rust
  parity bug, fixed in `crates/nsh-http/src/client.rs`: an absolute `scheme://` path was joined onto the base URL
  (the TS client passes it through), and a query was always appended with `?` even when the path had one (TS
  uses `&`). Unit test `client::tests::an_absolute_path_ignores_the_base_and_query_joins_with_the_right_separator`
  fails when `is_absolute` is broken.
- **Cancellation proof (criterion 9) now runs headless too.** `examples/demo-ts/tests/live/abort.test.ts` no longer
  skips on the headless runner; it passes headless, on `--target macos` (`docs/evidence/examples/abort-macos-0.6.0.txt`
  shows the server's `aborted` lines) and its capture leg on `--target web`. Fails when the final `yes` check is
  broken. `capture/demo.test.ts` comments updated; captures re-taken on macos and web and looked at:
  `docs/evidence/examples/demo-ts-{echo,query,auth}.png` and `*-web.png` (the web run was impossible on 0.4.0,
  issue 5).
- **The monitor screen uses `List` again** (brief requirement; `Each` was a 0.4.0 workaround, issue 3). Slow call on
  top asserted in `examples/monitor-app/tests/unit/ready.test.ts`; fails with the sort reversed. Re-captured on macos
  and web: `docs/evidence/monitor/macos-ready.png`, `web-ready.png` (slow 1207-1214 ms above 12-25 ms, looked at).
  The ios and android captures were re-taken on 0.6.0 afterwards (see "Leftovers closed" below).
- Docs updated: `README.md` (0.6.0 platform facts), `docs/decision.md` ("Re-measured on 0.6.0"),
  `docs/upstream-issues.md` (issues 1, 2, 3, 5 marked fixed on 0.6.0; 4 stands).

Gates on 0.6.0: `cargo fmt --all -- --check` 0; `cargo clippy --all-targets -- -D warnings` 0; `cargo test` 70 passed
(17 lib incl. the new unit test, tests/ incl. the new errors.rs test) + `-- --ignored` 7 passed; wasm32 `cargo check` 0;
`nsh check` / `nsh build` (zero warnings) / `nsh test` for `packages/nsh-http` 66/66, `examples/demo-ts` 9/9,
`examples/monitor-app` 4/4; `bun test` in `tools/echo-server` 43/43; `examples/demo-rs` fmt, clippy, test 1/1, live 1/1.
`nsh test` prints `warn the status bar is not granted` per test for the packages' test hosts; it is a runner
notice, not an `nsh build` warning.

## Leftovers closed on 0.6.0 (2026-11-19)

- **iOS and Android monitor captures re-taken on 0.6.0**, on own devices (simulator `nsh-http-0.6`, iPhone 17 Pro, iOS 27;
  AVD `nsh-http-0.6`, Pixel 8, android-37, on a private adb server via `ANDROID_ADB_SERVER_PORT=5038` because
  `nsh test --target android` takes the first device `adb devices` lists and the shared server held another build's
  emulator). Command: `nsh test examples/monitor-app/tests/capture/ready.capture.test.ts --target ios --device <udid>`
  / `--target android`, both pass. `docs/evidence/monitor/ios-ready.png` (looked at: slow `/slow?delay=1200` 1237 ms,
  ttfb 1232 ms, on top of `/health` 162 ms and `/fast` 24 ms; filter field and host aggregate visible) and
  `android-ready.png` (looked at: slow 1225 ms on top; `10.0.2.2` aggregate 3 calls 0% errors; the `127.0.0.1` row
  is the app's cross-target probe failing on the emulator, which cannot reach the host's loopback, as designed).
- **Criterion 6 on a real native target (macos), Rust root, 0.6.0**: `crates/nsh-http/tests/capability-app` now asserts
  `REFUSED` for an undeclared host (`localhost`) and for the redirect hop (`refused.invalid`), both through
  `HttpClient::execute` as `RefusedByCapability`; `nsh test --target macos` passes
  (`docs/evidence/rust-client/capability-macos-0.6.0-run.txt`). Fails once per leg when the declaration is widened
  (`capability-macos-0.6.0-red.txt`: declaring `localhost` gives `NOT REFUSED status=200`; declaring `refused.invalid`
  gives a DNS failure). `capability-macos-run.txt` is the superseded 0.4.0 run (nothing refused). iOS simulator not
  run for this item; macos is the same engine check. Its D2 leg now goes through the client rather than raw `fetch`.
- **Rust `fetch` re-measured on 0.6.0**: unchanged, whole body, one resolution, so `ttfbMs` stays `null` from Rust
  (`docs/evidence/decision/exp2-rust-fetch-0.6.0-run.txt`, headless and macos; numbers in `docs/decision.md`).
  The code comments and README that said "0.4.0" for this limit now say 0.6.0. The scratch test's first run failed
  on a wrong lower bound for `/stream` (908 ms, not 1.2 s); the bound was fixed to what the route sends.
- Env note: on this Mac a cold C build (`onig_sys`) hung under the `kache` rustc/cc wrapper; the runs above used
  `CARGO_BUILD_RUSTC_WRAPPER= HOST_CC=cc HOST_CXX=c++ CC_KNOWN_WRAPPER_CUSTOM=` and a PATH without the kache shims.
- Gates: `cargo fmt --all -- --check` 0, `cargo clippy --all-targets -- -D warnings` 0, `cargo test` and
  `cargo test -- --ignored` all pass (Rust-side comment edits only plus the capability-app).

## Per-area record

- **decision** — done. Six experiment families on installed 0.4.0; audited clean in 2 rounds. Committed `83bc457`.
- **rust client** — done. Core client + seam fixes (headers passthrough, loud Stream rejection, single-flight wake-on-abandon, prelude re-exports). 3 audit rounds to convergence, 19 fail-once mutations, real-target capability run. Commits `404f44f`, `d281d38`.
- **ts client** — done. 2 audit rounds clean (round 1's five findings fixed; the index.ts finding was an auditor false positive, retracted). 25 unit tests fail-once'd (`docs/evidence/ts-client/`). Commit `e6b4ac2`.
- **monitor** — done, both halves + ready screen. 2 audit rounds clean (parity: redaction, path keys, capacity 200; List deviation backed by saved experiment evidence `docs/evidence/monitor/list-experiment.md`). Probe window aligned to the port contract. Criterion-8 tests both sides. Commits `7407ac0`, `1e565b5`.
- **streaming and uploads** — done, both halves. 3 audit rounds to convergence (TS SSE/multipart parity with the Rust reference; clean-close reconnect; exact 8-candidate boundary re-roll). 26+21 fail-once mutations. Commits `7407ac0`, `1e565b5`.
- **examples and docs** — done. Echo server (14 routes + `/log`, CORS, port fallback, 43 tests), demo-ts (9 tests; criterion-9 wire proof; styled captures), demo-rs (standalone crate; live test green), README (walked clean), upstream-issues (5 entries). Audit r1's high finding (clean-clone port collision) fixed and re-walked clean. Vision judges passed both capture sets (monitor round 1; demos round 2 after the restyle). Commits `931931d` + final.

## How this was run

z-workflow structure per the brief: six areas, each through implement → audit → unit
tests, plus device captures and vision judging where an area has a screen, audits and
the final smoke capped at three rounds (the smoke converged in round 1). All subagents
ran GLM-5.3-Flash; specialist personas were loaded from `.zcode/agents/` at run time.
Disclosed deviation: the `CreateWorkflow` engine was not available in this harness, so
the coordinator executed the launcher's workflow script (`.zcode/workflow-drafts/nsh-http-build.ts`)
directly with the Agent tool; the script was never weakened.

## Not verified / honest caveats

- **Criterion 6 on the Rust path** was blocked on 0.4.0; proven on 0.6.0 headless and on a real macos target
  (see "Leftovers closed"). Not run on the iOS simulator.
- **demo-ts web capture** (superseded: exists on 0.6.0, see the re-audit); on 0.4.0 it did not exist: upstream issue 5 — the `nsh test --target web`
  page's `nsh` module lacks the `lifecycle` export, so any bundle importing nsh-query
  fails module linking (evidence `docs/evidence/examples/web-missing-lifecycle.png`,
  vision-verified). The monitor's web capture (no nsh-query import) is real and passed.
- **demo-rs captures the Echo+Auth legs only** (labeled as such in README and capture
  header); the query-cancel leg is TS-only — its wire proof needs a real target, which
  the headless live lane cannot provide (upstream issue 2).
- **Headless runs**: live abort-proof tests skip loudly headless (upstream issue 2);
  `#[ignore]`/LIVE tests run against the real server only when it is up (it was, at smoke
  time).
- Android monitor fast-route timings are elevated by emulator NAT (real timings, honest
  caveat in criterion 7).
- Rust single-flight lead-recovery test relies on the engine's deterministic
  single-threaded FIFO scheduling (same assumption as nsh-query's ordering tests).
- TS `performance.now()`-based ttfbMs is asserted for honesty (non-null when headers
  arrived, null when not), not for magnitude against the manual clock — their relation
  was never pinned.
- Vision-cosmetic, non-blocking: demo-rs capture has tight left padding.
