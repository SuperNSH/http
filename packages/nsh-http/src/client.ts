/** The HTTP client (behavior rows 1-2, 4-7, 10 of `docs/behavior.md`): typed request
 * methods over the platform fetch per `docs/decision.md`, timeouts composed with the
 * caller's cancellation, retries, middleware, single-flight token refresh, and one
 * frozen `NetworkEvent` per attempt. Redaction of recorded URLs and headers happens
 * one layer up, in the monitor. */

import type { TokenProvider } from "./auth";
import { errorFromRejection, HttpError } from "./errors";
import type { Transport } from "./mock";
import { composeMiddleware, type HttpRequest, type Middleware } from "./middleware";
import type { Observer } from "./monitor";
import { retryAfterMs, retryDelayMs, type RetryPolicy } from "./retry";

const textEncoder = new TextEncoder();
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"]);
// Event ids are one monotonic counter per process, shared by every client of this
// module: unique for the app's lifetime, never scoped or reset per client.
let nextEventId = 1;

export interface ClientOptions {
  /** Every request joins this; a request whose path is already an absolute URL ignores it. A mock-only client needs none. */
  baseUrl?: string;
  /** Sent with every request; a call's headers win per name. */
  headers?: Record<string, string>;
  /** The attempt timeout for calls that bring no `timeoutMs` of their own. None by default. */
  timeoutMs?: number;
  /** Nothing retries unless given a policy, and then only idempotent methods, and never once a request body stream has started. */
  retry?: RetryPolicy;
  /** Wraps the transport, first entry outermost. */
  middleware?: Middleware[];
  /** Attaches `Authorization: Bearer ..` and refreshes once on a 401. */
  tokenProvider?: TokenProvider;
  /** Called with the frozen `NetworkEvent` once per attempt, after it ends. Event `id`s
   * come from one monotonic counter per process — unique for the app's lifetime across
   * every client, not per client (`nsh-firebase` keys on it). `durationMs` runs to the
   * end of the decoded body, except on `send`, where the body is handed to the caller
   * as a stream and the event is measured to that handoff. */
  observe?: Observer;
  /** Replaces the platform fetch for this client's requests (see `mockTransport`); the app's fetch itself keeps hitting NSH's stubs. */
  transport?: Transport;
}

/** One query value; `null` and `undefined` drop the pair, an array repeats the key. */
export type QueryParamValue = string | number | boolean | null | undefined | (string | number | boolean)[];

export type QueryParams = Record<string, QueryParamValue>;

export interface RequestOptions {
  query?: QueryParams;
  /** Substituted into `{name}` holes in the path, URL-encoded. */
  path?: Record<string, string | number>;
  headers?: Record<string, string>;
  /** Overrides the client's timeout for this call; `null` or 0: no timeout. */
  timeoutMs?: number | null;
  /** The caller's cancellation, composed with the timeout. */
  signal?: AbortSignal;
  /** Sent as the body; ignored when `json` is set. */
  body?: BodyInit | null;
  /** Encoded as JSON with a `content-type: application/json`. */
  json?: unknown;
  /** Overrides the client's retry policy for this call (`noRetries`: none). */
  retry?: RetryPolicy;
}

export interface SendOptions {
  signal?: AbortSignal;
  /** `null` or 0: no timeout. */
  timeoutMs?: number | null;
  retry?: RetryPolicy;
}

