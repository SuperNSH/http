// Capture: opens the Rust demo (the echo and auth legs — the query-cancel leg
// is TS-only, see README) against the live echo server on a real target and
// saves its window to docs/evidence/examples/demo-rs-macos.png via
// app.screenshot. `open("../..")` starts the root `nsh.json` names, in the
// headless runner built with this crate. Only a real target draws the app, so
// run it from the repository root with:
//   nsh test examples/demo-rs/tests/capture/demo.test.ts --target macos
// Headless, the behavior assertions still run; the PNG step skips loudly.
import { open, test } from "nsh/test";

const CANDIDATES = ["http://127.0.0.1:8123", "http://10.0.2.2:8123"];

test("captures the running rust demo", async () => {
  const app = await open("../..", { network: "live" });
  await app.waitFor("text:DEMO-RS-DONE");
  let draws: boolean;
  try {
    await app.screenshot();
    draws = true;
  } catch {
    draws = false;
  }
  if (!draws) {
    console.log(`SKIP (capture): this is the headless runner, which draws nothing — take the picture with:
  nsh test examples/demo-rs/tests/capture/demo.test.ts --target macos`);
    return;
  }
  try {
    await app.screenshot("docs/evidence/examples/demo-rs-macos.png");
    console.log("capture: saved docs/evidence/examples/demo-rs-macos.png");
  } catch (error) {
    throw new Error(`the screenshot could not be written: ${String(error)}`);
  }
});
