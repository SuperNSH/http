# Build nsh-http

## Goal

Decide, with evidence, what an NSH app should use to make HTTP requests from Rust and from TypeScript, then build the smallest library that gives apps a real client on top of it: base URLs, JSON and typed decoding, timeouts, retries, middleware, token refresh, uploads, streaming and SSE, cancellation, mocks, and network monitoring that shows which calls take what time.

This repository holds only directories, `.agents/skills`, `.zcode` and this prompt. You build everything else.

## Decide first

Write `docs/decision.md` before writing the library, and base it on experiments you actually ran on 0.4.0, in throwaway apps.

What exists already, to verify:

- TSX has a global `fetch`, with streaming bodies, `FormData`, `AbortController`, `AbortSignal.timeout` and `AbortSignal.any`, plus `WebSocket`. See `https://nsh.dev/docs/networking.md` and `https://nsh.dev/modules/standard-modules.md`.
- Rust has `nsh_core::prelude::fetch(impl Into<HttpRequest>)` and `HttpRequest` (`method`, `url`, `headers`, `body`, `follow_redirects`), where the whole body arrives with the response, per `crates/nsh-core/src/element/ambient.rs` in `~/fo/.refs/nsh-v0.4.0`. Check how far streaming goes on the Rust side. It goes through the engine's network stack, the app's `capabilities.network`, and every redirect hop. It works in `wasm32`, and `nsh_testing::StubNetwork` and `open`'s `network` stub it.
- `reqwest`, `ureq` and similar in a Rust crate: test whether they bypass capabilities, stubs and the web target. They very likely do, which likely rules them out as the default. Confirm that with a run, and say when one is still right, such as a tool or a big download on desktop only.
- npm clients in QuickJS: try `ky`, `ofetch` and `axios` through `node_modules`, and record bundle size, `resolve.conditions` needs and failures. The sandbox docs mention `axios` patterns.

If a thin wrapper is the right answer, the library is a thin wrapper, and the doc says why. Reusing what exists is a good outcome. Do not reimplement a network stack.

## The library

Rust crate `crates/nsh-http`, TypeScript package `packages/nsh-http`, with the same behavior and the same tests. Follow the structure and README shape of `~/fo/nsh-query`, including its "why two versions" section.

- `createClient({ baseUrl, headers, timeoutMs, retry, middleware })`, and `HttpClient::builder()` in Rust.
- Methods with a typed decode: `client.get<T>(path, { query })`, `post`, `put`, `patch`, `delete`. `serde` in Rust. Query encoding and path params.
- A typed error taxonomy: network, timeout, cancelled, refused by capability, HTTP status with a decoded body, decode failure. Refused-by-capability stays distinct, because `ERR_ACCESS_DENIED` means something different from a failed request.
- Timeouts per client and per call, composed with the caller's cancellation.
- Retries with backoff and jitter on a manual clock, honoring `Retry-After`, only for idempotent methods by default, and never after a body stream started.
- Middleware that can read and change requests and responses, in a defined order, with tests of that order.
- Auth seam: a token provider with single-flight refresh on 401, so ten parallel requests cause one refresh and replay once.
- Multipart upload, streaming request and response bodies, download progress where the runtime gives it, upload progress with the honest limit documented, and SSE with reconnect and `Last-Event-ID`.
- ETag and `Cache-Control` helpers that feed `nsh-query`, as `gpui-query-http` does for `gpui-query`. Read `crates/gpui-query-http` in `https://github.com/freeoxide/gpui-query`.
- `nsh-query` integration, shown in an example where cancellation goes from the query's signal to the request.
- A mock adapter for tests. It works alongside, not instead of, NSH's own stubs.

## Network monitoring

Which calls take what time is a core deliverable. A separate project, `nsh-firebase`, consumes this exact event shape, so do not change it:

```ts
interface NetworkEvent {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  startedAtMs: number;
  durationMs: number;
  ttfbMs: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
  error: string | null;
  initiator: string | null;
}
```

Provide an observer API on the client and a standalone instrumented `fetch`, a ring buffer with a set capacity, aggregates per host and path (count, error rate, p50, p95), redaction of secrets in URLs and headers by default, a sampling option, and a ready screen in `examples/` that shows the calls sorted and filterable, using `List` and the `nsh-component-library` rules.

Say what timing means here. Find out, with an experiment, what `ttfbMs` can be measured from TSX and Rust, and set it to `null` where it cannot be measured honestly. Do not invent a number.

## Areas

Disjoint files:

