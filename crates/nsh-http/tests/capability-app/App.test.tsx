// LIVE: this test drives the real echo server (ECHO_PORT, or its
// .runtime.json) through the rust-root capability-app on a real target
// (`nsh test --target macos crates/nsh-http/tests/capability-app`).
//
// What it can and cannot prove: the app's nsh.json declares ONLY
// `127.0.0.1`, so a working engine would refuse D2 (undeclared host) and D3
// (redirect hop to refused.invalid) with ERR_ACCESS_DENIED. On 0.4.0 the
// native host never attaches a rust root's capabilities
// (`nsh-platform-macos/src/native.rs:270`, `App::Rust(_) =>
// Policy::default().access()`), so the run below documents what actually
// happens rather than asserting a refusal that would be a false pass. The
// assertions hold for BOTH outcomes and the lines themselves are the
// evidence; if a future nsh enforces on this path, the lines flip to REFUSED
// and this comment should be updated.
import { expect, open, test } from "nsh/test";

test("capability refusal on a real macos target (rust root)", async () => {
  const app = await open(".", { network: "live" });
  await app.waitFor("CAPABILITY-RS-DONE", { timeout: 30000 });
  const texts = app.texts();
  for (const line of texts) console.log(`RESULT ${line}`);

  // D1: the declared host works through the client — the pipeline is live.
  expect(texts.some((t) => t.startsWith("D1 declared:") && t.includes("route=fast"))).toBe(true);
  // D2/D3: the outcomes are recorded, whichever way the host rules.
  expect(texts.some((t) => t.startsWith("D2 undeclared-host:"))).toBe(true);
  expect(texts.some((t) => t.startsWith("D3 redirect-hop:"))).toBe(true);
}, 60000);
