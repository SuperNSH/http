// nsh-http build — six areas, each through its own implement → audit → unit tests chain,
// plus native captures and vision judging where an area has a screen, and one whole-tree
// smoke at the final join. Decision experiments lead; library areas scaffold structure
// immediately and wait for docs/decision.md before transport code.

const MODELS = {
  flash: model("account:zai-individual-coding-plan/GLM-5.3-Flash$high"),
};

type AgentHandle = ReturnType<typeof agent>;

const AGENT_DIR = "/Users/hmziq/fo/nsh-http/.zcode/agents";

async function specialist(name: string, fallback: string): Promise<{ persona: string; source: string }> {
  const adapter =
    `You are the ${name} specialist for one area of a parallel workflow. ` +
    `Your full specialist contract follows verbatim — apply it to this area's work; ` +
    `where it conflicts with your ask, the ask wins.` + "\n\n";
  for (const p of [`.zcode/agents/${name}.md`, `${AGENT_DIR}/${name}.md`]) {
    try {
      const raw = await files.read(p);
      return { persona: adapter + raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim(), source: p };
    } catch { /* try the next source */ }
  }
  return { persona: fallback, source: "fallback" };
}

// ---------- shared ask text ----------

const NO_GIT =
  "Work directly in the current checkout at /Users/hmziq/fo/nsh-http — no branches, no worktrees, " +
  "no git commits, no pushes. The coordinator commits at milestones. Never publish to crates.io or npm.\n";

const FACTS = `
Environment facts, measured on this Mac (trust them over the docs):
- nsh 0.4.0 (e626a8d), from Homebrew. Do not upgrade. NEVER invent an API: look names up in the reference source at ~/fo/.refs/nsh-v0.4.0 (read-only), in ~/.cargo/registry/src/*/nsh-core-0.4.0 for Rust, or in a package's generated .nsh/types for TSX. The nsh.dev site and the upstream nsh skill follow main and may be ahead of 0.4.0.
- Real capability keys: network, webview, statusBar, clipboard, picker, speech, openUrl, process, fs, host. A typo fails nsh build but passes nsh check — always run BOTH.
- If and Each are globals in TSX; importing them from nsh is a type error.
- nsh check/build/test/run all accept an app directory as their entry argument, so they can run from the repo root (e.g. \`nsh check packages/nsh-http\`). An app needs App.tsx at its root.
- Rust dev-dependencies must be 0.4.0: nsh-engine = "0.4.0", nsh-testing = "0.4.0". The docs' nsh-engine = "0.1" samples are stale. The generated Cargo.toml has no log crate.
- Headless::start can return before the first frame — wait_for something before the first step. Headless::shows takes plain text; wait_for/press take selectors; wait_for_gone takes a timeout; screen().count returns a Result.
- Signal::update needs T: Clone; pair stored(..) with a version signal for user types (see ~/fo/nsh-query/crates/nsh-query/src/tracked.rs). A component's signals are disposed when its cleanup runs — capture what cleanup needs in an Rc<Cell<..>>; create_root gives an owner that outlives the component.
- open's host handlers need annotated parameters (async ({ id }: { id: number }) => ...). Selector regexes use Rust regex syntax: no look-ahead.
- Manual clock by default: open(entry, { clock: {} }) in TSX, Clock::manual in Rust. A test that took 13.7 s on the wall clock took 18 ms on a manual one.
- A TSX app consumes a sibling package through node_modules: mkdir -p node_modules && ln -s ../../packages/nsh-http node_modules/nsh-http (path relative to the app dir). The bundler and nsh check both read it; tsconfig.json needs no change; overriding compilerOptions.paths breaks the nsh types.
- nsh.json capabilities use "network": { "hosts": [...] }. Declare ["127.0.0.1", "localhost", "10.0.2.2"] for every app and package that talks to the local echo server, and verify on 0.4.0 how host+port matching works. Refusal rejects with code ERR_ACCESS_DENIED.
- Tests run under the app's declared capabilities, so every URL in tests must be on a declared host — use 127.0.0.1 everywhere (stub routes included).
- Sibling libraries ~/fo/nsh-query and ~/fo/nsh-form and ~/fo/.refs/* are READ-ONLY. If you find a bug in them, do not edit them; record it in your result under upstream.
- The echo server on Android emulator is reachable as 10.0.2.2 (same port as on the host); on iOS simulator and desktop as 127.0.0.1.
- This machine is SHARED: other agents build other repos right now. Never run xcrun simctl shutdown all / erase all, adb kill-server, killall, or anything that stops a process you did not start. Pick free ports, never kill a port holder. If a build is slow because the machine is busy, wait — do not lower a check.
- Comments are 1-2 lines and state a non-obvious constraint; never narrate the next line. Dead code is deleted; no speculative abstractions. Docs read like a competent human wrote them (the antislop-copy and code-comments skills apply).
- Tests: stubs on a manual clock by default; network: "live" only inside files whose header comment starts with "LIVE:" and states the reason. Every new test is seen to fail once, by breaking the code on purpose (load test-quality-guardrails).
`;

const ESCALATE =
  "Never weaken, skip or delete a check to get a pass. If a check is impossible to pass, or your " +
  "instructions contradict each other, escalate and say so plainly rather than working around it. " +
  "Report anything you could not verify honestly as unverified.\n";

const EVENT_SHAPE = `
The NetworkEvent shape is FROZEN — the nsh-firebase project consumes it exactly; do not change field names or types:
\`\`\`ts
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
\`\`\`
The Rust struct mirrors it with #[serde(rename_all = "camelCase")] so the wire shape is identical. ttfbMs is null wherever docs/decision.md says it cannot be measured honestly. Do not invent a number.
`;

const BEHAVIOR_ROWS = `
1 Client construction: createClient({ baseUrl, headers, timeoutMs, retry, middleware }) in TS; HttpClient::builder() in Rust.
2 Methods with typed decode: get/post/put/patch/delete with generic JSON decoding (serde in Rust), query encoding, path params.
3 Typed error taxonomy with six distinct cases: network, timeout, cancelled, refused-by-capability, http-status (carrying the decoded body), decode-failure. Refused-by-capability stays distinct from network failure (ERR_ACCESS_DENIED means something different).
4 Timeouts per client and per call, composed with the caller's cancellation (AbortSignal / cancel token).
5 Retries with backoff and jitter on a manual clock, honoring Retry-After (seconds and HTTP-date), only idempotent methods by default, POST never retried by default, never after a body stream started.
6 Middleware that reads and changes requests and responses in a defined order; the order is tested.
7 Auth seam: token provider with single-flight refresh on 401 — ten parallel requests with an expired token cause exactly one refresh and all ten succeed.
8 A mock adapter transport for tests, working alongside NSH's own stubs (not instead of them).
9 ETag and Cache-Control helpers that feed nsh-query: conditional requests with If-None-Match, 304 handling.
10 Observer emit points on the client: one NetworkEvent per request attempt, with honest timings (ttfbMs exactly as docs/decision.md allows).
11 Ring buffer with a set capacity; aggregates per host and per path (count, error rate, p50, p95).
12 Redaction of secrets in URLs and headers by default; a sampling option; a standalone instrumented fetch.
13 Multipart upload; streaming request bodies; streaming response bodies; download progress where the runtime gives it; upload progress with the honest limit documented.
14 SSE with reconnect and Last-Event-ID.
15 nsh-query integration: query cancellation flows to the request; the local server's log proves it (live).
16 A request the app's capabilities.network does not allow is refused through the client as refused-by-capability, including on a redirect hop (live).
`;

const TEST_FILES = `
Predetermined test file names (docs/behavior.md references them; both suites must cover every row):
- Rust, crates/nsh-http/tests/: core.rs, errors.rs, timeout.rs, retry.rs, middleware.rs, auth.rs, mock.rs, etag.rs, observe.rs, monitor.rs, streaming.rs, sse.rs, multipart.rs, live_capability.rs, live_streams.rs. Files starting with live_ carry #[ignore] tests that read the echo port from tools/echo-server/.runtime.json and fail loudly if it is missing; they run with \`cargo test -- --ignored\` while the echo server is up.
- TypeScript, packages/nsh-http/tests/unit/: client.test.ts, errors.test.ts, timeout.test.ts, retry.test.ts, middleware.test.ts, auth.test.ts, mock.test.ts, etag.test.ts, observe.test.ts, monitor.test.ts, streaming.test.ts, sse.test.ts, upload.test.ts. Live files live in packages/nsh-http/tests/live/: capability.test.ts, streaming.test.ts, sse.test.ts, each with a header comment starting "LIVE:".
- App test dirs keep unit tests under tests/unit/ and capture tests under tests/capture/ so the unit gate can target tests/unit explicitly.
`;

// ---------- typed results ----------

/** One actionable problem; auditors return ONLY these, never pass notes. */
interface Finding {
  /** Workspace-relative path, with a line when it applies. */
  path: string;
  /** One sentence: what is wrong, not how to fix it. */
  problem: string;
  /** How much it matters. Reserve "high" for a crash, data loss or a wrong result. */
  severity: "low" | "medium" | "high";
}

interface SpecialistResult {
  /** One sentence copied VERBATIM from your specialist contract (your system prompt) that most shaped this work. */
  contractLine?: string;
}

interface ImplementResult extends SpecialistResult {
  /** True when your own scoped gates all pass. The script re-runs the gates itself; never claim a gate you did not run. */
  done: boolean;
  /** Two or three sentences: what was built. */
  summary: string;
  /** Anything you could not verify, with the reason. */
  unverified: string[];
  /** Bugs found in read-only sibling repos or NSH itself. */
  upstream: string[];
}

interface AuditResult extends SpecialistResult {
  /** Actionable findings only; an empty array means the audit found nothing. */
  findings: Finding[];
}

interface DeviceReport {
  /** True only when every dispatched capture ran and its file exists on disk. */
  ok: boolean;
  /** One row per capture: target, absolute PNG path, one-line observation. */
  captures: { target: string; path: string; note: string }[];
  /** What could not run and why (device missing, build failed, wrong device claimed the slot). */
  issues: string[];
}

interface VisionVerdict {
  /** True only when every PNG was viewed and every dispatched criterion holds. */
  pass: boolean;
  /** One row per PNG you actually opened. */
  perPng: { path: string; verdict: "pass" | "fail"; note: string }[];
  /** Actionable findings only. */
  findings: Finding[];
}

interface EchoInfo {
  ok: boolean;
  port: number;
  note: string;
}

interface AreaOutcome {
  name: string;
  status: "done" | "failed";
  summary: string;
  rounds: { audit: number; tests: number };
  /** True when the audit loop hit its round cap with findings left. */
  auditConverged: boolean;
  /** True when the unit-test gate loop hit its round cap with failures left. */
  testsConverged: boolean;
  blockers: string[];
  unverified: string[];
  upstream: string[];
  evidence: string[];
  personaVerified: boolean;
}

interface Gate {
  cmd: string;
  args: string[];
  timeoutMs: number;
  /** True for nsh build gates: exit 0 is not enough, no warn line may appear. */
  noWarnings?: boolean;
}

interface GateFail {
  cmd: string;
  exitCode: number;
  output: string;
}

// ---------- board ----------

artifact.board("areas", {
  key: "name",
  status: "phase",
  columns: ["implementing", "auditing", "testing", "capturing", "done", "failed"],
});

function announce(name: string, phase: string, summary: string): void {
  report({ name, phase, summary }, "areas");
}

// ---------- gate helpers ----------

