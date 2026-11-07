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
| 6 | Request outside `capabilities.network` refused through the client, incl. redirect hop | **verified on the TSX path; Rust path upstream-blocked on 0.4.0 (documented)** | TSX: unit refusal (`errors.test.ts` — the headless capability gate refuses an undeclared-host stub) + live refusal incl. the redirect hop (`tests/live/capability.test.ts` vs echo `/redirect/refused`, runs for real, 66/66 suite). Rust: cannot be enforced anywhere on 0.4.0 — headless runner drops rust-root capabilities (`nsh-testing/src/runner.rs:224`) and native hosts attach allow-all (`nsh-platform-macos/src/native.rs:270`), proven by the real-target run `docs/evidence/rust-client/capability-macos-run.txt` (undeclared host returns 200, redirect followed). The Rust client's refusal CLASSIFICATION is tested against the engine's exact message (fixture format verified at `nsh-engine/src/access.rs:31`). Upstream issue 1 in [docs/upstream-issues.md](upstream-issues.md) |
| 7 | Monitor records real slow/fast timings on macos, ios, android, web; slow sorts on top; screenshots saved and looked at | **verified — all four targets captured and vision-passed** | `docs/evidence/monitor/{macos,macos-light,ios,android,web}-ready.png`. Vision judge viewed all five and passed them: slow (1204-1228 ms) sorts above fast/health on every target; filter field + per-host aggregates visible; styled and legible. Android answered via `10.0.2.2:8123` (the app's cross-target probe working as designed); web needed the echo server's CORS fix (now in). Honest caveat: Android's fast-route timings are elevated (emulator NAT + contention with the in-flight slow request) — real timings, sort unaffected |
| 8 | Redaction: token in URL or header never appears in a recorded event (test) | **verified both sides, audit clean** | Rust `tests/monitor.rs`: serialized-event scans prove tokens in URLs, secret headers, and free-text (error/initiator) echoes never appear; `[redacted]` masking idempotent. TS `tests/unit/monitor.test.ts`: mirrored semantics (normalized secret query/header lists matching the Rust reference), criterion-8 test incl. a quoted JSON set-cookie echo |
| 9 | `nsh-query` example cancels its request when the query is replaced; server log proves it | **verified — wire proof on a real target** | `examples/demo-ts` replaces the query while `/slow` is in flight; the live test reads the server log over the network (GET `/log`) and asserts the aborted line; on `--target macos` the aborted line (start + aborted, no end) is proven in `docs/evidence/examples/abort-runner-gap.md`; the capture `demo-ts-query.png` (vision-passed) shows "Server log check: yes · the aborted request is in the log". Headless SKIP is loud and documented (upstream issue 2: headless UreqNetwork never cancels server-side) |
| 10 | README gets a person from clean clone to running demo | **verified by literal clean-clone walks** | `README.md` (nsh-query shape: pitch, two-versions table, why-two-versions, both usages, behavior table → docs/behavior.md, exact Test commands, Demo section). Auditors walked the README in fresh /tmp copies twice: round 1 found the 8123-taken collision (fixed: server falls through the documented 8123..8132 window, `.runtime.json` records the real port, demo apps probe the same window; rehearsed live with the repo's server holding 8123); round 2 walked the Demo section in a fresh clone and found no failing step |

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

- **Criterion 6 on the Rust path** is unachievable on 0.4.0 (upstream issue 1): rust roots
  run unrestricted everywhere, so "refused through the client" can only be proven on the
  QuickJS/TSX path. What is verified for Rust: the client's refusal classification against
  the engine's exact message, and the documented negative (real-target run).
- **demo-ts web capture** does not exist: upstream issue 5 — the `nsh test --target web`
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
