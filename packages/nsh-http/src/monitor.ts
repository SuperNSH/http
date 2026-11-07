/** Network monitoring (behavior rows 11-12 of `docs/behavior.md`): the ring buffer,
 * per-host and per-path aggregates, redaction and sampling, plus a standalone
 * instrumented fetch. The client reports each attempt through `observe`; the monitor
 * owns everything about how an attempt is *recorded* — the frozen `NetworkEvent`
 * shape itself is fixed here because `nsh-firebase` consumes it. */

/**
 * One finished request attempt. The field names and types are FROZEN: `nsh-firebase`
 * consumes this exact shape, mirroring the Rust struct's camelCase serialization 1:1.
 *
 * `ttfbMs` stays `null` wherever `docs/decision.md` says time-to-first-byte cannot be
 * measured honestly; a number is never invented.
 */
export interface NetworkEvent {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  startedAtMs: number;
  durationMs: number;
  ttfbMs: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
  error: string | null;
  initiator: string | null;
}

/** Callback invoked once per finished attempt, registered through the client's observer seam. */
export type Observer = (event: NetworkEvent) => void;

/** The mask a redacted value leaves behind — the Rust monitor's placeholder. */
export const REDACTED = "[redacted]";

/** How many attempts a monitor keeps when constructed without a capacity. */
export const DEFAULT_CAPACITY = 200;

/** How a monitor records: how much it keeps, whether it redacts, and how it samples. */
export interface MonitorOptions {
  /** The ring buffer size; the oldest attempt falls off first. Default 200. */
  capacity?: number;
  /** Redact secret query parameters from the recorded url and path (headers are never recorded at all). Default true. */
  redact?: boolean;
  /** Fraction of attempts recorded, 0-1; drawn per attempt from `random`. Default: record every attempt. */
  sampleRate?: number;
  /** The source of the sampling draw; a test pins it by returning constants. Default Math.random. */
  random?: () => number;
}

/** Count, error share and duration percentiles for one host or path, over the
 * attempts currently in the ring buffer — the recent window, so eviction and the
 * aggregates stay consistent with what the events list shows. */
export interface Aggregate {
  count: number;
  /** Attempts with an `error` (network failure, HTTP error status, decode failure) over `count`, 0-1. */
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
}

export class Monitor {
  readonly capacity: number;

  private readonly redact: boolean;
  private readonly sampleRate: number | undefined;
  private readonly random: () => number;
  private buffer: NetworkEvent[] = [];

  constructor(options: MonitorOptions = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
    this.redact = options.redact ?? true;
    this.sampleRate = options.sampleRate;
    this.random = options.random ?? Math.random;
  }

  /** The client's observe seam and `instrumentedFetch`'s sink: applies sampling and
   * redaction, then buffers the attempt. Kept as a property so it passes as an
   * `Observer` without binding. */
  readonly record = (event: NetworkEvent): void => {
    if (this.sampleRate !== undefined && !(this.random() < this.sampleRate)) return;
    let kept = event;
    if (this.redact) {
      const freeText = (text: string | null): string | null => (text === null ? null : maskSecretHeaders(maskQuery(text)));
      kept = {
        ...event,
        url: maskSecretHeaders(maskQuery(event.url)),
        path: maskQuery(event.path),
        error: freeText(event.error),
        initiator: freeText(event.initiator),
      };
    }
    this.buffer.push(kept);
    if (this.buffer.length > this.capacity) this.buffer = this.buffer.slice(-this.capacity);
  };

  /** The recorded attempts, oldest first. A copy: callers may sort freely. */
  events(): NetworkEvent[] {
    return [...this.buffer];
  }

  /** Aggregates keyed by URL host. */
  byHost(): Record<string, Aggregate> {
    return aggregateBy(this.buffer, (event) => event.host);
  }

  /** Aggregates keyed by URL path without its query, mirroring the Rust `path_stats`. */
  byPath(): Record<string, Aggregate> {
    return aggregateBy(this.buffer, (event) => event.path.split("?")[0]);
  }

  /** Drops every recorded attempt and its aggregates. */
  clear(): void {
    this.buffer = [];
  }
}

