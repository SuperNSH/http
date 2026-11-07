// Local sandbox echo server for the nsh-http build. Binds 127.0.0.1 on an
// OS-assigned port and records the port in .runtime.json — the file every
// other area reads — only after its own /health check answers.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonLog, type JsonLog } from "./log";

const HOST = "127.0.0.1";
const ECHO_DIR = join(import.meta.dir, "..");
// Bun's default idle timeout would cut off slow routes and look like an abort.
const IDLE_TIMEOUT = 0;
const MAX_BYTES = 100_000_000;

interface ServerOpts {
  /** Defaults: ECHO_LOG_PATH, else .runtime.log (temp file under bun test). */
  logPath?: string;
  /** Defaults: ECHO_RUNTIME_PATH, else .runtime.json (never written under bun test). */
  runtimePath?: string | null;
}

export interface EchoServerHandle {
  readonly port: number;
  readonly logPath: string;
  readonly runtimePath: string | null;
  flushLog(): Promise<void>;
  stop(): Promise<void>;
}

interface Ctx {
  request: Request;
  url: URL;
  signal: AbortSignal;
  /** Resolves once the client disconnects (immediately when already gone). */
  disconnect(): Promise<void>;
  /** Log the end line; a no-op after abort. */
  complete(status: number): void;
  /** Log the aborted line; idempotent. */
  abort(): void;
  /** Streaming routes call this so the wrapper does not log `end` at return time. */
  deferEnd(): void;
}

interface AppState {
  // One hit counter per `fail` value, so concurrent flaky tests stay independent.
  flakyHits: Map<number, number>;
  log: JsonLog;
}

/** The last `tail` log lines, parsed, oldest first. Test VMs on 0.4.0 cannot
 * read files, so the nsh-query cancellation proof goes through this route. */
async function handleLog(ctx: Ctx, state: AppState): Promise<Response> {
  const tail = clampInt(ctx.url.searchParams.get("tail"), 20, 1, 1000);
  let raw: string;
  try {
    raw = await Bun.file(state.log.path).text();
  } catch {
    // No log yet (fresh server, nothing answered): an empty tail is the truth.
    return json({ lines: [] });
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const sliced = lines.slice(-tail);
  const parsed: unknown[] = [];
  for (const line of sliced) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      parsed.push({ event: "unparsable", raw: line });
    }
  }
  return json({ lines: parsed });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function json(data: unknown, init?: number | ResponseInit): Response {
  const resInit: ResponseInit = typeof init === "number" ? { status: init } : (init ?? {});
  const headers = new Headers(resInit.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { ...resInit, headers });
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method_not_allowed", allow }, { status: 405, headers: { allow } });
}

function matchesEtag(headerValue: string, etag: string): boolean {
  return headerValue.split(",").some((c) => c.trim() === etag || c.trim() === "*");
}

const ETAG = '"r1"';

async function handleSlow(ctx: Ctx): Promise<Response> {
  const delay = clampInt(ctx.url.searchParams.get("delay"), 1000, 0, 600_000);
  const outcome = await Promise.race([
    sleep(delay).then(() => "done" as const),
    ctx.disconnect().then(() => "gone" as const),
  ]);
  if (outcome === "gone") return new Response(null, { status: 499 });
  return json({ route: "slow", delay });
}

function handleStatus(ctx: Ctx): Response {
  const code = Number(ctx.url.pathname.split("/")[2]);
  if (!Number.isInteger(code) || code < 200 || code > 599) return json({ error: "bad_status" }, 400);
  // 204 and 304 forbid a body in the Response constructor.
  if (code === 204 || code === 304) return new Response(null, { status: code });
  return json({ status: code }, { status: code });
}

function handleFlaky(ctx: Ctx, state: AppState): Response {
  const fail = clampInt(ctx.url.searchParams.get("fail"), 0, 0, 100);
  const attempt = (state.flakyHits.get(fail) ?? 0) + 1;
  state.flakyHits.set(fail, attempt);
  if (attempt <= fail) {
    return json(
      { route: "flaky", failing: true, attempt },
      { status: 503, headers: { "retry-after": "1" } },
    );
  }
  return json({ route: "flaky", ok: true, failed: fail, attempt });
}

function handleEtag(ctx: Ctx): Response {
  const ifNoneMatch = ctx.request.headers.get("if-none-match");
  if (ifNoneMatch && matchesEtag(ifNoneMatch, ETAG)) {
    return new Response(null, { status: 304, headers: { etag: ETAG } });
  }
  return json({ route: "etag", rev: 1 }, { headers: { etag: ETAG } });
}

