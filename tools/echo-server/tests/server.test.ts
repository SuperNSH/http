// LIVE: these tests run a real server instance on loopback 127.0.0.1 (port 0) —
// the echo server's own contract is the sandbox the stubbed suites rely on, so
// it must be exercised over real sockets. No external network is touched.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { start, type EchoServerHandle } from "../src/server";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let srv: EchoServerHandle;
let base: string;

beforeAll(async () => {
  // runtimePath: null keeps the suite off the real .runtime.json.
  srv = await start({ runtimePath: null });
  base = `http://127.0.0.1:${srv.port}`;
});

afterAll(async () => {
  await srv.stop();
});

type LogLine = Record<string, unknown> & { event: string; id?: string; path?: string };

function readLog(): LogLine[] {
  return readFileSync(srv.logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Most recent start line for a path — the suite runs sequentially, so "last" is ours. */
function lastStart(path: string): LogLine & { id: string } {
  const starts = readLog().filter((l) => l.event === "start" && l.path === path);
  expect(starts.length).toBeGreaterThan(0);
  return starts[starts.length - 1] as LogLine & { id: string };
}

function parseSse(raw: string): { id: number; data: Record<string, unknown> }[] {
  return raw
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => ({
      id: Number(block.match(/^id: (\d+)$/m)![1]),
      data: JSON.parse(block.match(/^data: (.+)$/m)![1]),
    }));
}

describe("simple routes", () => {
  test("/health -> 200 {ok:true}", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("/fast -> {route:'fast'}", async () => {
    const res = await fetch(`${base}/fast`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ route: "fast" });
  });

  test("/slow waits the requested delay and echoes it", async () => {
    const began = Date.now();
    const res = await fetch(`${base}/slow?delay=80`);
    const elapsed = Date.now() - began;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ route: "slow", delay: 80 });
    expect(elapsed).toBeGreaterThanOrEqual(70);
  });

  test("/slow without a delay param defaults to 1000", async () => {
    const res = await fetch(`${base}/slow`);
    expect(await res.json()).toEqual({ route: "slow", delay: 1000 });
  }, 5000);

  test("/status/:code responds with the code", async () => {
    for (const code of [201, 404, 418, 500, 599]) {
      const res = await fetch(`${base}/status/${code}`);
      expect(res.status).toBe(code);
      expect(await res.json()).toEqual({ status: code });
    }
  });

  test("/status/204 and /status/304 return the code with no body", async () => {
    const res = await fetch(`${base}/status/204`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const res304 = await fetch(`${base}/status/304`);
    expect(res304.status).toBe(304);
  });

  test("/status/out-of-range -> 400", async () => {
    expect((await fetch(`${base}/status/199`)).status).toBe(400);
    expect((await fetch(`${base}/status/600`)).status).toBe(400);
    expect((await fetch(`${base}/status/abc`)).status).toBe(400);
  });

  test("unknown path -> 404 JSON error", async () => {
    const res = await fetch(`${base}/definitely/not/here`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", path: "/definitely/not/here" });
  });

  test("wrong method -> 405 with Allow", async () => {
    const res = await fetch(`${base}/token`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("/flaky", () => {
  test("first N hits 503 with Retry-After: 1, then 200", async () => {
    const first = await fetch(`${base}/flaky?fail=2`);
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("1");
    const second = await fetch(`${base}/flaky?fail=2`);
    expect(second.status).toBe(503);
    const third = await fetch(`${base}/flaky?fail=2`);
    expect(third.status).toBe(200);
    expect(await third.json()).toEqual({ route: "flaky", ok: true, failed: 2, attempt: 3 });
    const fourth = await fetch(`${base}/flaky?fail=2`);
    expect(fourth.status).toBe(200);
  });

  test("fail counters are independent per fail value", async () => {
    const first = await fetch(`${base}/flaky?fail=1`);
    expect(first.status).toBe(503);
    const second = await fetch(`${base}/flaky?fail=1`);
    expect(second.status).toBe(200);
    const fresh = await fetch(`${base}/flaky?fail=3`);
    expect(fresh.status).toBe(503);
  });
});

describe("/etag", () => {
  test("returns an ETag and a body", async () => {
    const res = await fetch(`${base}/etag`);
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await res.json()).toEqual({ route: "etag", rev: 1 });
    expect(etag).toBe((await (await fetch(`${base}/etag`)).headers.get("etag")));
  });

  test("If-None-Match match -> 304 with empty body", async () => {
    const etag = (await fetch(`${base}/etag`)).headers.get("etag")!;
    const res = await fetch(`${base}/etag`, { headers: { "if-none-match": etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
  });

  test("non-matching If-None-Match -> 200", async () => {
    const res = await fetch(`${base}/etag`, { headers: { "if-none-match": '"other"' } });
    expect(res.status).toBe(200);
  });
});

describe("/stream", () => {
  test("emits one ndjson chunk per tick with the right count", async () => {
    const res = await fetch(`${base}/stream?chunks=4&delay=10`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const text = await res.text();
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => JSON.parse(l).chunk)).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(lines[3]).chunks).toBe(4);
  });
});

describe("/sse", () => {
  test("emits count events with ids 1..count", async () => {
    const res = await fetch(`${base}/sse?count=3&delay=5`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());
    expect(events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(events[0].data).toEqual({ route: "sse", id: 1 });
  });

  test("Last-Event-ID replays from that id", async () => {
    const res = await fetch(`${base}/sse?count=5&delay=5`, { headers: { "last-event-id": "3" } });
    const events = parseSse(await res.text());
    expect(events.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  test("Last-Event-ID beyond count closes with no events", async () => {
    const res = await fetch(`${base}/sse?count=2&delay=5`, { headers: { "last-event-id": "9" } });
    expect(parseSse(await res.text())).toEqual([]);
  });
});

describe("/multipart", () => {
  test("echoes fields and files as JSON parts", async () => {
    const form = new FormData();
    form.set("note", "hello");
    form.set("file", new File(["abc"], "part.txt", { type: "text/plain" }));
    const res = await fetch(`${base}/multipart`, { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parts).toContainEqual({ name: "note", value: "hello" });
    expect(body.parts).toContainEqual({ name: "file", filename: "part.txt", size: 3, content: "abc" });
  });

  test("non-multipart body -> 400", async () => {
    const res = await fetch(`${base}/multipart`, { method: "POST", body: "plain" });
    expect(res.status).toBe(400);
  });
});

describe("/token", () => {
  test("Bearer expired -> 401 {error:'expired'}", async () => {
    const res = await fetch(`${base}/token`, {
      method: "POST",
      headers: { authorization: "Bearer expired" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "expired" });
  });

  test("Bearer refreshed -> 200 {ok:true}", async () => {
    const res = await fetch(`${base}/token`, {
      method: "POST",
      headers: { authorization: "Bearer refreshed" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("missing or unknown credentials -> 401", async () => {
    expect((await fetch(`${base}/token`, { method: "POST" })).status).toBe(401);
    const unknown = await fetch(`${base}/token`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });
    expect(unknown.status).toBe(401);
    expect((await unknown.json()).error).toBe("unknown_token");
  });
});

describe("/echo", () => {
  test("POST echoes method, path and parsed JSON body", async () => {
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1, b: [true, "x"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      method: "POST",
      path: "/echo",
      query: "",
      body: { a: 1, b: [true, "x"] },
    });
  });

  test("GET echoes its method and query string; non-JSON bodies echo as strings", async () => {
    const res = await fetch(`${base}/echo?q=hello%20world&n=2`);
    const body = await res.json();
    expect(body.method).toBe("GET");
    expect(body.path).toBe("/echo");
    expect(body.query).toBe("?q=hello%20world&n=2");
    expect(body.body).toBeNull();

    const text = await fetch(`${base}/echo`, { method: "PUT", body: "not json {" });
    expect((await text.json()).body).toBe("not json {");
  });
});

describe("/redirect", () => {
  test("/redirect/refused 302s to the undeclared host refused.invalid", async () => {
    const res = await fetch(`${base}/redirect/refused`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://refused.invalid/next");
  });

  test("/redirect/local 302s to /fast and resolves through fetch", async () => {
    const manual = await fetch(`${base}/redirect/local`, { redirect: "manual" });
    expect(manual.status).toBe(302);
    expect(manual.headers.get("location")).toBe("/fast");
    const followed = await fetch(`${base}/redirect/local`);
    expect(followed.url).toBe(`${base}/fast`);
    expect(await followed.json()).toEqual({ route: "fast" });
  });
});

describe("/bytes/:n", () => {
  test("returns n bytes with Content-Length", async () => {
    const res = await fetch(`${base}/bytes/1024`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1024");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(1024);
    expect(buf[0]).toBe(0);
    expect(buf[255]).toBe(255);
  });

  test("bad or oversized n -> 400", async () => {
    expect((await fetch(`${base}/bytes/nope`)).status).toBe(400);
    expect((await fetch(`${base}/bytes/99999999999`)).status).toBe(400);
  });
});

describe("request log", () => {
  test("completed requests pair a start line with an end line carrying status and ms", async () => {
    const res = await fetch(`${base}/fast`);
    expect(res.status).toBe(200);
    await srv.flushLog();
    const start = lastStart("/fast");
    expect(start.method).toBe("GET");
    expect(typeof start.ts).toBe("number");
    const ends = readLog().filter((l) => l.event === "end" && l.id === start.id);
    expect(ends).toHaveLength(1);
    expect(ends[0].status).toBe(200);
    expect(typeof ends[0].ms).toBe("number");
  });

  test("client abort during /slow logs aborted and no end line", async () => {
    const controller = new AbortController();
    const pending = fetch(`${base}/slow?delay=5000`, { signal: controller.signal });
    await sleep(150);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await sleep(300);
    await srv.flushLog();
    const start = lastStart("/slow");
    const aborted = readLog().filter((l) => l.event === "aborted" && l.id === start.id);
    expect(aborted).toHaveLength(1);
    expect(aborted[0].path).toBe("/slow");
    expect(readLog().some((l) => l.event === "end" && l.id === start.id)).toBe(false);
  }, 15000);

  test("client abort mid-/stream logs aborted and no end line", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/stream?chunks=500&delay=50`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await sleep(200);
    await srv.flushLog();
    const start = lastStart("/stream");
    expect(readLog().some((l) => l.event === "aborted" && l.id === start.id)).toBe(true);
    expect(readLog().some((l) => l.event === "end" && l.id === start.id)).toBe(false);
  }, 15000);

  test("/sse abort also lands in the log (cancellation proof for streams)", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/sse?count=500&delay=50`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await sleep(200);
    await srv.flushLog();
    const start = lastStart("/sse");
    expect(readLog().some((l) => l.event === "aborted" && l.id === start.id)).toBe(true);
  }, 15000);
});

describe("start-up contract", () => {
  test("a real start writes the runtime file only after /health answers, and honors ECHO_LOG_PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nsh-http-echo-contract-"));
    const logPath = join(dir, "runtime.log");
    const runtimePath = join(dir, "runtime.json");
    const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, ECHO_LOG_PATH: logPath, ECHO_RUNTIME_PATH: runtimePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let runtime: { port?: number; pid?: number } | null = null;
      for (let i = 0; i < 100 && !runtime; i++) {
        await sleep(50);
        try {
          runtime = await Bun.file(runtimePath).json();
        } catch {
          // not written yet — the server only writes it once /health answered
        }
      }
      expect(runtime).not.toBeNull();
      expect(runtime!.port).toBeGreaterThan(0);
      expect(runtime!.pid).toBe(proc.pid);

      const health = await fetch(`http://127.0.0.1:${runtime!.port}/health`);
      expect(health.status).toBe(200);
      await fetch(`http://127.0.0.1:${runtime!.port}/fast`);
      await sleep(150);

      const lines = readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const start = lines.filter((l) => l.event === "start" && l.path === "/fast").at(-1);
      expect(start).toBeDefined();
      expect(lines.some((l) => l.event === "end" && l.id === start!.id && l.status === 200)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20000);
});
