// LIVE: these tests run the demo app against the real echo server
// (tools/echo-server, pinned at 127.0.0.1:8123) with network: "live". NSH's
// stubs cannot prove real timings or the refresh flow against a real 401.
// The app probes /health over the documented candidates; when nothing
// answers, the test prints a loud SKIP and asserts nothing. 10.0.2.2 is the
// Android emulator's host loopback. (The wire-level abort proof is
// tests/live/abort.test.ts, which needs a real target.)
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const CANDIDATES = ["http://127.0.0.1:8123", "http://10.0.2.2:8123"];

async function show(): Promise<App | null> {
  const app = await open("../../App.tsx", { network: "live" });
  await app.waitFor("text:base probing", { state: "gone" });
  return app.shows(`text:base none (candidates: ${CANDIDATES.join(", ")})`) ? null : app;
}

test("the demo's fast and slow calls land with real timings", async () => {
  const app = await show();
  if (app === null) {
    console.log(`SKIP (live): no echo server answering on ${CANDIDATES.join(", ")} — start it with
  (cd tools/echo-server && ECHO_PORT=8123 nohup bun run src/server.ts >/tmp/nsh-http-echo.log 2>&1 &)`);
    return;
  }
  await app.press("id:open-Echo");
  await app.press("id:load-fast");
  await app.waitFor("text:fast fast");
  expect(app.texts().some((line) => line.startsWith("fast-info status 200 "))).toBe(true);
  await app.press("id:load-slow");
  await app.waitUntil(() => app.shows("text:slow slow 1200"));
  const info = app.texts().find((line) => line.startsWith("slow-info status 200 "));
  expect(info).toBeDefined();
  const ms = Number(info!.match(/ (\d+)ms /)?.[1]);
  expect(ms).toBeGreaterThanOrEqual(1100);
});

test("three parallel 401s share one refresh and all three succeed", async () => {
  const app = await show();
  if (app === null) {
    console.log(`SKIP (live): no echo server answering on ${CANDIDATES.join(", ")}`);
    return;
  }
  await app.press("id:open-Auth");
  await app.press("id:run-refresh");
  await app.waitFor("text:refreshes 1");
  await app.waitFor("text:done 3");
  await app.waitFor("text:failed 0");
});