function handleStream(ctx: Ctx): Response {
  const chunks = clampInt(ctx.url.searchParams.get("chunks"), 8, 1, 10_000);
  const delay = clampInt(ctx.url.searchParams.get("delay"), 50, 0, 5_000);
  ctx.deferEnd();
  const encoder = new TextEncoder();
  let sent = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (ctx.signal.aborted) {
        ctx.abort();
        return;
      }
      sent++;
      controller.enqueue(encoder.encode(JSON.stringify({ route: "stream", chunk: sent, chunks }) + "\n"));
      if (sent >= chunks) {
        controller.close();
        ctx.complete(200);
        return;
      }
      await sleep(delay);
    },
    cancel() {
      ctx.abort();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}

function handleSse(ctx: Ctx): Response {
  const count = clampInt(ctx.url.searchParams.get("count"), 20, 1, 10_000);
  const delay = clampInt(ctx.url.searchParams.get("delay"), 10, 0, 5_000);
  // Reconnect replays starting at the id the client last saw, not after it;
  // an id beyond count means there is nothing left to replay.
  const last = Number(ctx.request.headers.get("last-event-id"));
  let next = Number.isInteger(last) ? Math.min(Math.max(last, 1), count + 1) : 1;
  ctx.deferEnd();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async pull(controller) {
      if (ctx.signal.aborted) {
        ctx.abort();
        return;
      }
      if (next > count) {
        controller.close();
        ctx.complete(200);
        return;
      }
      const id = next++;
      controller.enqueue(
        encoder.encode(`id: ${id}\nevent: tick\ndata: ${JSON.stringify({ route: "sse", id })}\n\n`),
      );
      await sleep(delay);
    },
    cancel() {
      ctx.abort();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

async function handleMultipart(ctx: Ctx): Promise<Response> {
  const contentType = ctx.request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "not_multipart" }, 400);
  }
  const form = await ctx.request.formData();
  const parts: Record<string, unknown>[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      parts.push({ name, value });
    } else {
      parts.push({ name, filename: value.name, size: value.size, content: await value.text() });
    }
  }
  return json({ parts });
}

function handleToken(ctx: Ctx): Response {
  const header = ctx.request.headers.get("authorization");
  if (!header) return json({ error: "missing_authorization" }, 401);
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer") return json({ error: "unsupported_scheme" }, 401);
  if (token === "expired") return json({ error: "expired" }, 401);
  if (token === "refreshed") return json({ ok: true });
  return json({ error: "unknown_token" }, 401);
}

async function handleEcho(ctx: Ctx): Promise<Response> {
  const raw = await ctx.request.text();
  let body: unknown;
  try {
    body = raw === "" ? null : JSON.parse(raw);
  } catch {
    body = raw;
  }
  return json({ method: ctx.request.method, path: ctx.url.pathname, query: ctx.url.search, body });
}

function handleBytes(ctx: Ctx): Response {
  const n = Number(ctx.url.pathname.split("/")[2]);
  if (!(n >= 0) || n > MAX_BYTES) return json({ error: "bad_size", max: MAX_BYTES }, 400);
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = i % 256;
  return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
}

async function routeRequest(ctx: Ctx, state: AppState): Promise<Response> {
  const path = ctx.url.pathname;
  const method = ctx.request.method;

  if (path === "/health") {
    if (method !== "GET") return methodNotAllowed("GET");
    return json({ ok: true });
  }
  if (path === "/fast") {
    if (method !== "GET") return methodNotAllowed("GET");
    return json({ route: "fast" });
  }
  if (path === "/slow") {
    if (method !== "GET") return methodNotAllowed("GET");
    return handleSlow(ctx);
  }
  if (path.startsWith("/status/")) {
    if (method !== "GET") return methodNotAllowed("GET");
    return handleStatus(ctx);
  }
  if (path === "/flaky") {
    if (method !== "GET") return methodNotAllowed("GET");
    return handleFlaky(ctx, state);
  }
  if (path === "/etag") {
    if (method !== "GET") return methodNotAllowed("GET");
    return handleEtag(ctx);
  }
  if (path === "/stream") {
    if (method !== "GET") return methodNotAllowed("GET");
    return handleStream(ctx);
  }
  if (path === "/sse") {
    if (method !== "GET") return methodNotAllowed("GET");
    return handleSse(ctx);
  }
  if (path === "/multipart") {
    if (method !== "POST") return methodNotAllowed("POST");
    return handleMultipart(ctx);
  }
  if (path === "/token") {
    if (method !== "POST") return methodNotAllowed("POST");
    return handleToken(ctx);
  }
  if (path === "/echo") {
    return handleEcho(ctx);
  }
  if (path === "/redirect/refused") {
    if (method !== "GET") return methodNotAllowed("GET");
    // refused.invalid is a host no test app declares: capability refusal on a
    // redirect hop must stay distinguishable from a network failure.
    return new Response(null, { status: 302, headers: { location: "http://refused.invalid/next" } });
  }
  if (path === "/redirect/local") {
    if (method !== "GET") return methodNotAllowed("GET");
    return new Response(null, { status: 302, headers: { location: "/fast" } });
  }
  if (path.startsWith("/bytes/")) {
    if (method !== "GET") return methodNotAllowed("GET");
    return handleBytes(ctx);
  }
  if (path === "/log") {
    if (method !== "GET") return methodNotAllowed("GET");
    return handleLog(ctx, state);
  }
  return json({ error: "not_found", path }, { status: 404 });
}