async function runGates(gates: Gate[]): Promise<GateFail[]> {
  const fails: GateFail[] = [];
  for (const g of gates) {
    const r = await world.run(g.cmd, g.args, { timeoutMs: g.timeoutMs });
    const warnHit = g.noWarnings === true && /(^|\n)\s*warn\b/i.test(r.stdout + "\n" + r.stderr);
    if (r.exitCode !== 0 || warnHit) {
      const text = (r.stdout + "\n" + r.stderr).trim();
      fails.push({
        cmd: `${g.cmd} ${g.args.join(" ")}`,
        exitCode: r.exitCode,
        output: text.length > 6000 ? text.slice(-6000) : text,
      });
    }
  }
  return fails;
}

async function gateLoop(
  areaKey: string,
  gates: Gate[],
  fix: (fails: GateFail[]) => Promise<void>,
): Promise<{ rounds: number; converged: boolean; fails: GateFail[] }> {
  let last: GateFail[] = [];
  for (let round = 1; round <= 3; round++) {
    announce(areaKey, "testing", `running its own gates (round ${round})`);
    last = await runGates(gates);
    if (last.length === 0) return { rounds: round, converged: true, fails: [] };
    log(`${areaKey}: ${last.length} gate failure(s); fixing`);
    announce(areaKey, "testing", `${last.length} gate failure(s); fixing`);
    await fix(last);
  }
  return { rounds: 3, converged: false, fails: last };
}

async function auditLoop(
  areaKey: string,
  auditOnce: (round: number) => Promise<AuditResult>,
  fix: (findings: Finding[]) => Promise<void>,
): Promise<{ rounds: number; converged: boolean; findings: Finding[] }> {
  let last: Finding[] = [];
  for (let round = 1; round <= 3; round++) {
    announce(areaKey, "auditing", `independent audit (round ${round})`);
    const res = await auditOnce(round);
    last = res.findings;
    if (last.length === 0) return { rounds: round, converged: true, findings: [] };
    log(`${areaKey}: audit round ${round} found ${last.length} issue(s)`);
    announce(areaKey, "auditing", `${last.length} audit finding(s); fixing`);
    await fix(last);
  }
  return { rounds: 3, converged: false, findings: last };
}

function lineOk(persona: string, res: SpecialistResult): boolean {
  const line = res.contractLine;
  return typeof line === "string" && line.trim().length > 12 && persona.includes(line.trim());
}

async function askVerified<T extends SpecialistResult>(
  a: AgentHandle,
  persona: string,
  askText: string,
): Promise<{ res: T; verified: boolean }> {
  const first = await a.ask<T>(askText);
  if (lineOk(persona, first)) return { res: first, verified: true };
  const second = await a.ask<T>(
    "Your previous result's contractLine was not a verbatim sentence from your specialist contract. " +
      "Return the same result again, with contractLine copied EXACTLY — verbatim, no paraphrase — " +
      "from the contract text you were given (your system prompt).",
  );
  if (lineOk(persona, second)) return { res: second, verified: true };
  return { res: first, verified: false };
}

// Bounded poll for the decision gate: docs/decision.md exists and states its Decision.
async function awaitDecision(areaKey: string): Promise<boolean> {
  for (let i = 0; i < 90; i++) {
    const exists = await world.run("test", ["-s", "docs/decision.md"], { timeoutMs: 15000 });
    if (exists.exitCode === 0) {
      const stated = await world.run("grep", ["-q", "## Decision", "docs/decision.md"], { timeoutMs: 15000 });
      if (stated.exitCode === 0) return true;
    }
    await world.run("sleep", ["30"], { timeoutMs: 60000 });
  }
  log(`${areaKey}: docs/decision.md never appeared after 45 minutes of waiting`);
  return false;
}

async function readEcho(): Promise<EchoInfo> {
  const cat = await world.run("cat", ["tools/echo-server/.runtime.json"], { timeoutMs: 15000 });
  if (cat.exitCode !== 0) return { ok: false, port: 0, note: "tools/echo-server/.runtime.json missing" };
  try {
    const data: unknown = JSON.parse(cat.stdout);
    if (typeof data === "object" && data !== null && "port" in data) {
      const port = (data as { port: unknown }).port;
      if (typeof port === "number" && port > 0) {
        const health = await world.run("curl", ["-sf", `http://127.0.0.1:${port}/health`], { timeoutMs: 20000 });
        if (health.exitCode === 0) return { ok: true, port, note: "echo server healthy" };
        return { ok: false, port, note: "echo server port recorded but /health failed" };
      }
    }
  } catch {
    return { ok: false, port: 0, note: "tools/echo-server/.runtime.json did not parse" };
  }
  return { ok: false, port: 0, note: "tools/echo-server/.runtime.json has no usable port" };
}

// ---------- gate sets (command names are compile-time literals) ----------

function rustGates(): Gate[] {
  return [
    { cmd: "cargo", args: ["fmt", "--all", "--", "--check"], timeoutMs: 180000 },
    { cmd: "cargo", args: ["clippy", "--all-targets", "--", "-D", "warnings"], timeoutMs: 900000 },
    { cmd: "cargo", args: ["test"], timeoutMs: 900000 },
  ];
}

function tsGates(dir: string, unitDir: string): Gate[] {
  return [
    { cmd: "nsh", args: ["check", dir], timeoutMs: 300000 },
    { cmd: "nsh", args: ["build", dir], timeoutMs: 300000, noWarnings: true },
    { cmd: "nsh", args: ["test", unitDir], timeoutMs: 600000 },
  ];
}

function smokeGates(echo: EchoInfo): Gate[] {
  const gates: Gate[] = [
    ...rustGates(),
    { cmd: "cargo", args: ["test", "--", "--ignored"], timeoutMs: 600000 },
    { cmd: "cargo", args: ["check", "--target", "wasm32-unknown-unknown", "-p", "nsh-http"], timeoutMs: 600000 },
    { cmd: "cargo", args: ["fmt", "--manifest-path", "examples/demo-rs/Cargo.toml", "--", "--check"], timeoutMs: 180000 },
    { cmd: "cargo", args: ["clippy", "--manifest-path", "examples/demo-rs/Cargo.toml", "--all-targets", "--", "-D", "warnings"], timeoutMs: 600000 },
    { cmd: "cargo", args: ["test", "--manifest-path", "examples/demo-rs/Cargo.toml"], timeoutMs: 600000 },
    ...tsGates("packages/nsh-http", "packages/nsh-http/tests/unit"),
    { cmd: "nsh", args: ["test", "packages/nsh-http/tests/live"], timeoutMs: 600000 },
    ...tsGates("examples/monitor-app", "examples/monitor-app/tests/unit"),
    ...tsGates("examples/demo-ts", "examples/demo-ts/tests/unit"),
    { cmd: "nsh", args: ["test", "examples/demo-ts/tests/live"], timeoutMs: 600000 },
    { cmd: "bun", args: ["--cwd", "tools/echo-server", "test"], timeoutMs: 300000 },
  ];
  if (echo.ok) {
    gates.push({ cmd: "curl", args: ["-sf", `http://127.0.0.1:${echo.port}/health`], timeoutMs: 20000 });
  }
  return gates;
}

// ---------- shared specialists ----------

const nshPersona = await specialist("z-nsh-engineer", "You are a careful Native Shell app engineer working on one area of a parallel build.");
const rustPersona = await specialist("z-rust-engineer", "You are a careful Rust library engineer working on one area of a parallel build.");
const asyncPersona = await specialist("z-rust-async-engineer", "You are a careful Rust async engineer working on one area of a parallel build.");
const qaPersona = await specialist("z-qa-evaluator", "You are a skeptical QA evaluator who judges only what the evidence in front of you shows.");
const devicePersona = await specialist("z-native-device-verifier", "You are a careful device verification operator who serializes all device work.");

const DEVICE_ENV = `
Operational facts for this machine:
- Repo: /Users/hmziq/fo/nsh-http. Evidence goes under docs/evidence/<area>/ (absolute paths).
- The echo server's port is in tools/echo-server/.runtime.json (JSON with "port"). Health: curl -sf http://127.0.0.1:<port>/health. If it is down, you may start it: (cd tools/echo-server && nohup bun run src/server.ts >/tmp/nsh-http-echo.log 2>&1 &) — it is this repo's own server. Never kill any other process.
- iOS: create our own simulator if missing — xcrun simctl create nsh-http "iPhone 17" (iOS 27.0 runtime is installed). Boot only ours: xcrun simctl boot <UDID of nsh-http>. Capture with xcrun simctl io <UDID> screenshot or, preferably, the app's own capture test via nsh test --target ios (app.screenshot writes the PNG).
- Android: ANDROID_HOME=/Users/hmziq/Library/Android/sdk, JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" (export both; put $ANDROID_HOME/platform-tools and -cmdline-tools/latest/bin on PATH). Create our own AVD if missing: avdmanager create avd -n nsh-http -k "system-images;android-37.0;google_apis_playstore_ps16k" (pick a device profile with -d if needed). Boot only ours: emulator -avd nsh-http -port 5560 -no-window -no-snapshot -no-audio & then adb wait for boot_completed. ALWAYS adb -s emulator-5560 on every adb call.
- nsh test --target android uses the first device adb lists. Export ANDROID_SERIAL=emulator-5560 for that call, and verify the capture actually shows our app (the app id is in the app's nsh.json) before counting it. If another repo's device grabbed the slot and you cannot scope it, record the target as unverified instead of forcing it.
- On Android the echo base URL is http://10.0.2.2:<port>; export ECHO_BASE accordingly for that run. Everywhere else http://127.0.0.1:<port>.
- Run captures with nsh test --target macos|ios|android|web <app-dir> — the app's tests/capture/ file drives the app and saves PNGs with app.screenshot(<absolute path>). Verify every file exists with ls -la afterwards. Do not view or judge the PNGs; the vision judge does that.
- macos opens a real window briefly — keep it short, that is expected and sanctioned. web runs in a headless Chrome.
- Never run xcrun simctl shutdown all / erase all, adb kill-server, killall. Never stop a process you did not start. Serial device work only: one lane at a time.
`;

const device = agent("device·operator", { system: devicePersona.persona + DEVICE_ENV, model: MODELS.flash });

// ---------- area 6a: the echo server (examples-and-docs' first deliverable, started early) ----------

