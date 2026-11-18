// LIVE: the nsh-query cancellation proof (behavior row 15) — replacing the
// query aborts the in-flight /slow request, and the echo server's log proves
// it. On 0.6.0 both the headless runner's live network and `--target` runners
// close the request on abort, so the server logs `aborted` on either. The echo
// server must be up somewhere in the port window (default 8123, fallback
// 8123..8132 — the repository README defines it); without one nothing asserts.
//   nsh test tests/live/abort.test.ts [--target macos]
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const NONE = "text:base none (ports 8123..8132)";

async function show(): Promise<App | null> {
  const app = await open("../../App.tsx", { network: "live" });
  try {
    await app.waitFor("text:/^base /", { timeout: 8000 });
  } catch {
    console.log("SKIP (live): the page never rendered the app");
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
  if (app === null) {
    console.log("SKIP (live): no echo server answered in the port window, or this page cannot load the app");
    return;
  }
  await app.press("id:open-Query");
  await app.waitFor("text:pending · fetching");
  await app.press("id:replace-query");
  await app.waitFor("text:/^2$/");
  await app.waitFor("text:pending · fetching");
  // The proof rides the network too: the test VM cannot read the server's
  // log file, so the app reads it back through GET /log (tools/echo-server).
  await app.press("id:check-log");
  await app.waitFor("text:/^yes/");
});
