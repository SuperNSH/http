# echo-server

Local sandbox HTTP server for the nsh-http build. The client libraries, example
apps and live test suites integrate against it; nothing reaches an external network.

Start it detached. Live tests and demo apps look for the server on 127.0.0.1:8123,
because nsh test VMs on 0.4.0 cannot read `.runtime.json` or inherit environment,
so the port must be known before the app runs:

    (cd tools/echo-server && ECHO_PORT=8123 nohup bun run src/server.ts >/tmp/nsh-http-echo.log 2>&1 &)

`ECHO_PORT` overrides the port; plain `bun run src/server.ts` binds a random free
port — the mode the test suite exercises. Either way the port is recorded in
`.runtime.json` once `/health` answers.

Run the tests:

    bun --cwd tools/echo-server test

## The port file is the contract

`tools/echo-server/.runtime.json` is `{"port": <port>, "pid": <pid>}`. The server
fetches its own `/health`, and only then writes the file — read the port from
there, never hardcode it. Tests never write it.

`tools/echo-server/.runtime.log` gets one JSON line per request:

    {"event":"start","id":"…","ts":1762…,"method":"GET","path":"/slow"}
    {"event":"end","id":"…","ts":1762…,"status":200,"ms":1204}
    {"event":"aborted","id":"…","ts":1762…,"path":"/slow"}

An aborted request has `start` plus `aborted` and no `end`; aborted ids correlate
with their start line. That distinction is the cancellation proof the nsh-query
example relies on. Both files are resolved from the server's own directory, so the
working directory does not matter. `ECHO_LOG_PATH` and `ECHO_RUNTIME_PATH` override
them (that is how the test suite stays off the real files; under `bun test` the
runtime file is not written at all unless `ECHO_RUNTIME_PATH` is set).

## Routes

| Route | Behavior |
|---|---|
| GET /health | 200 `{"ok":true}` |
| GET /fast | immediate `{"route":"fast"}` |
| GET /slow?delay=1200 | waits `delay` ms (default 1000, max 600000), then `{"route":"slow","delay":<ms>}`; honors client disconnect |
| GET /status/:code | responds with that status (integer 200–599; 204/304 have no body) |
| GET /flaky?fail=2 | first `fail` hits (counter per `fail` value) return 503 with `Retry-After: 1`, then 200 |
| GET /etag | ETag `"r1"`; 304 with empty body and the same ETag when `If-None-Match` matches |
| GET /stream?chunks=8&delay=50 | one ndjson chunk per `delay` ms; honors client disconnect |
| GET /sse?count=20&delay=10 | `text/event-stream`, events with ids 1..count; `Last-Event-ID: k` replays starting at id `k` (an id beyond `count` closes with no events) |
| POST /multipart | parses multipart/form-data and echoes the parts as JSON |
| POST /token | `Bearer expired` → 401 `{"error":"expired"}`; `Bearer refreshed` → 200 `{"ok":true}`; anything else 401 |
| /echo (any method) | JSON echo of `method`, `path`, `query` and the body (parsed as JSON when possible) |
| GET /redirect/refused | 302 to `http://refused.invalid/next` — a host no test app declares, so capability refusal on a redirect hop is provable |
| GET /redirect/local | 302 to `/fast` |
| GET /bytes/:n | `n` bytes with `Content-Length` (max 100000000) |
| GET /log?tail=n | the last `n` lines of `.runtime.log` as `{"lines":[...]}`, parsed, oldest first (`tail` clamped 1–1000, default 20; `[]` on an empty log). Reading it appends nothing to the log. Test VMs on 0.4.0 cannot read files, so the nsh-query cancellation proof in `examples/demo-ts` goes through this route |

`/slow`, `/stream` and `/sse` watch the request's abort signal; a client that
disconnects early makes the server log an `aborted` line for that request.