/** Percentiles use the nearest-rank rule over the attempts in the buffer. */
function aggregateBy(events: NetworkEvent[], keyOf: (event: NetworkEvent) => string): Record<string, Aggregate> {
  const groups: Record<string, NetworkEvent[]> = {};
  for (const event of events) (groups[keyOf(event)] ??= []).push(event);
  const result: Record<string, Aggregate> = {};
  for (const [key, group] of Object.entries(groups)) {
    const errors = group.filter((event) => event.error !== null).length;
    const durations = group.map((event) => event.durationMs).sort((a, b) => a - b);
    result[key] = {
      count: group.length,
      errorRate: errors / group.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
    };
  }
  return result;
}

function percentile(sorted: number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

// Query names whose values are secrets, matched normalized: lower-case with `-` and
// `_` dropped, so `access-token` and `ACCESS_TOKEN` hit too. Kept identical to the
// Rust monitor's SECRET_QUERY_KEYS for cross-implementation parity.
const SECRET_QUERY_KEYS = [
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "auth",
  "authorization",
  "apikey",
  "key",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "session",
  "sessionid",
  "jwt",
  "signature",
  "sig",
  "credential",
  "privatekey",
];

// Header names whose values are secrets, matched as lower-case names at name
// boundaries — the Rust monitor's SECRET_HEADER_NAMES list.
const SECRET_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "api-key",
  "x-api-key",
  "auth-token",
  "x-auth-token",
  "access-token",
  "x-access-token",
  "csrf-token",
  "x-csrf-token",
  "refresh-token",
  "id-token",
  "session-token",
  "x-session-token",
  "token",
  "password",
  "secret",
];

// Lower-case and drop `-`/`_`, so `Access_Token` and `api-key` normalize alike.
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

/** Whether a query-key or header name looks like it carries a secret. */
export function isSecretName(name: string): boolean {
  const normalized = normalizeName(name);
  return SECRET_QUERY_KEYS.includes(normalized) || SECRET_HEADER_NAMES.includes(normalized);
}

const SECRET_HEADER_NAMES_NORMALIZED = SECRET_HEADER_NAMES.map(normalizeName);

function isSecretHeaderName(name: string): boolean {
  return SECRET_HEADER_NAMES_NORMALIZED.includes(normalizeName(name));
}

/** Masks the values of secret query names; other pairs survive byte-exact.
 * Everything after the first `?` is treated as the query, so an error message that
 * quotes a URL loses any secrets past it (the Rust `mask_query`). */
function maskQuery(text: string): string {
  const queryAt = text.indexOf("?");
  if (queryAt === -1) return text;
  const head = text.slice(0, queryAt + 1);
  const rest = text.slice(queryAt + 1);
  const fragmentAt = rest.indexOf("#");
  const query = fragmentAt === -1 ? rest : rest.slice(0, fragmentAt);
  const fragment = fragmentAt === -1 ? "" : rest.slice(fragmentAt);
  const pairs = query.split("&").map((pair) => {
    const valueAt = pair.indexOf("=");
    if (valueAt === -1) return pair;
    const name = pair.slice(0, valueAt);
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      // Keep the raw name; a broken escape cannot hide a secret name from the raw check.
    }
    return SECRET_QUERY_KEYS.includes(normalizeName(decoded)) ? `${name}=${REDACTED}` : pair;
  });
  return head + pairs.join("&") + fragment;
}

// `]` `}` `)` are not stops: the `[redacted]` placeholder must survive re-masking.
const HEADER_VALUE_STOPS = new Set(["\n", "\r", '"', "'", "`", ",", ";", "&"]);

/** Masks header-shaped values in free text (the Rust `mask_headers`): after a
 * sensitive name at a name boundary, an optional closing quote, blanks, then `:` or
 * `=` (or `,` when the name was quoted), blanks, an optional opening quote, and the
 * value up to a stop character. */