1. **decision**: the experiments and `docs/decision.md`.
2. **rust client**: `crates/nsh-http`.
3. **ts client**: `packages/nsh-http`.
4. **monitor**: both versions, and the screen.
5. **streaming and uploads**: both versions, and SSE.
6. **examples and docs**: a demo app in each language, against the local server, plus `README.md`.

## Sandbox

No external service. `tools/echo-server` is a small local server, in Rust or Bun, with routes for delay, status, flaky failure with `Retry-After`, ETag, chunked streaming, SSE, multipart echo and a token check. Unit tests use stubs on a manual clock, per `nsh-testing`. A labelled integration suite uses the local server through `network: "live"`, with `capabilities.network` allowing `127.0.0.1`. On the Android emulator the host is `10.0.2.2`.

## Satisfaction criteria

All of these hold, each with evidence in `docs/STATUS.md`:

1. `docs/decision.md` records each option with a run result, and states the choice and why.
2. Gates pass for the crate and the package. Rust and TypeScript suites cover the same behavior list, kept in `docs/behavior.md`.
3. Ten parallel requests with an expired token cause exactly one refresh and all succeed, in a test.
4. A retry honors `Retry-After` on a manual clock, and a POST does not retry by default.
5. A timeout, a caller's cancel and a refused capability each give their own error, in a test.
6. A request the app's `capabilities.network` does not allow is refused through the client, including on a redirect hop.
7. The monitor records the real timings of a slow route and a fast route on `macos`, `ios`, `android` and `web` through the demo, and the slow route sorts on top. Screenshots saved and looked at.
8. Redaction: a token in a URL or header never appears in a recorded event, with a test.
9. An `nsh-query` example cancels its request when the query is replaced, and the local server's log proves it.
10. `README.md` gets a person from a clean clone to a running demo.

## Environment, as measured on this Mac

