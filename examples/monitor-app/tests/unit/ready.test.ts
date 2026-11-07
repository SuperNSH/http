// The ready screen: on start it fires the slow and the fast call through the
// instrumented client, sorts by durationMs with slow on top, filters by host or path,
// and shows per-host aggregates. All on a manual clock over stub routes; the live
// per-target capture lives in tests/capture/ready.capture.ts for the device operator.
import { expect, open, test } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

const STUBS = {
  [`GET ${BASE}/health`]: { body: { ok: true } },
  [`GET ${BASE}/slow?delay=1200`]: { body: { route: "slow" }, delay: 1200 },
  [`GET ${BASE}/fast`]: { body: { route: "fast" } },
};

test("start records slow and fast, slow on top, with per-host aggregates", async () => {
  const app = await open("../../App.tsx", { clock: {}, network: STUBS });
  await app.waitFor("text:Recording calls on http://127.0.0.1:8123");
  await app.clock!.runFor(1500);
  await app.waitFor("text:/slow\\?delay=1200/");

  const texts = app.texts();
  const slow = texts.indexOf("/slow?delay=1200");
  const fast = texts.indexOf("/fast");
  expect(slow).toBeGreaterThan(-1);
  expect(fast).toBeGreaterThan(-1);
  expect(slow).toBeLessThan(fast);
  expect(app.shows("text:1200 ms")).toBe(true);
  expect(app.shows("text:/ttfb /")).toBe(true);
  // The probe, the fast and the slow attempt all landed on one host without errors.
  expect(app.shows("text:/127.0.0.1/")).toBe(true);
  expect(app.shows("text:/3 calls/")).toBe(true);
  expect(app.shows("text:/0% errors/")).toBe(true);
  expect(app.shows("text:/p95 1200 ms/")).toBe(true);
});

test("the filter narrows the calls by host or path", async () => {
  const app = await open("../../App.tsx", { clock: {}, network: STUBS });
  await app.waitFor("text:Recording calls on http://127.0.0.1:8123");
  await app.clock!.runFor(1500);
  await app.waitFor("text:/fast/");

  await app.type("id:filter", "fast");
  expect(app.shows("text:/fast")).toBe(true);
  expect(app.shows("text:/slow\\?delay=1200/")).toBe(false);
  // Aggregates stay whole: they describe the buffer, not the filter.
  expect(app.shows("text:/3 calls/")).toBe(true);
  expect(app.shows("text:No calls match")).toBe(false);

  await app.clear("id:filter");
  await app.type("id:filter", "zzz");
  expect(app.shows("text:No calls match \"zzz\"")).toBe(true);
});

test("when no echo server answers, the screen says so and records the failed probes", async () => {
  const app = await open("../../App.tsx", { clock: {}, network: {} });
  await app.waitFor("text:/No echo server answered/");
  // The none message names README's whole fallback window, not just the pinned port.
  expect(app.shows("text:/none \\(ports 8123\\.\\.8132\\)/")).toBe(true);
  // One failed probe per window port per host, each host with its own aggregate row.
  expect(app.count("id:host-agg")).toBe(2);
  expect(app.shows("text:/10 calls · 100% errors/")).toBe(true);
});
