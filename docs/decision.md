# Decision: HTTP transport for nsh-http on nsh 0.4.0

Every claim here comes from a run on installed `nsh` 0.4.0 (e626a8d) in the
throwaway apps under `scratch/decision/`, against a local server
(`scratch/decision/server.ts`). Raw outputs live in
`docs/evidence/decision/`; source citations point at the reference checkout
`~/fo/.refs/nsh-v0.4.0`, which is exactly what Homebrew installed.

## Question

What should an NSH app use to make HTTP requests from TypeScript and from
Rust on 0.4.0 — the platform's own fetch, a direct crate (reqwest, ureq), or
an npm client (ky, ofetch, axios) — and what can a network monitor honestly
record about timing (`ttfbMs`) on each side?

## Experiments

### 1. The TSX fetch surface on 0.4.0

App: `scratch/decision/exp-ts` (nsh.json declares only `hosts: ["127.0.0.1"]`),
driven by `nsh test` with `network: "live"` against `scratch/decision/server.ts`.
The API names were cross-checked against the generated `.nsh/types/nsh/globals.d.ts`
(`fetch`, `AbortSignal.timeout`, `AbortSignal.any`, `FormData`, `WebSocket`,
`BodyInit` including `ReadableStream<Uint8Array>` with `duplex: "half"`),
not against nsh.dev, which may be ahead. Full output:
`docs/evidence/decision/exp1-tsx-fetch-run.txt`.

Result: everything the library needs exists and works on 0.4.0 — streaming
response bodies (`/drip`: ttfb=1ms, body finished at 1209ms), SSE read
incrementally (first event after 1ms, stream closed at ~907ms), a streamed
request body (`duplex: "half"`, echoed `part1-part2`), `FormData` multipart
(field + `File`, parsed by the server), `WebSocket` echo (`echo:ping`),
`AbortController` (rejects `AbortError`, code 20), `AbortSignal.timeout`
(`TimeoutError`, code 23), `AbortSignal.any` (both composed), `redirect:
"manual"` (the 302 itself, `location` visible) and follow (302 -> 200
`{"route":"fast"}`), HTTP error statuses as responses (503, `ok=false`, no
rejection), network failures as `TypeError` (`Network request failed: io:
Connection refused (os error 61)`), and capability refusal as a rejection
with `code=ERR_ACCESS_DENIED`, `permission=network`, on a direct call
(`http://localhost:<port>` with only `127.0.0.1` declared) and on a redirect
hop (302 to `refused.invalid` refused before any DNS). Request and response
byte counts are observable (`requestBytes` from the body we build;
`responseBytes` from `Content-Length: 63` on `/echo`).

### 2. The Rust fetch surface on 0.4.0

App: `scratch/decision/exp-rs` (`--template rust`, same nsh.json hosts),
same server, `nsh test` with `network: "live"`. API verified against
`nsh-core/src/element/ambient.rs` (`fetch`, line 783),
`nsh-core/src/platform.rs` (`HttpRequest`, `HttpBody`, `FetchEvent`),
`nsh-core/src/element/services.rs` (`HttpResponse`), and
`nsh-core/src/core/components.rs` (`fetch_event`, lines 5223-5251). Full
output: `docs/evidence/decision/exp2-rust-fetch-run.txt`.

Result: `nsh_core::prelude::fetch` works, under the engine's stack, and
returns the whole response in one resolution — `/drip` resolved at
total=1210ms with `body_len=28` (the entire body), an SSE endpoint resolved
only after the server closed the stream (total=907ms), so SSE, download
progress and streamed uploads are not consumable through the public Rust
API. `follow_redirects: false` hands back the 302 itself (`location=
Some("/fast")`). The streaming machinery exists below the app level —
the engine's network thread emits `Head`/`Data`/`BodyWanted`
(`nsh-engine/src/net.rs`) — but `fetch_event` consumes `Head` and `Data`
internally and delivers the answer only on `End`; `HttpBody::Stream`
request chunks are driven only by the JS host (`FetchOp::Send`). Nothing
before the full body is observable from Rust code.

