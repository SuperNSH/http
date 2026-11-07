# Upstream issues

Findings about NSH 0.4.0 and the sibling libraries made during this build, recorded read-only — nothing here edits
another repository. Each entry states where it bites in this repository and the workaround in use. Line numbers
refer to the exact installed sources (`nsh` 0.4.0 e626a8d; crates `~/.cargo/registry/src/*/nsh-*-0.4.0` and the
reference checkout `~/fo/.refs/nsh-v0.4.0`, which is the same code).

## 1. Rust roots are never capability-restricted on 0.4.0

Severity: high (a security boundary the docs describe does not hold on the Rust path).

A rust root's `nsh.json` `capabilities` are dropped headlessly — `nsh-testing/src/runner.rs:224` builds
`Built::Rust(root())` with no `capabilities_json` (the JS path at line 221 does attach them) — and native hosts
attach an allow-all policy: `nsh-platform-macos/src/native.rs:270`, `App::Rust(_) => Policy::default().access()`.
The engine does have the per-request check (`nsh-engine/src/lib.rs:2245-2255`, `allows_http`, redirect hops
re-checked), but `is_unrestricted` short-circuits it (`nsh-engine/src/lib.rs:2248`), and every rust root runs
unrestricted. Net effect: `capabilities.network` refusal is enforced only on the QuickJS/TSX path.

Evidence: `docs/evidence/decision/exp2-rust-fetch-run.txt` (a rust root fetches an undeclared host — 200 — and
follows a redirect to a host nothing declared, while the TSX app in the same run is refused both ways) and
`docs/evidence/rust-client/capability-macos-run.txt` (the same negatives on a real macos target). The Rust client
still classifies refusals (`crates/nsh-http/src/error.rs`) against the engine's exact message, proven in
`crates/nsh-http/tests/errors.rs`; the refusal demo runs through the TSX path (`packages/nsh-http/tests/live/`,
`examples/demo-ts`).

Workaround in this repo: capability refusal is tested through TSX apps or a real target, never through
`cargo test` alone, and the demo's Rust live tests document the gap instead of asserting refusal. Upstream fix:
attach the rust root's `capabilities_json` in the headless runner and pass the app policy in native hosts.

## 2. The headless runner's live network never tells the server about an aborted request

Severity: medium (silent behavior difference between the headless runner and every real target).

With `network: "live"` headless, app fetches go through `UreqNetwork` (`nsh-testing/src/run.rs`,
`NetworkSetup::Live`). When the app aborts a fetch through its `AbortSignal`, the JS promise rejects but the
underlying request is not cancelled: the server never sees a disconnect and answers in full. On a real target
(`--target macos` via `open_on_host`, `environment.live_network = true`) the same abort closes the request and the
server logs it. Found while building the nsh-query cancellation proof.

Evidence: `docs/evidence/examples/abort-runner-gap.md` — the server-side log excerpts of the same app flow on both
runners (headless: two `/slow` requests, both `end 200` at full 3002 ms, no `aborted` lines; target: `aborted`
with no `end`).

Workaround in this repo: the cancellation proof (`examples/demo-ts/tests/live/abort.test.ts`,
`examples/demo-rs` capture flows) runs on `--target`; on the headless runner it skips loudly and names that
command. Upstream fix: `UreqNetwork` should race the fetch future's drop/cancel against the socket and close it.

## 3. TSX `List` does not apply incremental reorders on 0.4.0

Severity: medium for anything that keeps a sorted list under live updates.

When the array passed to `List`'s `each` reorders while rows are mounted, rows keep their insertion order — the
reorder is not applied to the recycled cells. A full initial render in sorted order is fine. Found by the monitor
area's probe while building `examples/monitor-app`; their call site documents the workaround:
`examples/monitor-app/App.tsx:44` — assign a fresh sorted copy in one shot
(`calls.set([...monitor.events()].sort(...))`) so the list sees a new array per recording rather than an in-place
reorder of the old one.

