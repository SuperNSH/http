/** The auth seam (behavior row 7 of `docs/behavior.md`). The client attaches `token()`
 * as `Authorization: Bearer ..`; on a 401 it calls `refresh()` exactly once no matter
 * how many requests are waiting, then replays each with the fresh token. */

export interface TokenProvider {
  /** The current token, or null for none; read per attempt. */
  token(): string | null | Promise<string | null>;
  /** Fetches a fresh token; concurrent 401s share one call of this. */
  refresh(): string | null | Promise<string | null>;
}
