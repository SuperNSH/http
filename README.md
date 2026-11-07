# nsh-http

An HTTP client and network monitor for [Native Shell](https://nsh.dev) apps: base URLs, typed JSON decoding, a
six-case error taxonomy, timeouts composed with the caller's cancellation, retries that honor `Retry-After`,
ordered middleware, single-flight token refresh, multipart and streaming, and an observer that records which calls
took what time.

There are two versions with the same behavior:

| Version | Path | For |
|---|---|---|
| Rust crate | `crates/nsh-http` | Rust and Rust-with-TSX apps |
| TypeScript package | `packages/nsh-http` | TSX apps, signed packages, anything with no Rust crate |

## Why two versions

Both clients wrap the transport NSH already has — TypeScript over the global `fetch`, Rust over
`nsh_core::prelude::fetch` (`docs/decision.md` has the measured comparison with reqwest, ureq, ky, ofetch and
axios). One shared implementation is impossible: a TSX app runs on NSH's prebuilt QuickJS runtime with no crate of
its own, and Rust generics and JS closures do not cross that boundary. So each side gets a full client, and the two
suites cover one behavior list.

The platform splits them on 0.4.0. TSX streams: response bodies, streamed request bodies (`duplex: "half"`), SSE,
and an honest `ttfbMs`, because `await fetch()` resolves at the response head. The Rust transport resolves once,
with the whole body, so streaming and SSE are TS-only and Rust's events record `ttfbMs: null` rather than a number
nothing measured.

Requires NSH 0.4.0.

## Rust

```toml
[dependencies]
nsh-http = { path = "../nsh-http/crates/nsh-http" }
```

```rust
use nsh_core::prelude::*;
use nsh_http::{CallOptions, HttpClient, RetryPolicy};

#[derive(serde::Deserialize)]
struct Todo {
    title: String,
}

#[component]
pub fn Todos() -> impl IntoElement {
    let titles = signal(Vec::<String>::new());
    let client = HttpClient::builder()
        .base_url("https://api.example.com")
        .timeout_ms(10_000)
        .retry(RetryPolicy::new(2))
        .build();
    spawn({
        let titles = titles.clone();
        async move {
            match client
                .get_with::<Vec<Todo>>("/todos", &CallOptions::new().query("done", "false"))
                .await
            {
                Ok(todos) => titles.set(todos.into_iter().map(|t| t.title).collect()),
                Err(error) => titles.set(vec![error.to_string()]),
            }
        }
    });
    view().child(each(
        titles,
        |title| title.clone(),
        |title, _| text(move || title.get()),
    ))
}
```

Calls are `async`: await them in a task (`spawn`), and cancel by dropping the task. Errors are one
`nsh_http::Error`: `Network`, `Timeout`, `Cancelled`, `RefusedByCapability`, `HttpStatus { status, body, headers }`,
`Decode`.

## TypeScript

Install it into `node_modules`, which the NSH bundler and `nsh check` both read. The depth depends on the app's
location; from an app under `examples/<name>/`:

```sh
mkdir -p node_modules
ln -s ../../../packages/nsh-http node_modules/nsh-http
```

(`examples/<app>/node_modules/` is three levels below the repository root, so the relative target needs three
`../`. A sibling repository such as `nsh-query` is outside the checkout — link it by absolute path.)

```tsx
import { signal, Text, View } from "nsh";
import { createClient } from "nsh-http";

const client = createClient({ baseUrl: "https://api.example.com", timeoutMs: 10_000 });

export function Todos() {
  const titles = signal<string[]>([]);
  client.get<{ title: string }[]>("/todos", { query: { done: "false" } }).then(
    (todos) => titles.set(todos.map((todo) => todo.title)),
    (error) => titles.set([String(error)]),
  );
  return (
    <View class="gap-2">
      <Each of={titles()}>{(title) => <Text>{title()}</Text>}</Each>
    </View>
  );
}
```

A call rejected with an `HttpError` carries `kind` — `"network"`, `"timeout"`, `"cancelled"`, `"refused"`,
`"http-status"`, `"decode"` — with `status` and the decoded `body` on an HTTP status.

## Behavior

The canonical list is [docs/behavior.md](docs/behavior.md): one row per behavior, naming the Rust and the
TypeScript test that covers it, kept 1:1 across the two suites.

| Behavior group | Rust entry | TypeScript entry |
|---|---|---|
| Client, typed decode, query and path params | `HttpClient::builder` | `createClient` |
| Errors, timeouts, retries, middleware, auth, mocks | `crates/nsh-http/tests/` | `packages/nsh-http/tests/unit/` |
| Monitor: ring buffer, aggregates, redaction, sampling | `tests/monitor.rs` | `tests/unit/monitor.test.ts` |
| Multipart, streams, SSE | `tests/{streaming,multipart,sse}.rs` | `tests/unit/{streaming,upload,sse}.test.ts` |
| Live rows: nsh-query cancellation, capability refusal | `tests/live_*.rs` (`#[ignore]`) | `tests/live/`, `examples/demo-ts/tests/live/` |

Two observers of one key share one load; ten parallel requests with an expired token cause exactly one refresh and
all ten succeed; a POST never retries by default; a refusal by `capabilities.network` is its own error, never a
network failure. Rows 15-16 run against this repository's echo server (`tools/echo-server`), never an external
service.

## Test

```sh
bun --cwd tools/echo-server test

cargo test --manifest-path crates/nsh-http/Cargo.toml
cd packages/nsh-http && nsh check && nsh build && nsh test

cargo fmt --manifest-path examples/demo-rs/Cargo.toml -- --check
cargo clippy --manifest-path examples/demo-rs/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path examples/demo-rs/Cargo.toml
cargo test --manifest-path examples/demo-rs/Cargo.toml -- --ignored   # LIVE: needs the echo server
nsh check examples/demo-ts
nsh build examples/demo-ts
nsh test examples/demo-ts                                              # live tests skip loudly without the server
```

The Rust live tests (`#[ignore]`, `-- --ignored`) read the echo server's port from
`tools/echo-server/.runtime.json` and fail loudly when the server is not up. The headless runner's live network on
0.4.0 never tells the server about an aborted request — the wire-level cancellation proof needs a real target:
`nsh test examples/demo-ts/tests/live/abort.test.ts --target macos` (`docs/evidence/examples/abort-runner-gap.md`).

## Demo

From a clean clone to the demo running against the local echo server. Prerequisites: `nsh` 0.4.0, `bun`, Rust
stable, and the `nsh-query` repository cloned alongside this one (`git clone --depth 1 https://github.com/SuperNSH/query ~/nsh-query`;
`~/nsh-query` below; adjust the path to yours) — the demo's query screen consumes its package read-only by
symlink. The package is TanStack Query v5 based; its dependencies install with
`(cd ~/nsh-query/packages/nsh-query && bun install --ignore-scripts)`.

**The port contract.** The echo server's pinned default is `127.0.0.1:8123`; test VMs on 0.4.0 cannot read files
or inherit environment, so the port must be known before an app runs. When that port is taken (`EADDRINUSE` —
another checkout's server, another project), the server falls through the window **8123..8132** in ascending
order before giving up, and records the ACTUAL chosen port in `tools/echo-server/.runtime.json`. The two demos
find a server anywhere in that window: the TypeScript app probes `/health` across it live (127.0.0.1 first, then
`10.0.2.2` — the Android emulator's host loopback — with a 500 ms budget per candidate, first responder wins);
the Rust app reads `.runtime.json` and honors `ECHO_PORT`. These numbers are defined here and in
`tools/echo-server/src/server.ts`; change both together.

Start the echo server on the pinned port:

```sh
(cd tools/echo-server && ECHO_PORT=8123 nohup bun run src/server.ts >/tmp/nsh-http-echo.log 2>&1 &)
cat tools/echo-server/.runtime.json           # {"port":8123,...} — or the window port it fell through to
curl -sf http://127.0.0.1:$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' tools/echo-server/.runtime.json)/health
```

If another server already holds 8123 (the usual clean-clone surprise), this start does not fail: it lands on the
first free port in 8123..8132, the runtime file names it, and both demos still find it — read on.

TypeScript demo — link the two packages, then run it:

```sh
cd examples/demo-ts
mkdir -p node_modules
ln -s ../../../packages/nsh-http node_modules/nsh-http
ln -s ~/nsh-query/packages/nsh-query node_modules/nsh-query
cd ../..
nsh run examples/demo-ts
```

The app's first line probes the window and shows what answered — `base http://127.0.0.1:8123`, or the window
port a fresh server fell through to, or `base none (ports 8123..8132)` when nothing did.

Three screens: **Echo** loads `/fast` and `/slow?delay=1200` and shows each call's status, duration and time to
first byte from the client's observer. **Query** runs an `nsh-query` load against `/slow?delay=3000`; **replace
query** moves to a new key while the old request is in flight, and **check log** reads the server's own log back
over `GET /log` to prove the dead request was aborted on the wire. **Auth** fires three parallel requests with an
expired token; the screen shows one refresh and three successes.

Rust demo — the Echo and Auth flows; the query-cancel leg is TS-only (its wire
proof needs a real target, which the TS capture above provides):

```sh
nsh run examples/demo-rs          # or: cargo run --manifest-path examples/demo-rs/Cargo.toml
```

It prints `base http://127.0.0.1:<port>` for the server its port resolution found: `ECHO_PORT` if set, else the
`.runtime.json` written at start-up (so a fresh server that fell through the window is found without extra
steps), else the pinned 8123.

Both demos auto-report one line per outcome. Their tests drive the same screens: stubs and a manual clock in
`examples/demo-rs/tests/demo.rs` and `examples/demo-ts/tests/unit/`, the real server in each area's live tests, and
`app.screenshot` captures into `docs/evidence/examples/` from
`nsh test examples/demo-ts/tests/capture/demo.test.ts --target macos` and
`nsh test examples/demo-rs/tests/capture/demo.test.ts --target macos`. One platform caveat, upstream on 0.4.0:
under `nsh test --target web` the page's `nsh` module lacks the `lifecycle` export, so the TS demo — which uses
nsh-query — cannot load there; its web capture does not exist and the tests skip loudly naming
[docs/upstream-issues.md](docs/upstream-issues.md) (`nsh run --target web` works; native targets work).
