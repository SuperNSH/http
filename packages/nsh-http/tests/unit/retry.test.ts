// Retries (behavior row 5): backoff on the manual clock, deterministic jitter,
// Retry-After in seconds and as an HTTP-date, idempotent-only, POST never, and
// never once a request body stream has started.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";
const EPOCH = 1_700_000_000_000;

type Network = NonNullable<NonNullable<Parameters<typeof open>[1]>["network"]>;

async function show(network: Network): Promise<App> {
  const app = await open("../../App.tsx", { clock: { time: EPOCH }, network });
  await app.press("id:open-Retry");
  return app;
}

test("a flaky get retries on the manual clock until it succeeds", async () => {
  let attempts = 0;
  const app = await show({ [`GET ${BASE}/flaky`]: () => (++attempts < 3 ? { status: 500 } : { body: { ok: true } }) });
  await app.press("id:load-flaky");
  expect(app.requests().length).toBe(1);
  await app.clock!.runFor(999);
  expect(app.requests().length).toBe(1);
  await app.clock!.runFor(1);
  expect(app.requests().length).toBe(2);
  await app.clock!.runFor(1000);
  await app.waitFor("text:flaky ok true");
  expect(app.requests().length).toBe(3);
});

test("a post never retries", async () => {
  const app = await show({ [`POST ${BASE}/flaky`]: { status: 500 } });
  await app.press("id:load-post");
  await app.clock!.runFor(2500);
  await app.waitFor("text:post http-status 500");
  expect(app.requests().length).toBe(1);
});

test("Retry-After in seconds is honored over the backoff", async () => {
  let attempts = 0;
  const app = await show({
    [`GET ${BASE}/retry-after`]: () => (++attempts === 1 ? { status: 503, headers: { "retry-after": "2" } } : { body: { ok: true } }),
  });
  await app.press("id:load-after");
  await app.clock!.runFor(1999);
  expect(app.requests().length).toBe(1);
  await app.clock!.runFor(1);
  await app.waitFor("text:after ok");
  expect(app.requests().length).toBe(2);
});

test("Retry-After as an HTTP-date is honored against the manual clock", async () => {
  let attempts = 0;
  const retryAt = new Date(EPOCH + 2000).toUTCString();
  const app = await show({
    [`GET ${BASE}/retry-after-date`]: () =>
      ++attempts === 1 ? { status: 503, headers: { "retry-after": retryAt } } : { body: { ok: true } },
  });
  await app.press("id:load-after-date");
  await app.clock!.runFor(1999);
  expect(app.requests().length).toBe(1);
  await app.clock!.runFor(1);
  await app.waitFor("text:after-date ok");
  expect(app.requests().length).toBe(2);
});

test("a request whose body is a stream never retries", async () => {
  const app = await show({ [`PUT ${BASE}/flaky`]: { status: 500 } });
  await app.press("id:load-stream");
  await app.clock!.runFor(2500);
  await app.waitFor("text:stream http-status 500");
  expect(app.requests().length).toBe(1);
});

test("jitter follows the injected random, so the retry wait is exact", async () => {
  const app = await show({ [`GET ${BASE}/jitter`]: { status: 500 } });
  await app.press("id:load-jitter");
  await app.clock!.runFor(1499);
  expect(app.requests().length).toBe(1);
  await app.clock!.runFor(1);
  await app.waitFor("text:jitter http-status 500");
  expect(app.requests().length).toBe(2);
});
