/** Multipart uploads and upload progress with its honest limit (behavior row 13 of
 * `docs/behavior.md`). The limit, verified against `.nsh/types/nsh/globals.d.ts` on
 * 0.4.0: the platform fetch exposes no upload events — no `ProgressEvent`, no
 * `onprogress` — and the fetch promise resolves once, at the response head. So progress
 * can never claim bytes confirmed on the wire. It fires at the two observable moments:
 * when the body is built (exact bytes, and only where we build them ourselves with
 * `encodeMultipart` — a `FormData` hides its encoded size) and when the response head
 * arrives, the first observable sign that the whole body left. */

import type { HttpClient } from "./client";
import { concatBytes, decodeJson } from "./streaming";

export interface UploadPart {
  name: string;
  /** A string field, or file bytes as a `Blob` (a runtime `File` works and keeps its name). */
  value: string | Blob;
  filename?: string;
  contentType?: string;
}

/** What the runtime lets this library know about an upload. `null` where it knows
 * nothing: a `FormData` body's encoded size is never exposed. */
export interface UploadProgress {
  phase: "encoded" | "sent";
  sentBytes: number | null;
  totalBytes: number | null;
}

export interface UploadOptions {
  /** Default `POST`. */
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** `null` or 0: no timeout. */
  timeoutMs?: number | null;
  onProgress?: (progress: UploadProgress) => void;
}

/** Builds the runtime's own `FormData` from parts — the multipart path the platform
 * encodes itself. Its boundary is the platform's, so the `content-type` header must be
 * left to it: setting one by hand would name a boundary the body does not use. */
export function formDataOf(parts: UploadPart[]): FormData {
  const form = new FormData();
  for (const part of parts) {
    const { name, value, filename, contentType } = part;
    if (typeof value === "string" && filename === undefined && contentType === undefined) {
      form.append(name, value);
    } else if (typeof value === "string") {
      form.append(name, new Blob([value], contentType === undefined ? undefined : { type: contentType }), filename ?? "blob");
    } else if (filename !== undefined) {
      form.append(name, value, filename);
    } else {
      form.append(name, value);
    }
  }
  return form;
}

export interface MultipartEncoding {
  contentType: string;
  boundary: string;
  bytes: Uint8Array;
}

/** Encodes the multipart body here instead of in the runtime, so its exact byte length
 * is known up front — the only way upload progress can report real numbers. Field names
 * and filenames are percent-escaped for quotes and line breaks so a part cannot forge a
 * boundary. A `Blob` part's bytes are read before encoding, so this awaits. */
export async function encodeMultipart(
  parts: UploadPart[],
  boundary = `----nsh-http-${crypto.randomUUID().replace(/-/g, "")}`,
): Promise<MultipartEncoding> {
  const escape = (text: string) => text.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const chunks: (Uint8Array | string)[] = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    if (typeof part.value === "string" && part.filename === undefined) {
      chunks.push(`Content-Disposition: form-data; name="${escape(part.name)}"\r\n\r\n`);
      chunks.push(part.value);
    } else {
      const filename = escape(
        part.filename ?? (typeof part.value === "string" || !(part.value instanceof File) ? "blob" : part.value.name),
      );
      const type =
        part.contentType ??
        (typeof part.value === "string" || part.value.type === "" ? "application/octet-stream" : part.value.type);
      chunks.push(`Content-Disposition: form-data; name="${escape(part.name)}"; filename="${filename}"\r\n`);
      chunks.push(`Content-Type: ${type}\r\n\r\n`);
      chunks.push(typeof part.value === "string" ? part.value : await part.value.bytes());
    }
    chunks.push("\r\n");
  }
  chunks.push(`--${boundary}--\r\n`);
  return { contentType: `multipart/form-data; boundary=${boundary}`, boundary, bytes: concatBytes(chunks) };
}

/** Uploads a body built here (see `encodeMultipart`), so both progress events carry the
 * exact byte count. The response is decoded as JSON; a bad status maps to `http-status`. */
export async function uploadBytes<T = unknown>(
  client: HttpClient,
  path: string,
  encoding: MultipartEncoding,
  options: UploadOptions = {},
): Promise<T> {
  return uploadBody<T>(client, path, encoding.bytes, { "content-type": encoding.contentType }, encoding.bytes.byteLength, options);
}

/** Multipart upload through the runtime's own `FormData`. The honest limit: the runtime
 * exposes neither the encoded size nor any send events, so both progress events carry
 * `null` byte counts — inventing a size here would be exactly the invented number
 * `docs/decision.md` forbids. */
export async function uploadMultipart<T = unknown>(
  client: HttpClient,
  path: string,
  parts: UploadPart[],
  options: UploadOptions = {},
): Promise<T> {
  return uploadBody<T>(client, path, formDataOf(parts), {}, null, options);
}

async function uploadBody<T>(
  client: HttpClient,
  path: string,
  body: BodyInit,
  headers: Record<string, string>,
  encodedBytes: number | null,
  options: UploadOptions,
): Promise<T> {
  const onProgress = options.onProgress ?? noProgress;
  onProgress({ phase: "encoded", sentBytes: encodedBytes, totalBytes: encodedBytes });
  const response = await client.send(
    { method: options.method ?? "POST", url: client.url(path), headers: { ...headers, ...options.headers }, body },
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
  onProgress({ phase: "sent", sentBytes: encodedBytes, totalBytes: encodedBytes });
  return decodeJson<T>(response);
}

function noProgress(): void {}