function createFetchHandler(state: AppState, log: JsonLog) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const id = crypto.randomUUID();
    const startedAt = performance.now();
    // /log reads the log; logging it would append to the very tail the next
    // reader is about to fetch, so it stays out of its own answer.
    const quiet = url.pathname === "/log";
    const write = (record: Record<string, unknown>) => {
      if (!quiet) log.write(record);
    };
    write({ event: "start", id, ts: Date.now(), method: request.method, path: url.pathname });

    let ended = false;
    let aborted = false;
    let deferred = false;
    let resolveDisconnect: () => void = () => {};
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
    });

    const markAborted = () => {
      if (ended || aborted) return;
      aborted = true;
      resolveDisconnect();
      write({ event: "aborted", id, ts: Date.now(), path: url.pathname });
    };
    const complete = (status: number) => {
      if (ended || aborted) return;
      ended = true;
      write({
        event: "end",
        id,
        ts: Date.now(),
        status,
        ms: Math.round(performance.now() - startedAt),
      });
    };

    if (request.signal.aborted) markAborted();
    else request.signal.addEventListener("abort", markAborted, { once: true });

    const ctx: Ctx = {
      request,
      url,
      signal: request.signal,
      disconnect: () => disconnected,
      complete,
      abort: markAborted,
      deferEnd: () => {
        deferred = true;
      },
    };

    let response: Response;
    try {
      response = await routeRequest(ctx, state);
    } catch (err) {
      response = json({ error: "internal_error", message: String(err) }, 500);
    }
    if (!deferred) complete(response.status);
    return response;
  };
}

function resolvePaths(opts: ServerOpts): { logPath: string; runtimePath: string | null } {
  const underTest = process.env.NODE_ENV === "test";
  const logPath =
    opts.logPath ??
    process.env.ECHO_LOG_PATH ??
    (underTest ? join(tmpdir(), `nsh-http-echo-test-${process.pid}.log`) : join(ECHO_DIR, ".runtime.log"));
  const runtimePath =
    opts.runtimePath !== undefined
      ? opts.runtimePath
      : process.env.ECHO_RUNTIME_PATH
        ? process.env.ECHO_RUNTIME_PATH
        : underTest
          ? null
          : join(ECHO_DIR, ".runtime.json");
  return { logPath, runtimePath };
}

async function verifyHealth(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`http://${HOST}:${port}/health`);
      if (res.ok) return true;
    } catch {
      // not accepting connections yet
    }
    await sleep(50);
  }
  return false;
}

export async function start(opts: ServerOpts = {}): Promise<EchoServerHandle> {
  const { logPath, runtimePath } = resolvePaths(opts);
  const log = createJsonLog(logPath);
  const state: AppState = { flakyHits: new Map(), log };
  // ECHO_PORT pins the port because nsh test VMs on 0.4.0 cannot read .runtime.json —
  // live suites and apps can only find the server on a port known in advance.
  const requested = process.env.ECHO_PORT ? Number(process.env.ECHO_PORT) : 0;
  const server = Bun.serve({
    hostname: HOST,
    port: requested,
    idleTimeout: IDLE_TIMEOUT,
    fetch: createFetchHandler(state, log),
  });
  const port = server.port;

  // The port file is the contract: it appears only once /health provably answers.
  const healthy = await verifyHealth(port);
  if (healthy && runtimePath) {
    await Bun.write(runtimePath, JSON.stringify({ port, pid: process.pid }) + "\n");
    console.log(`echo-server listening on ${HOST}:${port} (pid ${process.pid}), runtime file ${runtimePath}`);
  } else if (healthy) {
    console.log(`echo-server listening on ${HOST}:${port} (pid ${process.pid}), runtime file disabled`);
  } else {
    console.error(`echo-server listening on ${HOST}:${port} but its /health self-check failed; runtime file NOT written`);
  }

  return {
    port,
    logPath,
    runtimePath: runtimePath ?? null,
    flushLog: () => log.flush(),
    stop: async () => {
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  await start();
}