const ECHO_SPEC = `
You are building tools/echo-server for the nsh-http repository — the local sandbox every other area
integrates against. Bun + TypeScript (bun 1.4.4 is installed). Files you own: tools/echo-server/** (delete its .gitkeep).

Write src/server.ts (+ small modules as you like) and tests/server.test.ts, then START it detached and record its state.

Routes (all on 127.0.0.1, a free port — bind port 0 and read back the real port):
- GET /health -> 200 {"ok":true}
- GET /slow?delay=1200 -> waits delay ms, then small JSON {"route":"slow","delay":<ms>}
- GET /fast -> immediate small JSON {"route":"fast"}
- GET /status/:code -> responds with that status code
- GET /flaky?fail=2 -> the first N hits return 503 with a Retry-After: 1 header, then 200
- GET /etag -> ETag header; 304 with empty body when If-None-Match matches
- GET /stream?chunks=8&delay=50 -> chunked transfer, one chunk per delay ms
- GET /sse?count=20 -> text/event-stream, events with ids 1..count; honors a Last-Event-ID request header by replaying from that id (for SSE reconnect tests)
- POST /multipart -> parses multipart/form-data and echoes the parts as JSON
- POST /token -> checks the Authorization: Bearer header. Token "expired" -> 401 with {"error":"expired"}; token "refreshed" -> 200 {"ok":true}. Used by the single-flight refresh tests.
- POST /echo -> JSON echo of method, path, and the request body
- GET /redirect/refused -> 302 with Location http://refused.invalid/next (a host the test apps do NOT declare — proves capability refusal on a redirect hop)
- GET /redirect/local -> 302 to /fast
- GET /bytes/:n -> n bytes with Content-Length (download progress)
Aborts: for /slow and /stream, watch the request's abort signal; when the client disconnects early, append {"event":"aborted","path":...} to the log.
Log: append one JSON line per request start, end and abort to tools/echo-server/.runtime.log — the nsh-query cancellation proof (satisfaction criterion 9) reads this log, so aborted requests must be distinguishable from completed ones.
Write tools/echo-server/.runtime.json ({"port": <port>, "pid": <pid>}) after starting, and a short README.md in the dir: how to start it, route list, and that the port file is the contract.
.gitignore is owned by another area — do not edit it.

Tests: tests/server.test.ts (bun test) covers every route on a spawned port-0 instance — stub-level, no external network.
Then start the real server detached (nohup bun run src/server.ts >/tmp/nsh-http-echo.log 2>&1 &), verify curl -sf http://127.0.0.1:<port>/health, and write .runtime.json.
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, and contractLine copied verbatim from your specialist contract.
`;

