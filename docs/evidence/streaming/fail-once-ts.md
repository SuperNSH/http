# Fail-once evidence — streaming-and-uploads, TypeScript half

Every new test in this area was seen to fail at least once by breaking the code on
purpose, per `docs/PROMPT.md`. Mutations were applied to the area's own sources
(`packages/nsh-http/src/{streaming,upload,sse}.ts`), the named test was run, the
failure was observed in the output, and the mutation was reverted. After the last
revert the full suite is green: 57 tests, 0 failed (`full-run-1.txt` in this
directory). Test counts below refer to `tests/unit/{streaming,upload,sse}.test.ts`
(T1-T17) and `tests/live/{streaming,sse}.test.ts` (L1-L6).

Two test weaknesses were found by mutations and fixed before recording:

- The stub round-trip test could not observe a body change (a truncated stream still
  answered `{received:true}`). The route now echoes `request.body` back; the stub
  turns out to report streamed bodies as `null` (per `.nsh/types/nsh/test.d.ts`,
  "(or streamed)"), which is itself the honest signal that the body went out as a
  stream, and the test asserts exactly that.
- The server-retry test's trailing `waitFor` advanced the manual clock, masking the
  backoff timing (mutation M13 initially passed). The test now asserts at exactly
  250 ms with `app.wait(0)` for the microtasks only.

