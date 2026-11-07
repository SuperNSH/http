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

/** Why `boundary` is not a legal RFC 2046 boundary (1-70 characters of the allowed set,
 * no trailing space), if it is not one. */
function boundaryError(boundary: string): string | null {
  if (boundary.length === 0 || boundary.length > 70) {
    return `must be 1-70 characters, got ${boundary.length}`;
  }
  if (!/^[\x00-\x7F]+$/.test(boundary)) return "must be ASCII";
  for (let index = 0; index < boundary.length; index += 1) {
    const character = boundary[index];
    const allowed =
      /[A-Za-z0-9]/.test(character) || "'()+_,-./:=?".includes(character) || (character === " " && index + 1 !== boundary.length);
    if (!allowed) return `"${character}" is outside the RFC 2046 set`;
  }
  return null;
}

/** One part with its bytes settled, ready for the collision check and the encoder. */
interface EncodedPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  bytes: Uint8Array;
}

async function encodedPartsOf(parts: UploadPart[]): Promise<EncodedPart[]> {
  const encoder = new TextEncoder();
  return Promise.all(
    parts.map(async (part) => {
      if (typeof part.value === "string" && part.filename === undefined) {
        return { name: part.name, filename: null, contentType: null, bytes: encoder.encode(part.value) };
      }
      const filename = part.filename ?? (typeof part.value === "string" || !(part.value instanceof File) ? "blob" : part.value.name);
      const contentType =
        part.contentType ??
        (typeof part.value === "string" || part.value.type === "" ? "application/octet-stream" : part.value.type);
      const bytes = typeof part.value === "string" ? encoder.encode(part.value) : await part.value.bytes();
      return { name: part.name, filename, contentType, bytes };
    }),
  );
}

/** Whether any part's name, filename or bytes contain the boundary — the collision
 * RFC 2046 forbids, and the one that makes a body silently unparseable. */
function partsContain(parts: EncodedPart[], boundary: string): boolean {
  const encoder = new TextEncoder();
  const needle = encoder.encode(boundary);
  const contains = (haystack: Uint8Array): boolean => {
    search: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
      for (let offset = 0; offset < needle.length; offset += 1) {
        if (haystack[start + offset] !== needle[offset]) continue search;
      }
      return true;
    }
    return false;
  };
  return parts.some(
    (part) =>
      contains(encoder.encode(part.name)) ||
      (part.filename !== null && contains(encoder.encode(part.filename))) ||
      contains(part.bytes),
  );
}

function generateBoundary(): string {
  return `----nsh-http-${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Encodes the multipart body here instead of in the runtime, so its exact byte length
 * is known up front — the only way upload progress can report real numbers. Field names
 * and filenames are percent-escaped for quotes and line breaks so a part cannot forge a
 * boundary. A caller boundary is validated and checked against every part (a boundary
 * appearing inside a part makes the body unparseable); a generated one re-rolls, like
 * the Rust half. A `Blob` part's bytes are read before encoding, so this awaits. */
export async function encodeMultipart(parts: UploadPart[], boundary?: string): Promise<MultipartEncoding> {
  const generated = boundary === undefined;
  let chosen = boundary ?? generateBoundary();
  if (!generated) {
    const reason = boundaryError(chosen);
    if (reason !== null) throw new Error(`invalid multipart boundary: ${reason}`);
  }
  const encoded = await encodedPartsOf(parts);
  // Eight candidates in total, as the Rust loop's `for _ in 0..8` counts them.
  for (let candidate = 0; ; candidate += 1) {
    if (!partsContain(encoded, chosen)) break;
    if (!generated) throw new Error("multipart boundary collides with a part's name, filename or content");
    if (candidate + 1 >= 8) throw new Error("the boundary occurs inside a part's content after 8 candidates");
    chosen = generateBoundary();
  }
  const escape = (text: string) => text.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const chunks: (Uint8Array | string)[] = [];
  for (const part of encoded) {
    chunks.push(`--${chosen}\r\n`);
    if (part.filename === null) {
      chunks.push(`Content-Disposition: form-data; name="${escape(part.name)}"\r\n\r\n`);
    } else {
      chunks.push(`Content-Disposition: form-data; name="${escape(part.name)}"; filename="${escape(part.filename)}"\r\n`);
      chunks.push(`Content-Type: ${part.contentType}\r\n\r\n`);
    }
    chunks.push(part.bytes);
    chunks.push("\r\n");
  }
  chunks.push(`--${chosen}--\r\n`);
  return { contentType: `multipart/form-data; boundary=${chosen}`, boundary: chosen, bytes: concatBytes(chunks) };
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
