// Unit: the demo screens driven through NSH's stub network on a manual clock —
// no real network, no real time. The wire-level proofs that stubs cannot
// express (the server's aborted line, real timings) live in tests/live/.
import { describe, expect, open, test } from "nsh/test";
import type { App, StubRequest, StubResponse } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

type Routes = Record<string, StubResponse | ((request: StubRequest) => StubResponse | Promise<StubResponse>)>;

// The echo server's own /token contract: `Bearer refreshed` passes, every
// other bearer is a 401 the client must refresh and replay.
const tokenRoute = (request: StubRequest): StubResponse =>
  request.headers.authorization === "Bearer refreshed"
    ? { status: 200, body: { ok: true } }
    : { status: 401, body: { error: "expired" } };

// The echo server's /slow contract: it echoes the delay it was asked for and
// takes that long (the stub delay, on the test's manual clock).
const slowRoute = (request: StubRequest): StubResponse => {
  const delay = Number(new URL(request.url).searchParams.get("delay") ?? 1000);
  return { body: { route: "slow", delay }, delay };
};

function demoRoutes(extra: Routes = {}): Routes {
  return {
    [`GET ${BASE}/health`]: { body: { ok: true } },
    [`GET ${BASE}/fast`]: { body: { route: "fast" } },
    // The demo's /slow URLs carry their query (?delay=n&topic=n), so the
    // route matches the whole family by glob.
    [`GET ${BASE}/slow*`]: slowRoute,
    [`POST ${BASE}/token`]: tokenRoute,
    ...extra,
  };
}

async function appWith(routes: Routes): Promise<App> {
  const app = await open("../../App.tsx", { clock: {}, network: routes });
  await app.waitFor("text:base http://127.0.0.1:8123");
  return app;
}

describe("base discovery", () => {
  test("when nothing in the port window answers, the screen says so", async () => {
    // No /health route anywhere: every probe fails, and the none line names
    // the window the server side falls through (the strings must match the
    // live tests' skip detection).
    const app = await open("../../App.tsx", { clock: {}, network: {} });
    await app.waitFor("text:base none (ports 8123..8132)");
    await app.waitFor("id:base-wait");
  });

  test("the demo finds a server deeper in the window — the 8123-already-taken case", async () => {
    // The auditor's scenario in miniature: 8123 is held by a foreign server,
    // the echo server fell through to another window port, and nothing else
    // answers. Only a fallback-window port has a /health route, so the app
    // must land on it.
    const app = await open("../../App.tsx", {
      clock: {},
      network: {
        "GET http://127.0.0.1:8123/health": { error: "held by a foreign server" },
        "GET http://127.0.0.1:8125/health": { body: { ok: true } },
      },
    });
    await app.waitFor("text:base http://127.0.0.1:8125");
  });
});

describe("echo screen", () => {
  test("fast and slow calls show their status and timings", async () => {
    const app = await appWith(demoRoutes());
    await app.press("id:open-Echo");
    await app.press("id:load-fast");
    await app.waitFor("text:fast");
    expect(app.texts().some((line) => line.startsWith("fast · status 200 "))).toBe(true);
    await app.press("id:load-slow");
    await app.waitUntil(() => app.shows("text:slow 1200"));
    expect(app.texts().some((line) => line.startsWith("slow · status 200 "))).toBe(true);
  });
});

describe("query screen", () => {
  test("replacing the query drops the in-flight load and starts the new key", async () => {
    const app = await appWith(
      demoRoutes({
        // What the echo server's /log route returns after an abort: the dead
        // request's id has an aborted line and never an end line.
        [`GET ${BASE}/log?tail=50`]: {
          body: {
            lines: [
              { event: "start", id: "lost-one", path: "/slow" },
              { event: "aborted", id: "lost-one", path: "/slow" },
            ],
          },
        },
      }),
    );
    await app.press("id:open-Query");
    await app.waitFor("text:loading-empty");
    await app.press("id:replace-query");
    await app.waitFor("text:/^2$/");
    await app.waitFor("text:loading-empty");
    await app.waitUntil(() => app.shows("text:success"));
    await app.waitFor("text:/^slow$/");
    await app.press("id:check-log");
    await app.waitFor("text:/^yes/");
  });
});

describe("auth screen", () => {
  test("three parallel 401s share one refresh and all three succeed", async () => {
    const app = await appWith(demoRoutes());
    await app.press("id:open-Auth");
    await app.press("id:run-refresh");
    await app.waitFor("text:1 refresh");
    await app.waitFor("text:3 succeeded");
    await app.waitFor("text:0 failed");
    // Three sends plus three replays: the refresh happened once, mid-flight.
    const tokenCalls = app.requests().filter((request) => request.url === `${BASE}/token`);
    expect(tokenCalls.map((request) => request.url)).toEqual(
      Array.from({ length: 6 }, () => `${BASE}/token`),
    );
  });
});
