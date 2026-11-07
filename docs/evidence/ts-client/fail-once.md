# Fail-once evidence — packages/nsh-http tests/unit

Hard rule: every new test is seen to fail once, by breaking the code the tests bind
to on purpose, confirming the failure names the right thing, then restoring. This log
records that sweep for the ten unit files, run on nsh 0.4.0. Raw outputs (one file
per break) live in `raw/` next to this document. After the last break was restored,
all ten files were re-run green; the tallies are listed per entry and every raw
`*-restored.txt` holds the full pass line.

Method: one behavior broken at a time in `src/`, the file's test run via
`nsh test packages/nsh-http/tests/unit/<file>.test.ts`, output captured, then the
break reverted. Where a file's tests bind to different behaviors, each test got its
own break. Nothing was weakened: all breaks are edits to source, reverted before the
next one; the final state of every source file is identical to the audited state
(residue-checked by grep).

## 1. tests/unit/network-event.test.ts — 2 tests

- Break A (runtime, `src/monitor.ts`): the placeholder `Monitor` constructor throws
  `"broken on purpose"`.
  - Failed: 1 of 2 — `the package's exports resolve at run time`
    (`✗ ... exports resolve at run time (0ms)` / `broken on purpose`).
  - The key-set test stayed green during this break, as expected: it binds to its own
    literal and the `EVENT_KEYS` list, so it got its own break (Break C).
- Break B (type level, `src/monitor.ts`): the frozen field `ttfbMs` renamed to `ttfb`.
  Interfaces vanish at run time, so this drift is caught by the type gate:
  `nsh check packages/nsh-http` fails, naming the drift at the test's own literal —
  `tests/unit/network-event.test.ts(33,5): error TS2561: Object literal may only
  specify known properties, but 'ttfbMs' does not exist in type 'NetworkEvent'.
  Did you mean to write 'ttfb'?` (raw/network-event-typecheck.txt).
