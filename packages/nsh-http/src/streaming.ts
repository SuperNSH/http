/** Streaming request and response bodies, download progress and its honest limits
 * (behavior row 13 of `docs/behavior.md`). Download progress comes from the body
 * stream: byte counts from `Content-Length` when the response names one, chunk counts
 * when it does not. Upload progress is a different, more limited thing — `upload.ts`. */

import type { HttpClient } from "./client";
import { errorFromRejection, HttpError } from "./errors";
import type { RetryPolicy } from "./retry";

/** Where a download stands; one callback per chunk read, plus a final `done` one. */
export interface DownloadProgress {
  receivedBytes: number;
  /** From `Content-Length`; `null` when the response names none — count `chunks` instead. */
  totalBytes: number | null;
  chunks: number;
  done: boolean;
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** `null` or 0: no timeout. The timeout spans the headers and the whole body read. */
  timeoutMs?: number | null;
  retry?: RetryPolicy;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadResult {
  status: number;
  ok: boolean;
  headers: Headers;
  bytes: Uint8Array;
  text: string;
}

/** GETs `path` and consumes the body as a stream, reporting progress per chunk. The
 * client's own event for this request ends at the handoff (the head), so this is the
 * only place the rest of the download is observable. A failure after the head — the
 * stream erroring mid-body — surfaces as a taxonomy error like any other. */
export async function download(client: HttpClient, path: string, options: DownloadOptions = {}): Promise<DownloadResult> {
  const response = await client.send(
    { method: "GET", url: client.url(path), headers: options.headers ?? {} },
    { signal: options.signal, timeoutMs: options.timeoutMs, retry: options.retry },
  );
  const totalBytes = contentLengthOf(response);
  const onProgress = options.onProgress ?? noProgress;
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let chunksSeen = 0;
  try {
    if (reader === undefined) {
      // No body (204, 304): the download is complete at the head.
      onProgress({ receivedBytes: 0, totalBytes, chunks: 0, done: true });
    } else {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.byteLength;
        chunksSeen += 1;
        onProgress({ receivedBytes, totalBytes, chunks: chunksSeen, done: false });
      }
      onProgress({ receivedBytes, totalBytes, chunks: chunksSeen, done: true });
    }
  } catch (cause) {
    throw errorFromRejection(cause);
  }
  const bytes = concatBytes(chunks);
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    bytes,
    text: new TextDecoder().decode(bytes),
  };
}

/** A request body that streams: an iterable of byte chunks (strings encoded UTF-8) as a
 * `ReadableStream`. The platform transport sends it as it is read (`duplex: "half"`),
 * and the client correctly refuses to retry a request carrying one. */
export function byteStream(source: Iterable<Uint8Array | string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = source[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(typeof next.value === "string" ? encoder.encode(next.value) : next.value);
    },
    cancel() {
      iterator.return?.();
    },
  });
}

export interface StreamRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** `null` or 0: no timeout. */
  timeoutMs?: number | null;
}

/** Sends a request whose body streams from `source` (an iterable of chunks, or an
 * already-built body stream) and decodes the response as JSON. Never retried: the
 * client never replays a request whose body already started. */
export async function streamRequest<T = unknown>(
  client: HttpClient,
  method: string,
  path: string,
  source: Iterable<Uint8Array | string> | ReadableStream<Uint8Array>,
  options: StreamRequestOptions = {},
): Promise<T> {
  const body = source instanceof ReadableStream ? source : byteStream(source);
  const response = await client.send(
    { method, url: client.url(path), headers: options.headers ?? {}, body },
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
  return decodeJson<T>(response);
}

/** Decodes a handed-back `Response` as JSON, mapping a bad status to `http-status` and
 * bad JSON to `decode`, exactly as the typed methods do. */
export async function decodeJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError("http-status", `HTTP ${response.status}`, { status: response.status, body: parseMaybeJson(text) });
  }
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError("decode", `decode failure: ${text.slice(0, 120)}`);
  }
}

/** Joins byte chunks (strings encoded UTF-8) into one array. */
export function concatBytes(chunks: (Uint8Array | string)[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk));
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function noProgress(): void {}

function contentLengthOf(response: Response): number | null {
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
