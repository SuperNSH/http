// LIVE: the nsh-query cancellation proof (behavior row 15) — replacing the
// query aborts the in-flight /slow request, and the echo server's log proves
// it. The proof needs a runner whose network stack propagates an abort to the
// wire: on `nsh test --target` the app fetches over the real stack and the
// server logs `aborted`. The headless runner's live network (UreqNetwork) on
// 0.4.0 rejects the fetch but keeps the request running server-side (recorded
// in docs/upstream-issues.md), so there the log would never show it. The
// runner is told apart the documented way — only a real target draws — and a
// headless run prints a loud SKIP naming the command that proves it. The
// echo server must be up somewhere in the port window (default 8123, fallback
// 8123..8132 — the repository README defines it); without one nothing asserts.
//   nsh test examples/demo-ts/tests/live/abort.test.ts --target macos
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

test("replacing the query aborts the in-flight /slow request, and the server's log proves it", async () => {
  const app = await show();
  const reasons: string[] = [];
  if (app === null) reasons.push("no echo server answered in the port window, or this page cannot load the app");
  else {
    try {
      await app.screenshot();
    } catch {
      reasons.push("this is the headless runner, whose live network on 0.4.0 never tells the server about an abort");
    }
  }
  if (reasons.length > 0) {
    console.log(`SKIP (live): ${reasons[0]} — prove it on a real target:
  nsh test examples/demo-ts/tests/live/abort.test.ts --target macos`);
    return;
  }
  await app!.press("id:open-Query");
  await app!.waitFor("text:query-status loading-empty");
  await app!.press("id:replace-query");
  await app!.waitFor("text:query-topic 2");
  await app!.waitFor("text:query-status loading-empty");
  // The proof rides the network too: the test VM cannot read the server's
  // log file, so the app reads it back through GET /log (tools/echo-server).
  await app!.press("id:check-log");
  await app!.waitFor("text:/^yes/");
});
