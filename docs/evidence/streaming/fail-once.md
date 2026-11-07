# Mutation round: streaming, SSE and multipart (2026-11-07)

Per docs/PROMPT.md §Hard rules, every new test in this area was seen to fail
against a deliberate break in `crates/nsh-http/src` (or, for one structural
property, in the test's own subject), the failure was confirmed to name the
right thing, and the code was restored. Files mutated: `src/sse.rs`,
`src/streaming.rs`, `src/multipart.rs`. Restores were verified by `diff`
against snapshots after every run; the full suite is green after the round.

Mutations are numbered in run order. "LIVE:" rows are `tests/live_streams.rs`
runs against the real echo server (`cargo test -- --ignored`).

## sse.rs

| # | Mutation (break) | Test that caught it | Failure observed |
|---|---|---|---|
| 1 | parser: `data:` lines overwrite instead of join | (unit) `id_event_data_and_retry_lines_build_events` | data `"two"` ≠ `"one\ntwo"` |
| 2 | parser: `\r` no longer terminates a line | (unit) `crlf_and_cr_line_endings_all_parse` | 0 events ≠ 1 (`\r`-separated lines never split) |
| 3 | parser: blank line dispatches even with empty data | (unit) `comments_unknown_fields_and_empty_events_stay_out` | `data:\n\n` dispatched an event the test forbids |
| 4 | parser: buffer cleared after each feed (partial-line retention gone) | (unit) `chunk_splits_inside_lines_and_utf8_scalars_are_safe` and `an_unterminated_line_waits_for_its_newline` | both: 0 events ≠ 1 (split/mid-UTF-8 and trailing lines lost) |
| 5 | parser: BOM strip removed (test feeds the BOM on the first `data:` line, so a kept BOM mangles the field name) | (unit) `a_bom_is_dropped_and_an_invalid_retry_is_ignored` | 0 events ≠ 1 |
| 6 | parser: `id` NUL-byte guard removed | (unit) `an_id_with_a_nul_is_ignored` | `last_id = Some("bad\0id")` ≠ `None` |
| 7 | backoff: `.min(self.max)` cap removed | (unit) `backoff_grows_to_its_cap_and_the_server_retry_overrides_it` | delay(4) `2.7s` ≠ `1s` |
| 8 | loop: server `retry:` override ignored | `the_server_retry_field_sets_the_reconnect_delay` | FAILED (reconnect gap hit the 1000 ms default, not 250) |
| 9 | loop: reconnect's `Last-Event-ID` header dropped | `a_reconnect_carries_last_event_id_after_backoff_and_stops_on_cancel` | FAILED (second connect's recorded header `None` ≠ `Some("2")`); LIVE: `sse_reconnects_with_last_event_id_and_replays_from_it` — header `None` ≠ `Some("3")` |
| 10 | `Race` ignores the cancel token (both checks removed) | `a_cancel_during_the_backoff_stops_the_loop_before_the_next_connect` | FAILED. A first mutation attempt passed because the loop-top token check masked it (cancel noticed only after the full backoff); the test was strengthened to demand a PROMPT stop (`run_for(200 ms)` — far under the 1000 ms backoff) and then caught it. Both the strengthened test's green run and the mutation's red run were observed. |
| 11 | non-2xx connect ends the source `Ok(())` instead of `Err(HttpStatus)` | `a_non_2xx_connect_ends_the_source_without_a_reconnect` | FAILED (`"status 503"` never shown) |
| 12 | content-type refusal removed entirely (the loop then reconnects forever on a JSON body) | `a_json_body_is_refused_without_a_reconnect` | FAILED at `wait_for`'s 5 s timeout (the reconnect loop never ended — the structural "no reconnect" is what failed); LIVE: `a_non_event_stream_is_refused_without_a_reconnect` — same, 5.01 s |
| 13 | `max_attempts` off by one (`failures + 1 >=`) | `failed_connects_back_off_and_exhaust_the_attempt_bound` | requests 1 ≠ 2 (gave up one connect early) |
| 14 | `listen` detaches the loop (`nsh_core::prelude::spawn` inside; the `+ 'static` callback bound the detach forces is part of the mutation, with the one borrowing call site adapted) | `dropping_the_listen_task_leaves_no_orphan_connects` | requests 10 ≠ 1 — after the caller's task was cancelled, the orphan loop kept reconnecting. This is the orphan-task failure mode the "spawns nothing" design prevents. |

