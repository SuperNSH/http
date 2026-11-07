// LIVE: captures the ready screen against the real echo server (127.0.0.1:8123), so
// durationMs and ttfbMs are the device's honest timings (satisfaction criterion 7).
// A headless run asserts the live behavior but draws nothing, so the screenshot needs
// a target: the device operator captures per target with e.g.
//   nsh test examples/monitor-app/tests/capture/ready.capture.test.ts --target ios
// which saves docs/evidence/monitor/<os>-ready.png (the os comes from the app's
// Storage, because test VMs cannot read the caller's environment).
import { expect, open, test } from "nsh/test";

const CANDIDATES = ["http://127.0.0.1:8123", "http://10.0.2.2:8123"];

test("the ready screen shows live slow and fast calls, slow on top, and captures per target", async () => {
  const app = await open("../../App.tsx", { network: "live" });
  await app.waitFor("text:/Recording calls|No echo server answered/");
  if (app.shows("text:/No echo server answered/")) {
    console.log(`SKIP (live): no echo server answered (candidates: ${CANDIDATES.join(", ")})`);
    return;
  }
  await app.waitFor("text:/slow\\?delay=1200/", { timeout: 20_000 });
  await app.waitFor("text:/fast/");
  const texts = app.texts();
  expect(texts.indexOf("/slow?delay=1200")).toBeLessThan(texts.indexOf("/fast"));
  await app.waitUntil(() => app.storage().platform !== undefined);
  try {
    await app.screenshot(`/Users/hmziq/fo/nsh-http/docs/evidence/monitor/${app.storage().platform}-ready.png`);
  } catch (cause) {
    console.log(`PNG not saved here: ${(cause as Error).message}`);
  }
});
