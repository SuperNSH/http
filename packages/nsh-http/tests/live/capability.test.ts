// LIVE: proves behavior row 16 against the real echo server, which NSH's stubs cannot
// express — a request outside capabilities.network must surface through the client as
// refused, directly and on a redirect hop. The headless runtime has no native
// filesystem, so the port cannot be read from tools/echo-server/.runtime.json; the
// app's Live screen probes the documented pinned default (8123) live and shows
// "live-port none (candidates: 8123)" when nothing answers. Then this test prints a
// loud SKIP naming the candidates and asserts nothing.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const PORTS = [8123];

async function show(): Promise<App | null> {
  const app = await open("../../App.tsx", { network: "live" });
  await app.press("id:open-Live");
  await app.waitFor("text:live-port probing", { state: "gone" });
  return app.shows(`text:live-port none (candidates: ${PORTS.join(", ")})`) ? null : app;
}

test("a request outside capabilities.network is refused through the client, directly and on a redirect hop", async () => {
  const app = await show();
  if (app === null) {
    console.log(`SKIP (live): no echo server on 127.0.0.1:${PORTS[0]} (candidates: ${PORTS.join(", ")})`);
    return;
  }
  await app.press("id:live-fast");
  await app.waitFor("text:live-ok fast");
  await app.press("id:refuse-direct");
  await app.waitFor("text:live-direct refused");
  await app.press("id:refuse-hop");
  await app.waitFor("text:live-hop refused");
});
