// Per-client and per-call timeouts, composed with the caller's cancellation
// (behavior row 4).
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

type Network = NonNullable<NonNullable<Parameters<typeof open>[1]>["network"]>;

async function show(network: Network): Promise<App> {
  const app = await open("../../App.tsx", { clock: {}, network });
  await app.press("id:open-Timeout");
  return app;
}

test("a per-call timeout overrides the client's and cuts the attempt short", async () => {
  const app = await show({ [`GET ${BASE}/slow`]: { body: { ok: true }, delay: 1000 } });
  await app.press("id:start-call");
  await app.clock!.runFor(100);
  expect(app.shows("text:per-call pending")).toBe(true);
  await app.clock!.runFor(150);
  await app.waitFor("text:per-call timeout");
});

test("the client timeout applies when the call brings none", async () => {
  const app = await show({ [`GET ${BASE}/slow`]: { body: { ok: true }, delay: 1000 } });
  await app.press("id:start-client");
  await app.clock!.runFor(300);
  expect(app.shows("text:per-client pending")).toBe(true);
  await app.clock!.runFor(250);
  await app.waitFor("text:per-client timeout");
});

test("the caller's cancel wins over the timeout and reads as cancelled", async () => {
  const app = await show({ [`GET ${BASE}/slow`]: { body: { ok: true }, delay: 1000 } });
  await app.press("id:start-cancel");
  await app.clock!.runFor(50);
  expect(app.shows("text:cancelled pending")).toBe(true);
  await app.press("id:do-cancel");
  await app.waitFor("text:cancelled cancelled");
});