export class HttpClient {
  readonly baseUrl: string;

  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number | undefined;
  private readonly retry: RetryPolicy | undefined;
  private readonly tokenProvider: TokenProvider | undefined;
  private readonly observe: Observer | undefined;
  private readonly composed: (request: HttpRequest) => Promise<Response>;
  /** The single-flight refresh: null once it settles, so a later 401 refreshes again. */
  private refreshing: Promise<string | null> | null = null;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl ?? "";
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs;
    this.retry = options.retry;
    this.tokenProvider = options.tokenProvider;
    this.observe = options.observe;
    this.composed = composeMiddleware(options.middleware ?? [], options.transport ?? fetchTransport);
  }

  /** Joins `path` to the base URL (an absolute `path` passes through), substitutes
   * `{name}` params and encodes `query`. */
  url(path: string, options?: Pick<RequestOptions, "query" | "path">): string {
    let expanded = path;
    const params = options?.path;
    if (params !== undefined) {
      expanded = expanded.replace(/\{(\w+)\}/g, (_match, name: string) => {
        if (!(name in params)) throw new Error(`missing path parameter {${name}}`);
        return encodeURIComponent(String(params[name]));
      });
    }
    const joined = /^[a-z][a-z0-9+.-]*:\/\//i.test(expanded)
      ? expanded
      : `${this.baseUrl.replace(/\/+$/, "")}/${expanded.replace(/^\/+/, "")}`;
    const query = options?.query === undefined ? "" : encodeQuery(options.query);
    return query === "" ? joined : `${joined}${joined.includes("?") ? "&" : "?"}${query}`;
  }

  /** `GET` with the response decoded as JSON (`undefined` for a 204 or empty body). */
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.decode<T>(this.request("GET", path, options), options);
  }

  /** `POST` with the response decoded as JSON. Never retried: the default only promises idempotent retries, and a POST is not one. */
  post<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.decode<T>(this.request("POST", path, options), options);
  }

  /** `PUT` with the response decoded as JSON. */
  put<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.decode<T>(this.request("PUT", path, options), options);
  }

  /** `PATCH` with the response decoded as JSON; not retried, as an unsafe method. */
  patch<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.decode<T>(this.request("PATCH", path, options), options);
  }

  /** `DELETE` with the response decoded as JSON. */
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.decode<T>(this.request("DELETE", path, options), options);
  }

  /** The request itself, the platform `Response` handed over as it arrived — for
   * conditional requests, streams and anything the typed methods do not cover. Its
   * event's `durationMs` is measured to the handoff when the body is handed to the
   * caller as a stream — end of body is never observable there — and `ttfbMs` equals
   * it. */
  send(
    request: { method: string; url: string; headers?: Record<string, string>; body?: BodyInit | null },
    options: SendOptions = {},
  ): Promise<Response> {
    return this.execute(
      { method: request.method, url: request.url, headers: request.headers ?? {}, body: request.body ?? null },
      options,
      true,
    ).then(({ response }) => response);
  }

  private request(method: string, path: string, options: RequestOptions = {}): HttpRequest {
    let body = options.body ?? null;
    const headers: Record<string, string> = {};
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["content-type"] = "application/json";
    }
    return {
      method,
      url: this.url(path, options),
      headers: { ...headers, ...options.headers },
      body,
    };
  }

  private decode<T>(request: HttpRequest, options: RequestOptions = {}): Promise<T> {
    return this.execute(request, options, false).then(({ response, value }) => {
      if (response.status === 204) return undefined as T;
      return value as T;
    });
  }

  /** One logical call: attempts under the retry policy, a 401 refresh replayed once,
   * every attempt observed. `stream`: hand the response over unread (its event ends
   * at the head); otherwise read the body so `durationMs` ends at the end of it. */
  private async execute(
    request: HttpRequest,
    call: SendOptions,
    stream: boolean,
  ): Promise<{ response: Response; text: string | null; value: unknown }> {
    const policy = call.retry ?? this.retry;
    const replayable = !(request.body instanceof ReadableStream);
    const canRetry = policy !== undefined && policy.maxRetries > 0 && replayable && IDEMPOTENT.has(request.method);
    const timeout = call.timeoutMs === undefined ? this.timeoutMs : call.timeoutMs;
    let attempt = 0;
    let refreshed = false;
    for (;;) {
      const headers: Record<string, string> = { ...this.headers, ...request.headers };
      if (this.tokenProvider !== undefined && headers.authorization === undefined) {
        const token = await this.tokenProvider.token();
        if (token !== null) headers.authorization = `Bearer ${token}`;
      }
      const attemptRequest: HttpRequest = { ...request, headers, signal: composeSignal(call.signal, timeout) };
      const started = performance.now();
      const startedAtMs = Date.now();
      const requestBytes = requestBytesOf(request.body);
      let response: Response;
      try {
        response = await this.composed(attemptRequest);
      } catch (cause) {
        const error = this.classify(cause, call.signal);
        this.emit(attemptRequest, startedAtMs, requestBytes, {
          status: null,
          ttfbMs: null,
          durationMs: Math.round(performance.now() - started),
          responseBytes: null,
          error: error.message,
        });
        if (canRetry && attempt < policy.maxRetries && error.kind === "network") {
          await sleep(retryDelayMs(policy, attempt));
          attempt += 1;
          continue;
        }
        throw error;
      }
      const ttfbMs = Math.round(performance.now() - started);
      if (response.status === 401 && this.tokenProvider !== undefined && !refreshed && replayable) {
        // Concurrent 401s share the refresh promise; the replay is a fresh attempt.
        refreshed = true;
        await this.refreshToken();
        await response.text();
        continue;
      }
      const retrying = canRetry && attempt < policy.maxRetries && (response.status === 429 || response.status >= 500);
      const wait = retrying
        ? Math.max(retryDelayMs(policy, attempt), retryAfterMs(response.headers.get("retry-after"), Date.now()) ?? 0)
        : 0;
      if (stream) {
        // The body belongs to the caller now, so the event's durationMs is measured to
        // the handoff (ttfbMs) — end of body is never observable on a handed-off stream.
        this.emit(attemptRequest, startedAtMs, requestBytes, {
          status: response.status,
          ttfbMs,
          durationMs: ttfbMs,
          responseBytes: contentLength(response),
          error: response.ok ? null : `HTTP ${response.status}`,
        });
        if (retrying) {
          await response.text();
          if (wait > 0) await sleep(wait);
          attempt += 1;
          continue;
        }
        return { response, text: null, value: undefined };
      }
      const text = await response.text();
      const durationMs = Math.round(performance.now() - started);
      let value: unknown = undefined;
      let errorMessage: string | null = null;
      if (response.ok) {
        try {
          value = text === "" ? undefined : JSON.parse(text);
        } catch {
          errorMessage = `decode failure: ${text.slice(0, 120)}`;
        }
      } else {
        errorMessage = `HTTP ${response.status}`;
      }
      this.emit(attemptRequest, startedAtMs, requestBytes, {
        status: response.status,
        ttfbMs,
        durationMs,
        responseBytes: contentLength(response) ?? byteLengthOf(text),
        error: errorMessage,
      });
      if (retrying) {
        if (wait > 0) await sleep(wait);
        attempt += 1;
        continue;
      }
      if (errorMessage !== null) {
        throw response.ok
          ? new HttpError("decode", errorMessage)
          : new HttpError("http-status", errorMessage, { status: response.status, body: parseMaybeJson(text) });
      }
      return { response, text, value };
    }
  }

  /** The caller's own abort is a cancel even when it races the timeout; a
   * `TimeoutError` reaching here is the client's own composed signal. */
  private classify(cause: unknown, caller: AbortSignal | undefined): HttpError {
    const message = (cause as { message?: string } | null | undefined)?.message ?? String(cause);
    if (caller?.aborted) return new HttpError("cancelled", `cancelled: ${message}`);
    if ((cause as { name?: string } | null | undefined)?.name === "TimeoutError") {
      return new HttpError("timeout", `timed out: ${message}`);
    }
    return errorFromRejection(cause);
  }

  private refreshToken(): Promise<string | null> {
    this.refreshing ??= Promise.resolve(this.tokenProvider!.refresh()).then((token) => {
      this.refreshing = null;
      return token;
    }, (cause) => {
      this.refreshing = null;
      throw cause;
    });
    return this.refreshing;
  }

  private emit(
    request: HttpRequest,
    startedAtMs: number,
    requestBytes: number | null,
    values: { status: number | null; ttfbMs: number | null; durationMs: number; responseBytes: number | null; error: string | null },
  ): void {
    if (this.observe === undefined) return;
    let host = "";
    let path = request.url;
    try {
      const url = new URL(request.url);
      host = url.hostname;
      path = `${url.pathname}${url.search}`;
    } catch {
      // Keep the whole URL as the path; a malformed URL is the caller's to see.
    }
    this.observe({
      id: `${nextEventId}`,
      method: request.method,
      url: request.url,
      host,
      path,
      status: values.status,
      startedAtMs,
      durationMs: values.durationMs,
      ttfbMs: values.ttfbMs,
      requestBytes,
      responseBytes: values.responseBytes,
      error: values.error,
      initiator: null,
    });
    nextEventId += 1;
  }
}

