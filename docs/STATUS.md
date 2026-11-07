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
| 1 | `docs/decision.md` records each option with a run result, states choice and why | implemented, audit pending | [docs/decision.md](decision.md), 6 experiments with cited run evidence in [docs/evidence/decision/](evidence/decision/) |
| 2 | Gates pass for crate and package; same behavior list in `docs/behavior.md` | not started | — |
| 3 | Ten parallel requests, expired token → exactly one refresh, all succeed (test) | not started | — |
| 4 | Retry honors `Retry-After` on a manual clock; POST does not retry by default | not started | — |
| 5 | Timeout, caller cancel, refused capability each give their own error (test) | not started | — |
| 6 | Request outside `capabilities.network` refused through the client, incl. redirect hop | not started | — |
| 7 | Monitor records real slow/fast timings on macos, ios, android, web; slow sorts on top; screenshots saved and looked at | not started | — |
| 8 | Redaction: token in URL or header never appears in a recorded event (test) | not started | — |
| 9 | `nsh-query` example cancels its request when the query is replaced; server log proves it | not started | — |
| 10 | README gets a person from clean clone to running demo | not started | — |

## Per-area progress

- **decision**: done (scaffold round). Decision: both clients wrap NSH's own fetch — TSX over the global `fetch` (streams, ttfb 1 ms vs total 1209 ms on a drip route), Rust over `nsh_core::prelude::fetch` (body resolves at end-of-body, so `ttfbMs` is null on Rust). reqwest/ureq bypass capabilities+stubs and fail wasm32; ky/ofetch/axios run on QuickJS but add 18-147 KB over `fetch`. Independent audit pending.
- **echo-server**: done. 127.0.0.1:61305 (pid in `tools/echo-server/.runtime.json`), 14 routes, 34 bun tests green, abort/Last-Event-ID/redirect-refusal behaviors verified live.
- **rust client**: scaffold done (workspace mirrors `nsh-query`, four stub modules declared, `docs/behavior.md` 16 rows, fmt/clippy/test + wasm32 green). Core implementation starting.
- **ts client**: scaffold done (11 modules exported, frozen `NetworkEvent` verbatim, check/build green zero warnings, 2 tests). Core implementation starting.
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

- Everything in criteria 2-10 — no library behavior exists yet.
- TSX fetch semantics verified on the headless macOS runner only; per-target behavior
  (iOS/Android/web) is the monitor area's capture work.
- Capability refusal through Rust `fetch` on a real host target: not yet observed
  (engine source has the check; a real-target proof is part of the rust client area).
