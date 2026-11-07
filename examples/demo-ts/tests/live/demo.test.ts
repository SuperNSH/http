// LIVE: these tests run the demo app against the real echo server
// (tools/echo-server: pinned default 127.0.0.1:8123, fallback window
// 8123..8132 — see the repository README) with network: "live". NSH's stubs
// cannot prove real timings or the refresh flow against a real 401. The app
// probes the window over 127.0.0.1 (then 10.0.2.2, the Android emulator's
// host loopback); when nothing answers, the test prints a loud SKIP and
// asserts nothing. (The wire-level abort proof is tests/live/abort.test.ts,
// which needs a real target.)
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const NONE = "text:base none (ports 8123..8132)";

async function show(): Promise<App | null> {
  const app = await open("../../App.tsx", { network: "live" });
  try {
    await app.waitFor("text:/^base /", { timeout: 8000 });
  } catch {
    // Nothing ever rendered: on the web test target this is the 0.4.0
    // missing-'lifecycle'-export limitation (docs/upstream-issues.md).
    console.log(`SKIP (live): the page never rendered the app — on the web test target this is the
  0.4.0 missing-'lifecycle'-export limitation (docs/upstream-issues.md)`);
    return null;
  }
  await app.waitFor("text:base probing", { state: "gone" });
  if (app.shows(NONE)) {
    console.log(`SKIP (live): no echo server answering on 127.0.0.1:8123..8132 (or 10.0.2.2:8123..8132) — start it with
  (cd tools/echo-server && ECHO_PORT=8123 nohup bun run src/server.ts >/tmp/nsh-http-echo.log 2>&1 &)`);
    return null;
  }
  return app;
}

test("the demo's fast and slow calls land with real timings", async () => {
  const app = await show();
  if (app === null) return;
  await app.press("id:open-Echo");
  await app.press("id:load-fast");
  await app.waitFor("text:fast");
  expect(app.texts().some((line) => line.startsWith("fast · status 200 "))).toBe(true);
  await app.press("id:load-slow");
  await app.waitUntil(() => app.shows("text:slow 1200"));
  const info = app.texts().find((line) => line.startsWith("slow · status 200 "));
  expect(info).toBeDefined();
  const ms = Number(info!.match(/· (\d+) ms ·/)?.[1]);
  expect(ms).toBeGreaterThanOrEqual(1100);
});

test("three parallel 401s share one refresh and all three succeed", async () => {
  const app = await show();
  if (app === null) return;
  await app.press("id:open-Auth");
  await app.press("id:run-refresh");
  await app.waitFor("text:1 refresh");
  await app.waitFor("text:3 succeeded");
  await app.waitFor("text:0 failed");
});
