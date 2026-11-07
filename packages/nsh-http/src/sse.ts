/** Server-sent events with reconnect and `Last-Event-ID` (behavior row 14 of
 * `docs/behavior.md`): an incremental `text/event-stream` parser, exponential reconnect
 * backoff that a server `retry:` line overrides, `Last-Event-ID` on every reconnect,
 * and cancellation through the caller's `AbortSignal` or `close()`. Each (re)connection
 * is one client attempt, so it emits one `NetworkEvent` measured to the handoff — the
 * body is consumed here, after that event ends. */

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
 * consecutive failed connections (a clean stream end always reconnects while retries
 * remain). Default: reconnect until cancelled, doubling from 1 s, capped at 30 s. */
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
        if (!response.ok) {
          attempt += 1;
          options.onError?.(new HttpError("http-status", `HTTP ${response.status}`, { status: response.status }));
        } else {
          attempt = 0;
          options.onOpen?.(handle);
          await consume(response);
        }
      } catch (cause) {
        if (closed) return;
        attempt += 1;
        options.onError?.(errorFromRejection(cause));
      }
      if (closed) return;
      if (attempt >= policy.maxRetries) {
        options.onError?.(new HttpError("network", `gave up after ${attempt} failed connections`));
        return;
      }
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
      case "retry":
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        return null;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
