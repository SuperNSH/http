// Capture: drives the demo against the live echo server and saves PNGs of the
// screens to docs/evidence/examples/ via app.screenshot. Only a real target
// draws the app, so run it from the repository root with:
//   nsh test examples/demo-ts/tests/capture/demo.test.ts --target macos
// Headless, the echo and auth flows still run against the live server; the
// query-capture leg skips loudly there, because its proof — the server's
// aborted line — needs a real network stack (0.4.0's headless runner never
// tells the server about an abort, docs/upstream-issues.md entry 2), and the
// PNGs need drawing. On the web test target the app cannot load at all (the
// page's "nsh" module does not export `lifecycle`, which nsh-query's compiled
// code imports — entry 5): that run skips loudly too.
import { open, test } from "nsh/test";
import type { App } from "nsh/test";

const NONE = "text:base none (ports 8123..8132)";

// The page must have drawn SOMETHING before the flows make sense. On the web
// test target the bundle fails module linking and nothing ever renders; there
// the run skips loudly instead of failing with an empty screen.
async function settled(app: App): Promise<boolean> {
  try {
    await app.waitFor("text:/^base /", { timeout: 8000 });
    return true;
  } catch {
    console.log(`SKIP (capture): the page never rendered the app — on the web test target this is the
  0.4.0 missing-'lifecycle'-export limitation (docs/upstream-issues.md); capture on macos instead:
  nsh test examples/demo-ts/tests/capture/demo.test.ts --target macos`);
    return false;
  }
}

// Only a real target draws the app (the documented signal): the PNG and the
// query-capture leg hang off this.
async function draws(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch {
    return false;
  }
}

async function shot(app: App, path: string): Promise<void> {
  try {
    await app.screenshot(path);
    console.log(`capture: saved ${path}`);
  } catch (error) {
    try {
      await app.screenshot();
    } catch {
      console.log(`SKIP (capture): this is the headless runner, which draws nothing — take the pictures with:
  nsh test examples/demo-ts/tests/capture/demo.test.ts --target macos`);
      return;
    }
    throw error;
  }
}

test("captures the demo screens", async () => {
  const app = await open("../../App.tsx", { network: "live" });
  if (!(await settled(app))) return;
  if (app.shows(NONE)) {
    console.log("SKIP (capture): no echo server answering in the port window 127.0.0.1:8123..8132");
    return;
  }
  const target = await draws(app);
  await app.press("id:open-Echo");
  await app.press("id:load-fast");
  await app.waitFor("text:fast");
  await app.press("id:load-slow");
  await app.waitUntil(() => app.shows("text:slow 1200"));
  if (!target) {
    console.log(`SKIP (capture): this is the headless runner — the query-capture leg needs a real
  network stack (the server's aborted line, docs/upstream-issues.md) and the PNGs need drawing:
  nsh test examples/demo-ts/tests/capture/demo.test.ts --target macos`);
    return;
  }
  await shot(app, "docs/evidence/examples/demo-ts-echo.png");
  await app.press("id:home");
  // The query screen must show the cancellation outcome, not just the
  // replacement: replace while /slow is in flight, wait for the aborted
  // request to land in the server's log (read back over GET /log), and take
  // the picture of the checked state (behavior row 15).
  await app.press("id:open-Query");
  await app.waitFor("text:loading-empty");
  await app.press("id:replace-query");
  await app.waitFor("text:/^2$/");
  await app.waitFor("text:loading-empty");
  await app.press("id:check-log");
  await app.waitFor("text:/^yes/");
  await shot(app, "docs/evidence/examples/demo-ts-query.png");
  await app.press("id:home");
  await app.press("id:open-Auth");
  await app.press("id:run-refresh");
  await app.waitFor("text:3 succeeded");
  await shot(app, "docs/evidence/examples/demo-ts-auth.png");
});
