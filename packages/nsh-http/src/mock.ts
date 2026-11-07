/** A mock adapter transport (behavior row 8 of `docs/behavior.md`), for tests and
 * examples. It works alongside NSH's own stubs, not instead of them: the stubs answer
 * the app's `fetch` under `open`, and this answers only the clients given it. */

import type { HttpRequest } from "./middleware";

/** Anything that can sit where the platform fetch sits. */
export type Transport = (request: HttpRequest) => Promise<Response>;

/** One canned answer, shaped like `open`'s stub responses; a function gets the request
 * and computes one (a 401 from the Authorization header, a flaky sequence). */
export type MockRoute =
  | {
      status?: number;
      headers?: Record<string, string>;
      body?: unknown;
      /** The answer waits this long; on a manual clock it takes `clock.runFor`. */
      delay?: number;
      /** The transport fails with this message instead of answering. */
      error?: string;
    }
  | ((request: HttpRequest) => MockRoute | Promise<MockRoute>);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toResponse(route: { status?: number; headers?: Record<string, string>; body?: unknown }): Response {
  const body = route.body;
  if (body === undefined || body === null || typeof body === "string") {
    return new Response(body ?? null, { status: route.status ?? 200, headers: route.headers });
  }
  return new Response(JSON.stringify(body), {
    status: route.status ?? 200,
    headers: { "content-type": "application/json", ...route.headers },
  });
}

/** A transport that answers from `routes`, keyed `"<METHOD> <URL>"` (a bare URL is a
 * GET; `*` matches any text). A request without a route rejects, as an unlisted stub
 * request does, so a test fails loudly instead of silently succeeding. */
export function mockTransport(routes: Record<string, MockRoute>): Transport {
  return async (request: HttpRequest): Promise<Response> => {
    const key = `${request.method} ${request.url}`;
    const entry = Object.keys(routes).find((candidate) => {
      const splitAt = candidate.indexOf(" ");
      const method = splitAt < 0 ? "GET" : candidate.slice(0, splitAt);
      const pattern = splitAt < 0 ? candidate : candidate.slice(splitAt + 1);
      return method === request.method && (pattern === request.url || wildcard(pattern, key));
    });
    if (entry === undefined) {
      throw new TypeError(`no mock route for ${key}`);
    }
    const route = await Promise.resolve(routes[entry](request));
    if (route.error !== undefined) {
      throw new TypeError(route.error);
    }
    if (route.delay) await sleep(route.delay);
    return toResponse(route);
  };
}

/** The stubs' wildcard rule: each `*` stands for any text. */
function wildcard(pattern: string, key: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(key);
}