async function bootstrapEcho(): Promise<EchoInfo> {
  try {
    const persona = await specialist("z-nsh-engineer", "You are a careful server engineer working on one area of a parallel build.");
    const server = agent("examples·server", { system: persona.persona, model: MODELS.flash });
    const res = await askVerified<ImplementResult>(server, persona.persona, ECHO_SPEC);
    const info = await readEcho();
    if (!info.ok) return { ok: false, port: 0, note: `echo server did not come up: ${info.note}` };
    log(`echo server up on 127.0.0.1:${info.port}`);
    return info;
  } catch (err) {
    return { ok: false, port: 0, note: `echo server bootstrap failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------- area 1: decision ----------

const DECISION_ASK = `
You own the decision work for nsh-http: real experiments on installed nsh 0.4.0 and docs/decision.md.
Files you own: docs/decision.md, docs/evidence/decision/**, scratch/** (throwaway experiment apps; delete tools/… nothing else), and one edit: APPEND these lines to the existing .gitignore (no other area touches it): "scratch/", "tools/echo-server/.runtime.json", "tools/echo-server/.runtime.log", "/tmp logs none".

docs/PROMPT.md is the brief; read it fully first (§Decide first, §The library, §Network monitoring, §Facts that bite). AGENTS.md binds you.

Run these experiments in throwaway apps under scratch/decision/ (nsh init --template ts / --template rust; give each its own free port; a tiny bun server in scratch is fine when you need a slow route). Record the actual run output under docs/evidence/decision/ and cite it:
1. TSX fetch: confirm global fetch with streaming bodies, FormData, AbortController, AbortSignal.timeout, AbortSignal.any, WebSocket on 0.4.0 (see https://nsh.dev/docs/networking.md but verify against .nsh/types — the site may be ahead).
2. Rust fetch: nsh_core::prelude::fetch(impl Into<HttpRequest>) and HttpRequest (method, url, headers, body, follow_redirects) — verify against ~/fo/.refs/nsh-v0.4.0/crates/nsh-core/src/element/ambient.rs. Establish how far streaming goes on the Rust side (the docs say the whole body arrives with the response — confirm what that means for progress and SSE).
3. reqwest/ureq bypass: in a scratch Rust app, call reqwest and ureq directly and show whether they bypass capabilities, StubNetwork and the web target (e.g. a call that fetch's stub would refuse or stub succeeds through the real stack; try cargo check --target wasm32-unknown-unknown with reqwest too). State when such a crate is still right (a tool, a big desktop-only download).
4. npm clients in QuickJS: in a scratch TSX app, pull ky, ofetch and axios through node_modules and record bundle size after nsh build, resolve.conditions needs, and failures.
5. TTFB experiment: what can ttfbMs honestly be? From TSX, measure time-to-response-headers on a delayed route (the response promise resolves when headers arrive). From Rust, check whether anything before the full body is observable. Record the numbers; the monitor will set ttfbMs to null wherever this experiment says it cannot be measured honestly.

Then write docs/decision.md with EXACTLY these sections: "## Question", "## Experiments" (one subsection per experiment, each with a "Result:" line citing the run evidence and numbers), "## Decision" (the choice, stated in one sentence — expected shape: a thin wrapper over NSH's own fetch for both languages, with the reasons), "## When a direct crate is still right", "## npm clients", "## What ttfbMs can honestly be", "## Consequences for the library". The "## Decision" heading is load-bearing: other areas poll for it before writing transport code.
Do NOT write any library code — the library areas start once your Decision section exists.
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim from your specialist contract.
`;

const DECISION_GATE: Gate[] = [
  { cmd: "test", args: ["-s", "docs/decision.md"], timeoutMs: 15000 },
  { cmd: "grep", args: ["-q", "## Decision", "docs/decision.md"], timeoutMs: 15000 },
  { cmd: "grep", args: ["-c", "Result:", "docs/decision.md"], timeoutMs: 15000 },
  { cmd: "test", args: ["-d", "docs/evidence/decision"], timeoutMs: 15000 },
];

async function decisionArea(): Promise<AreaOutcome> {
  const key = "decision";
  announce(key, "implementing", "running the decide-first experiments");
  try {
    const experimenter = agent("decision·experimenter", { system: nshPersona.persona, model: MODELS.flash });
    const impl = await askVerified<ImplementResult>(experimenter, nshPersona.persona, DECISION_ASK);

    announce(key, "testing", "mechanical checks on docs/decision.md");
    let gateRounds = 0;
    let gatesOk = false;
    for (let round = 1; round <= 3; round++) {
      gateRounds = round;
      const fails: GateFail[] = [];
      for (const g of DECISION_GATE) {
        const r = await world.run(g.cmd, g.args, { timeoutMs: g.timeoutMs });
        // grep -c prints the count; require at least 5 experiment results.
        if (g.args[0] === "-c" && r.exitCode === 0) {
          const count = Number(r.stdout.trim());
          if (!(count >= 5)) fails.push({ cmd: "grep -c Result: docs/decision.md", exitCode: count, output: `only ${count} Result: lines` });
          continue;
        }
        if (r.exitCode !== 0) fails.push({ cmd: `${g.cmd} ${g.args.join(" ")}`, exitCode: r.exitCode, output: (r.stderr || r.stdout).slice(0, 1000) });
      }
      if (fails.length === 0) { gatesOk = true; break; }
      await experimenter.ask<ImplementResult>(`docs/decision.md is missing required structure. Fix it (content only — the headings "## Decision" and at least five "Result:" lines, evidence under docs/evidence/decision/):\n${JSON.stringify(fails)}`);
    }

    const audit = await auditLoop(
      key,
      async (round) => {
        const auditor = agent(`decision·auditor·r${round}`, { system: nshPersona.persona, model: MODELS.flash });
        return auditor.ask<AuditResult>(
          `Audit docs/decision.md against its evidence (read-only: do not edit anything). docs/PROMPT.md §"Decide first" is the standard. Check: every option (TSX fetch, Rust nsh_core::fetch, reqwest/ureq, npm clients ky/ofetch/axios) carries a run result with real numbers, the evidence files under docs/evidence/decision/ actually back the claims, the TTFB conclusion says honestly what is measurable from TSX and Rust, and the Decision states the choice and why. Return findings ONLY (actionable problems with path+problem+severity); an empty findings array means it passed. contractLine: one sentence verbatim from your specialist contract.`,
        );
      },
      async (findings) => {
        await experimenter.ask<ImplementResult>(`The audit of docs/decision.md found these problems. Fix them in the decision doc and its evidence (do not touch any other area's files):\n${JSON.stringify(findings)}`);
      },
    );

    announce(key, "done", gatesOk && audit.converged ? "decision.md written and audited clean" : "decision.md written; issues remain (reported honestly)");
    return {
      name: key,
      status: "done",
      summary: impl.res.summary,
      rounds: { audit: audit.rounds, tests: gateRounds },
      auditConverged: audit.converged,
      testsConverged: gatesOk,
      blockers: gatesOk ? [] : ["decision.md mechanical checks did not fully pass"],
      unverified: impl.res.unverified,
      upstream: impl.res.upstream,
      evidence: ["docs/decision.md", "docs/evidence/decision/"],
      personaVerified: impl.verified,
    };
  } catch (err) {
    announce(key, "failed", `failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      name: key, status: "failed", summary: `decision area failed: ${err instanceof Error ? err.message : String(err)}`,
      rounds: { audit: 0, tests: 0 }, auditConverged: false, testsConverged: false,
      blockers: [err instanceof Error ? err.message : String(err)], unverified: ["the whole decision area"], upstream: [], evidence: [], personaVerified: false,
    };
  }
}

// ---------- area 2: rust client ----------

const RUST_SCAFFOLD = `
PART 1 — scaffold the Rust workspace for nsh-http (structure only; core implementation comes in your next instruction).
Files you own for the whole area: the root Cargo.toml, crates/nsh-http/** EXCEPT src/monitor.rs, src/streaming.rs, src/sse.rs and src/multipart.rs whose CONTENTS later areas own (you create their skeletons now), crates/nsh-http/tests/** (same rule for monitor.rs, streaming.rs, sse.rs, multipart.rs test files), docs/behavior.md, and you delete crates/nsh-http/src/.gitkeep, crates/nsh-http/tests/.gitkeep and crates/nsh-http/.gitkeep when real files exist.

Read ~/fo/nsh-query/Cargo.toml and crates/nsh-query/Cargo.toml first and mirror their shape (workspace root manifest, workspace.package inheritance, edition 2024, resolver "3"). This repo has no remote — omit repository/authors URLs rather than inventing one.

Create:
- Root Cargo.toml: workspace with members = ["crates/nsh-http"].
- crates/nsh-http/Cargo.toml: name nsh-http; dependencies nsh-core = "0.4.0" and serde = { version = "1", features = ["derive"] }; dev-dependencies nsh-engine = "0.4.0", nsh-testing = "0.4.0".
- src/lib.rs: crate docs (1-2 lines), modules: client, error, retry, middleware, auth, mock, etag, observe (or fold observe into client — your call, but the observer emit points are yours), plus pub mod monitor; pub mod streaming; pub mod sse; pub mod multipart; and a prelude re-export. The four stub modules are declared NOW so later areas never touch lib.rs.
- src/monitor.rs skeleton (the monitor area replaces its contents later): the frozen NetworkEvent struct (${EVENT_SHAPE.trim()}) with derive(Serialize, Clone) and #[serde(rename_all = "camelCase")], a pub Observer alias (Arc<dyn Fn(&NetworkEvent) + Send + Sync>), and a minimal placeholder pub struct Monitor that compiles warning-free with a doc comment saying the monitor area owns the real implementation.
- src/streaming.rs, src/sse.rs, src/multipart.rs skeletons: minimal compiling placeholder pub items with doc comments saying the streaming-and-uploads area owns them.
- docs/behavior.md: the canonical behavior list both suites cover. Use exactly these ${BEHAVIOR_ROWS.trim()} — a table: | # | Behavior | Rust test | TypeScript test | Owner |. Fill the Rust test column with the predetermined names and the TypeScript column with the same predetermined names mapped to files (${TEST_FILES.trim()}). Owners: rows 11-12 monitor, 13-14 streaming, 15 examples-and-docs, everything else rust+ts core.
Then make \`cargo fmt --all -- --check\`, \`cargo clippy --all-targets -- -D warnings\` and \`cargo test\` pass at the repo root (empty suites are fine; no warnings anywhere — every pub export documented).
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim.
`;

const RUST_CORE_ASK = (decisionReady: boolean) => `
PART 2 — implement the core Rust client in crates/nsh-http.
${decisionReady ? "docs/decision.md exists: read it first and follow its Decision (transport choice, ttfbMs honesty)." : "WARNING: docs/decision.md never appeared — proceed only on structure and record that as unverified; do NOT guess a transport choice."}
You implement everything in behavior rows 1-10 and 16 (see docs/behavior.md which you wrote): HttpClient::builder() with base_url/headers/timeout_ms/retry/middleware/observe/token_provider; typed get/post/put/patch/delete with serde decode, query encoding and path params; the six-case error taxonomy (refused-by-capability distinct); per-client and per-call timeouts composed with caller cancellation; retries (backoff+jitter on a manual clock, Retry-After in seconds and HTTP-date, idempotent-only default, POST never, never after a body stream started); ordered middleware; token provider with single-flight refresh on 401 (ten parallel -> one refresh, all replay); a mock adapter transport alongside NSH's own stubs; ETag/Cache-Control helpers feeding nsh-query (read ~/fo/nsh-query's crate for the integration shape); observer emit points constructing the frozen NetworkEvent per attempt with honest timings (ttfbMs per docs/decision.md).
Tests in the predetermined files (core.rs, errors.rs, timeout.rs, retry.rs, middleware.rs, auth.rs, mock.rs, etag.rs, observe.rs, live_capability.rs) — headless UI tests with nsh_testing::Headless on a manual clock and StubNetwork routes, mirroring how ~/fo/nsh-query tests its crate. Stubbed-test URLs must be on 127.0.0.1 so the declared capabilities stay coherent. live_capability.rs holds #[ignore] "LIVE:" tests for capability refusal incl. the redirect hop (echo route /redirect/refused) that read the port from tools/echo-server/.runtime.json — write them now even though the echo server may not be up yet; the smoke runs them later.
Find how to enforce capabilities under cargo test from the nsh-engine/nsh-testing 0.4.0 source; if capabilities cannot be set in a pure crate test, put those tests in a tiny test app under crates/nsh-http/tests/capability-app/ (nsh.json + App.tsx + test) run via nsh test, and say so in your result.
Every new test must be seen to fail once: break the code on purpose, confirm the failure names the right thing, then restore.
Do not implement monitor/streaming/sse/multipart contents — their files are other areas'. Keep their stub files compiling and warning-free.
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim.
`;

async function rustClientArea(): Promise<AreaOutcome> {
  const key = "rust client";
  announce(key, "implementing", "scaffolding the Rust workspace");
  try {
    const impl = agent("rust·implementer", { system: rustPersona.persona, model: MODELS.flash });
    const scaffold = await askVerified<ImplementResult>(impl, rustPersona.persona, RUST_SCAFFOLD);
    const decisionReady = await awaitDecision(key);
    announce(key, "implementing", decisionReady ? "implementing the core client per docs/decision.md" : "decision.md missing after 45 min — structure only");
    const core = await impl.ask<ImplementResult>(RUST_CORE_ASK(decisionReady));

    const audit = await auditLoop(
      key,
      async (round) => {
        const auditor = agent(`rust·auditor·r${round}`, { system: rustPersona.persona, model: MODELS.flash });
        return auditor.ask<AuditResult>(
          `Audit the Rust client (read-only: do not edit anything). Scope: root Cargo.toml, crates/nsh-http/src (client, error, retry, middleware, auth, mock, etag, observer emit points, and the four stub files ONLY for compile hygiene), crates/nsh-http/tests, docs/behavior.md. Standard: docs/PROMPT.md §The library, §Hard rules, and the rust-best-practices/rust-testing skills you can load. Look for: invented APIs (every NSH name must exist in the 0.4.0 source), weakened or fake tests, retry/timeout/cancel logic errors, capability refusal not distinct, dead code, narration comments. Return findings ONLY (path+problem+severity); empty array means clean. contractLine verbatim from your contract.`,
        );
      },
      async (findings) => {
        await impl.ask<ImplementResult>(`The audit found these problems in your Rust client. Fix them (only files you own):\n${JSON.stringify(findings)}`);
      },
    );

    const gates = await gateLoop(key, rustGates(), async (fails) => {
      await impl.ask<ImplementResult>(`These repo-root gates failed. Fix the cause in files you own — never weaken a check. If a failure is caused by a file another area is editing concurrently (monitor.rs, streaming.rs, sse.rs, multipart.rs), rerun the gate once and only then treat it as real:\n${JSON.stringify(fails)}`);
    });

    const wasm = await world.run("cargo", ["check", "--target", "wasm32-unknown-unknown", "-p", "nsh-http"], { timeoutMs: 600000 });
    const unverified = core.unverified.slice();
    if (wasm.exitCode !== 0) unverified.push(`wasm32-unknown-unknown check failed: ${(wasm.stderr || wasm.stdout).slice(0, 500)}`);

    announce(key, audit.converged && gates.converged ? "done" : "failed", audit.converged && gates.converged ? "Rust core client done, gates green" : "finished with unresolved issues");
    return {
      name: key, status: audit.converged && gates.converged ? "done" : "failed",
      summary: `${core.summary} Scaffold: ${scaffold.res.summary}`,
      rounds: { audit: audit.rounds, tests: gates.rounds },
      auditConverged: audit.converged, testsConverged: gates.converged,
      blockers: gates.fails.map((f) => `gate failed: ${f.cmd}`).concat(audit.findings.map((f) => `audit finding left: ${f.path}: ${f.problem}`)),
      unverified, upstream: core.upstream,
      evidence: ["crates/nsh-http/", "docs/behavior.md"],
      personaVerified: scaffold.verified,
    };
  } catch (err) {
    announce(key, "failed", `failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      name: key, status: "failed", summary: `rust client area failed: ${err instanceof Error ? err.message : String(err)}`,
      rounds: { audit: 0, tests: 0 }, auditConverged: false, testsConverged: false,
      blockers: [err instanceof Error ? err.message : String(err)], unverified: [], upstream: [], evidence: [], personaVerified: false,
    };
  }
}

// ---------- area 3: ts client ----------

const TS_SCAFFOLD = `
PART 1 — scaffold the TypeScript package packages/nsh-http (structure only; core comes next).
Files you own for the whole area: packages/nsh-http/** EXCEPT src/monitor.ts, src/streaming.ts, src/sse.ts and src/upload.ts whose CONTENTS later areas own (you create their skeletons now), packages/nsh-http/tests/** (same rule), and you delete packages/nsh-http/src/.gitkeep, packages/nsh-http/tests/.gitkeep and packages/nsh-http/.gitkeep when real files exist.

Read ~/fo/nsh-query/packages/nsh-query first (package.json, nsh.json, tsconfig.json, App.tsx, src layout, test style) and mirror it exactly: package.json (name nsh-http, version 0.1.0, type module, main/types ./src/index.ts, exports), nsh.json (id dev.nshhttp.nsh-http; capabilities.network hosts ["127.0.0.1", "localhost", "10.0.2.2"] — verify the exact host-matching shape on 0.4.0 from the docs/source before finalizing), tsconfig.json extending .nsh/tsconfig.json, App.tsx at the package root (tiny demo app mounting a screen that uses the client — it is what nsh check/build/test drive).

Create src/index.ts exporting every module from day one: client, errors, retry, middleware, auth, mock, etag, plus monitor, streaming, sse, upload (stubs). src/monitor.ts skeleton (the monitor area replaces its contents later): the frozen NetworkEvent interface VERBATIM (${EVENT_SHAPE.trim()}) exported, plus a placeholder in-memory monitor object that compiles warning-free. src/streaming.ts, src/sse.ts, src/upload.ts skeletons: minimal exported placeholders with doc comments saying the streaming-and-uploads area owns them. Every export documented (nsh build treats an undocumented export as a warning).
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim.
`;

const TS_CORE_ASK = (decisionReady: boolean) => `
PART 2 — implement the core TypeScript client in packages/nsh-http, mirroring the Rust crate's behavior row for row.
${decisionReady ? "Read docs/decision.md first and follow its Decision (transport choice, ttfbMs honesty)." : "WARNING: docs/decision.md never appeared — structure only; record that as unverified; do NOT guess a transport choice."}
You implement behavior rows 1-10 and 16 (docs/behavior.md): createClient({ baseUrl, headers, timeoutMs, retry, middleware, tokenProvider, observe }) over the global fetch; typed get/post/put/patch/delete with generic decode, query encoding, path params; the six-case error taxonomy (refused-by-capability distinct, ERR_ACCESS_DENIED mapped); per-client and per-call timeouts composed with AbortSignal (AbortSignal.timeout / AbortSignal.any where useful); retries with backoff+jitter on a manual clock honoring Retry-After, idempotent-only by default, never after a body stream started; ordered middleware; token provider with single-flight refresh on 401 (ten parallel -> one refresh); a mock adapter transport working alongside NSH's own stubs; ETag/Cache-Control helpers feeding nsh-query (read ~/fo/nsh-query/packages/nsh-query for the integration shape); observer emit points building the frozen NetworkEvent per attempt with honest timings (ttfbMs exactly as docs/decision.md allows).
Tests in packages/nsh-http/tests/unit/ (the predetermined files) using open(..., { clock: {}, network: {...stub routes...} }) — every stub URL on 127.0.0.1. Also write tests/live/capability.test.ts ("LIVE:" header) proving refusal incl. the redirect hop against the echo server's /redirect/refused once it runs — use the port from tools/echo-server/.runtime.json when it exists, default 8123 with a clear failure message if absent.
Every new test seen to fail once by breaking the code on purpose. Do not implement monitor/streaming/sse/upload contents — their files are other areas'. Keep their stubs compiling and warning-free (nsh build treats every warning as a finding).
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim.
`;

async function tsClientArea(): Promise<AreaOutcome> {
  const key = "ts client";
  announce(key, "implementing", "scaffolding the TypeScript package");
  try {
    const impl = agent("ts·implementer", { system: nshPersona.persona, model: MODELS.flash });
    const scaffold = await askVerified<ImplementResult>(impl, nshPersona.persona, TS_SCAFFOLD);
    const decisionReady = await awaitDecision(key);
    announce(key, "implementing", decisionReady ? "implementing the core client per docs/decision.md" : "decision.md missing after 45 min — structure only");
    const core = await impl.ask<ImplementResult>(TS_CORE_ASK(decisionReady));

    const audit = await auditLoop(
      key,
      async (round) => {
        const auditor = agent(`ts·auditor·r${round}`, { system: nshPersona.persona, model: MODELS.flash });
        return auditor.ask<AuditResult>(
          `Audit the TypeScript client (read-only: do not edit anything). Scope: packages/nsh-http/** (src/client, errors, retry, middleware, auth, mock, etag, observer emit points; the four stub files only for compile hygiene), tests/unit, App.tsx, manifests. Standard: docs/PROMPT.md §The library + §Hard rules, parity with the Rust crate's behavior rows in docs/behavior.md, and the nsh skill. Look for: invented APIs, weakened or fake tests, retry/timeout/cancel logic errors, redaction or timing dishonesty, undocumented exports, dead code. Return findings ONLY (path+problem+severity); empty means clean. contractLine verbatim from your contract.`,
        );
      },
      async (findings) => {
        await impl.ask<ImplementResult>(`The audit found these problems in your TypeScript client. Fix them (only files you own):\n${JSON.stringify(findings)}`);
      },
    );

    const gates = await gateLoop(key, tsGates("packages/nsh-http", "packages/nsh-http/tests/unit"), async (fails) => {
      await impl.ask<ImplementResult>(`These package gates failed. Fix the cause in files you own — never weaken a check; every nsh build warning is a finding. If a failure comes from a file another area is editing concurrently (monitor.ts, streaming.ts, sse.ts, upload.ts), rerun once before treating it as real:\n${JSON.stringify(fails)}`);
    });

    announce(key, audit.converged && gates.converged ? "done" : "failed", audit.converged && gates.converged ? "TS core client done, gates green" : "finished with unresolved issues");
    return {
      name: key, status: audit.converged && gates.converged ? "done" : "failed",
      summary: `${core.summary} Scaffold: ${scaffold.res.summary}`,
      rounds: { audit: audit.rounds, tests: gates.rounds },
      auditConverged: audit.converged, testsConverged: gates.converged,
      blockers: gates.fails.map((f) => `gate failed: ${f.cmd}`).concat(audit.findings.map((f) => `audit finding left: ${f.path}: ${f.problem}`)),
      unverified: core.unverified, upstream: core.upstream,
      evidence: ["packages/nsh-http/"],
      personaVerified: scaffold.verified,
    };
  } catch (err) {
    announce(key, "failed", `failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      name: key, status: "failed", summary: `ts client area failed: ${err instanceof Error ? err.message : String(err)}`,
      rounds: { audit: 0, tests: 0 }, auditConverged: false, testsConverged: false,
      blockers: [err instanceof Error ? err.message : String(err)], unverified: [], upstream: [], evidence: [], personaVerified: false,
    };
  }
}

// ---------- area 4: monitor ----------

const MONITOR_RUST_ASK = `
Implement the monitor's Rust half in crates/nsh-http (you own src/monitor.rs and tests/monitor.rs from here on; do not edit any other file, including lib.rs and the client's modules).
Read docs/decision.md first (transport + ttfbMs honesty) and the current src/monitor.rs skeleton the core area left.
Implement, per docs/PROMPT.md §Network monitoring and behavior rows 11-12 of docs/behavior.md: Monitor with a ring buffer of set capacity; per-host and per-path aggregates (count, error rate, p50, p95); redaction of secrets in URLs and headers BY DEFAULT (tokens/keys in query strings stripped or masked; Authorization/Cookie/Set-Cookie/api-key style headers masked) with an opt-out; a sampling option; a standalone instrumented fetch wrapping nsh_core::prelude::fetch that records NetworkEvent per attempt (frozen shape, serde camelCase); registration with the client's observer seam (the core client emits events — wire Monitor::install or an observer adapter so a Monitor fed by a client keeps aggregates; if the seam needs a tiny addition inside YOUR files only, keep it there and document it).
ttfbMs: set null exactly where docs/decision.md says it is not honestly measurable from Rust.
Tests in tests/monitor.rs: capacity eviction, aggregates math (p50/p95 on a fixed manual clock), redaction (a token in a URL and in a header never appears in a recorded event — this is satisfaction criterion 8; make the test prove both), sampling. Manual clock, no real network. Every new test seen to fail once by breaking the code on purpose.
Keep the whole workspace compiling: another area edits src/streaming.rs, src/sse.rs, src/multipart.rs concurrently — if a gate failure is in those files, rerun once before treating it as real.
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim.
`;

const MONITOR_TS_ASK = (echo: EchoInfo) => `
Implement the monitor's TypeScript half and the ready screen (you own packages/nsh-http/src/monitor.ts, packages/nsh-http/tests/unit/monitor.test.ts, and examples/monitor-app/** from here on; do not edit any other file).
Read docs/decision.md first (transport + ttfbMs honesty) and the current src/monitor.ts skeleton.
Package side, behavior rows 11-12: a monitor with a ring buffer of set capacity; per-host and per-path aggregates (count, error rate, p50, p95); redaction of secrets in URLs and headers by default with opt-out; a sampling option; a standalone instrumentedFetch wrapping the global fetch recording NetworkEvent per attempt (frozen shape verbatim); wiring into the client's observe seam. Unit tests in tests/unit/monitor.test.ts: capacity, aggregates on a manual clock, redaction (a token in URL and header never appears in a recorded event), sampling. Every new test seen to fail once.
Screen side: examples/monitor-app — a TSX NSH app (App.tsx at its root, nsh.json id dev.nshhttp.monitor, capabilities.network hosts ["127.0.0.1", "localhost", "10.0.2.2"], node_modules symlink to ../../packages/nsh-http). It is the "ready screen": on start it fires a slow request (echo /slow?delay=1200) and a fast one (/fast) through the instrumented client, then shows the recorded calls in a List sorted by durationMs descending (slow on top), filterable by host/path text, with per-host aggregates visible. Follow the nsh-design-guides and nsh-component-library skills (tokens, styled controls, List rules) — read them via the Skill tool.
The echo server runs at http://127.0.0.1:${echo.port} (from tools/echo-server/.runtime.json; its health endpoint is /health). Make the base URL overridable by env var ECHO_BASE (the Android emulator needs http://10.0.2.2:<port>) — read it via the process standard module with the 127.0.0.1 default.
Unit tests under examples/monitor-app/tests/unit/ (stubs + manual clock). Capture tests under examples/monitor-app/tests/capture/ (excluded from the unit gate): a test that opens the app with network: "live", waits for both routes to land, and saves app.screenshot("/Users/hmziq/fo/nsh-http/docs/evidence/monitor/<target>-ready.png") — one file per target run; the device operator runs it per target and sets ECHO_BASE.
Every new test seen to fail once by breaking the code on purpose.
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim.
`;

const MONITOR_CAPTURE_ASK = (echo: EchoInfo) => `
Capture the monitor ready screen on all four targets for satisfaction criterion 7. The app is examples/monitor-app (id dev.nshhttp.monitor); its capture test saves PNGs under /Users/hmziq/fo/nsh-http/docs/evidence/monitor/. The echo server is up on 127.0.0.1:${echo.port} (verify /health first; restart per your briefing if down). ECHO_BASE: 127.0.0.1:${echo.port} for macos/ios/web, 10.0.2.2:${echo.port} for android.
Run, serially: nsh test --target macos examples/monitor-app; --target ios (our nsh-http simulator booted); --target android (our nsh-http AVD on emulator-5560, ANDROID_SERIAL exported, verify the capture shows OUR app); --target web (headless Chrome).
Before each capture, confirm the app's screen will show both routes landed (the capture test waits for that itself). Verify every PNG it wrote exists on disk (ls -la). Record target, path, one-line observation per capture. If a target cannot run, record it under issues with the exact reason — never fake a capture.
`;

async function monitorArea(rust: Promise<AreaOutcome>, ts: Promise<AreaOutcome>, echoP: Promise<EchoInfo>): Promise<AreaOutcome> {
  const key = "monitor";
  announce(key, "implementing", "waiting for the two client cores, then implementing the monitor");
  try {
    const settled = await Promise.allSettled([rust, ts]);
    const rustOk = settled[0].status === "fulfilled" && settled[0].value.status === "done";
    const tsOk = settled[1].status === "fulfilled" && settled[1].value.status === "done";
    const echo = await echoP;
    const degraded: string[] = [];
    if (!rustOk) degraded.push("Rust client core did not finish cleanly; Rust-side monitor work proceeds on the skeleton only if it compiles");
    if (!tsOk) degraded.push("TS client core did not finish cleanly; TS-side monitor work proceeds on the skeleton only if it compiles");
    if (!echo.ok) degraded.push(`echo server unavailable (${echo.note}); live capture criteria will be reported unverified`);

    const rustImpl = agent("monitor·rust", { system: rustPersona.persona, model: MODELS.flash });
    const screenImpl = agent("monitor·screen", { system: nshPersona.persona, model: MODELS.flash });

    const rustWork = rustOk
      ? askVerified<ImplementResult>(rustImpl, rustPersona.persona, MONITOR_RUST_ASK)
      : Promise.resolve({ res: { done: false, summary: "skipped: Rust core did not finish", unverified: ["Rust-side monitor"], upstream: [] } as ImplementResult, verified: false });
    const tsWork = tsOk
      ? askVerified<ImplementResult>(screenImpl, nshPersona.persona, MONITOR_TS_ASK(echo))
      : Promise.resolve({ res: { done: false, summary: "skipped: TS core did not finish", unverified: ["TS-side monitor and screen"], upstream: [] } as ImplementResult, verified: false });

    const [rustRes, tsRes] = await Promise.all([rustWork, tsWork]);

    // One auditor per domain per round; findings merged.
    const audit = await auditLoop(
      key,
      async (round) => {
        const [rustAudit, tsAudit] = await Promise.all([
          agent(`monitor·rust-auditor·r${round}`, { system: rustPersona.persona, model: MODELS.flash }).ask<AuditResult>(
            `Audit the monitor's Rust half (read-only): crates/nsh-http/src/monitor.rs and tests/monitor.rs. Standard: docs/PROMPT.md §Network monitoring (frozen NetworkEvent shape, honest ttfbMs per docs/decision.md, ring buffer, p50/p95 aggregates, redaction by default, sampling) and the rust skills you can load. Criterion 8 (redaction test proves a token in URL and header never appears) must actually hold. Return findings ONLY; empty means clean. contractLine verbatim.`,
          ),
          agent(`monitor·ts-auditor·r${round}`, { system: nshPersona.persona, model: MODELS.flash }).ask<AuditResult>(
            `Audit the monitor's TS half and the ready screen (read-only): packages/nsh-http/src/monitor.ts, tests/unit/monitor.test.ts, examples/monitor-app/**. Standard: docs/PROMPT.md §Network monitoring + §Areas, the frozen NetworkEvent shape, nsh-design-guides and nsh-component-library (load them via the Skill tool) for the screen. Criterion 8's TS redaction test must actually hold. Return findings ONLY; empty means clean. contractLine verbatim.`,
          ),
        ]);
        return { findings: [...rustAudit.findings, ...tsAudit.findings] };
      },
      async (findings) => {
        const rustFindings = findings.filter((f) => f.path.startsWith("crates/"));
        const tsFindings = findings.filter((f) => !f.path.startsWith("crates/"));
        const jobs: Promise<unknown>[] = [];
        if (rustFindings.length > 0 && rustOk) jobs.push(rustImpl.ask<ImplementResult>(`Monitor audit findings in your Rust files — fix them:\n${JSON.stringify(rustFindings)}`));
        if (tsFindings.length > 0 && tsOk) jobs.push(screenImpl.ask<ImplementResult>(`Monitor audit findings in your TS/screen files — fix them:\n${JSON.stringify(tsFindings)}`));
        await Promise.all(jobs);
      },
    );

    const monitorGateSet: Gate[] = [];
    if (rustOk) monitorGateSet.push(...rustGates());
    if (tsOk) {
      monitorGateSet.push(...tsGates("packages/nsh-http", "packages/nsh-http/tests/unit"));
      monitorGateSet.push(...tsGates("examples/monitor-app", "examples/monitor-app/tests/unit"));
    }
    const pkgGates = await gateLoop(key, monitorGateSet, async (fails) => {
      const rustFails = fails.filter((f) => f.cmd.startsWith("cargo"));
      const tsFails = fails.filter((f) => !f.cmd.startsWith("cargo"));
      const jobs: Promise<unknown>[] = [];
      if (rustFails.length > 0 && rustOk) jobs.push(rustImpl.ask<ImplementResult>(`Monitor-area gate failures (Rust side). Fix in files you own; never weaken a check. Failures inside streaming/sse/multipart files belong to another area — rerun once first:\n${JSON.stringify(rustFails)}`));
      if (tsFails.length > 0 && tsOk) jobs.push(screenImpl.ask<ImplementResult>(`Monitor-area gate failures (TS/screen side). Fix in files you own; every nsh build warning is a finding. Failures inside streaming/sse/upload files belong to another area — rerun once first:\n${JSON.stringify(tsFails)}`));
      await Promise.all(jobs);
    });

    // Native captures + vision judging (criterion 7) — only when the screen and the echo server exist.
    const unverified = degraded.concat(rustRes.res.unverified, tsRes.res.unverified);
    let evidence = ["docs/evidence/monitor/"];
    if (tsOk && echo.ok) {
      announce(key, "capturing", "capturing the ready screen on macos, ios, android and web");
      const cap = await device.ask<DeviceReport>(MONITOR_CAPTURE_ASK(echo));
      for (const issue of cap.issues) unverified.push(`device: ${issue}`);

      announce(key, "capturing", "a fresh vision judge now views every PNG");
      const judge = agent("monitor·vision-judge", { system: qaPersona.persona, model: MODELS.flash });
      const visionAsk = (extra: string) =>
        `View EVERY PNG under /Users/hmziq/fo/nsh-http/docs/evidence/monitor/ (open each file; do not trust filenames). This judges satisfaction criterion 7 of docs/PROMPT.md: the monitor recorded the real timings of a slow route and a fast route on macos, ios, android and web through the demo screen, and the slow route sorts on top. Judge per PNG: (a) it shows the monitor screen with a list of requests, (b) the slow route's row is above the fast route's, sorted by duration descending, (c) durations are visible and plausible (slow noticeably larger), (d) a filter affordance and per-host aggregates are visible, (e) legibility and design-guide quality. ${extra} Return perPng verdicts for every file you opened, findings ONLY for real problems, and contractLine verbatim from your contract. You never edit anything.`;
      let vision = await judge.ask<VisionVerdict>(visionAsk("Fix-round budget exists; judge strictly but judge what is there."));
      if (!vision.pass) {
        const fixables = vision.findings;
        announce(key, "capturing", `${fixables.length} vision finding(s); one fix round, then recapture`);
        if (tsOk) await screenImpl.ask<ImplementResult>(`The vision judge could not confirm criterion 7 on the captures. Fix the screen or capture flow (files you own only):\n${JSON.stringify(fixables)}`);
        const recapt = await device.ask<DeviceReport>(MONITOR_CAPTURE_ASK(echo));
        for (const issue of recapt.issues) unverified.push(`device (recapture): ${issue}`);
        vision = await judge.ask<VisionVerdict>(visionAsk("This is the final round; judge what is there."));
      }
      if (!vision.pass) unverified.push("vision judge: criterion 7 not fully confirmed on the captures (see findings)");
      evidence = vision.perPng.map((p) => p.path);
    } else {
      unverified.push("criterion 7 native captures skipped: " + (!tsOk ? "screen area degraded" : "echo server down"));
    }

    const ok = audit.converged && pkgGates.converged;
    announce(key, ok ? "done" : "failed", ok ? "monitor done (both versions + ready screen)" : "finished with unresolved issues");
    return {
      name: key, status: ok ? "done" : "failed",
      summary: `Rust: ${rustRes.res.summary} TS+screen: ${tsRes.res.summary}`,
      rounds: { audit: audit.rounds, tests: pkgGates.rounds },
      auditConverged: audit.converged, testsConverged: pkgGates.converged,
      blockers: pkgGates.fails.map((f) => `gate failed: ${f.cmd}`).concat(audit.findings.map((f) => `audit finding left: ${f.path}: ${f.problem}`)),
      unverified, upstream: [], evidence,
      personaVerified: rustRes.verified && tsRes.verified,
    };
  } catch (err) {
    announce(key, "failed", `failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      name: key, status: "failed", summary: `monitor area failed: ${err instanceof Error ? err.message : String(err)}`,
      rounds: { audit: 0, tests: 0 }, auditConverged: false, testsConverged: false,
      blockers: [err instanceof Error ? err.message : String(err)], unverified: [], upstream: [], evidence: [], personaVerified: false,
    };
  }
}

// ---------- area 5: streaming and uploads ----------

const STREAMING_RUST_ASK = `
Implement streaming and uploads' Rust half in crates/nsh-http (you own src/streaming.rs, src/sse.rs, src/multipart.rs and tests/streaming.rs, tests/sse.rs, tests/multipart.rs, tests/live_streams.rs from here on; do not edit any other file, including lib.rs).
Read docs/decision.md first (what streaming is honestly possible from Rust's fetch — the decision experiments measured this; honor it).
Implement, per docs/PROMPT.md §The library and behavior rows 13-14: multipart upload (build and send multipart/form-data); streaming request bodies where the runtime allows; streaming response body handling; download progress where the runtime gives it — if the decision shows the whole response body arrives at once in Rust, expose progress honestly as all-at-once and DOCUMENT that limit in the API docs; upload progress with its honest limit documented. SSE with reconnect (backoff) and Last-Event-ID sent on reconnect, cancellation-safe (a dropped stream/cancel token stops the loop cleanly — apply the rust-async-patterns skill; load it via the Skill tool).
Unit tests on stubs + manual clock in tests/streaming.rs, tests/sse.rs, tests/multipart.rs (StubNetwork function routes can stream chunks — verify against nsh-testing 0.4.0 source; if the stub cannot stream, test the parsing/reconnect machinery purely and move the wire-level proof to the live tests). Live tests in tests/live_streams.rs: #[ignore], "LIVE:" header, read the port from tools/echo-server/.runtime.json, drive /stream, /sse (incl. Last-Event-ID reconnect), /multipart, /bytes/:n — the smoke runs them with the server up.
Every new test seen to fail once by breaking the code on purpose. Another area edits src/monitor.rs concurrently — rerun once if a gate failure lands there.
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim.
`;

const STREAMING_TS_ASK = (echo: EchoInfo) => `
Implement streaming and uploads' TypeScript half in packages/nsh-http (you own src/streaming.ts, src/sse.ts, src/upload.ts, tests/unit/streaming.test.ts, tests/unit/sse.test.ts, tests/unit/upload.test.ts, tests/live/streaming.test.ts, tests/live/sse.test.ts from here on; do not edit any other file, including index.ts beyond nothing — it already re-exports your modules).
Read docs/decision.md first (TSX fetch has streaming bodies — the experiments confirmed; honor its ttfbMs/progress findings).
Implement behavior rows 13-14: multipart upload (FormData where the runtime gives it); streaming request bodies; streaming response bodies via the body stream with download progress (content-length based); upload progress with the honest limit documented; SSE client with reconnect backoff and Last-Event-ID on reconnect, AbortSignal-cancellable.
Unit tests in tests/unit/ (stub routes + manual clock; NSH stub routes support delayed responses — verify against .nsh/types and the nsh-testing docs). Live tests in tests/live/streaming.test.ts and tests/live/sse.test.ts ("LIVE:" header, network: "live", base http://127.0.0.1:${echo.port} from tools/echo-server/.runtime.json, clear failure if absent): chunked stream consumption, SSE reconnect replaying from Last-Event-ID, multipart echo round-trip.
Every new test seen to fail once by breaking the code on purpose. Another area edits src/monitor.ts concurrently — rerun once if a gate failure lands there.
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim.
`;

async function streamingArea(rust: Promise<AreaOutcome>, ts: Promise<AreaOutcome>, echoP: Promise<EchoInfo>): Promise<AreaOutcome> {
  const key = "streaming and uploads";
  announce(key, "implementing", "waiting for the two client cores, then implementing streaming, uploads and SSE");
  try {
    const settled = await Promise.allSettled([rust, ts]);
    const rustOk = settled[0].status === "fulfilled" && settled[0].value.status === "done";
    const tsOk = settled[1].status === "fulfilled" && settled[1].value.status === "done";
    const echo = await echoP;
    const degraded: string[] = [];
    if (!rustOk) degraded.push("Rust core did not finish cleanly; Rust-side streaming proceeds on the skeleton only");
    if (!tsOk) degraded.push("TS core did not finish cleanly; TS-side streaming proceeds on the skeleton only");

    const rustImpl = agent("streaming·rust", { system: asyncPersona.persona, model: MODELS.flash });
    const tsImpl = agent("streaming·ts", { system: nshPersona.persona, model: MODELS.flash });

    const rustWork = rustOk
      ? askVerified<ImplementResult>(rustImpl, asyncPersona.persona, STREAMING_RUST_ASK)
      : Promise.resolve({ res: { done: false, summary: "skipped: Rust core did not finish", unverified: ["Rust-side streaming"], upstream: [] } as ImplementResult, verified: false });
    const tsWork = tsOk
      ? askVerified<ImplementResult>(tsImpl, nshPersona.persona, STREAMING_TS_ASK(echo))
      : Promise.resolve({ res: { done: false, summary: "skipped: TS core did not finish", unverified: ["TS-side streaming"], upstream: [] } as ImplementResult, verified: false });
    const [rustRes, tsRes] = await Promise.all([rustWork, tsWork]);

    const audit = await auditLoop(
      key,
      async (round) => {
        const [rustAudit, tsAudit] = await Promise.all([
          agent(`streaming·rust-auditor·r${round}`, { system: asyncPersona.persona, model: MODELS.flash }).ask<AuditResult>(
            `Audit streaming/uploads' Rust half (read-only): crates/nsh-http/src/{streaming.rs,sse.rs,multipart.rs} and their test files. Standard: docs/PROMPT.md §The library (rows 13-14 of docs/behavior.md), honest limits per docs/decision.md, cancellation safety, reconnect+Last-Event-ID correctness. Load rust-async-patterns via the Skill tool. Return findings ONLY; empty means clean. contractLine verbatim.`,
          ),
          agent(`streaming·ts-auditor·r${round}`, { system: nshPersona.persona, model: MODELS.flash }).ask<AuditResult>(
            `Audit streaming/uploads' TS half (read-only): packages/nsh-http/src/{streaming.ts,sse.ts,upload.ts} and tests/unit/{streaming,sse,upload}.test.ts + tests/live. Standard: docs/PROMPT.md §The library rows 13-14, honest limits per docs/decision.md, AbortSignal cancellation, reconnect+Last-Event-ID. Return findings ONLY; empty means clean. contractLine verbatim.`,
          ),
        ]);
        return { findings: [...rustAudit.findings, ...tsAudit.findings] };
      },
      async (findings) => {
        const rustFindings = findings.filter((f) => f.path.startsWith("crates/"));
        const tsFindings = findings.filter((f) => !f.path.startsWith("crates/"));
        const jobs: Promise<unknown>[] = [];
        if (rustFindings.length > 0 && rustOk) jobs.push(rustImpl.ask<ImplementResult>(`Streaming audit findings — fix them in your Rust files:\n${JSON.stringify(rustFindings)}`));
        if (tsFindings.length > 0 && tsOk) jobs.push(tsImpl.ask<ImplementResult>(`Streaming audit findings — fix them in your TS files:\n${JSON.stringify(tsFindings)}`));
        await Promise.all(jobs);
      },
    );

    const gates: Gate[] = [];
    if (rustOk) gates.push(...rustGates());
    if (tsOk) {
      gates.push(...tsGates("packages/nsh-http", "packages/nsh-http/tests/unit"));
      if (echo.ok) gates.push({ cmd: "nsh", args: ["test", "packages/nsh-http/tests/live"], timeoutMs: 600000 });
    }
    const gateRes = await gateLoop(key, gates, async (fails) => {
      const rustFails = fails.filter((f) => f.cmd.startsWith("cargo"));
      const tsFails = fails.filter((f) => !f.cmd.startsWith("cargo"));
      const jobs: Promise<unknown>[] = [];
      if (rustFails.length > 0 && rustOk) jobs.push(rustImpl.ask<ImplementResult>(`Streaming gate failures (Rust). Fix in files you own; never weaken a check. Failures in monitor.rs belong to another area — rerun once first:\n${JSON.stringify(rustFails)}`));
      if (tsFails.length > 0 && tsOk) jobs.push(tsImpl.ask<ImplementResult>(`Streaming gate failures (TS). Fix in files you own; every nsh build warning is a finding. Failures in monitor.ts belong to another area — rerun once first:\n${JSON.stringify(tsFails)}`));
      await Promise.all(jobs);
    });

    const unverified = degraded.concat(rustRes.res.unverified, tsRes.res.unverified);
    if (!echo.ok) unverified.push("live streaming/SSE suites not run: echo server down");
    const ok = audit.converged && gateRes.converged;
    announce(key, ok ? "done" : "failed", ok ? "streaming, uploads and SSE done" : "finished with unresolved issues");
    return {
      name: key, status: ok ? "done" : "failed",
      summary: `Rust: ${rustRes.res.summary} TS: ${tsRes.res.summary}`,
      rounds: { audit: audit.rounds, tests: gateRes.rounds },
      auditConverged: audit.converged, testsConverged: gateRes.converged,
      blockers: gateRes.fails.map((f) => `gate failed: ${f.cmd}`).concat(audit.findings.map((f) => `audit finding left: ${f.path}: ${f.problem}`)),
      unverified, upstream: [], evidence: ["crates/nsh-http/tests/", "packages/nsh-http/tests/"],
      personaVerified: rustRes.verified && tsRes.verified,
    };
  } catch (err) {
    announce(key, "failed", `failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      name: key, status: "failed", summary: `streaming area failed: ${err instanceof Error ? err.message : String(err)}`,
      rounds: { audit: 0, tests: 0 }, auditConverged: false, testsConverged: false,
      blockers: [err instanceof Error ? err.message : String(err)], unverified: [], upstream: [], evidence: [], personaVerified: false,
    };
  }
}

// ---------- area 6: examples and docs ----------

const DEMO_ASK = (echo: EchoInfo) => `
Build the two demo apps and the docs for nsh-http. Files you own: examples/demo-rs/**, examples/demo-ts/**, README.md, docs/upstream-issues.md; delete examples/.gitkeep and tools/echo-server/.gitkeep when real content exists. The echo server is already running on 127.0.0.1:${echo.port} (port also in tools/echo-server/.runtime.json). The libraries exist: crates/nsh-http (Rust) and packages/nsh-http (TS).

examples/demo-ts — TSX NSH app (App.tsx at root, nsh.json id dev.nshhttp.demo-ts, capabilities.network hosts ["127.0.0.1","localhost","10.0.2.2"], node_modules symlinks: ln -s ../../packages/nsh-http node_modules/nsh-http and ln -s ~/fo/nsh-query/packages/nsh-query node_modules/nsh-query — read-only sibling, symlink don't copy):
- On start: fetch a fast and a slow echo route through the nsh-http client and show status + timings (simple screen; the monitor's fancy screen belongs to another area).
- nsh-query integration (satisfaction criterion 9): a query whose fetcher goes through the nsh-http client with the query's AbortSignal; a button replaces the query (new key) while the old request is in flight against /slow; the echo server's .runtime.log must then show an "aborted" line for it. Add a test that proves the flow and a short note in the app.
- Token refresh demo: a button fires three parallel requests with an expired token through the client's token provider; the screen shows one refresh happened and all three succeeded.
- tests/unit/ (stubs + manual clock) and tests/live/ ("LIVE:" header, network: "live", base URL from env ECHO_BASE default http://127.0.0.1:${echo.port}): the live test asserts the client calls land and reads tools/echo-server/.runtime.log to prove the aborted request line appeared. A capture test under tests/capture/ saves app.screenshot PNGs to docs/evidence/examples/ for the device operator.
examples/demo-rs — Rust NSH app (own standalone crate at examples/demo-rs, NOT a workspace member: its own Cargo.toml with nsh-http path dep + nsh-core 0.4.0; dev-deps nsh-engine/nsh-testing 0.4.0; nsh.json with "rust" and "root"): the same fast/slow + token refresh demo in Rust; headless tests on stubs + manual clock; a #[ignore] "LIVE:" test in its tests/ reading the port from tools/echo-server/.runtime.json; a capture test for macos under tests/capture/.
README.md — follow ~/fo/nsh-query/README.md's shape exactly: title + one-paragraph pitch, the two-versions table, a "## Why two versions" section, Rust usage, TypeScript usage (node_modules symlink), a behavior table pointing at docs/behavior.md, "## Test" with the exact commands, and a "## Demo" section that gets a person from a CLEAN CLONE to a running demo against tools/echo-server (clone, prerequisites, start echo server, node_modules symlinks, nsh run / cargo run commands with real paths). Direct, concrete, no marketing filler (antislop-copy applies).
docs/upstream-issues.md — a short file listing any bugs found in read-only siblings (collect what your result and other areas' summaries report; empty template with instructions if none).
Every new test seen to fail once by breaking the code on purpose.
${FACTS}
${ESCALATE}
Return: done, summary, unverified, upstream, contractLine verbatim.
`;

const DEMO_CAPTURE_ASK = (echo: EchoInfo) => `
Prove the demos run on real targets (README satisfaction criterion 10 evidence). Echo server on 127.0.0.1:${echo.port} (verify /health; restart per your briefing if down).
1. README clean-clone walk: copy the repo working tree EXCLUDING .git and node_modules and target and scratch (e.g. rsync -a --exclude .git --exclude node_modules --exclude target --exclude scratch /Users/hmziq/fo/nsh-http/ /tmp/nsh-http-cleanclone/), then follow README.md's Demo section EXACTLY as written in that copy, from scratch: start the echo server (its port file may collide — use a fresh copy's own server on another free port), create the symlinks, run the demo. Record every step that did not work as written — those are README findings (you may NOT edit the repo to fix them; report them).
2. Captures: nsh test --target macos examples/demo-ts and --target web examples/demo-ts (ECHO_BASE set), then nsh test --target macos examples/demo-rs; capture PNGs land under /Users/hmziq/fo/nsh-http/docs/evidence/examples/ via the apps' capture tests; verify each file exists with ls -la. One-line observation per capture; issues for anything that could not run.
`;

async function examplesArea(rust: Promise<AreaOutcome>, ts: Promise<AreaOutcome>, decision: Promise<AreaOutcome>, echoP: Promise<EchoInfo>): Promise<AreaOutcome> {
  const key = "examples and docs";
  announce(key, "implementing", "echo server first, then demos and docs");
  try {
    let echo = await echoP;
    const settled = await Promise.allSettled([rust, ts]);
    const rustOk = settled[0].status === "fulfilled" && settled[0].value.status === "done";
    const tsOk = settled[1].status === "fulfilled" && settled[1].value.status === "done";
    const decisionOk = settled[2].status === "fulfilled" && settled[2].value.status === "done";
    const degraded: string[] = [];
    if (!rustOk) degraded.push("Rust core not done; demo-rs may not compile");
    if (!tsOk) degraded.push("TS core not done; demo-ts may not compile");
    if (!decisionOk) degraded.push("docs/decision.md not finished; demos proceed on the documented default");

    const apps = agent("examples·apps", { system: nshPersona.persona, model: MODELS.flash });
    if (!echo.ok) {
      // The bootstrap ran before the cores finished; if it lost the race, this area's own
      // implementer brings the server up before any demo work starts.
      degraded.push(`echo bootstrap failed earlier (${echo.note}); this area is bringing the server up itself`);
      await apps.ask<ImplementResult>(`The echo server did not come up during the early bootstrap (${echo.note}). Start it exactly as tools/echo-server/README.md documents (detached bun process, write tools/echo-server/.runtime.json with the real port), verify curl -sf http://127.0.0.1:<port>/health, and continue with the demo build against that port.`);
      echo = await readEcho();
    }
    if (!echo.ok) degraded.push(`echo server down (${echo.note}); live demo proofs unverified`);

    const demoWork = tsOk
      ? askVerified<ImplementResult>(apps, nshPersona.persona, DEMO_ASK(echo))
      : Promise.resolve({ res: { done: false, summary: "skipped: TS core did not finish", unverified: ["demo apps and README"], upstream: [] } as ImplementResult, verified: false });
    const demoRes = await demoWork;

    const audit = await auditLoop(
      key,
      async (round) => {
        const auditor = agent(`examples·auditor·r${round}`, { system: nshPersona.persona, model: MODELS.flash });
        return auditor.ask<AuditResult>(
          `Audit examples and docs (read-only over repo files; you MAY run commands and you MAY create throwaway copies under /tmp only). Scope: tools/echo-server/** (routes vs docs/PROMPT.md §Sandbox: delay, status, flaky+Retry-After, ETag, chunked streaming, SSE with Last-Event-ID, multipart echo, token check, redirect for the refusal test, abort logging for criterion 9), examples/demo-ts/**, examples/demo-rs/**, README.md, docs/upstream-issues.md. Criterion 10: literally follow README.md's clean-clone-to-demo path in a fresh /tmp copy and report every step that fails as a finding. Also check the demos' tests are honest (stubs + manual clock; live files labelled). Return findings ONLY (path+problem+severity); empty means clean. contractLine verbatim.`,
        );
      },
      async (findings) => {
        await apps.ask<ImplementResult>(`The examples/docs audit found these problems. Fix them in files you own (README wording, echo routes, demo code):\n${JSON.stringify(findings)}`);
      },
    );

    const gates: Gate[] = [
      { cmd: "bun", args: ["--cwd", "tools/echo-server", "test"], timeoutMs: 300000 },
    ];
    if (rustOk) {
      gates.push({ cmd: "cargo", args: ["fmt", "--manifest-path", "examples/demo-rs/Cargo.toml", "--", "--check"], timeoutMs: 180000 });
      gates.push({ cmd: "cargo", args: ["clippy", "--manifest-path", "examples/demo-rs/Cargo.toml", "--all-targets", "--", "-D", "warnings"], timeoutMs: 600000 });
      gates.push({ cmd: "cargo", args: ["test", "--manifest-path", "examples/demo-rs/Cargo.toml"], timeoutMs: 600000 });
    }
    if (tsOk) {
      gates.push(...tsGates("examples/demo-ts", "examples/demo-ts/tests/unit"));
      if (echo.ok) gates.push({ cmd: "nsh", args: ["test", "examples/demo-ts/tests/live"], timeoutMs: 600000 });
    }
    const gateRes = await gateLoop(key, gates, async (fails) => {
      await apps.ask<ImplementResult>(`Examples/docs gate failures. Fix the cause in files you own — never weaken a check; every nsh build warning is a finding:\n${JSON.stringify(fails)}`);
    });

    const unverified = degraded.concat(demoRes.res.unverified);
    let evidence = ["docs/evidence/examples/"];
    if (tsOk && echo.ok) {
      announce(key, "capturing", "clean-clone README walk + demo captures on real targets");
      const cap = await device.ask<DeviceReport>(DEMO_CAPTURE_ASK(echo));
      for (const issue of cap.issues) unverified.push(`device: ${issue}`);
      const readmeFindings = cap.issues.filter((i) => i.toLowerCase().includes("readme") || i.toLowerCase().includes("clone"));
      if (readmeFindings.length > 0) {
        await apps.ask<ImplementResult>(`The clean-clone README walk failed at some steps. Fix README.md (and anything the walk proves broken in files you own) so a fresh clone really runs:\n${JSON.stringify(readmeFindings)}`);
        unverified.push("README was fixed after the walk; the re-walk happens at the smoke stage only if a gate covers it — treat the README walk as verified only via the auditor round that follows");
      }

      announce(key, "capturing", "a fresh vision judge now views every demo PNG");
      const judge = agent("examples·vision-judge", { system: qaPersona.persona, model: MODELS.flash });
      const vision = await judge.ask<VisionVerdict>(
        `View EVERY PNG under /Users/hmziq/fo/nsh-http/docs/evidence/examples/ (open each file). Judge: (a) the demo app's screen is legible and follows the design-guide basics (tokens, spacing, hierarchy), (b) fast/slow request results and their timings are visible, (c) the token-refresh demo shows one refresh and three successes where that screen was captured, (d) nothing looks broken or unstyled. Return perPng verdicts for every file you opened, findings ONLY for real problems, contractLine verbatim. You never edit anything.`,
      );
      if (!vision.pass && tsOk) {
        await apps.ask<ImplementResult>(`The vision judge flagged the demo captures. Fix the screens (files you own):\n${JSON.stringify(vision.findings)}`);
        unverified.push("demo screen fixes applied after the vision round; captures not retaken — treat the affected captures as pre-fix evidence");
      }
      evidence = vision.perPng.map((p) => p.path);
    } else {
      unverified.push("demo native captures skipped: " + (!tsOk ? "apps degraded" : "echo server down"));
    }

    const ok = audit.converged && gateRes.converged;
    announce(key, ok ? "done" : "failed", ok ? "echo server, demos and README done" : "finished with unresolved issues");
    return {
      name: key, status: ok ? "done" : "failed",
      summary: demoRes.res.summary,
      rounds: { audit: audit.rounds, tests: gateRes.rounds },
      auditConverged: audit.converged, testsConverged: gateRes.converged,
      blockers: gateRes.fails.map((f) => `gate failed: ${f.cmd}`).concat(audit.findings.map((f) => `audit finding left: ${f.path}: ${f.problem}`)),
      unverified, upstream: demoRes.res.upstream, evidence,
      personaVerified: demoRes.verified,
    };
  } catch (err) {
    announce(key, "failed", `failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      name: key, status: "failed", summary: `examples area failed: ${err instanceof Error ? err.message : String(err)}`,
      rounds: { audit: 0, tests: 0 }, auditConverged: false, testsConverged: false,
      blockers: [err instanceof Error ? err.message : String(err)], unverified: [], upstream: [], evidence: [], personaVerified: false,
    };
  }
}

// ---------- the fan-out: every area advances through its own chain ----------

phase("Advance every area through its own chain in parallel — decision leads, libraries follow it, monitor and streaming join the finished cores");

announce("decision", "implementing", "experiments on nsh 0.4.0 begin now");
announce("rust client", "implementing", "workspace scaffold begins now");
announce("ts client", "implementing", "package scaffold begins now");
announce("monitor", "implementing", "queued behind the two client cores");
announce("streaming and uploads", "implementing", "queued behind the two client cores");
announce("examples and docs", "implementing", "echo server starts first, demos follow the cores");

const pEcho = bootstrapEcho();
const pDecision = decisionArea();
const pRust = rustClientArea();
const pTs = tsClientArea();
const pMonitor = monitorArea(pRust, pTs, pEcho);
const pStreaming = streamingArea(pRust, pTs, pEcho);
const pExamples = examplesArea(pRust, pTs, pDecision, pEcho);

const outcomes: AreaOutcome[] = await Promise.all([pDecision, pRust, pTs, pMonitor, pStreaming, pExamples]);
const failed = outcomes.filter((o) => o.status === "failed");
log(`all six areas settled: ${outcomes.length - failed.length} done, ${failed.length} failed`);

// ---------- whole-tree smoke, once, then fix rounds until clean (cap 3) ----------

phase("Smoke the whole tree once and fix what it finds, until zero issues or the round cap");

const smokeFixer = agent("smoke·fixer", {
  system: nshPersona.persona,
  model: MODELS.flash,
});

let smokeRounds = 0;
let smokeConverged = false;
let smokeFails: GateFail[] = [];
for (let round = 1; round <= 3; round++) {
  smokeRounds = round;
  let echo = await readEcho();
  if (!echo.ok) {
    log("smoke: echo server down; asking the fixer to start it before the live gates");
    await smokeFixer.ask<ImplementResult>(`The local echo server is down (${echo.note}). Start it exactly as tools/echo-server/README.md documents (detached bun process, write tools/echo-server/.runtime.json), verify curl /health, and report. Do not touch anything else.`);
    echo = await readEcho();
  }
  smokeFails = await runGates(smokeGates(echo));
  if (smokeFails.length === 0) { smokeConverged = true; break; }
  log(`smoke round ${round}: ${smokeFails.length} failing gate(s)`);
  if (round === 3) break;
  await smokeFixer.ask<ImplementResult>(
    `The whole-tree smoke found these failing gates. Fix the underlying causes across the tree — cargo gates at the repo root, nsh gates per app dir, bun gate in tools/echo-server. Never weaken, skip or delete a check; if a failure is an honest environment limit, say so in unverified instead of forcing it:\n${JSON.stringify(smokeFails)}`,
  );
}

// ---------- final status, evidence, handover ----------

phase("Write docs/STATUS.md from the evidence and hand over");

const evid = await world.run("find", ["docs/evidence", "-type", "f"], { timeoutMs: 30000 });
const evidenceList = evid.exitCode === 0 ? evid.stdout.trim() : "(evidence listing failed)";

const statusWriter = agent("status·writer", {
  system:
    "You write precise, human build status documents. Direct sentences, no filler; every claim carries its evidence; anything without evidence is labelled unverified. The antislop-copy skill applies.",
  model: MODELS.flash,
});
const statusAsk = (extra: string) =>
  `Write docs/STATUS.md for the nsh-http repository (you own that one file; do not edit anything else). docs/PROMPT.md §Satisfaction criteria lists criteria 1-10; map EVERY criterion to the work that covered it and the evidence file or command that proves it. Mark honestly what is NOT verified. Content sources:\n` +
  `- Area outcomes (status, summaries, rounds, blockers, unverified): ${JSON.stringify(outcomes)}\n` +
  `- Whole-tree smoke: converged=${smokeConverged} after ${smokeRounds} round(s); failing gates: ${JSON.stringify(smokeFails.map((f) => f.cmd))}\n` +
  `- docs/decision.md (criterion 1), docs/behavior.md (criterion 2), docs/evidence/** (see below)\n` +
  `- Evidence files present:\n${evidenceList}\n` +
  `Structure: a one-paragraph state of the build, a criteria 1-10 table (criterion | status: verified/unverified | evidence), a per-area section (done/failed, what was verified how, rounds used), and an explicit "Not verified" list. ${extra} Return done/summary as your result.`;

let statusDone = false;
for (let round = 1; round <= 2; round++) {
  await statusWriter.ask<ImplementResult>(statusAsk(round === 1 ? "This is the first write." : "Revise per the reader's findings."));
  const reader = agent(`status·reader·r${round}`, {
    system: "You are a skeptical reader: judge a status document from its own text. Read-only.",
    model: MODELS.flash,
  });
  const check = await reader.ask<AuditResult>(
    `Read docs/STATUS.md as a skeptical reader (do not edit anything). Findings ONLY for: claims presented as verified without a named evidence file or command, criteria 1-10 rows that do not map to real work, an absent or dishonest "Not verified" list, filler. Empty findings means the document holds. contractLine verbatim from your contract.`,
  );
  if (check.findings.length === 0) { statusDone = true; break; }
  await statusWriter.ask<ImplementResult>(`The reader flagged these problems in docs/STATUS.md. Fix them:\n${JSON.stringify(check.findings)}`);
}

const upstreamAll = outcomes.flatMap((o) => o.upstream);
if (upstreamAll.length > 0) {
  await statusWriter.ask<ImplementResult>(`Also append an "Upstream issues" section to docs/upstream-issues.md (create it if missing; that file is part of the examples area's set but you are the last writer and the areas have all finished) listing: ${JSON.stringify(upstreamAll)}`);
}

await artifact.file("status", "docs/STATUS.md", {
  title: "nsh-http build status and evidence",
  description: "Satisfaction criteria 1-10 with their evidence, per-area outcomes, and everything still unverified.",
  primary: true,
});

const unverifiedAll = outcomes.flatMap((o) => o.unverified);
const doneCount = outcomes.filter((o) => o.status === "done").length;
const conclusion =
  `nsh-http build: ${doneCount}/6 areas done` +
  (smokeConverged ? `, whole-tree smoke green after ${smokeRounds} round(s)` : `, smoke did NOT converge (${smokeFails.length} gate(s) still failing after the cap)`) +
  (statusDone ? "; docs/STATUS.md maps every satisfaction criterion to its evidence" : "; docs/STATUS.md written but its final reader pass did not come back clean") +
  (unverifiedAll.length > 0 ? `; ${unverifiedAll.length} item(s) honestly unverified — see the report` : "") +
  ". The checkout is left uncommitted for the coordinator; the echo server may still be running (port in tools/echo-server/.runtime.json).";

return {
  conclusion,
  areas: outcomes.map((o) => ({ name: o.name, status: o.status, summary: o.summary, rounds: o.rounds })),
  findings: outcomes.flatMap((o) =>
    o.blockers.map((b) => ({ where: o.name, what: b, evidence: "area gates and audits", status: "verified" as const, severity: "high" as const })),
  ),
  verified: [
    `per-area gates: cargo fmt/clippy/test at root, per-app nsh check/build/test, bun test for the echo server — each area ran its own, and the smoke re-ran the union ${smokeRounds} time(s)`,
    `audits ran until zero findings or the 3-round cap per area`,
    `native captures on real targets through one serialized device operator; every PNG viewed by a flash vision judge`,
  ],
  notCovered: unverifiedAll.length > 0 ? unverifiedAll : ["nothing outstanding was left unverified"],
  notes:
    `Decision-first sequencing: areas 2-3 scaffolded structure immediately and polled up to 45 min for docs/decision.md's "## Decision" before transport code; monitor and streaming joined the finished cores. ` +
    `The echo server belongs to examples-and-docs and started first, so only live gates ever waited on it; unit chains never did. ` +
    `All subagents ran GLM-5.3-Flash$high per the brief; specialist personas loaded verbatim from .zcode/agents at run time. ` +
    `No commits were made by any area. Remaining blockers: ${failed.map((o) => o.name).join(", ") || "none"}.`,
};