- `nsh` 0.4.0 (e626a8d), from Homebrew. Do not upgrade it. Embedding frameworks: `$(brew --prefix nsh)/libexec/embed/ios/{NativeShell,NativeShellDev}.xcframework` and `$(brew --prefix nsh)/libexec/embed/android/{nsh,nsh-dev}.aar`.
- Rust stable with `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `aarch64-linux-android`, `armv7-linux-androideabi`, `x86_64-linux-android` and `wasm32-unknown-unknown` installed.
- Xcode with an iOS 27 simulator runtime. Android SDK at `$ANDROID_HOME`, NDK 29, one AVD named `indopak-audit`.
- `/usr/bin/java` is a stub with no runtime behind it. Use Android Studio's JDK: `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`.
- `bun` and `node` 24 exist. Installing dev tools with them inside this repository is fine.
- Reference source, read-only: `~/fo/.refs/nsh-v0.4.0` is exactly what is installed, including its `examples/` (`gallery`, `gallery-rs`, `embed-ios`, `embed-android`, `embed-gpui`, `rust-exports`, `host-echo`). `~/fo/.refs/nsh-main` is unreleased. `~/fo/.refs/react-native-firebase` and `~/fo/.refs/flutterfire` are the Firebase references.
- Sibling libraries, already built and tested by someone else: `~/fo/nsh-query` and `~/fo/nsh-form`. Each has a Rust crate and a TypeScript package with the same behavior. Read their READMEs. Do not edit them. If one has a bug, write it up in `docs/upstream-issues.md`, and work around it.
- Installed for this repository: the `z-nsh-engineer` agent and the skills under `.agents/skills`, by `z-project-init`. Start with `nsh`, `nsh-testing` and `nsh-design-guides`.

## Tools you may use to look at the real thing

You have full access to this machine. Use it. A headless pass alone never finishes visible or native work.

- `nsh test` headless, and `nsh test --target macos|ios|android|web`, which use real input, and `app.screenshot(path)`.
- `nsh run --target ios|android|macos|web`, `nsh package --target ...`, `xcodebuild`, `xcrun simctl`, Gradle, `adb`, and the Android emulator.
- The computer-use, ios-simulator and android-emulator plugins, the `mobile-mcp` server, `mobilecli`, the `mobile-automation` and `open-computer-use` skills for live capture, and `agent-browser` for the web.
- Save evidence as PNGs and logs under `docs/evidence/<area>/`, and look at every PNG you save. A screenshot nobody looked at proves nothing.

## Facts that bite on 0.4.0

Each of these was hit by a real run. Trust them over the docs.

- The upstream `nsh` skill follows NSH's `main` and is ahead of 0.4.0. Not in 0.4.0: `nsh update-manifest`, `nsh/updater`, the `Notifications` module, and the `notifications` capability. Check `.nsh/types` for TSX and the crate source in `~/.cargo/registry/src/*/nsh-core-0.4.0` for Rust.
- Real capability keys, from the build's own error: `network`, `webview`, `statusBar`, `clipboard`, `picker`, `speech`, `openUrl`, `process`, `fs`, `host`. A typo fails `nsh build` and passes `nsh check`. Run both.
- `If` and `Each` are globals in TSX. Importing them from `nsh` is a type error.
- `nsh check` needs an `App.tsx` at the package root, or an entry passed to it. Generated files in `.nsh/` are git-ignored, and `nsh` writes them.
- The docs' `nsh-engine = "0.1"` samples are stale. Dev-dependencies must be `0.4.0`, as all NSH crates must come from one place. The generated `Cargo.toml` has no `log` crate.
- `Headless::start` can return before the first frame, so `wait_for` something first or a step sees `on screen: []`.
- `Headless::shows` takes plain text. `wait_for`, `press` and TypeScript's `app.shows` take selectors. `wait_for_gone` also takes a timeout. `screen().count` returns a `Result`.
- `Signal::update` needs `T: Clone`. For state machines holding user types, pair `stored(..)` with a version `signal`. See `~/fo/nsh-query/crates/nsh-query/src/tracked.rs`.
- A component's signals are already disposed when its `cleanup` runs, so reading one there panics. Capture what cleanup needs in an `Rc<Cell<..>>`. `create_root` gives an owner that outlives the component, which suits caches and in-flight writes.
- `open`'s host handlers need annotated parameters: `async ({ id }: { id: number }) => ...`. Selector regexes use Rust's `regex` syntax, so no look-ahead. On a manual clock, `open(entry, { clock: {} })`, a test that took 13.7 s took 18 ms.
- A TSX app consumes a sibling package through `node_modules`, with `mkdir -p node_modules && ln -s <path> node_modules/<name>`. The bundler and `nsh check` both read it, and `tsconfig.json` needs no change. Overriding `compilerOptions.paths` there breaks the `nsh` types.
- `nsh package` needs no Xcode project and no Gradle, and has no setting for extra native SDKs, URL schemes or entitlements beyond the provisioning profile. Anything needing those goes through an embedding host: `NshAppView` with `app.handle(..)` on iOS, and `NshView` with `nsh.handle(..)` on Android, as `examples/embed-ios` and `examples/embed-android` do. The app talks to it with `host.call`, `host.post` and `host.on`, and must list the names in `capabilities.host`.
- Failed host calls reject with `ERR_ACCESS_DENIED` when undeclared, `ERR_NSH_HOST_ERROR` when unhandled or thrown, and `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` with no host.
- Bytecode loads only from the app bundle, the APK or a verified package.

## How to run this

Use the `z-workflow` skill. All subagents run on GLM-5.3-Flash with high thinking. Split the work into the areas named below, with disjoint files, each advancing alone through its own chain. Name these phases for every area: implement, audit, unit tests. Add native device testing to any area touching iOS, Android or desktop, and a vision phase to any area with a screen. End with a whole-tree smoke gate. Run audit and smoke until zero issues, capped at three rounds, and report honestly if a cap is reached rather than weakening a check.

Set this session's goal to the goal above, and keep working until the satisfaction criteria hold or you are truly blocked. When you are blocked on one area, finish every other area first. Do not stop to ask whether to continue.

## Hard rules

- No real accounts, no real credentials, no billing, and no signing in as anyone. Never type a password or create an account on any provider's site. Everything here must work in a sandbox, as described below.
- Never commit a secret, a real `google-services.json` or `GoogleService-Info.plist`, or a real client secret. Fixtures with obviously fake values go under `fixtures/`.
- Do not publish to crates.io or npm, do not change repository visibility, and do not push. Commit on `main` as each milestone passes, using Conventional Commits with the reason in the body.
- Comments are 1-2 lines and state a non-obvious constraint. Never narrate the next line. Dead code is deleted. No speculative abstractions.
- Docs read like a competent human wrote them: direct, concrete, no marketing filler. The `antislop-copy` and `code-comments` skills apply.
- Never invent an API. Look the name up, in the source for 0.4.0.
- A Rust gate is `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test`. A TSX gate is `nsh check`, `nsh build` with every warning fixed, and `nsh test`. No check is weakened, skipped or deleted to get a pass.
- Tests go through the UI on a manual clock, with no real network and no real time, except the labelled sandbox runs below. Every new test is seen to fail once, by breaking the code on purpose. Use `test-quality-guardrails`.
- `docs/STATUS.md` stays current with what is done, what was verified how, and what was not verified. A claim with no evidence is reported as unverified.
