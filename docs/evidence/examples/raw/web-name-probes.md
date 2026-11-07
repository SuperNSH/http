Name-by-name probes on `nsh test --target web` (minimal apps in /tmp/webprobe1,
2026-11-07, nsh 0.4.0). Each app imported the name under test from "nsh" and
rendered one text; the test waited for it with a 3 s timeout.

- baseline (no extra imports): rendered ✓
- `effect` imported, called at module scope: rendered ✓
- `untracked` imported, unused: rendered ✓
- `cleanup` imported, called at module scope: rendered ✓
- `computed` imported, unused: rendered ✓
- `computed` called at module scope: BLANK (screen stayed empty; the page
  never rendered) — measured twice, deterministic
- `lifecycle` imported (used or not): BLANK — the page reports
  `SyntaxError: The requested module 'nsh' does not provide an export named
  'lifecycle'`
- full demo bundle: BLANK (its import list includes `lifecycle`, pulled in by
  nsh-query's compiled code)
- demo bundle with nsh-query tree-shaken out (createQuery stubbed): rendered ✓
- dynamic `await import("nsh-query")` as a load-time workaround: BLANK — the
  bundler does not split it into a separately linked chunk, so the main bundle
  still fails linking
