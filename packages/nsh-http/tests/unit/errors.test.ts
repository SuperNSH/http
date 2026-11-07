// The six failure kinds (behavior row 3): each surfaces through the client with its own
// `kind`, refused-by-capability apart from plain network failure.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

type Network = NonNullable<NonNullable<Parameters<typeof open>[1]>["network"]>;

async function show(name: string, network: Network): Promise<App> {
  const app = await open("../../App.tsx", { clock: {}, network });
  await app.press(`id:open-${name}`);
  return app;
}

test("a network failure, an http status with its decoded body, and a decode failure each get their own kind", async () => {
  const app = await show("Errors", {
    [`GET ${BASE}/offline`]: { error: "connection reset by stub" },
    [`GET ${BASE}/missing`]: { status: 404, body: { message: "gone" } },
    [`GET ${BASE}/badjson`]: { status: 200, headers: { "content-type": "text/plain" }, body: "not json" },
  });
  await app.press("id:offline");
  await app.waitFor("text:network network");
  await app.press("id:missing");
  await app.waitFor("text:status http-status 404 gone");
  await app.press("id:badjson");
  await app.waitFor("text:decode decode");
});

test("a timeout and a caller's cancel are kinds of their own", async () => {
  const app = await show("Timeout", { [`GET ${BASE}/slow`]: { body: { ok: true }, delay: 1000 } });
  await app.press("id:start-call");
  await app.clock!.runFor(250);
  await app.waitFor("text:per-call timeout");
  await app.press("id:start-cancel");
  await app.clock!.runFor(50);
  await app.press("id:do-cancel");
  await app.waitFor("text:cancelled cancelled");
});

test("a host the app's capabilities do not declare is refused through the client", async () => {
  // The stub route exists, but example.com is not in nsh.json's network hosts: the
  // capability gate must answer before any stub does.
  const app = await show("Errors", { [`GET https://example.com/refused`]: { body: { ok: true } } });
  await app.press("id:refuse");
  await app.waitFor("text:refused refused");
});
