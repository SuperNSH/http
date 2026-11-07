# What ttfbMs can honestly be on 0.4.0 (experiment 5)

## TSX: response headers are observable

The `fetch` promise resolves when the response head arrives; the body
arrives afterwards through the stream. Measured against
scratch/decision/server.ts (drip route: headers immediately, then 4 chunks
300 ms apart; slow route: nothing sent for the delay), on the headless
macOS runner with `network: "live"` (docs/evidence/decision/exp1-tsx-fetch-run.txt):

    E1  drip:      status=200 ttfb=1ms   total=1209ms   (headers at once, body over 1.2 s)
    E1b stream:    status=200 ttfb=1ms   total=315ms
    E1c sse:       first event after 1ms, stream closed after ~907ms
    E6  slow-1200: ttfb=1203ms total=1203ms            (headers only after the server's delay)

An honest ttfbMs on TSX is "request start -> await fetch() resolves".
durationMs is "request start -> body complete". The two differ exactly when
a response streams, which is the case a monitor exists for.

## Rust: nothing is observable before the whole body

`nsh_core::prelude::fetch` resolves once, when the full body is in. The
engine receives `Head` and `Data` events internally
(nsh-core components.rs `fetch_event`: `Head` stored, `Data` accumulated,
the answer delivered only on `End`), but no public API surfaces them.
Measured in the same live run (docs/evidence/decision/exp2-rust-fetch-run.txt):

    R1 drip: status=200 total=1210ms body_len=28   (one resolution, at end of body)
    R2 sse:  status=200 total=907ms  body_len=84   (resolved only after the server closed)

A Rust "ttfb" would equal durationMs. Recording it would be a lie, so for
Rust the monitor sets ttfbMs = null.
