// The auth seam (behavior row 7): ten parallel requests with an expired token cause
// exactly one refresh, and all ten replay and succeed.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

test("ten parallel 401s share one refresh and all replay with the fresh token", async () => {
  const app = await open("../../App.tsx", {
    clock: {},
    network: {
      [`GET ${BASE}/private`]: (request) =>
        request.headers.authorization === "Bearer new" ? { body: { ok: true } } : { status: 401 },
    },
  });
  await app.press("id:open-Auth");
  await app.press("id:parallel");
  await app.waitFor("text:done 10");
  expect(app.shows("text:refreshes 1")).toBe(true);
  expect(app.shows("text:errors 0")).toBe(true);
  // Ten refused attempts plus ten replays; the refresh itself is provider-local.
  expect(app.requests().length).toBe(20);
});

test("a fresh token does not refresh", async () => {
  const app = await open("../../App.tsx", {
    clock: {},
    network: {
      [`GET ${BASE}/private`]: () => ({ status: 401 }),
      [`GET ${BASE}/open`]: { body: { ok: true } },
    },
  });
  await app.press("id:open-Auth");
  await app.press("id:open-load");
  await app.waitFor("text:done 1");
  expect(app.shows("text:refreshes 0")).toBe(true);
});