### 3. reqwest and ureq bypass the platform

Same Rust app with `ureq 3.5.1` and `reqwest 0.12.28` added as dependencies,
each called directly on a plain std thread. Stub-mode run output:
`docs/evidence/decision/exp3-stub-bypass-run.txt`; live run output:
`docs/evidence/decision/exp2-rust-fetch-run.txt`.

Result: bypass proven twice. (a) Under the stubbed headless network
(`open(".")` without routes; `exp3-stub-bypass-run.txt`), every app fetch
was refused with "no response is listed for it" (R1-R4b) while direct
`ureq` and `reqwest` calls returned `status=200` against the real local
server in the same process, same test — they neither see `StubNetwork` nor
respect it. (b) Live (`exp2-rust-fetch-run.txt`), both reached the server
from plain
app threads; capability blindness is structural — the grant check runs only
in the engine's fetch path (`nsh-engine/src/lib.rs:2245`), which a socket
opened by reqwest/ureq never touches. In the TSX app the same undeclared
host was refused (experiment 1), so the gate exists and only the platform
fetch passes through it.

### 3b. Capability enforcement on the Rust path

Same app, live. Full output: `docs/evidence/decision/exp2-rust-fetch-run.txt`.

Result: the TSX app was refused for `localhost` and at the refused redirect
hop; the rust-root app was not — its fetch of undeclared `localhost`
returned 200, and the redirect to `refused.invalid` was followed into real
DNS ("failed to lookup address information"). The engine has the check for
component fetches (`nsh-engine/src/lib.rs:2250`, `allows_http` on the
`Requester::Task` path, redirect hops re-checked at line 2252-2255), but it
short-circuits when the engine runs unrestricted (`is_unrestricted`, line
2248), and the headless test runner never attaches a rust root's
capabilities (`nsh-testing/src/runner.rs:224`, `Reply::Root => Built::Rust(root())`
with no `capabilities_json`, unlike the JS path at line 221). On 0.4.0,
capability enforcement is a guarantee of the JS/QuickJS path; a rust root in
a headless test run runs unrestricted regardless of nsh.json.

### 4. npm clients in QuickJS

App: `scratch/decision/exp-npm`, `bun add ky@1 ofetch@1 axios@1` (ky 1.14.3,
ofetch 1.5.1, axios 1.21.0), each imported, used against the live server,
built with `nsh build`, run under `nsh test` with `network: "live"`.
Full notes: `docs/evidence/decision/exp4-npm-clients.md`; axios run output:
`docs/evidence/decision/exp4-axios-run.txt`. Baseline app: 635 B js.

Result: all three build and run on the 0.4.0 QuickJS bundler with no
`resolve.conditions` changes. ky: 29.8 KB js / 57.3 KB bytecode. ofetch:
18.4 KB js / 41.0 KB bytecode (it needs a JSON `content-type` to
auto-parse). axios: 146.7 KB js / 261.4 KB bytecode. All three are one more
abstraction over a fetch that already streams, aborts and parses; none of
them know about capabilities, `ERR_ACCESS_DENIED`, or NSH's stub network.

### 5. What ttfbMs can honestly be

Details and numbers: `docs/evidence/decision/exp5-ttfb.md`.

Result: TSX can measure time-to-response-headers honestly — `await fetch()`
resolves at the head (`/drip`: ttfb=1ms, total=1209ms; `/slow?delay=1200`:
ttfb=1203ms = total). Rust cannot: the future resolves once, at end of body
(`/drip` total=1210ms; SSE only after close, 907ms), so a Rust ttfb would
just duplicate durationMs. The monitor records ttfbMs from TSX and sets it
to `null` from Rust.

## Decision

Both nsh-http clients wrap the platform's own fetch — the TypeScript client
over the global `fetch`, the Rust client over `nsh_core::prelude::fetch` —
with no direct HTTP crate and no npm client in the transport path.