- Break C (data level, the test's `EVENT_KEYS` list): dropped `initiator` from the
  list the sample is compared against.
  - Failed: 1 of 2 — `the frozen NetworkEvent keeps its exact camelCase key set`
    (`expected [...13 keys...] to equal [...12 keys...]`).
- Restored: `✓ 2 tests: 2 passed, 0 failed` (raw/network-event-restored.txt).

## 2. tests/unit/client.test.ts — 3 tests

- Break (`src/client.ts` `decode`): every decoded answer returns `undefined`, so
  typed decoding is dead.
  - Failed: 3 of 3 — all of them, each with its screen state showing the broken
    decode (`user error undefined`, `echoed error undefined`):
    - `a typed get joins the base url, substitutes path params and encodes the query`
    - `post, put, patch and delete decode their answers`
    - `the client's default headers reach the request, and a call can add its own`
- Restored: `✓ 3 tests: 3 passed, 0 failed` (raw/client-restored.txt).

## 3. tests/unit/errors.test.ts — 3 tests

- Break A (`src/errors.ts`): `ERR_ACCESS_DENIED` mapped to the `network` kind instead
  of `refused`.
  - Failed: 1 of 3 — `a host the app's capabilities do not declare is refused through
    the client` (screen shows `refused network`).
  - The other two tests stayed green during this break, as expected; each got its own
    break below.
- Break B (`src/client.ts`): non-2xx answers thrown as the `decode` kind instead of
  `http-status`.
  - Failed: 1 of 3 — `a network failure, an http status with its decoded body, and a
    decode failure each get their own kind` (screen shows `status decode 404 gone`).
- Break C (`src/client.ts` `composeSignal`): returns `undefined` — no timeout signal,
  no caller signal composed.
  - Failed: 1 of 3 — `a timeout and a caller's cancel are kinds of their own` (the
    per-call row shows `ok`, never `timeout`).
- Restored: `✓ 3 tests: 3 passed, 0 failed` (raw/errors-restored.txt).

## 4. tests/unit/timeout.test.ts — 3 tests

- Break (`src/client.ts` `composeSignal`): same signal-dropping break as 3C, run
  against this file.
  - Failed: 3 of 3 — `a per-call timeout overrides the client's and cuts the attempt
    short`, `the client timeout applies when the call brings none`, `the caller's
    cancel wins over the timeout and reads as cancelled` (the attempts complete
    normally: rows show `ok` where `timeout`/`cancelled` was required).
- Restored: `✓ 3 tests: 3 passed, 0 failed` (raw/timeout-restored.txt).

## 5. tests/unit/retry.test.ts — 6 tests

- Break A (`src/retry.ts` `retryDelayMs`): always returns `0` — no backoff, no jitter.
  - Failed: 2 of 6 — `a flaky get retries on the manual clock until it succeeds`
    (`expected 3 to be 1`: both retries fired before the first clock step) and
    `jitter follows the injected random, so the retry wait is exact`
    (`expected 2 to be 1`).
  - The other four tests stayed green during this break: `Retry-After` bypasses the
    backoff (own break B), and the never-retry tests bind to the method/body guard
    (own break C).
- Break B (`src/retry.ts` `retryAfterMs`): always returns `null` — `Retry-After`
  ignored.
  - Failed: 2 of 6 — `Retry-After in seconds is honored over the backoff` and
    `Retry-After as an HTTP-date is honored against the manual clock` (both
    `expected 2 to be 1`: the retry fired on the backoff at 1 s instead of waiting
    the demanded 2 s).
- Break C (`src/client.ts`): the retry guard dropped — `canRetry` no longer checks
  the idempotent method set or the streamed-body flag.
  - Failed: 2 of 6 — `a post never retries` (`expected 3 to be 1`: the POST was
    replayed twice) and `a request whose body is a stream never retries` (the
    replayed attempt fails with the consumed stream: screen `stream network null`).
- Restored: `✓ 6 tests: 6 passed, 0 failed` (raw/retry-restored.txt).

## 6. tests/unit/middleware.test.ts — 1 test

- Break (`src/middleware.ts` `composeMiddleware`): `reduceRight` swapped for `reduce`,
  inverting the onion (requests last-to-first, responses first-to-last).
  - Failed: 1 of 1 — `requests flow first to last, responses last to first, and a
    rewrite reaches the route` (`expected false to be true` at the order assertion).
- Restored: `✓ 1 test: 1 passed, 0 failed` (raw/middleware-restored.txt).

## 7. tests/unit/auth.test.ts — 2 tests

- Break A (`src/client.ts` `refreshToken`): the refresh promise is not shared
  (`this.refreshing = fresh` instead of `??=`) — every 401 refreshes on its own.
  - Failed: 1 of 2 — `ten parallel 401s share one refresh and all replay with the
    fresh token` (screen showed `refreshes 10`, expected 1).
  - The fresh-token test stayed green during this break, as expected; it got its own
    break below.
- Break B (`src/client.ts`): the auth-replay trigger widened from `status === 401` to
  `status >= 200` — successful answers demand a refresh too.
  - Failed: 1 of 2 — `a fresh token does not refresh` (the 200 triggered a refresh).
- Restored: `✓ 2 tests: 2 passed, 0 failed` (raw/auth-restored.txt).

## 8. tests/unit/mock.test.ts — 2 tests

- Break A (`src/mock.ts`): wildcard matching disabled (`pattern === request.url` only).
  - Failed: 1 of 2 — `the mock answers statuses, failures, wildcards and delays, while
    the stubs answer another client` (screen `wild network`; the `/wild*` route no
    longer matches `/wildcard-deep`, and the mock's unlisted-route rejection surfaces
    as kind `network`).
  - The ghost test stayed green during this break, as expected; it got its own break
    below (Break C).
- Break B (`src/mock.ts`): `answer.delay` ignored — canned delays never wait.
  - Failed: 1 of 2 — the same combined test (`expected false to be true` at the
    `late pending` assertion: the delayed answer arrived before the clock moved).
- Break C (`src/mock.ts`): an unmocked request resolves with a 200 instead of
  rejecting.
  - Failed: 1 of 2 — `an unmocked request fails loudly instead of silently passing`
    (the ghost row never shows `network`; the request silently "succeeded").
- Restored: `✓ 2 tests: 2 passed, 0 failed` (raw/mock-restored.txt).

## 9. tests/unit/etag.test.ts — 2 tests

- Break A (`src/etag.ts` `createEtagFetcher`): `If-None-Match` never sent.
  - Failed: 1 of 2 — `a revalidation sends If-None-Match and a 304 keeps the cached
    value` (`expected undefined to be "\"a\""` at the header assertion; the route
    answered a fresh 200 instead of a 304).
  - The Cache-Control test stayed green during this break, as expected; it got its
    own break below.
- Break B (`src/etag.ts` `cacheControl`): `max-age` directives ignored
  (`maxAgeMs` stays `null`).
  - Failed: 1 of 2 — `Cache-Control directives parse` (`text:cc 60000 true` never
    shown).
- Restored: `✓ 2 tests: 2 passed, 0 failed` (raw/etag-restored.txt).

## 10. tests/unit/observe.test.ts — 1 test

- Break (`src/client.ts` `emit`): the decode-path event emitted with `status: null`
  regardless of the response.
  - Failed: 1 of 1 — `each attempt emits one event with its method, url, host, path,
    status and timings` (the first assertion `text:last-status 200` never shows).
- Restored: `✓ 1 test: 1 passed, 0 failed` (raw/observe-restored.txt).

## Coverage note

Every one of the 25 tests in the ten unit files is named above failing at least once
under a break of the behavior it binds to, and every file was re-run green after its
breaks were restored. The live file `tests/live/capability.test.ts` was covered in
the same way in the earlier sweep: with `ERR_ACCESS_DENIED` mapped to the `network`
kind (break 3A), it failed (`✗ ... refused through the client, directly and on a
redirect hop`), and it passed again once restored.
