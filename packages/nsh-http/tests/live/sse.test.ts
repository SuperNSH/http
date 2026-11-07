// LIVE: proves behavior row 14 against the real echo server — events arriving
// incrementally off a real text/event-stream, and a reconnect that replays from
// Last-Event-ID — which NSH's stub network (whole bodies only) cannot express.
// Runs with network: "live". The headless test VM cannot read files and does not
// inherit env, so the port cannot come from tools/echo-server/.runtime.json; the app
// probes /health over the documented pinned candidates and, when nothing answers,
// shows "live-port none (candidates: 8123)". Then this test prints a loud SKIP naming
// the candidates and asserts nothing.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const CANDIDATES = ["http://127.0.0.1:8123"];
const SKIP = `SKIP (live): no echo server on 127.0.0.1:8123 (candidates: ${CANDIDATES.map((c) => c.replace("http://127.0.0.1:", "")).join(", ")})`;

async function showLive(): Promise<App | null> {
  const app = await open("./sse.app.tsx", { network: "live" });
  await app.press("id:open-Live");
  await app.waitFor("text:live-port probing", { state: "gone" });
  return app.shows("text:live-port none (candidates: 8123)") ? null : app;
}

test("a live event stream delivers its events and stops when closed", async () => {
  const app = await showLive();
  if (app === null) {
    console.log(SKIP);
    return;
  }
  await app.press("id:lv-sse");
  await app.waitFor("text:lv-sse-count 5");
  expect(app.shows('text:lv-sse-last 5|tick|{"route":"sse","id":5}')).toBeTruthy();
  // The server closed after 5 events; the reconnect replays from Last-Event-ID 5, so
  // id 5 arrives again and the count climbs past 5. Then close before the loop spins.
  await app.waitFor("text:lv-sse-opens 2");
  await app.waitFor("text:lv-sse-count 6");
  await app.press("id:lv-sse-close");
  await app.wait(1500);
  expect(app.shows("text:lv-sse-count 6")).toBeTruthy();
});

test("a reconnect replays from Last-Event-ID, not from the first event", async () => {
  const app = await showLive();
  if (app === null) {
    console.log(SKIP);
    return;
  }
  await app.press("id:lv-replay");
  // The server sends ids 1,2,3 then closes; the reconnect must start at 3 again —
  // the first id of the second connection is 3, proving Last-Event-ID was sent.
  await app.waitFor("text:lv-replay-firsts 1,3");
  expect(app.shows("text:lv-replay-opens 2")).toBeTruthy();
  await app.press("id:lv-replay-close");
});
