// Streaming request and response bodies (behavior row 13): download progress from
// Content-Length and from chunk counts, streamed request bodies, mid-stream cancel,
// and a bodyless response. The stub network answers whole bodies (its response shape
// has no chunked form, per .nsh/types/nsh/test.d.ts), so paced chunks come from an
// in-app transport over the platform Response, paced on the manual clock.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

type Network = NonNullable<NonNullable<Parameters<typeof open>[1]>["network"]>;

async function showDownload(network: Network): Promise<App> {
  const app = await open("./streaming.app.tsx", { clock: {}, network });
  await app.press("id:open-Download");
  return app;
}

test("download reports content-length progress through the stub network", async () => {
  const app = await showDownload({
    [`GET ${BASE}/bytes/64`]: { headers: { "content-length": "64" }, body: "x".repeat(64) },
  });
  await app.press("id:dl-stub");
  await app.waitFor("text:dl-status 200 ok");
  expect(app.shows("text:dl-received 64")).toBeTruthy();
  expect(app.shows("text:dl-total 64")).toBeTruthy();
  expect(app.shows("text:dl-done yes")).toBeTruthy();
  expect(app.shows(`text:dl-text ${"x".repeat(64)}`)).toBeTruthy();
});

test("download without content-length counts chunks and reports a null total", async () => {
  const app = await showDownload({});
  await app.press("id:dl-paced");
  await app.clock!.runFor(1);
  await app.waitFor("text:dl-chunks 1");
  expect(app.shows("text:dl-received 10")).toBeTruthy();
  expect(app.shows("text:dl-total null")).toBeTruthy();
  expect(app.shows("text:dl-done no")).toBeTruthy();
  await app.clock!.runFor(1000);
  await app.waitFor("text:dl-chunks 2");
  expect(app.shows("text:dl-received 20")).toBeTruthy();
  await app.clock!.runFor(1000);
  await app.waitFor("text:dl-status 200 ok");
  expect(app.shows("text:dl-chunks 3")).toBeTruthy();
  expect(app.shows("text:dl-received 30")).toBeTruthy();
  expect(app.shows("text:dl-done yes")).toBeTruthy();
});

test("download progress names the content-length total from the first chunk", async () => {
  const app = await showDownload({});
  await app.press("id:dl-total");
  await app.clock!.runFor(1);
  await app.waitFor("text:dl-chunks 1");
  expect(app.shows("text:dl-total 30")).toBeTruthy();
  expect(app.shows("text:dl-received 10")).toBeTruthy();
  await app.clock!.runFor(2000);
  await app.waitFor("text:dl-status 200 ok");
  expect(app.shows("text:dl-received 30")).toBeTruthy();
});

test("a caller cancel mid-body rejects the download as cancelled", async () => {
  const app = await showDownload({});
  await app.press("id:dl-cancel");
  await app.clock!.runFor(10);
  await app.waitFor("text:dl-chunks 1");
  await app.press("id:do-cancel");
  await app.waitFor("text:dl-status cancelled");
  expect(app.shows("text:dl-done no")).toBeTruthy();
});

test("a bodyless response downloads as empty and done", async () => {
  const app = await showDownload({ [`GET ${BASE}/empty`]: { status: 204 } });
  await app.press("id:dl-empty");
  await app.waitFor("text:dl-status 204 ok");
  expect(app.shows("text:dl-received 0")).toBeTruthy();
  expect(app.shows("text:dl-total null")).toBeTruthy();
  expect(app.shows("text:dl-chunks 0")).toBeTruthy();
  expect(app.shows("text:dl-done yes")).toBeTruthy();
});

test("a streamed request body arrives as the chunks the caller gave", async () => {
  const app = await open("./streaming.app.tsx", { clock: {}, network: {} });
  await app.press("id:open-Stream");
  await app.press("id:stream-echo");
  await app.waitFor("text:stream-echoed part1part2");
});

test("a streamed request body round-trips through the stub network", async () => {
  const app = await open("./streaming.app.tsx", {
    clock: {},
    network: {
      [`PUT ${BASE}/streamed`]: (request) => ({ body: { bodySeen: request.body ?? null } }),
    },
  });
  await app.press("id:open-Stream");
  await app.press("id:stream-stub");
  // The stub cannot materialize a streamed body: its request body is null, where a
  // plain string body would arrive as text. Seeing null proves the body went out as a
  // stream, and the decoded answer proves the attempt completed end to end.
  await app.waitFor("text:stream-through seen null");
});
