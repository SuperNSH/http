/** Server-sent events with reconnect and `Last-Event-ID` (behavior row 14 of
 * `docs/behavior.md`): an incremental `text/event-stream` parser, exponential reconnect
 * backoff that a server `retry:` line overrides, `Last-Event-ID` on every reconnect,
 * and cancellation through the caller's `AbortSignal` or `close()`. A non-2xx answer or
 * a body without a `text/event-stream` content type ends the source with an error — the
 * server refusing SSE is not retryable. Each (re)connection is one client attempt, so
 * it emits one `NetworkEvent` measured to the handoff — the body is consumed here,
 * after that event ends. */

import type { HttpClient } from "./client";
import { errorFromRejection, HttpError } from "./errors";
import { noRetries, retryDelayMs, type RetryPolicy } from "./retry";

export interface SseEvent {
  /** The connection's last seen id, which persists across events without one and is
   * what the next reconnect sends as `Last-Event-ID`. */
  id: string | null;
  /** `message` unless an `event:` line said otherwise. */
  event: string;
  /** The event's `data:` lines, joined with `\n`. */
  data: string;
}

/** Reconnect backoff, shaped like the request retry policy; `maxRetries` counts
 * consecutive failed connections — a clean stream end always reconnects, whatever the
 * cap says. Default: reconnect until cancelled, doubling from 1 s, capped at 30 s. */
export type SseReconnect = RetryPolicy;

const defaultReconnect: RetryPolicy = {
  maxRetries: Number.POSITIVE_INFINITY,
  delayMs: 1000,
  exponentialBackoff: true,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

export interface SseOptions {
  headers?: Record<string, string>;
  /** Cancels the connection: the stream stops and nothing reconnects. A cancel fires
   * no error — it is the caller's own decision. */
  signal?: AbortSignal;
  reconnect?: RetryPolicy;
  /** Once per successful connection, reconnects included. */
  onOpen?: (connection: SseConnection) => void;
  /** Per failed connection (bad status, network failure, exhausted retries). */
  onError?: (error: HttpError) => void;
  /** When a `retry:` line changes the reconnection time (it is sticky from then on). */
  onRetry?: (retryMs: number) => void;
}

export interface SseConnection {
  /** The id the next reconnect sends as `Last-Event-ID`. */
  lastEventId(): string | null;
  /** Stops the stream and any pending reconnect; idempotent. */
  close(): void;
}

export function connectEventSource(
  client: HttpClient,
  path: string,
  onEvent: (event: SseEvent) => void,
  options: SseOptions = {},
): SseConnection {
  const url = client.url(path);
  const policy = options.reconnect ?? defaultReconnect;
  let closed = options.signal?.aborted ?? false;
  let lastEventId: string | null = null;
  let retryOverrideMs: number | null = null;
  let attempt = 0;
  const internal = new AbortController();
  const composed =
    options.signal === undefined ? internal.signal : AbortSignal.any([options.signal, internal.signal]);
  options.signal?.addEventListener("abort", () => {
    closed = true;
  }, { once: true });

  // A refused connect still owns a body stream: release it before the loop goes on (or
  // ends), so a failed-status answer does not leak the underlying connection.
  const discardBody = async (response: Response): Promise<void> => {
    try {
      await response.body?.cancel();
    } catch {
      // The body already closed or the connection is gone — nothing to release.
    }
  };

  const consume = async (response: Response): Promise<void> => {
    const reader = response.body?.getReader();
    if (reader === undefined) return;
    const parser = new SseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(value)) onEvent(event);
        lastEventId = parser.lastEventId;
        if (parser.retryMs !== null && parser.retryMs !== retryOverrideMs) {
          retryOverrideMs = parser.retryMs;
          options.onRetry?.(parser.retryMs);
        }
      }
      for (const event of parser.end()) onEvent(event);
    } finally {
      lastEventId = parser.lastEventId;
    }
  };

  const run = async (): Promise<void> => {
    while (!closed) {
      const headers: Record<string, string> = { accept: "text/event-stream", ...options.headers };
      if (lastEventId !== null) headers["last-event-id"] = lastEventId;
      try {
        const response = await client.send({ method: "GET", url, headers }, { signal: composed, timeoutMs: null, retry: noRetries });
        if (closed) return;
        // A non-2xx is the server refusing SSE: it ends the source, as the Rust half's
        // Err(HttpStatus) does — retrying a refused endpoint would loop forever.
        if (!response.ok) {
          await discardBody(response);
          options.onError?.(new HttpError("http-status", `HTTP ${response.status}`, { status: response.status }));
          return;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          await discardBody(response);
          options.onError?.(
            new HttpError("network", `the SSE connect answered ${response.status} without a text/event-stream body`),
          );
          return;
        }
        attempt = 0;
        options.onOpen?.(handle);
        await consume(response);
      } catch (cause) {
        if (closed) return;
        attempt += 1;
        options.onError?.(errorFromRejection(cause));
        // Only failed connections count toward the cap: after a clean stream end the
        // loop reconnects whatever maxRetries says, as the Rust loop does.
        if (attempt >= policy.maxRetries) {
          options.onError?.(new HttpError("network", `gave up after ${attempt} failed connections`));
          return;
        }
      }
      if (closed) return;
      // A server `retry:` line is sticky: it replaces the computed backoff from then on.
      await sleep(retryOverrideMs ?? retryDelayMs(policy, attempt));
      if (closed) return;
    }
  };

  const handle: SseConnection = {
    lastEventId: () => lastEventId,
    close(): void {
      closed = true;
      internal.abort();
    },
  };
  void run();
  return handle;
}

