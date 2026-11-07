// The mock adapter transport (behavior row 8): it answers its client's requests with
// no network at all, and works alongside NSH's own stubs in the same app.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

test("the mock answers statuses, failures, wildcards and delays, while the stubs answer another client", async () => {
  const app = await open("../../App.tsx", {
    clock: {},
    network: { [`GET ${BASE}/users/1`]: { body: { name: "Ada" } } },
  });
  await app.press("id:open-Mock");
  await app.press("id:load-mock");
  await app.waitFor("text:mock true");
  await app.press("id:load-boom");
  await app.waitFor("text:boom http-status 500");
  await app.press("id:load-broken");
  await app.waitFor("text:broken network");
  await app.press("id:load-wild");
  await app.waitFor("text:wild true");
  await app.press("id:load-stub");
  await app.waitFor("text:stub Ada");
  expect(app.requests().length).toBe(1);
  await app.press("id:load-late");
  await app.clock!.runFor(999);
  expect(app.shows("text:late pending")).toBe(true);
  await app.clock!.runFor(1);
  await app.waitFor("text:late true");
});

test("an unmocked request fails loudly instead of silently passing", async () => {
  const app = await open("../../App.tsx", { clock: {}, network: {} });
  await app.press("id:open-Mock");
  await app.press("id:load-ghost");
  await app.waitFor("text:ghost network");
  expect(app.requests().length).toBe(0);
});
