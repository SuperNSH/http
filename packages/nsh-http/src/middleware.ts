/** Middleware (behavior row 6 of `docs/behavior.md`): each one wraps the transport, so
 * it sees every attempt, including retries. Requests flow first to last; responses flow
 * back last to first, an onion. */

/** One request, ready for the transport. Middleware may rewrite any field. */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: BodyInit | null;
  /** The caller's signal and the client's timeout, composed; aborts end the attempt. */
  signal?: AbortSignal;
}

/** A middleware: handle the request itself, pass it to `next`, and change or replace what comes back. */
export type Middleware = (
  request: HttpRequest,
  next: (request: HttpRequest) => Promise<Response>,
) => Promise<Response>;

/** Composes middlewares around `endpoint` (the platform fetch or a mock transport):
 * the first middleware wraps the rest. */
export function composeMiddleware(
  middlewares: Middleware[],
  endpoint: (request: HttpRequest) => Promise<Response>,
): (request: HttpRequest) => Promise<Response> {
  return middlewares.reduceRight<(request: HttpRequest) => Promise<Response>>(
    (next, middleware) => (request) => middleware(request, next),
    endpoint,
  );
}