Why: the platform fetch already gives streaming bodies, FormData, aborts,
timeouts, redirects and WebSocket in TSX, and whole-body requests through
the engine stack in Rust; it is the only path that goes through the engine's
`capabilities.network` check (refusal `ERR_ACCESS_DENIED` distinct, on
direct calls and redirect hops, wherever the host enforces grants) and the
only path NSH's stubs and test clock answer;
reqwest/ureq bypass capabilities and stubs and fail the wasm32 build; npm
clients add 19-150 KB to sit on the same fetch with none of the platform
integration. The library's job is the layer the platform lacks: base URLs,
typed decoding, the six-case error taxonomy, timeouts composed with
cancellation, retries on a manual clock, middleware, single-flight token
refresh, monitoring — not a transport.

## When a direct crate is still right

Outside app code. A build tool, a generator, or a desktop-only utility that
never ships in the app bundle can use reqwest or ureq freely — it needs no
capability grants, never runs in QuickJS, and never targets wasm32. Inside
an app, a direct crate is defensible only for a desktop-only, non-stubbed
feature where capabilities are consciously bypassed (a local dev server
client, a large download that must not buffer in memory) — and it should be
isolated behind cfg guards, because it will not compile for wasm32 (see
experiment 3/`docs/evidence/decision/exp3-wasm-with-direct-crates.txt`) and
it will silently stop hitting stubs in tests. None of that applies to
nsh-http's default path.

## npm clients

None in the library. If an app wants sugar on top of fetch — retry, hooks,
prefixes — ky (29.8 KB) or ofetch (18.4 KB) are reasonable and run on 0.4.0
without bundler tweaks; ofetch needs the server to send a JSON content-type
for auto-decoding. axios costs 146.7 KB js (231x the app's own code) and
brings its own timeout/cancel machinery, which duplicates
`AbortSignal.timeout` and composes worse with NSH cancellation. All three
would sit under nsh-http's middleware, not replace it.

## What ttfbMs can honestly be

- TypeScript: `ttfbMs` = `performance.now()` at `await fetch()` resolution
  minus request start. Honest: headers are the observable event.
- Rust: `null`. The public API resolves once, with the whole body; nothing
  earlier is observable (`docs/evidence/decision/exp5-ttfb.md`).
- `durationMs` is end of body on both sides.
- `requestBytes` is known exactly wherever the client builds the body
  (everything except a TSX streamed body, where it accumulates as sent).
- `responseBytes` comes from `Content-Length` when present (experiment 1,
  E6b), else accumulates as the stream is read (TSX) or from the final body
  length (Rust, after the fact).

## Consequences for the library

- Transport: TSX wraps global `fetch`; Rust wraps `nsh_core::fetch`.
  The Rust `HttpRequest` has no per-call timeout field — timeouts come from
  cancelling the task (`Spawned::cancel` / owner death), which the client
  implements as a race between the fetch and a timer on the manual clock.
- Streaming is TSX-only: response streams, streamed request bodies
  (`duplex: "half"`), download progress and SSE-with-reconnect are
  implemented on the TS side; the Rust side documents that a response
  arrives whole and SSE resolves only when the server closes. The Rust mock
  adapter and middleware never promise incremental bodies.
- Errors: TS maps `TypeError` ("Network request failed: ..." / DOMException
  `AbortError` code 20 / `TimeoutError` code 23) and `ERR_ACCESS_DENIED`
  (`permission: "network"`) into the taxonomy, refused-by-capability
  distinct. Rust maps the `Err(String)` shapes seen in the runs ("io: ...",
  stub misses, refusal strings when a host enforces grants).
- Capability refusal is proven live through the TSX path, including on
  redirect hops; on the Rust side, a headless rust-root test cannot prove
  it (experiment 3b) — the Rust refusal tests go through a TSX app or a
  real host target, never through `cargo test` alone.
- The mock adapter sits above the transport (a transport-seam type), and
  tests by default use NSH's own stubs (`open` stub routes /
  `StubNetwork`); the mock exists for cases the stubs cannot express.
- Monitoring: per-attempt `NetworkEvent`s with ttfbMs exactly as above;
  `requestBytes`/`responseBytes` from the sources in the previous section;
  no invented numbers.
