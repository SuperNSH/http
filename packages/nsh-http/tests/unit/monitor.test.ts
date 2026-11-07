// Network monitoring (behavior rows 11-12): ring-buffer capacity, per-host and
// per-path aggregates, redaction by default with opt-out, sampling, the frozen wire
// shape of a recorded attempt, and the standalone instrumented fetch. Aggregate
// fixtures carry fixed durations, so nothing here runs on the real clock; the
// manual-clock end-to-end through the ready screen lives in examples/monitor-app.
import { expect, test } from "nsh/test";
import { createClient } from "../../src/client";
import {
  DEFAULT_CAPACITY,
  instrumentedFetch,
  isSecretName,
  Monitor,
  redactHeaders,
  redactPath,
  redactUrl,
  REDACTED,
  type NetworkEvent,
} from "../../src/monitor";
import { mockTransport } from "../../src/mock";

const BASE = "http://127.0.0.1:8123";

let seq = 0;
function event(overrides: Partial<NetworkEvent> = {}): NetworkEvent {
  seq += 1;
  return {
    id: `${seq}`,
    method: "GET",
    url: `${BASE}/p${seq}`,
    host: "127.0.0.1",
    path: `/p${seq}`,
    status: 200,
    startedAtMs: 1000 + seq,
    durationMs: 10,
    ttfbMs: 5,
    requestBytes: null,
    responseBytes: 2,
    error: null,
    initiator: null,
    ...overrides,
  };
}

test("the ring buffer keeps the newest attempts up to its capacity, and events() hands out a copy", () => {
  const monitor = new Monitor({ capacity: 3 });
  expect(monitor.capacity).toBe(3);
  for (let i = 0; i < 5; i += 1) monitor.record(event({ id: `${i}` }));
  expect(monitor.events().map((e) => e.id)).toEqual(["2", "3", "4"]);

  monitor.events().length = 0;
  expect(monitor.events()).toHaveLength(3);

  expect(new Monitor().capacity).toBe(DEFAULT_CAPACITY);
});

test("aggregates per host and path give count, error rate, p50 and p95", () => {
  const monitor = new Monitor();
  monitor.record(event({ id: "a", host: "a.dev", path: "/slow", durationMs: 100 }));
  monitor.record(event({ id: "b", host: "a.dev", path: "/slow", durationMs: 200 }));
  monitor.record(event({ id: "c", host: "a.dev", path: "/slow", durationMs: 300, status: 500, error: "HTTP 500" }));
  monitor.record(event({ id: "d", host: "a.dev", path: "/fast", durationMs: 400 }));
  monitor.record(event({ id: "e", host: "b.dev", path: "/slow", durationMs: 7, status: null, ttfbMs: null, error: "network failure: refused" }));

  const byHost = monitor.byHost();
  expect(byHost["a.dev"]).toEqual({ count: 4, errorRate: 0.25, p50Ms: 200, p95Ms: 400 });
  expect(byHost["b.dev"]).toEqual({ count: 1, errorRate: 1, p50Ms: 7, p95Ms: 7 });

  const byPath = monitor.byPath();
  expect(byPath["/slow"]).toEqual({ count: 4, errorRate: 0.5, p50Ms: 100, p95Ms: 300 });
  expect(byPath["/fast"]).toEqual({ count: 1, errorRate: 0, p50Ms: 400, p95Ms: 400 });

  expect(new Monitor().byHost()).toEqual({});
  monitor.clear();
  expect(monitor.events()).toEqual([]);
  expect(monitor.byPath()).toEqual({});
});

test("a token in the URL and secrets in headers never appear in a recorded event", async () => {
  const monitor = new Monitor();
  const client = createClient({
    baseUrl: BASE,
    transport: mockTransport({ [`GET ${BASE}/session*`]: { body: { ok: true } } }),
    observe: monitor.record,
  });
  await client.get("/session?token=super-secret-token&keep=1", {
    headers: { authorization: "Bearer sk-header-secret", "x-api-key": "key-123" },
  });

  const recorded = monitor.events();
  expect(recorded).toHaveLength(1);
  const serialized = JSON.stringify(recorded);
  expect(serialized).not.toContain("super-secret-token");
  expect(serialized).not.toContain("sk-header-secret");
  expect(serialized).not.toContain("key-123");
  expect(recorded[0].url).toBe(`${BASE}/session?token=${REDACTED}&keep=1`);
  expect(recorded[0].path).toBe(`/session?token=${REDACTED}&keep=1`);
  // The frozen event records no headers at all; this helper is for logs beside the monitor.
  expect(redactHeaders({ authorization: "Bearer x", cookie: "sid=1", "x-api-key": "k", "content-type": "application/json" })).toEqual({
    authorization: REDACTED,
    cookie: REDACTED,
    "x-api-key": REDACTED,
    "content-type": "application/json",
  });
});

test("redaction covers secret query names on url and path helpers, and redact: false opts out", () => {
  expect(redactUrl(`https://a.dev/x?access_token=t1&ok=1&api-key=t2&sortkey=fine&secret=${encodeURIComponent("p@ss")}`)).toBe(
    `https://a.dev/x?access_token=${REDACTED}&ok=1&api-key=${REDACTED}&sortkey=fine&secret=${REDACTED}`,
  );
  expect(redactUrl("https://a.dev/no-query")).toBe("https://a.dev/no-query");
  expect(redactPath("/p?token=abc#frag")).toBe(`/p?token=${REDACTED}#frag`);
  expect(isSecretName("Authorization")).toBe(true);
  expect(isSecretName("sessionId")).toBe(true);
  expect(isSecretName("monkey")).toBe(false);

  const off = new Monitor({ redact: false });
  off.record(event({ id: "raw", url: `${BASE}/x?token=raw-secret`, path: "/x?token=raw-secret" }));
  expect(JSON.stringify(off.events())).toContain("raw-secret");
});

