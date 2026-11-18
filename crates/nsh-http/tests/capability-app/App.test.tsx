// LIVE: this test drives the real echo server (ECHO_PORT, or its
// .runtime.json) through the rust-root capability-app on a real target
// (`nsh test --target macos crates/nsh-http/tests/capability-app`).
//
// The app's nsh.json declares ONLY `127.0.0.1`, so the native host must
// refuse D2 (undeclared host) and D3 (redirect hop to refused.invalid)
// through the client as RefusedByCapability. Not provable on 0.4.0, where a
// rust root was never restricted (docs/upstream-issues.md, issue 1).
import { expect, open, test } from "nsh/test";

test("capability refusal on a real macos target (rust root)", async () => {
  const app = await open(".", { network: "live" });
  await app.waitFor("CAPABILITY-RS-DONE", { timeout: 30000 });
  const texts = app.texts();
  for (const line of texts) console.log(`RESULT ${line}`);

  // D1: the declared host works through the client — the pipeline is live.
  expect(texts.some((t) => t.startsWith("D1 declared:") && t.includes("route=fast"))).toBe(true);
  // D2/D3: the engine's grant check, classified by the client.
  expect(texts.some((t) => t.startsWith("D2 undeclared-host: REFUSED") && t.includes("localhost"))).toBe(true);
  expect(texts.some((t) => t.startsWith("D3 redirect-hop: REFUSED") && t.includes("refused.invalid"))).toBe(true);
}, 60000);
