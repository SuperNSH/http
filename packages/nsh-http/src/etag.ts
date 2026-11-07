/** ETag and `Cache-Control` helpers feeding nsh-query (behavior row 9 of
 * `docs/behavior.md`): a `fetch` for `createQuery` that revalidates with
 * `If-None-Match`, returns the cached value untouched on a 304, and records the
 * response's `ETag` for next time. */

import type { HttpClient } from "./client";
import { HttpError } from "./errors";

/** A parsed `Cache-Control` header; absent directives are their defaults. */
export interface CacheControl {
  /** `max-age` in milliseconds; `null` when the header names none. */
  maxAgeMs: number | null;
  noStore: boolean;
  noCache: boolean;
  mustRevalidate: boolean;
}

/** Parses a `Cache-Control` header. */
export function cacheControl(headers: Headers | Record<string, string>): CacheControl {
  const raw = headers instanceof Headers ? headers.get("cache-control") : (headers["cache-control"] ?? null);
  const parsed: CacheControl = { maxAgeMs: null, noStore: false, noCache: false, mustRevalidate: false };
  if (raw === null) return parsed;
  for (const directive of raw.split(",")) {
    const [name, value] = directive.trim().split("=", 2);
    switch ((name ?? "").toLowerCase()) {
      case "no-store":
        parsed.noStore = true;
        break;
      case "no-cache":
        parsed.noCache = true;
        break;
      case "must-revalidate":
        parsed.mustRevalidate = true;
        break;
      case "max-age": {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) parsed.maxAgeMs = seconds * 1000;
        break;
      }
    }
  }
  return parsed;
}

/** A stored answer: the decoded value and the etag that names it. */
export interface EtagEntry {
  value: unknown;
  etag: string | null;
}

/** Where `createEtagFetcher` keeps its answers; make one per key space. */
export class EtagStore {
  private entries = new Map<string, EtagEntry>();

  /** The answer stored for `key`, if any. */
  get(key: string): EtagEntry | undefined {
    return this.entries.get(key);
  }

  /** Stores `value` under `key` with the etag that produced it. */
  set(key: string, value: unknown, etag: string | null): void {
    this.entries.set(key, { value, etag });
  }
}

export interface EtagFetcherOptions {
  client: HttpClient;
  /** Builds the path (client-relative or absolute) from the query key. */
  path: (key: string) => string;
  /** Default: a fresh in-memory store, private to this fetcher. */
  store?: EtagStore;
  headers?: Record<string, string>;
}

export interface EtagFetcherContext {
  key: string;
  signal?: AbortSignal;
}

/** Builds a `fetch` for nsh-query's `createQuery`: on each call it sends
 * `If-None-Match` when the store holds an etag for the key, answers a 304 from the
 * cache without decoding, and stores fresh answers with their `ETag`. */
export function createEtagFetcher<T>(options: EtagFetcherOptions) {
  const store = options.store ?? new EtagStore();
  return async ({ key, signal }: EtagFetcherContext): Promise<T> => {
    const entry = store.get(key);
    const headers: Record<string, string> = { ...options.headers };
    if (entry !== undefined && entry.etag !== null) headers["if-none-match"] = entry.etag;
    const response = await options.client.send(
      { method: "GET", url: options.client.url(options.path(key)), headers },
      { signal },
    );
    if (response.status === 304) {
      if (entry === undefined) {
        throw new HttpError("http-status", "HTTP 304 with nothing cached", { status: 304 });
      }
      return entry.value as T;
    }
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError("http-status", `HTTP ${response.status}`, {
        status: response.status,
        body: text === "" ? null : text,
      });
    }
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch {
      throw new HttpError("decode", `decode failure: ${text.slice(0, 120)}`);
    }
    store.set(key, value, response.headers.get("etag"));
    return value;
  };
}
