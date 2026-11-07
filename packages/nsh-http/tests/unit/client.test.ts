import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

type Network = NonNullable<NonNullable<Parameters<typeof open>[1]>["network"]>;

async function show(name: string, network: Network): Promise<App> {
  const app = await open("../../App.tsx", { clock: {}, network });
  await app.press(`id:open-${name}`);
  return app;
}

test("a typed get joins the base url, substitutes path params and encodes the query", async () => {
  const app = await show("Client", { [`GET ${BASE}/users/7?full=true`]: { body: { name: "Ada" } } });
  expect(app.shows(`text:url ${BASE}/users/7?full=true&tag=a&tag=b`)).toBe(true);
  await app.press("id:load-user");
  await app.waitFor("text:user Ada");
});

test("post, put, patch and delete decode their answers", async () => {
  const app = await show("Client", {
    [`POST ${BASE}/echo`]: (request) => ({ body: { got: (JSON.parse(request.body ?? "{}") as { n: number }).n } }),
    [`PUT ${BASE}/users/7`]: { body: { updated: true } },
    [`PATCH ${BASE}/users/7`]: { body: { patched: true } },
    [`DELETE ${BASE}/users/7`]: { status: 204 },
  });
  await app.press("id:echo");
  await app.waitFor("text:echoed 9");
  await app.press("id:save");
  await app.waitFor("text:saved yes");
  await app.press("id:patch");
  await app.waitFor("text:patched yes");
  await app.press("id:remove");
  await app.waitFor("text:gone yes");
});

test("the client's default headers reach the request, and a call can add its own", async () => {
  const app = await show("Client", {
    [`GET ${BASE}/users/7?full=true`]: (request) => ({
      body: { name: request.headers["x-client"] === "nsh-http" ? "Ada" : "stripped" },
    }),
  });
  await app.press("id:load-user");
  await app.waitFor("text:user Ada");
});