| Mutation (file: change) | Tests seen failing |
|---|---|
| M1 `streaming.ts`: `contentLengthOf` always returns null | T1 download reports content-length progress through the stub network; T3 progress names the content-length total from the first chunk |
| M3 `streaming.ts`: `receivedBytes += 1` instead of byte length | T1, T2 download without content-length counts chunks, T3 |
| M4 `streaming.ts`: `byteStream` drops chunks after the first | T6 a streamed request body arrives as the chunks the caller gave |
| M4b `streaming.ts`: `streamRequest` body downgraded to a plain string | T6; T7 a streamed request body round-trips through the stub network (route saw the text instead of a stream's null) |
| M5 `streaming.ts`: mid-stream catch rethrows the raw cause | T4 a caller cancel mid-body rejects the download as cancelled |
| M6 `streaming.ts`: bodyless response emits `chunks: 1` | T5 a bodyless response downloads as empty and done |
| M7 `upload.ts`: `formDataOf` appends `"mutated"` for string fields | T8 multipart via FormData is encoded by the platform and seen by the route (route no longer saw "milk") |
| M8 `upload.ts`: `encodeMultipart` uses LF instead of CRLF | T9 encodeMultipart produces the exact multipart bytes and exact total; T10 an exact body reports encoded and sent progress with real byte counts |
| M10 `streaming.ts`: `decodeJson` maps a bad status to `network` | T11 an error status from an upload comes back as http-status with the status (row showed `network 500`) |
| M11 `sse.ts`: dispatch keeps the trailing newline | T12 the parser dispatches id, event, data, multi-line data and retry; T13 a broken stream reconnects and sends Last-Event-ID |
| M12 `sse.ts`: `Last-Event-ID` header never sent | T13 (row showed `sse-leid none`) |
| M13 `sse.ts`: server `retry:` override ignored | T14 a server retry line overrides the reconnect backoff (after the test's masking-wait fix) |
| M14 `sse.ts`: `close()` no longer sets `closed` | T15 close() during the backoff stops any reconnect (reconnect fired anyway) |
| M15 `sse.ts`: give-up check disabled | T16 the connection gives up with an error after maxRetries |
| M16 `sse.ts`: caller-abort listener no-op | T17 the caller's signal cancels the stream and nothing reconnects (conns climbed to 2) |
| L1 `streaming.ts`: download loop breaks after one chunk | L1 a chunked stream is consumed to the last line with progress along the way (live) |
| L2 `streaming.ts`: `contentLengthOf` returns null (live rerun; the app's progress row was also fixed so the progress callback is its only writer) | L2 download progress reports the content-length total on a real byte route (live) |
| L3 `upload.ts`: same corruption as M7, live rerun | L3 a multipart upload round-trips through the echo server's parser (live) |
| L4 `streaming.ts`: same body downgrade as M4b, live rerun | L4 a streamed request body echoes whole over the duplex fetch (live) |
| L5 `sse.ts`: same trailing-newline dispatch as M11 (live app row now escapes newlines, so the difference is visible) | L5 a live event stream delivers its events and stops when closed (live) |
| L6 `sse.ts`: same missing header as M12, live rerun | L6 a reconnect replays from Last-Event-ID, not from the first event (live; server restarted at id 1) |

Coverage check: T1-T17 and L1-L6 each appear at least once above — 23 of 23 new
tests seen failing. Run outputs: `unit-run-1.txt` (first fully green suite),
`unit-run-2.txt` (rerun landing on the monitor area's concurrent in-flight test,
which passed on the next full run), `full-run-1.txt` (final all-green run incl. live),
`live-streaming-run.txt`, `live-sse-run.txt`.

Notes:

- M2 and M9 do not appear: they were drafted mutations (breaking the final `done`
  progress emit, and nulling the sent-phase byte counts) that were dropped before
  running because the tests they targeted were already failed by M1/M3 and M8. The
  numbering kept its original order instead of being renumbered.

## Audit fix round (streaming TS half)

Each changed/new test below was run against the pre-fix code first and observed
failing (red outputs: `audit-red-sse.txt`, `audit-red-upload.txt`), then the fix
landed and the test passed. Where a selector was also adjusted during landing, the
red run still shows the behavioral failure — the pre-fix code did not do the thing
the test pins.

| Audit item | Test | Observed failure against pre-fix code |
|---|---|---|
| 1 — non-2xx connect is terminal (parity with `sse.rs:442`) | a permanently non-2xx connect ends the source with an error instead of looping | pre-fix code retried forever: conns climbed to 2 with errors 2 during the run, and the refused body was never released (`sse-cancels 0`) |
| 1 — non-event-stream content type is terminal (parity with `sse.rs:456-466`) | a connect without a text/event-stream body ends the source without reconnecting | pre-fix code accepted `text/plain`, consumed the stream and reconnected; no error ever fired |
| 3 — huge `retry:` value (parity with the `u64` parse at `sse.rs:106-109`) | a huge server retry value is ignored like the Rust u64 parse, so the loop never spins | pre-fix code set `retryMs = Infinity` and the engine's manual clock panicked ("the manual clock cannot move") — worse than a spin |
| 2 — boundary collision check (parity with `multipart.rs:155-168`, `parts_contain`) | a caller boundary that collides with a part's content fails loudly | pre-fix code encoded the unparseable body silently (`up-collide-out ok 100`) |
| 2 — boundary charset/length validation (parity with `boundary_error`, `multipart.rs:191`) | a boundary outside the RFC 2046 set is rejected, not encoded silently | pre-fix code accepted `"bad boundary!"` and encoded it (`up-badboundary-out ok 209`) |
| 4 — refused connect's body is released | covered by the non-2xx test's `sse-cancels 1` assertion (the pre-fix red showed `sse-cancels 0`) | same red run as item 1 |

Item 5 (the M2/M9 numbering gap) is documentation-only, fixed in the Notes above.

## Audit round 2 (two parity nits)

Both tests run against the pre-fix code first (red outputs: `audit2-red-sse.txt`,
`audit2-red-upload.txt`).

| Nit | Test | Observed failure against pre-fix code |
|---|---|---|
| Clean close with `maxRetries: 0` ended the source with "gave up after 0 failed connections" instead of reconnecting like `sse.rs:476-480` | a clean stream end reconnects even with maxRetries 0 — only failed connections count | `sse-opens 1`, last error "gave up after 0 failed connections"; the fix moves the cap check into the failure path only |
| Generated-boundary cap was 9 candidates (initial + 8 re-rolls) vs Rust's exactly 8 (`multipart.rs:157`), with the old "after 8 re-rolls" wording | a generated boundary gives up after exactly 8 candidates, like the Rust loop | threw with the old wording "multipart boundary collides with a part's content after 8 re-rolls"; the fix counts 8 candidates total and uses Rust's wording plus the count |

The re-roll test pins `crypto.randomUUID` to an all-zero UUID inside the test app so
every candidate collides with the part and the cap is reached deterministically.
