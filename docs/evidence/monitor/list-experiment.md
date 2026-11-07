# The calls list is `Each` in a `Scroll`, not `List`: measured on 0.4.0

The ready screen must sort recorded calls by `durationMs` descending with the slow
call on top (satisfaction criterion 7), and the slow call lands last: the screen
fires `/fast` and `/slow?delay=1200` together, and only the slow answer carries a
1200 ms delay. PROMPT.md asks for `List`, so the List-compatible design was tried
first, twice, on the real screen with the manual-clock unit test
(`examples/monitor-app/tests/unit/ready.test.ts`). Variant A is exactly the
proposed fix: the events signal gets a fresh sorted copy of the ring buffer
assigned in one shot on every recording (`calls.set([...monitor.events()].sort(...))`,
not an in-place reorder or append), and `List` takes `each={visible()}` with a
`keyExtractor`. It failed: the slow row rendered at the bottom, in insertion
order, while the same data was provably in the signal (the header's aggregate on
the same screen read "p95 1200 ms"). Variant B removed the `keyExtractor` so the
list falls back to index identity — identical failure. Both runs are captured
verbatim below; a minimal probe earlier that day agreed (a bulk sorted set
rendered correctly when the list was built from empty, but no incremental update
ever reordered cells, and filter narrowing — pure removals — worked). `Each`
reorders correctly because it is keyed, so the calls list ships as `Each` in a
`Scroll`; the ring buffer bounds the collection, which is the lists skill's own
criterion for `Each` over a virtualized list. What a List-compatible fix would
need from upstream is re-running the row diff when the array's order changes, not
only when its length grows or items are removed.

## Variant A — one-shot sorted reassignment, List with keyExtractor

Command: `nsh test tests/unit/ready.test.ts` (headless, manual clock), after
changing only the ingest and the container:

```tsx
const ingest: Observer = (event) => {
  monitor.record(event);
  // LIST-EXPERIMENT A: fresh sorted copy assigned in one shot per recording.
  calls.set([...monitor.events()].sort((a, b) => b.durationMs - a.durationMs));
};
...
<List class="flex-1" contentClass="px-4 pb-4" each={visible()}
  estimatedItemSize={52} keyExtractor={(event) => event.id}
  separator={<View class="h-px bg-border" />} testID="call-list">
  {(event) => <CallRow event={event} />}
</List>
```

Verbatim output (2026-11-07, nsh 0.4.0 e626a8d):

```text
✓ bundled App.tsx (28449 B in 6.1 ms)
✗ tests/unit/ready.test.ts › start records slow and fast, slow on top, with per-host aggregates (116ms)
    expected 13 to be less than 9
    at <anonymous>(tests/unit/ready.test.ts:26:29)
    on screen: ["Network monitor", "Recording calls on http://127.0.0.1:8123", "127.0.0.1", "3 calls · 0% errors · p50 0 ms · p95 1200 ms", "GET", "/health", "0 ms", "HTTP 200 · ttfb 0 ms", "GET", "/fast", "0 ms", "HTTP 200 · ttfb 0 ms", "GET", "/slow?delay=1200", "1200 ms", "HTTP 200 · ttfb 1200 ms"]
✓ tests/unit/ready.test.ts › the filter narrows the calls by host or path (108ms)
✓ tests/unit/ready.test.ts › when no echo server answers, the screen says so and records the failed probes (2ms)
error 3 tests: 2 passed, 1 failed (232ms)
```

The on-screen dump shows `/health`, `/fast`, `/slow?delay=1200` in that order —
insertion order, not the sorted array the List received (slow is 1200 ms, the
others 0 ms), while the aggregate line "p95 1200 ms" proves the sorted data was
in the signal.

## Variant B — same, without keyExtractor

Only change: `keyExtractor` deleted, so the List falls back to index identity.

Verbatim output (2026-11-07, nsh 0.4.0 e626a8d):

```text
✓ bundled App.tsx (28411 B in 7.2 ms)
✗ tests/unit/ready.test.ts › start records slow and fast, slow on top, with per-host aggregates (120ms)
    expected 13 to be less than 9
    at <anonymous>(tests/unit/ready.test.ts:26:29)
    on screen: ["Network monitor", "Recording calls on http://127.0.0.1:8123", "127.0.0.1", "3 calls · 0% errors · p50 0 ms · p95 1200 ms", "GET", "/health", "0 ms", "HTTP 200 · ttfb 0 ms", "GET", "/fast", "0 ms", "HTTP 200 · ttfb 0 ms", "GET", "/slow?delay=1200", "1200 ms", "HTTP 200 · ttfb 1200 ms"]
✓ tests/unit/ready.test.ts › the filter narrows the calls by host or path (111ms)
✓ tests/unit/ready.test.ts › when no echo server answers, the screen says so and records the failed probes (2ms)
error 3 tests: 2 passed, 1 failed (240ms)
```

Identical rendering. After both variants the screen was restored to
`Each` in a `Scroll` and the app gates were rerun green (check exit 0, build zero
warnings, `4 passed, 0 failed` including the live capture test).
