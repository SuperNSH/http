// LIVE: the nsh-query cancellation proof (behavior row 15) — replacing the
// query aborts the in-flight /slow request, and the echo server's log proves
// it. The proof needs a runner whose network stack propagates an abort to the
// wire: on `nsh test --target` the app fetches over the real stack and the
// server logs `aborted`. The headless runner's live network (UreqNetwork) on
// 0.4.0 rejects the fetch but keeps the request running server-side (recorded
// in docs/upstream-issues.md), so there the log would never show it. The
// runner is told apart the documented way — only a real target draws — and a
// headless run prints a loud SKIP naming the command that proves it. The
// echo server must be up on the pinned port; without it nothing asserts.
//   nsh test examples/demo-ts/tests/live/abort.test.ts --target macos
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const CANDIDATES = ["http://127.0.0.1:8123", "http://10.0.2.2:8123"];

async function show(): Promise<App | null> {
  const app = await open("../../App.tsx", { network: "live" });
  await app.waitFor("text:base probing", { state: "gone" });
  return app.shows(`text:base none (candidates: ${CANDIDATES.join(", ")})`) ? null : app;
}

test("replacing the query aborts the in-flight /slow request, and the server's log proves it", async () => {
  const app = await show();
  const reasons: string[] = [];
  if (app === null) reasons.push(`no echo server answering on ${CANDIDATES.join(", ")}`);
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
  await app!.waitFor("text:log-abort yes");
});