function maskSecretHeaders(text: string): string {
  // ASCII-only lower-casing keeps indexes stable between `lower` and `text`.
  const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const isNameChar = (at: number): boolean => /[a-z0-9_-]/.test(lower[at] ?? "");
  const spans: [number, number][] = [];
  for (const name of SECRET_HEADER_NAMES) {
    let from = 0;
    for (;;) {
      const start = lower.indexOf(name, from);
      if (start === -1) break;
      from = start + name.length;
      const end = start + name.length;
      if ((start > 0 && isNameChar(start - 1)) || (end < lower.length && isNameChar(end))) continue;
      let cursor = end;
      const quotedName = lower[cursor] === '"' || lower[cursor] === "'";
      if (quotedName) cursor += 1;
      while (lower[cursor] === " " || lower[cursor] === "\t") cursor += 1;
      const separator = lower[cursor];
      const separates = separator === ":" || separator === "=" || (quotedName && separator === ",");
      if (!separates) continue;
      cursor += 1;
      while (lower[cursor] === " " || lower[cursor] === "\t") cursor += 1;
      const opener = lower[cursor];
      const hasOpener = opener === '"' || opener === "'" || opener === "`";
      if (hasOpener) cursor += 1;
      const value = cursor;
      while (lower[cursor] !== undefined && !HEADER_VALUE_STOPS.has(lower[cursor])) cursor += 1;
      if (hasOpener) {
        const closing = lower.indexOf(opener, value);
        if (closing !== -1) cursor = closing;
      }
      if (cursor > value) spans.push([value, cursor]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = text;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const [start, end] = merged[i];
    out = out.slice(0, start) + REDACTED + out.slice(end);
  }
  return out;
}

/** The URL as it may be recorded: secret query parameters and header echoes masked. */
export function redactUrl(url: string): string {
  return maskSecretHeaders(maskQuery(url));
}

/** The request path as it may be recorded; also covers the whole-URL path a
 * malformed URL leaves behind. */
export function redactPath(path: string): string {
  return maskQuery(path);
}

/** The header map as it may be logged: every secret-bearing name loses its value.
 * The frozen `NetworkEvent` records no headers at all — this is for apps that log
 * headers beside the monitor. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, isSecretHeaderName(name) ? REDACTED : value]),
  );
}

export interface InstrumentedFetchOptions {
  /** Where each attempt's event lands — `monitor.record`, or a callback that also refreshes a UI. */
  onEvent: Observer;
  /** Recorded in each event's `initiator` (`null` when not given). */
  initiator?: string | null;
  /** The fetch underneath; defaults to the global one. Tests inject a fake here. */
  fetch?: typeof fetch;
}

/** Wraps a fetch so every attempt records the frozen `NetworkEvent`. The event is
 * emitted when the response head arrives — the body belongs to the caller from that
 * point, so `durationMs` measures to the handoff and equals `ttfbMs`
 * (`docs/decision.md`); `responseBytes` comes from `Content-Length` when present. */
export function instrumentedFetch(options: InstrumentedFetchOptions): typeof fetch {
  const base = options.fetch ?? fetch;
  const textEncoder = new TextEncoder();
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === "object" && input !== null && "method" in input ? input.method : "GET");
    const body = init?.body;
    const requestBytes =
      typeof body === "string"
        ? textEncoder.encode(body).length
        : body instanceof ArrayBuffer
          ? body.byteLength
          : ArrayBuffer.isView(body)
            ? body.byteLength
            : null;
    const started = performance.now();
    const startedAtMs = Date.now();
    let response: Response;
    try {
      response = await base(input, init);
    } catch (cause) {
      options.onEvent({
        id: nextId(),
        method,
        url,
        host: hostOf(url),
        path: pathOf(url),
        status: null,
        startedAtMs,
        durationMs: Math.round(performance.now() - started),
        ttfbMs: null,
        requestBytes,
        responseBytes: null,
        error: (cause as { message?: string } | null)?.message ?? String(cause),
        initiator: options.initiator ?? null,
      });
      throw cause;
    }
    const ttfbMs = Math.round(performance.now() - started);
    const lengthHeader = response.headers.get("content-length");
    const length = lengthHeader === null ? NaN : Number(lengthHeader);
    const responseBytes = Number.isInteger(length) && length >= 0 ? length : null;
    options.onEvent({
      id: nextId(),
      method,
      url,
      host: hostOf(url),
      path: pathOf(url),
      status: response.status,
      startedAtMs,
      durationMs: ttfbMs,
      ttfbMs,
      requestBytes,
      responseBytes,
      error: response.ok ? null : `HTTP ${response.status}`,
      initiator: options.initiator ?? null,
    });
    return response;
  };
}

// Namespaced ids: the client seam owns its own counter, so a plain number here
// would collide with it the moment both record into one buffer.
let nextEventId = 1;
function nextId(): string {
  return `fetch-${nextEventId++}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
