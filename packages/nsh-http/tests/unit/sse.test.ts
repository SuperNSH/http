// SSE with reconnect and Last-Event-ID (behavior row 14): the wire-format parser
// (id/event/data/retry, comments, multi-line data), reconnect backoff on the manual
// clock, Last-Event-ID sent on reconnect, a server retry line overriding the backoff,
// giving up after maxRetries, and cancellation by close() or the caller's signal.
// The stub network answers whole bodies, so the event streams come from a scripted
// in-app transport over the platform Response, paced on the manual clock.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

async function showSse(): Promise<App> {
  const app = await open("./sse.app.tsx", { clock: {}, network: {} });
  await app.press("id:open-Sse");
  return app;
}

test("the parser dispatches id, event, data, multi-line data and retry, skipping comments", async () => {
  const app = await showSse();
  await app.press("id:sse-parse");
  await app.waitFor("text:sse-last 7|note|x\\ny");
  expect(app.shows("text:sse-events 2")).toBeTruthy();
  expect(app.shows("text:sse-retryms 250")).toBeTruthy();
  expect(app.shows("text:sse-handle 7")).toBeTruthy();
});

test("a broken stream reconnects and sends Last-Event-ID of the last seen event", async () => {
  const app = await showSse();
  await app.press("id:sse-reconnect");
  await app.waitFor("text:sse-errors 1");
  await app.clock!.runFor(1000);
  await app.waitFor("text:sse-opens 2");
  expect(app.shows("text:sse-leid 2")).toBeTruthy();
  await app.waitFor("text:sse-last 3|tick|three");
  expect(app.shows("text:sse-firsts 1,2")).toBeTruthy();
  expect(app.shows("text:sse-conns 2")).toBeTruthy();
});

test("a server retry line overrides the reconnect backoff", async () => {
  const app = await showSse();
  await app.press("id:sse-retry");
  await app.waitFor("text:sse-opens 1");
  await app.waitFor("text:sse-retryms 250");
  await app.clock!.runFor(249);
  expect(app.shows("text:sse-opens 1")).toBeTruthy();
  // No waitFor past here: it would advance the manual clock and mask the timing.
  await app.clock!.runFor(1);
  await app.wait(0);
  expect(app.shows("text:sse-opens 2")).toBeTruthy();
  expect(app.shows("text:sse-conns 2")).toBeTruthy();
});

test("close() during the backoff stops any reconnect", async () => {
  const app = await showSse();
  await app.press("id:sse-close");
  await app.waitFor("text:sse-events 1");
  await app.press("id:sse-do-close");
  await app.clock!.runFor(3000);
  expect(app.shows("text:sse-opens 1")).toBeTruthy();
  expect(app.shows("text:sse-conns 1")).toBeTruthy();
  expect(app.shows("text:sse-errors 0")).toBeTruthy();
});

test("the connection gives up with an error after maxRetries failed connections", async () => {
  const app = await showSse();
  await app.press("id:sse-giveup");
  await app.clock!.runFor(500);
  await app.waitFor("text:sse-lasterr gave up after 2 failed connections");
  expect(app.shows("text:sse-conns 2")).toBeTruthy();
  expect(app.shows("text:sse-errors 3")).toBeTruthy();
  expect(app.shows("text:sse-opens 0")).toBeTruthy();
});

test("the caller's signal cancels the stream and nothing reconnects", async () => {
  const app = await showSse();
  await app.press("id:sse-cancel");
  await app.waitFor("text:sse-conns 1");
  await app.press("id:sse-do-cancel");
  await app.clock!.runFor(2000);
  expect(app.shows("text:sse-conns 1")).toBeTruthy();
  expect(app.shows("text:sse-errors 0")).toBeTruthy();
  expect(app.shows("text:sse-opens 1")).toBeTruthy();
});
