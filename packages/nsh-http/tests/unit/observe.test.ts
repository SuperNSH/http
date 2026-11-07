// Observer emit points (behavior row 10): one frozen NetworkEvent per attempt —
// including each retry attempt — with honest timings, host and path.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

test("each attempt emits one event with its method, url, host, path, status and timings", async () => {
  let oflaky = 0;
  const app = await open("../../App.tsx", {
    clock: {},
    network: {
      [`GET ${BASE}/ping`]: { body: { pong: true } },
      [`GET ${BASE}/gone`]: { status: 404 },
      [`GET ${BASE}/offline`]: { error: "connection reset by stub" },
      [`GET ${BASE}/oflaky`]: () => (++oflaky === 1 ? { status: 500 } : { body: { ok: true } }),
    },
  });
  await app.press("id:open-Observe");
  await app.press("id:observe-ping");
  await app.waitFor("text:events 1");
  expect(app.shows("text:last-status 200")).toBe(true);
  expect(app.shows("text:last-error none")).toBe(true);
  expect(app.shows("text:last-ttfb set")).toBe(true);
  expect(app.shows("text:last-host 127.0.0.1")).toBe(true);
  expect(app.shows("text:last-path /ping")).toBe(true);

  await app.press("id:observe-gone");
  await app.waitFor("text:events 2");
  expect(app.shows("text:last-status 404")).toBe(true);
  expect(app.shows("text:last-error HTTP 404")).toBe(true);
  expect(app.shows("text:last-ttfb set")).toBe(true);

  await app.press("id:observe-offline");
  await app.waitFor("text:events 3");
  expect(app.shows("text:last-status null")).toBe(true);
  expect(app.shows("text:last-ttfb null")).toBe(true);
  // The event carries the runtime's message through, classified as a network failure.
  expect(app.shows("text:last-error network failure: Network request failed: connection reset by stub")).toBe(true);

  await app.press("id:observe-flaky");
  await app.clock!.runFor(100);
  await app.waitFor("text:events 5");
  expect(app.shows("text:last-status 200")).toBe(true);
  expect(app.shows("text:last-error none")).toBe(true);
});
