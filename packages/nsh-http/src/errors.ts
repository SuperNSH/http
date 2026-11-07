/** The six-case error taxonomy (behavior row 3 of `docs/behavior.md`). Refused by
 * capability stays distinct from a network failure: `ERR_ACCESS_DENIED` means the
 * app's `capabilities.network` does not allow the URL (every redirect hop is checked
 * again), not that the request failed on the wire. */

/** The six cases, one per behavior row. */
export type HttpErrorKind = "network" | "timeout" | "cancelled" | "refused" | "http-status" | "decode";

/** Every failure `HttpClient` surfaces: tell the cases apart by `kind`, not by message. */
export class HttpError extends Error {
  /** Which of the six cases this is. */
  readonly kind: HttpErrorKind;
  /** The response status, for `http-status`; `null` for every other case. */
  readonly status: number | null;
  /** The decoded body for `http-status` (JSON when it parses, else the raw text); `null` otherwise. */
  readonly body: unknown;

  constructor(kind: HttpErrorKind, message: string, details?: { status?: number; body?: unknown }) {
    super(message);
    this.kind = kind;
    this.status = details?.status ?? null;
    this.body = details?.body ?? null;
  }
}

/** Maps what the platform fetch (or a mock transport) rejects with onto the taxonomy.
 * The client tells a caller's cancel from its own timeout first (both arrive as aborts)
 * and calls this only for the rest. */
export function errorFromRejection(cause: unknown): HttpError {
  const reason = cause as { name?: string; code?: unknown; message?: string } | null | undefined;
  if (reason?.code === "ERR_ACCESS_DENIED") {
    return new HttpError("refused", `refused by capabilities.network: ${reason?.message ?? "not allowed"}`);
  }
  if (reason?.name === "TimeoutError") {
    return new HttpError("timeout", `timed out: ${reason?.message ?? "signal"}`);
  }
  if (reason?.name === "AbortError") {
    return new HttpError("cancelled", `cancelled: ${reason?.message ?? "signal"}`);
  }
  return new HttpError("network", `network failure: ${reason?.message ?? String(cause)}`);
}
