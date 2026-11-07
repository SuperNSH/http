// Capture: drives the demo against the live echo server and saves PNGs of the
// screens to docs/evidence/examples/ via app.screenshot. Only a real target
// draws the app, so run it from the repository root with:
//   nsh test examples/demo-ts/tests/capture/demo.test.ts --target macos
// Headless, the behavior assertions still run; each PNG step skips loudly.
import { open, test } from "nsh/test";
import type { App } from "nsh/test";

const CANDIDATES = ["http://127.0.0.1:8123", "http://10.0.2.2:8123"];

async function shot(app: App, path: string): Promise<void> {
  try {
    await app.screenshot(path);
    console.log(`capture: saved ${path}`);
  } catch (error) {
    // Headless draws nothing (the documented signal); anything else — a bad
    // path, a missing directory — is a real failure and must not skip.
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
  await app.waitFor("text:base probing", { state: "gone" });
  if (app.shows(`text:base none (candidates: ${CANDIDATES.join(", ")})`)) {
    console.log(`SKIP (capture): no echo server answering on ${CANDIDATES.join(", ")}`);
    return;
  }
  await app.press("id:open-Echo");
  await app.press("id:load-fast");
  await app.waitFor("text:fast fast");
  await app.press("id:load-slow");
  await app.waitUntil(() => app.shows("text:slow slow 1200"));
  await shot(app, "docs/evidence/examples/demo-ts-echo.png");
  await app.press("id:home");
  await app.press("id:open-Query");
  await app.waitFor("text:query-status loading-empty");
  await app.press("id:replace-query");
  await app.waitFor("text:query-topic 2");
  await shot(app, "docs/evidence/examples/demo-ts-query.png");
  await app.press("id:home");
  await app.press("id:open-Auth");
  await app.press("id:run-refresh");
  await app.waitFor("text:done 3");
  await shot(app, "docs/evidence/examples/demo-ts-auth.png");
});
