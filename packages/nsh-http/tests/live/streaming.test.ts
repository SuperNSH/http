// LIVE: proves behavior row 13 against the real echo server — a chunked stream
// consumed incrementally, download progress with a real Content-Length, a multipart
// echo round-trip through the runtime's FormData encoding, and a streamed request body
// over the platform's duplex fetch — none of which NSH's stub network can express.
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
  const app = await open("./streaming.app.tsx", { network: "live" });
  await app.press("id:open-Live");
  await app.waitFor("text:live-port probing", { state: "gone" });
  return app.shows("text:live-port none (candidates: 8123)") ? null : app;
}

test("a chunked stream is consumed to the last line with progress along the way", async () => {
  const app = await showLive();
  if (app === null) {
    console.log(SKIP);
    return;
  }
  await app.press("id:lv-stream");
  await app.waitFor("text:stream-lines 4");
  expect(app.shows("text:stream-last 4")).toBeTruthy();
  // Four 39-char JSON lines with newlines make exactly 160 bytes; the chunk count is
  // the network's to choose, so it matches by shape, and the response names no total.
  expect(app.shows("text:/stream-progress 160 null \\d+ done/")).toBeTruthy();
});

test("download progress reports the content-length total on a real byte route", async () => {
  const app = await showLive();
  if (app === null) {
    console.log(SKIP);
    return;
  }
  await app.press("id:lv-bytes");
  await app.waitFor("text:bytes-progress 2048/2048 done");
});

test("a multipart upload round-trips through the echo server's parser", async () => {
  const app = await showLive();
  if (app === null) {
    console.log(SKIP);
    return;
  }
  await app.press("id:lv-multi");
  await app.waitFor("text:lv-multi-out milk=ok cat.png:png-bytes");
});

test("a streamed request body echoes whole over the duplex fetch", async () => {
  const app = await showLive();
  if (app === null) {
    console.log(SKIP);
    return;
  }
  await app.press("id:lv-sup");
  await app.waitFor("text:lv-sup-out part1part2");
});
