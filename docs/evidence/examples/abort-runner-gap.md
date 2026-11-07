# The abort proof needs a real target: headless live network keeps aborted requests running (nsh 0.4.0)

Finding from the examples-and-docs build, 2026-11-07. On the headless test
runner (`nsh test`, no `--target`), an app `fetch` aborted through its
`AbortSignal` rejects on the JS side, but the underlying request is not
cancelled: the server never sees a disconnect and answers it in full. On a
real target (`nsh test --target macos`) the same abort closes the request and
the server logs it. Consequence: any wire-level cancellation proof — here, the
nsh-query replacement proof of behavior row 15 — must run on `--target`;
`examples/demo-ts/tests/live/abort.test.ts` skips loudly on the headless
runner and names that command.

The server side is `tools/echo-server` (`/slow` honors client disconnects,
`/log?tail=n` reads the log back over HTTP). The app flow is the demo's query
screen: a `createQuery` fetcher riding the query's `AbortSignal` through the
nsh-http client against `/slow?delay=3000`, replaced (`queryClient.cancel`
plus a new key) while in flight.

## Headless run: the replaced request completes server-side

Command: `nsh test examples/demo-ts` (2026-11-07, before the skip existed —
this run FAILED at `waitFor("text:log-abort yes")` with `log-abort no` on
screen: the app read `/log` back over the network four times over ~1.2 s and
no aborted line appeared). The two `/slow` requests of that flow (initial load
topic 1 at ts …664808, replacement topic 2 at ts …664909) both ran to
completion server-side; there is no `aborted` line for either id anywhere in
`.runtime.log`:

    {"event":"start","id":"42abfcc2-1b1c-48cf-a48d-d61af325472b","ts":1794025664808,"method":"GET","path":"/slow"}
    {"event":"start","id":"5fa91acf-c717-4c42-8daf-2c7c836b7a08","ts":1794025664909,"method":"GET","path":"/slow"}
    {"event":"end","id":"42abfcc2-1b1c-48cf-a48d-d61af325472b","ts":1794025667810,"status":200,"ms":3002}
    {"event":"end","id":"5fa91acf-c717-4c42-8daf-2c7c836b7a08","ts":1794025667911,"status":200,"ms":3002}

3002 ms = the route's full sleep: the server never noticed anything. The
abort came from `queryClient.cancel` → the entry's `AbortController` → the
client's `fetch` (the query state did flip to the new key), so the JS-side
rejection works; what is lost is the transport-level cancel.

## Real target run: the same flow logs the abort

Command: `nsh test examples/demo-ts/tests/live/abort.test.ts --target macos`
(2026-11-07, passed, 1.3 s). The replaced request shows `aborted` with no
`end` (the second aborted id is the replacement load the runner aborts at test
teardown):

    {"event":"start","id":"c750f793-c28c-4ce7-ae39-d7ed3a028e5e","ts":1794025858490,"method":"GET","path":"/slow"}
    {"event":"aborted","id":"c750f793-c28c-4ce7-ae39-d7ed3a028e5e","ts":1794025858775,"path":"/slow"}
    {"event":"start","id":"a4fe3db2-11a6-40e1-aa98-e9acc6ead400","ts":1794025858785,"method":"GET","path":"/slow"}
    {"event":"aborted","id":"a4fe3db2-11a6-40e1-aa98-e9acc6ead400","ts":1794025859332,"path":"/slow"}

## Where it lives

The headless runner's live network is `UreqNetwork`
(`crates/nsh-testing/src/run.rs`, `NetworkSetup::Live => Arc::new(UreqNetwork::new())`);
a real target runs on the host's own stack
(`open_on_host`, `environment.live_network = true`). Recorded upstream in
`docs/upstream-issues.md`.