/** The default transport: the platform fetch, with `duplex: "half"` so a streamed
 * request body is sent as it is read. */
const fetchTransport: Transport = (request) => {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    body: request.body ?? null,
    signal: request.signal,
  };
  if (request.body instanceof ReadableStream) init.duplex = "half";
  return fetch(request.url, init);
};

/** Builds a client; the one constructor apps use. */
export function createClient(options: ClientOptions): HttpClient {
  return new HttpClient(options);
}

/** The caller's signal and the attempt timeout, composed into one signal. */
function composeSignal(caller: AbortSignal | undefined, timeoutMs: number | undefined | null): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (caller !== undefined) signals.push(caller);
  if (timeoutMs !== undefined && timeoutMs !== null && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  return signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function encodeQuery(query: QueryParams): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    }
  }
  return pairs.join("&");
}

function requestBytesOf(body: BodyInit | null | undefined): number | null {
  if (typeof body === "string") return byteLengthOf(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  // FormData, blobs and streams are the streaming-and-uploads area's honest limits.
  return null;
}

function byteLengthOf(text: string): number {
  return textEncoder.encode(text).length;
}

function contentLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header === null) return null;
  const bytes = Number(header);
  return Number.isInteger(bytes) && bytes >= 0 ? bytes : null;
}

function parseMaybeJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