/** Incremental `text/event-stream` parser (the WHATWG wire format): `id:` / `event:` /
 * `data:` / `retry:` fields, `:` comments, multi-line data, CR / LF / CRLF line endings
 * across chunk boundaries, and a BOM before the first event. An event block with no
 * `data:` lines dispatches nothing. */
class SseParser {
  lastEventId: string | null = null;
  retryMs: number | null = null;
  private buffer = "";
  private data = "";
  private eventType = "message";
  private decoder = new TextDecoder();
  private started = false;

  push(chunk: Uint8Array): SseEvent[] {
    let text = this.decoder.decode(chunk, { stream: true });
    if (!this.started) {
      this.started = true;
      if (text.startsWith("\uFEFF")) text = text.slice(1);
    }
    this.buffer += text;
    const events: SseEvent[] = [];
    for (const line of this.takeLines(false)) {
      const event = this.line(line);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /** Flushes at end of stream; the final line is processed even without its newline,
   * but an event block that never saw its blank line is discarded, per the format. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events: SseEvent[] = [];
    for (const line of this.takeLines(true)) {
      const event = this.line(line);
      if (event !== null) events.push(event);
    }
    this.data = "";
    this.eventType = "message";
    return events;
  }

  private takeLines(final: boolean): string[] {
    const lines: string[] = [];
    for (;;) {
      const lf = this.buffer.indexOf("\n");
      const cr = this.buffer.indexOf("\r");
      if (lf < 0 && cr < 0) break;
      let index: number;
      let skip: number;
      if (lf >= 0 && (cr < 0 || lf < cr)) {
        index = lf;
        skip = 1;
      } else if (cr === this.buffer.length - 1 && !final) {
        break; // a lone trailing CR may be the first half of a CRLF in the next chunk
      } else {
        index = cr;
        skip = this.buffer.charCodeAt(cr + 1) === 10 ? 2 : 1;
      }
      lines.push(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + skip);
    }
    if (final && this.buffer !== "") {
      lines.push(this.buffer);
      this.buffer = "";
    }
    return lines;
  }

  private line(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.data += `${value}\n`;
        return null;
      case "event":
        this.eventType = value;
        return null;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        return null;
      case "retry": {
        // The Rust half parses u64: non-digits and values past u64::MAX are ignored,
        // not clamped — a 200-digit retry must never become a reconnection time.
        const ms = Number(value);
        if (/^\d+$/.test(value) && Number.isFinite(ms) && ms <= U64_MAX_MS) this.retryMs = ms;
        return null;
      }
      default:
        return null;
    }
  }

  private dispatch(): SseEvent | null {
    if (this.data === "") {
      this.eventType = "message";
      return null;
    }
    const event: SseEvent = {
      id: this.lastEventId,
      event: this.eventType === "" ? "message" : this.eventType,
      data: this.data.slice(0, -1),
    };
    this.data = "";
    this.eventType = "message";
    return event;
  }
}

/** The largest millisecond value the Rust half parses for `retry:` (u64::MAX). */
const U64_MAX_MS = 18_446_744_073_709_551_615;

function sleep(ms: number): Promise<void> {
  // setTimeout coerces delays past 2^31-1 unpredictably (Infinity fires near-instantly),
  // so a legal-but-astronomical retry waits the runtime's own ceiling instead: about
  // 24.8 days, effectively the stop that Rust's u64::MAX ms timer is.
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2_147_483_647)));
}
