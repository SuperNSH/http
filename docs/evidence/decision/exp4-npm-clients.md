# npm clients in QuickJS on nsh 0.4.0 (experiment 4)

App: scratch/decision/exp-npm (nsh init --template ts), deps installed with
`bun add ky@1 ofetch@1 axios@1` into the app's node_modules (versions:
ky 1.14.3, ofetch 1.5.1, axios 1.21.0). Baseline build with no client:
635 B js / 2.1 KB bytecode.

Each client was imported, actually used against the live experiment server
(GET http://127.0.0.1:<port>/fast), built with `nsh build`, and run under
`nsh test` with `network: "live"`. No `resolve.conditions` changes were
needed for any of them; package.json created by bun was left untouched.

| client  | version | js bundle | bytecode | build | live run |
|---------|---------|-----------|----------|-------|----------|
| ky      | 1.14.3  | 29.8 KB   | 57.3 KB  | ok    | ok (`ky: got fast`) |
| ofetch  | 1.5.1   | 18.4 KB   | 41.0 KB  | ok    | ok after the server sent `content-type: application/json` (ofetch auto-parses JSON only then; otherwise `.route` was undefined) |
| axios   | 1.21.0  | 146.7 KB  | 261.4 KB | ok    | ok (`axios: got fast status=200`) |

Command excerpts:

    $ nsh build scratch/decision/exp-npm   # with ky
    ✓ built ... (29.8 KB js, 57.3 KB bytecode, 6ms)
    $ nsh test scratch/decision/exp-npm    # with ky
    ✓ 1 test: 1 passed, 0 failed (122ms)
    $ nsh build scratch/decision/exp-npm   # with ofetch
    ✓ built ... (18.4 KB js, 41.0 KB bytecode, 6ms)
    $ nsh build scratch/decision/exp-npm   # with axios
    ✓ built ... (146.7 KB js, 261.4 KB bytecode, 16ms)
    ✓ 1 test: 1 passed, 0 failed (125ms)

Reading: all three run on the 0.4.0 QuickJS bundler; the costs are bundle
size and a second abstraction over a fetch that already streams, aborts and
parses JSON. None of them add capability awareness, redirect-refusal
mapping, ERR_ACCESS_DENIED mapping, or NSH stub-network test integration.
ky/ofetch are thin enough to be viable if a fetch-plus-sugar API is wanted;
axios costs ~150 KB js (231x the app baseline) for features the platform
fetch already provides (timeout via signal is not even among them — axios
uses its own CancelToken/timeout machinery).
