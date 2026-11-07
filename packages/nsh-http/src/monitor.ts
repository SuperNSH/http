/** Network monitoring: the ring buffer, per-host and per-path aggregates, redaction
 * and sampling (behavior rows 11-12 of `docs/behavior.md`). The monitor area owns
 * this file's implementation; the scaffold fixes the frozen event shape only. */

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

/** Placeholder: the monitor area replaces this with the real monitor (ring buffer, aggregates, redaction, sampling). */
export class Monitor {}