test("secrets echoed in error and initiator free text never reach the recorded event (criterion 8)", () => {
  const monitor = new Monitor();
  monitor.record(
    event({
      id: "echo",
      url: `${BASE}/x?token=url-secret`,
      path: "/x?token=url-secret",
      status: null,
      ttfbMs: null,
      // A transport error quoting the URL: everything past its first `?` is query-shaped.
      error: "Network request failed: GET http://h/x?token=echo-secret: connection refused",
      initiator: "authorization: Bearer sk-header-echo",
    }),
  );
  monitor.record(event({ id: "echo2", error: `refresh denied: {"set-cookie":"sid=cookie-echo"}` }));

  const serialized = JSON.stringify(monitor.events());
  expect(serialized).not.toContain("url-secret");
  expect(serialized).not.toContain("echo-secret");
  expect(serialized).not.toContain("sk-header-echo");
  expect(serialized).not.toContain("cookie-echo");
  const [first, second] = monitor.events();
  expect(first?.error).toBe(`Network request failed: GET http://h/x?token=${REDACTED}`);
  // The whole header value is the secret, scheme included — the Rust mask_headers.
  expect(first?.initiator).toBe(`authorization: ${REDACTED}`);
  expect(second?.error).toBe(`refresh denied: {"set-cookie":"${REDACTED}"}`);
});

test("path aggregates group by the path without its query, like the Rust path_stats", () => {
  const monitor = new Monitor();
  monitor.record(event({ id: "q1", path: "/slow?delay=1200", durationMs: 100 }));
  monitor.record(event({ id: "q2", path: "/slow", durationMs: 300 }));

  const byPath = monitor.byPath();
  expect(Object.keys(byPath)).toEqual(["/slow"]);
  expect(byPath["/slow"]).toEqual({ count: 2, errorRate: 0, p50Ms: 100, p95Ms: 300 });
});

test("sampleRate keeps a deterministic fraction of attempts", () => {
  const draws = [0.1, 0.9, 0.2, 0.95];
  const monitor = new Monitor({ sampleRate: 0.5, random: () => draws.shift() ?? 1 });
  for (let i = 0; i < 4; i += 1) monitor.record(event({ id: `s${i}` }));
  expect(monitor.events().map((e) => e.id)).toEqual(["s0", "s2"]);

  const none = new Monitor({ sampleRate: 0 });
  none.record(event());
  expect(none.events()).toEqual([]);

  const all = new Monitor();
  all.record(event());
  all.record(event());
  expect(all.events()).toHaveLength(2);
});

test("a recorded attempt keeps the exact frozen wire shape", async () => {
  const monitor = new Monitor();
  const client = createClient({
    baseUrl: BASE,
    transport: mockTransport({ [`GET ${BASE}/ping`]: { body: { pong: true } } }),
    observe: monitor.record,
  });
  await client.get("/ping");

  const keys = ["id", "method", "url", "host", "path", "status", "startedAtMs", "durationMs", "ttfbMs", "requestBytes", "responseBytes", "error", "initiator"];
  expect(Object.keys(monitor.events()[0])).toEqual(keys);
  expect(monitor.events()[0].initiator).toBeNull();
});

test("the instrumented fetch records the frozen event per attempt, honest to the handoff", async () => {
  const events: NetworkEvent[] = [];
  const fetcher = instrumentedFetch({
    onEvent: (e) => events.push(e),
    initiator: "probe",
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-length": "13" } }),
  });
  const response = await fetcher(`${BASE}/health`, { method: "GET" });
  expect(response.status).toBe(200);

  expect(events).toHaveLength(1);
  expect(events[0].status).toBe(200);
  expect(events[0].host).toBe("127.0.0.1");
  expect(events[0].path).toBe("/health");
  expect(events[0].responseBytes).toBe(13);
  expect(events[0].error).toBeNull();
  expect(events[0].initiator).toBe("probe");
  // The body belongs to the caller at the head, so durationMs is the handoff time.
  expect(events[0].durationMs).toBe(events[0].ttfbMs);
  expect(Object.keys(events[0])).toEqual([
    "id",
    "method",
    "url",
    "host",
    "path",
    "status",
    "startedAtMs",
    "durationMs",
    "ttfbMs",
    "requestBytes",
    "responseBytes",
    "error",
    "initiator",
  ]);
});

test("the instrumented fetch records a failed attempt and rethrows, and redacts through a monitor", async () => {
  const monitor = new Monitor();
  const fetcher = instrumentedFetch({
    onEvent: monitor.record,
    initiator: "probe",
    fetch: async () => {
      throw new TypeError("Network request failed: connection refused");
    },
  });
  await expect(fetcher(`${BASE}/health?token=leaky-token`)).rejects.toThrow("connection refused");

  const recorded = monitor.events();
  expect(recorded).toHaveLength(1);
  expect(recorded[0].status).toBeNull();
  expect(recorded[0].ttfbMs).toBeNull();
  expect(recorded[0].error).toContain("connection refused");
  expect(recorded[0].url).not.toContain("leaky-token");
  expect(recorded[0].initiator).toBe("probe");
});
