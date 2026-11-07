// Middleware order (behavior row 6): requests flow first to last, responses back
// last to first, and each middleware's changes reach the ones inside it.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

test("requests flow first to last, responses last to first, and a rewrite reaches the route", async () => {
  const app = await open("../../App.tsx", {
    clock: {},
    network: {
      [`GET ${BASE}/right`]: (request) => ({
        body: { ok: true },
        headers: { "x-seen": request.headers["x-order"] ?? "" },
      }),
    },
  });
  await app.press("id:open-Middleware");
  await app.press("id:middle");
  await app.waitFor("text:rerouted ok true");
  expect(app.shows("text:order 12")).toBe(true);
  expect(app.shows("text:response-order 21")).toBe(true);
  expect(app.requests().length).toBe(1);
  expect(app.requests()[0]?.url).toBe(`${BASE}/right`);
});
