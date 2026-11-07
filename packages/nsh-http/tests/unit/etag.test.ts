// ETag helpers feeding nsh-query (behavior row 9): the second load sends
// If-None-Match, a 304 answers from the cache untouched, and Cache-Control parses.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

test("a revalidation sends If-None-Match and a 304 keeps the cached value", async () => {
  const app = await open("../../App.tsx", {
    clock: {},
    network: {
      [`GET ${BASE}/items/todo`]: (request) =>
        request.headers["if-none-match"] === '"a"'
          ? { status: 304 }
          : { body: { v: 1 }, headers: { etag: '"a"' } },
    },
  });
  await app.press("id:open-Etag");
  await app.press("id:load-etag");
  await app.waitFor("text:etag 1");
  expect(app.requests()[0]?.headers["if-none-match"]).toBeUndefined();
  await app.press("id:reload-etag");
  await app.clock!.runFor(0);
  await app.waitFor("text:etag 1");
  expect(app.requests().length).toBe(2);
  expect(app.requests()[1]?.headers["if-none-match"]).toBe('"a"');
});

test("Cache-Control directives parse", async () => {
  const app = await open("../../App.tsx", { clock: {}, network: {} });
  await app.press("id:open-Etag");
  expect(app.shows("text:cc 60000 true")).toBe(true);
});