Workaround in this repo: none needed — the demo's screens render results in arrival order. Upstream fix: `List`
should reconcile rows by key on reorder, not only on append/remove.

## 4. nsh-query does not cancel a released key's in-flight load

Severity: low (defensible design, but easy to read as a leak; the cancellation example depends on knowing it).

Replacing a `createQuery` key releases the previous entry, and release only schedules GC — five minutes by
default. The in-flight load keeps running, and its result is written into a cache entry nobody observes. This
holds in both implementations: `packages/nsh-query/src/query.ts` (`Entry.release` sets a gc timer; the controller
is aborted only by `start()`, `cancel()`, or `dispose()`), and `crates/nsh-query/src/query.rs:439` (`shown.release()`;
the doc comment says "Moving back to a key serves its cache"). TanStack Query behaves the same way, so this is
consistent semantics, not a bug — but an app that wants "replace the query kills the request" must say so:
`queryClient.cancel(prefix)` / `query_client().cancel(prefix)` fires the fetchers' `AbortSignal`s.

Workaround in this repo: the demo's replace button calls `queryClient.cancel(["post"])` before moving to the new
key (`examples/demo-ts/App.tsx`, QueryScreen), and the wire proof (`examples/demo-ts/tests/live/abort.test.ts`)
asserts the server saw the abort. Upstream fix, if wanted: a `cancelOnReplace` option (default off to keep
TanStack parity).

## 5. The `nsh test --target web` page's `nsh` module does not export `lifecycle` (and `computed` behaves differently than on other targets)

Severity: high for any TSX app that imports the affected names on web (here: every nsh-query-using app); invisible
elsewhere.

Under `nsh test --target web`, the generated facade for the `"nsh"` module does not provide `lifecycle`: a bundle
whose import graph reaches it fails to LINK — the page reports `SyntaxError: The requested module 'nsh' does not
provide an export named 'lifecycle'` — and nothing evaluates, not even the app's first frame. The dev page
(`nsh run --target web`) exports the name (the identical bundle renders there), and headless/QuickJS and the
native targets have it; only the test web page lacks it. Consistent with the sources: `lifecycle` appears
nowhere in `crates/nsh-platform-web/web/browser/` on 0.4.0 (`reactive.js`'s `createReactive` returns
`signal, computed, effect, cleanup, batch, untracked, root, context, split, getOwner, runWithOwner, renderEffect,
ErrorBoundary, protect` — no `lifecycle`), so the test page has nothing to export.

Measured by name, minimal apps under `nsh test --target web`: `effect`, `untracked`, `cleanup`, and `computed`
imported and unused all link and render; `lifecycle` imported fails to link; a `computed()` **called at module
scope** also blanks the page (the same import unused renders — a second, smaller quirk of the test realm).

Consequence here: `nsh-query`'s compiled code imports `lifecycle` (its `refetchOnForeground`/`refetchInterval`
logic), so **any TSX app that uses nsh-query cannot load under `nsh test --target web` on 0.4.0** —
`examples/demo-ts` included. The bundler does not split dynamic imports into separately linked chunks, so
`await import("nsh-query")` fails the same way at load time and is not a workaround (measured).

Evidence: the harness page's own problem banner captured in
`docs/evidence/examples/web-missing-lifecycle.png` (taken via `app.screenshot` during the failing capture), plus
the name-by-name probe results summarized above (raw outputs in `docs/evidence/examples/raw/`, this fix round).

Workaround in this repo: none that keeps nsh-query in the web bundle. `examples/demo-ts`'s capture and live tests
detect the never-rendering page (nothing matches `text:/^base /` within 8 s) and skip loudly naming this entry;
the demo's web capture therefore does not exist on 0.4.0, and the wire proofs run on macos/ios/android.
Upstream fix: provide `lifecycle` (ideally the full reactive export set) in the test web page's `"nsh"` module,
as the dev page effectively does.
