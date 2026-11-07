# nsh-http build status

Living record of what is done, what was verified and how, and what is not verified.
Rewritten as milestones land; the final version maps every satisfaction criterion in
`docs/PROMPT.md` to its evidence. A claim with no evidence here is unverified.

## State of the build

Started 2026-11-07. The z-workflow launcher prepared a six-area workflow script
(`.zcode/workflow-drafts/nsh-http-build.ts`): decision, rust client, ts client, monitor,
streaming and uploads, examples and docs — each through implement → audit → unit tests,
plus device captures and vision judging where an area has a screen, and one whole-tree
smoke at the final join (audit and smoke loop until zero issues, capped at three rounds).

Deviation, disclosed: the dynamic-workflow engine (`CreateWorkflow`) is not available in
this harness session, so the coordinator executes that script's structure directly with
GLM-5.3-Flash subagents (implementers/operators on `general-flash`, read-only audits on
`explore-flash`, each loading its specialist persona from `.zcode/agents/` at run time).
The script file is the orchestration spec; nothing in it was weakened to fit.

## Satisfaction criteria (docs/PROMPT.md §Satisfaction criteria)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `docs/decision.md` records each option with a run result, states choice and why | **verified** | [docs/decision.md](decision.md); run evidence in [docs/evidence/decision/](evidence/decision/) (7 files); independent audit round 1 found 2 findings (missing stub-mode run evidence, figure mismatch), fixed with real runs, round 2 clean |
| 2 | Gates pass for crate and package; same behavior list in `docs/behavior.md` | not started | — |
| 3 | Ten parallel requests, expired token → exactly one refresh, all succeed (test) | implemented both sides; Rust fix round in progress (wake-on-abandon) | `crates/nsh-http/tests/auth.rs` (10 parallel → 1 refresh, 20 sends, 10 replays); `packages/nsh-http/tests/unit/auth.test.ts` |
| 4 | Retry honors `Retry-After` on a manual clock; POST does not retry by default | implemented both sides, audited clean on Rust | `crates/nsh-http/tests/retry.rs`; `packages/nsh-http/tests/unit/retry.test.ts` (Retry-After seconds + HTTP-date; POST never) |
| 5 | Timeout, caller cancel, refused capability each give their own error (test) | implemented both sides | `crates/nsh-http/tests/{timeout,errors}.rs`; `packages/nsh-http/tests/unit/{timeout,errors}.test.ts` |
| 6 | Request outside `capabilities.network` refused through the client, incl. redirect hop | **TSX: verified. Rust: upstream-blocked on 0.4.0** | TSX unit + live: `packages/nsh-http/tests/unit/errors.test.ts`, `tests/live/capability.test.ts` (redirect hop vs echo /redirect/refused). Rust side cannot be enforced anywhere on 0.4.0: headless runner drops rust-root capabilities (`nsh-testing/src/runner.rs:224`) and native hosts attach allow-all (`nsh-platform-macos/src/native.rs:270`) — real-target run proves the negative in `docs/evidence/rust-client/capability-macos-run.txt`; the client's refusal classification is tested against the engine's exact message (`tests/errors.rs`, format verified at `nsh-engine/src/access.rs:31`). Upstream issue recorded. |
| 7 | Monitor records real slow/fast timings on macos, ios, android, web; slow sorts on top; screenshots saved and looked at | not started | — |
| 8 | Redaction: token in URL or header never appears in a recorded event (test) | not started | — |
| 9 | `nsh-query` example cancels its request when the query is replaced; server log proves it | not started | — |
| 10 | README gets a person from clean clone to running demo | not started | — |

## Per-area progress

- **decision**: **done and audited clean** (2 audit rounds: round 1 found a stub-mode claim without run evidence plus a figure mismatch; both fixed with real runs — `exp3-stub-bypass-run.txt` — and round 2 returned zero findings). Decision: both clients wrap NSH's own fetch — TSX over the global `fetch` (streams, ttfb 1 ms vs total 1209 ms on a drip route), Rust over `nsh_core::prelude::fetch` (body resolves at end-of-body, so `ttfbMs` is null on Rust). reqwest/ureq bypass capabilities+stubs and fail wasm32; ky/ofetch/axios run on QuickJS but add 18-147 KB over `fetch`.
- **echo-server**: done. 127.0.0.1:61305 (pid in `tools/echo-server/.runtime.json`), 14 routes, 34 bun tests green, abort/Last-Event-ID/redirect-refusal behaviors verified live.
- **rust client**: core implemented (25 headless tests on stubs + manual clock, 2 `#[ignore]` live tests, gates green over three consecutive runs incl. wasm32; fail-once evidence via 14 deliberate mutations in `docs/evidence/rust-client/mutations.md`; real-target capability run on macos in `docs/evidence/rust-client/capability-macos-run.txt`). Coordinator-confirmed gates. Audit round 1 returned 4 low findings — 2 real defects being fixed (single-flight wake-on-abandon; silent Stream-body downgrade), 1 documented 0.4.0 limitation, 1 stale STATUS (this file). Fix round in progress; re-audit follows.
- **ts client**: **core done and audited clean** (2 audit rounds; round 1's five findings fixed — live tests pinned to the documented echo default 8123 with diagnosable SKIP, fail-once evidence for all 25 unit tests under `docs/evidence/ts-client/`, doc alignments; the auditor's index.ts finding was a false positive on build output and was retracted in round 2). 26 tests green including the live refusal test proving the redirect hop; check/build zero warnings. Committed `e6b4ac2`.
- **monitor**: queued behind the two client cores.
- **streaming and uploads**: queued behind the two client cores.
- **examples and docs**: echo server done; demos follow the cores.

## Upstream findings (so far)

- NSH 0.4.0: the headless test runner discards a rust root's `nsh.json` capabilities
  (`nsh-testing/src/runner.rs:224` builds `Built::Rust` with no `capabilities_json`; the
  engine then runs unrestricted, `nsh-engine/src/lib.rs:2248`). Proven live:
  `docs/evidence/decision/exp2-rust-fetch-run.txt`. Consequence: capability refusal of a
  Rust app cannot be honestly tested headlessly — it must be proven on a real target
  (`nsh test --target macos` or a device) or through the TSX app path. Goes to
  `docs/upstream-issues.md` when the examples area creates it.

## Not verified

- Criteria 7-10 (monitor captures, redaction, nsh-query cancellation proof, README walk) — those areas are queued behind the client cores.
- Criterion 6 on the Rust path is upstream-blocked on 0.4.0 (rust roots are never
  restricted — see the table above and docs/decision.md experiment 3b); what IS verified
  is the client's refusal classification against the engine's exact message, and the
  TSX-path refusal incl. the redirect hop.
- TSX fetch semantics verified on the headless macOS runner only; per-target behavior
  (iOS/Android/web) is the monitor area's capture work.
- Rust single-flight refresh currently lacks wake-on-abandon (audit finding) — fix round
  in progress; criterion 3's test passes but a cancelled refresh task would hang followers.