## streaming.rs

| # | Mutation (break) | Test that caught it | Failure observed |
|---|---|---|---|
| 15 | `download` reports progress twice | `a_download_reports_the_whole_body_once_with_the_content_length_total`; LIVE: `the_stream_arrives_whole_with_one_progress_report` | both FAILED (exact `reports=[...]`/`reports=1` strings broke) |
| 16 | `download` invents a total when `Content-Length` is absent (`.or(Some(len))`) | `without_a_content_length_the_total_is_none_and_the_byte_count_stands` | `total=None` never shown |
| 17 | `content_length_of` always `None` | (unit) `content_length_reads_the_header_case_insensitively_or_not_at_all` (`None` ≠ `Some(42)`); `a_download_reports...` FAILED; LIVE: `bytes_download_matches_its_content_length` FAILED (`total=None`) |
| 18 | `upload` reports zero bytes sent | `an_upload_sends_its_whole_body_and_reports_the_exact_size_once` | FAILED (`reports=[0 of Some(0)]` shape broke the exact string) |
| 19 | `download` fires progress even when the request errors | `a_non_2xx_download_is_a_status_error_and_never_reports_progress` | `failed status=500 reports=0` never shown (a report fired on the error path) |

## multipart.rs

| # | Mutation (break) | Test that caught it | Failure observed |
|---|---|---|---|
| 20 | `escape` is identity (no `%22`/`%0D`/`%0A`) | (unit) `names_and_filenames_are_escaped` | `name="quo\"te..."` unescaped on the wire |
| 21 | file parts' `Content-Type` line dropped | (unit) `only_file_parts_carry_a_content_type` AND `the_wire_format_is_exact_parts_in_order_with_a_close` | both FAILED (count 0 ≠ 1; exact body mismatch) |
| 22 | boundary collision check disabled (`parts_contain` → `false`) | (unit) `boundary_collisions_fail_fixed_and_reroll_generated` (`Ok([45, 45, 88, ...])` ≠ `Err(BoundaryCollision)`); `a_boundary_collision_fails_before_any_request_goes_out` — the unencodable form went out on the wire |
| 23 | `MultipartForm::send` drops the content-type header | `a_form_posts_its_content_type_and_exact_bytes_through_the_client` | wire content type `application/json` ≠ `multipart/form-data; boundary=...` (the client's JSON stamp leaked through — exactly the seam the core fix closes); LIVE: `a_multipart_form_is_parsed_by_the_real_server` FAILED (server 400 `not_multipart`) |
| 24 | `content_type()` omits the boundary | (unit) `the_content_type_names_the_boundary` | `"multipart/form-data"` ≠ `"multipart/form-data; boundary=nsh-test-boundary"` |
| 25 | boundary length check dropped | (unit) `boundaries_outside_the_rfc_set_are_rejected` | 71-character boundary accepted |
| 26 | generated boundary is a constant | (unit) `generated_boundaries_are_legal_and_distinct` | `assert_ne` failed: `"nsh-http-fixed"` == `"nsh-http-fixed"` |

## Notes

- Two mutations initially did not reproduce a failure and were redone rather
  than recorded as passes: #10 (the loop-top cancel check masked the Race
  mutation — the test now pins prompt cancellation, not just eventual
  termination) and #5's test (the BOM originally sat on a `retry:` line, where
  a kept BOM produced the same observable result — it now sits on the first
  `data:` line).
- One operational incident during the round, disclosed: a mis-pathed restore
  briefly overwrote `tests/sse.rs` and `src/sse.rs` with each other's
  contents mid-round. Both were reconstructed (the test file from its authored
  content, the source from the tracked baseline), verified green (7 engine
  tests + 8 unit tests), and re-snapshotted before the round continued.
