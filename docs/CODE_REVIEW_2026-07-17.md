# Second-Opinion Code Review — 2026-07-17

Full-repo review at commit `449e644` ("Certify complete reversible control plane").
Method: five parallel review passes (Rust hardware core; Rust state/RPC; Rust
audio/samples/Overbridge; TypeScript control plane; repo hygiene/docs), with the
highest-severity claims re-verified against the source before inclusion.

Baseline at review time: `npm test` 23/23 green, `cargo test` 50/50 green,
`cargo clippy --all-targets` zero warnings, `cargo fmt --check` clean.

**Disposition** column: `fixed` = fixed in the 2026-07-17 review session,
`deferred` = documented here, intentionally not fixed yet, `owner` = needs a
project-owner decision.

---

## Verdict

The architecture is genuinely strong: the delta/revision/snapshot/rollback
model, atomic persist and capture finalization, idempotent replay, and
capability evidence are all real and mostly correctly implemented, and the
hardware certification harnesses are far beyond what most hobby-scale bridges
ever get. The defects cluster in three places: **error-path resilience** (a
handful of recoverable errors are treated as fatal, and two panics are
reachable from device-controlled data), **unbounded growth** (event/operation
journals and sample staging are never pruned), and **process discipline**
(no type-checking ever ran, no CI, no LICENSE). None of the certified happy
paths were found to be wrong.

---

## Critical (all verified against source)

### C1. Recoverable `poll()` errors kill the whole daemon — `daemon/src/rpc.rs:730`, `daemon/src/hardware_control.rs:793-802` — **fixed**
`serve_stdio` propagates `poll_messages()?`, and `poll()` propagates
`try_reconnect`/`process_observed_midi`/`send_generated_clock` errors. A USB
cable pulled mid-playback in generated-clock mode returns `Err` from the clock
send (after `mark_disconnected`), which exits the process — defeating the
entire reconnect machinery. Same for `persist()` failures inside poll.
Fix applied: poll errors are contained, surfaced as `connection.lost` events,
and the loop continues; reconnect logic now gets the chance to run.

### C2. One unresolvable rolled-forward operation permanently wedges reconnect and transport start — `daemon/src/hardware_control.rs:1051` — **fixed**
In the `LatePolicy::RollForward` arm of `reconcile_queued_epochs`, a
`resolve()` failure (e.g. a `pattern_step` target whose pattern is no longer
active) propagates with `?`, aborting the whole reconciliation — which runs on
every reconnect, transport start, and observed `0xFA`. Because the record is
durable, it reloads as `Queued` and re-poisons every subsequent attempt
forever. Fix applied: a resolve failure now rejects that record
(`not_applied`) and reconciliation continues.

### C3. Panic on device-controlled track index — `daemon/src/hardware.rs:2634` — **fixed**
`TRACK_NAMES[settings.selected_track()]` indexes a 12-element array with a
value decoded straight from device SysEx. The FX track (index 12) or any
corrupt value panics the daemon inside `state_summary`, which runs on every
inspect/reconcile/poll. Neighboring code already uses checked `.get()`.
Fix applied: checked lookup with an `FX`/`track-N` fallback.

### C4. Panic on malformed device Song data — `daemon/src/hardware.rs:2366` — **fixed**
`song_summary(...).expect("typed work-buffer Song remains valid")` inside the
infallible-signature `state_summary`. A work-buffer Song whose `rows()`
accessor errors (firmware variance) crashes the daemon on every inspect.
Fix applied: falls back to an error-annotated placeholder summary.

### C5. Full historical event log replays to the client after every daemon restart — `daemon/src/rpc.rs:172` — **fixed**
`emitted_event_cursor` starts at 0 and is never seeded from the persisted
store, but hardware events survive restart. The first poll after restart
re-emits every historical event as fresh pushes. Compounds with C6/T4: pushed
events carried no cursor, so the TypeScript client could not dedupe.
Fix applied: the cursor is seeded from the backend's last persisted cursor at
startup, and pushed event envelopes now include `cursor`.

### C6. One bad stdin line (non-UTF-8 / I/O error) exits the daemon — `daemon/src/rpc.rs:722` — **fixed**
Malformed JSON gets a structured `invalid_json` error, but a line failing
UTF-8 decoding propagates `line?` out of `serve_stdio`. Fix applied: read
errors are reported on stderr and the serve loop continues.

### T1. A single non-JSON daemon stdout line rejects ALL in-flight requests — `src/rpc/RustDaemonClient.ts:365-376` — **fixed**
`handleLine` called `rejectAll` on any `JSON.parse` failure, so one stray
`println!`/panic line failed every pending request with
`invalid_daemon_response` even though the daemon was healthy. This is the
mirror image of C6. Fix applied: unparseable lines are logged to stderr and
skipped; teardown happens only on stream close/error.

### T2. Type-checking has never run; provably dead code shipped — `src/rpc/types.ts:135-157` — **fixed**
A duplicate `import type` block after the interface body would be a
"duplicate identifier" error under `tsc`; it survives because
`--experimental-transform-types` strips types without checking, and the repo
had no tsconfig, no `typescript` dependency, and no typecheck script. Fix
applied: dead block removed; strict `tsc --noEmit` added (`npm run
typecheck`), wired into `npm run check`, and all surfaced strict-mode errors
fixed.

---

## High

### H1. Blocking SysEx apply on the generated-clock path stalls MIDI clock — `daemon/src/hardware_control.rs:1136-1158`, `daemon/src/hardware.rs:599-647` — **deferred (architectural)**
When a queued operation becomes due in generated-clock mode, the full
read/write/verify cycle (fixed 450–750 ms sleeps; snapshot = 16 stored-song
reads) runs inline in the same loop that emits `0xF8`, so a slaved Rytm
audibly stalls at exactly the boundary the operation targeted. Needs a
dedicated clock thread or apply-worker. Interim mitigation: schedule writes
while the transport is stopped, or use observed clock for live work (the
Rytm's own clock keeps running regardless).

### H2. No SysEx request/response correlation — `daemon/src/hardware.rs:153-201` — **deferred**
`request()` returns the first complete SysEx received; a late response to a
timed-out earlier query can be returned as the answer to the next one,
shifting every subsequent object read. Needs response-header validation
against the request type. Not observed in practice (8 s timeout is generous),
but it is silent-corruption class when it hits.

### H3. Hardware write precedes durable persist; non-idempotent ops can double-apply — `daemon/src/hardware_control.rs:1206-1238` — **deferred**
Crash between device write and `persist()` reloads the op as `Queued` with a
still-matching revision; `InsertSongRow`/`CopySongRow` then duplicate a row on
restart. Needs an intent marker persisted before the write or
observed-state reconciliation before re-apply.

### H4. Note-off queue dropped on transient send failure — `daemon/src/hardware_control.rs:1068-1082` — **fixed**
`pending_note_offs` was fully taken; the first failed send `break`s and
discards every remaining note-off, leaving notes ringing. Fix applied:
unsent entries are pushed back for the next poll.

### H5. `elektroid-cli` subprocess has no timeout — `daemon/src/samples.rs:634-640` — **fixed**
A wedged CLI (device mid-reboot, flaky USB) blocked the RPC thread forever.
Fix applied: bounded wait with kill-on-expiry.

### H6. Real-time audio callback allocates and locks — `daemon/src/audio.rs:930-955`, `daemon/src/overbridge.rs:902-924` — **deferred (documented)**
`submit_input` does `Vec::with_capacity` and `SyncSender::try_send`
(mutex-backed in std) on the CoreAudio real-time thread; the notice path
allocates too. Under contention this converts a scheduling hiccup into
dropped blocks, which Overbridge escalates to a failed capture. Either move
to a preallocated lock-free ring (e.g. `rtrb`) or explicitly narrow the
"real-time safe" claim to "bounded-queue, drop-on-overflow capture".

### H7. Overbridge client summary can disagree with the actual capture config — `daemon/src/overbridge.rs:500` vs `:681-686` — **fixed**
`selected_device_summary` picked its configuration with `max_by_key` (last
wins on ties) while the capture path uses strict-`>` first-wins scoring, and
the scoring logic was duplicated. A device advertising two equal-scoring
configs reports one config while capturing with another. Also, a missing
`maxSampleRate` nulled the whole summary while `available` stayed `true`.
Fix applied: one shared selection function feeds both the capture path and
the summary.

### H8. Overbridge finish-marker failure skips writer join and loses the real error — `daemon/src/overbridge.rs:360-365` — **fixed**
`send(...)?` early-returned when the writer had died (e.g. disk full),
discarding the writer's actual error and leaving `.partial` stems. Fix
applied: mirrors the audio.rs pattern — record the failure, still join the
writer, surface its error.

### H9. Two daemons can share one state file unguarded — `daemon/src/hardware_scheduler.rs:329-352` — **fixed**
Nothing prevented a second `serve` from loading the same
`hardware-state.json`; last-writer-wins silently discards the other's
operations and revisions. Fix applied: advisory `File::try_lock` held for the
daemon lifetime; a second instance refuses to start.

### H10. `persist()` temp-file name is shared and the directory entry is never fsynced — `daemon/src/hardware_scheduler.rs:362-385` — **fixed**
Content fsync + atomic rename were already correct; but the fixed
`.json.tmp` name races concurrent writers, and without a directory fsync the
rename may not survive power loss. Fix applied: PID-unique temp name plus
parent-directory `sync_all` after rename.

### T3. Six hardware entrypoints silently no-op on the declared minimum Node — `src/bin/verify-hardware-*.ts` — **fixed**
They gated on `import.meta.main`, which is `undefined` before Node 22.18 /
24.x, while `engines` declares `>=22.14` — `npm run hardware:audio` et al.
would load and exit silently on the supported floor. Fix applied:
standardized on the `import.meta.url === file://argv[1]` guard already used
by `verify-hardware-all.ts`.

### T4. Streamed events and cursor paging could not be reconciled — `src/rpc/types.ts:74-79` — **fixed**
Pushed events carried no cursor, so a client that pages `events.read` then
subscribes cannot dedupe or gap-fill. Fixed together with C5: pushed
envelopes now carry `cursor`, and the TS event type includes it.

### T5. No stream error listeners; an async EPIPE could crash the whole process — `src/rpc/RustDaemonClient.ts:121-126` — **fixed**
No `error` handlers on `child.stdin`/`child.stdout`; Node's default for an
unhandled stream `error` event is a process-level throw. Fix applied:
handlers route into the existing disconnect/reject path.

### T6. `close()` could hang forever — `src/rpc/RustDaemonClient.ts:303-318` — **fixed**
SIGTERM after 2 s but no SIGKILL escalation and no bound on the awaited
close. Fix applied: SIGTERM → SIGKILL escalation with a bounded wait.

### T7. EventJournal refuses to start after a torn final line — `src/service/EventJournal.ts:22-33` — **fixed**
A crash mid-append leaves a half-written last line; `init()` threw on it and
the service became permanently unstartable. Fix applied: malformed trailing
lines are skipped with a warning.

---

## Medium

- **M1 — Unbounded journals, full-file rewrite per mutation** —
  `daemon/src/hardware_scheduler.rs:354-400`, snapshots embed full raw SysEx.
  Persist latency and file size grow without bound over a long session; each
  live tweak rewrites the whole document with fsync on the MIDI-servicing
  thread. Needs retention caps and out-of-line snapshot blobs. **deferred**
- **M2 — Idempotent replay evaporates after 1024 requests or a restart** —
  `daemon/src/rpc.rs:27`; `snapshot.rollback` has no state-level idempotency
  key, so a retried rollback after cache eviction double-applies (revision
  bumps twice). Document `expectedRevision` as required for safe retries, or
  persist the replay watermark. **deferred**
- **M3 — Snapshot rollback is a partial restore** — `daemon/src/state.rs:406`:
  active scene, performance amounts, and sample-RAM state are not captured.
  Either include them or document the exclusion. (Mock-side; hardware
  snapshots restore raw objects.) **deferred**
- **M4 — Reconnect assumes stopped transport; observed-clock step tracking
  never starts if the device is already playing** —
  `daemon/src/hardware_control.rs:878-884`. Queued boundaries never fire
  after a mid-playback reconnect in observed mode until a fresh `0xFA`.
  **deferred**
- **M5 — Readback verification races a playing sequencer** —
  `daemon/src/hardware.rs:649-686`: byte-compare against a work buffer being
  mutated by playback can false-mismatch and roll back a successful write.
  Verify only touched fields, or quiesce. **deferred**
- **M6 — Required MIDI receive config never enforced in the control path** —
  `daemon/src/hardware.rs:2867-2881` exist but only tests call them; a device
  with CLOCK RECEIVE off silently desyncs from every boundary. Warn or repair
  on connect. **deferred**
- **M7 — Stringly-typed error classification** —
  `daemon/src/hardware_control.rs:1607-1616`, `rpc.rs:781-796`: substring
  matching on error text decides disconnect-vs-validation; every SysEx
  timeout is treated as a disconnect. Move to typed error variants.
  **deferred**
- **M8 — TS domain validation runs only on the mock path** —
  `src/mcp/RytmMcpAdapter.ts`: daemon-backed tools cast and forward args
  unvalidated; the Rust daemon is the only guard in production. Either
  enforce the advertised `inputSchema` at the boundary or explicitly scope
  TS validation as mock-only. **deferred (design decision)**
- **M9 — `RytmAgentService` duplicates the daemon state machine (~800 lines)**
  and the mock/durable stores derive event cursors differently
  (`len()+1` vs `last+1`) with different `events.read` default limits
  (100 vs 1000). Drift is guaranteed; extract a shared core or demote the TS
  service explicitly to a demo artifact. **deferred**
- **M10 — Silent daemon respawn on any disconnect** —
  `src/rpc/RustDaemonClient.ts:147-153`: any request after a crash silently
  starts a fresh daemon, masking crashes mid-workflow. Make restart opt-in or
  emit an event. **deferred**
- **M11 — Global daemon failures with `id: null` were silently dropped** —
  `src/rpc/RustDaemonClient.ts:382`. **fixed** (surfaced with a stderr
  warning).
- **M12 — Sample staging/verification files never cleaned up** —
  `daemon/src/samples.rs:491-518`: each upload leaves a staged WAV and a
  verification directory behind forever. **fixed** (removed after successful
  verification).
- **M13 — RPC envelope rejects unknown fields and exact-matches the schema
  string** — `daemon/src/rpc.rs:70-78,245-256`: no forward-compatible
  evolution path (a client adding an optional `traceId` is rejected
  wholesale). Drop `deny_unknown_fields` on the outer envelope; match a
  major-version prefix. **deferred**
- **M14 — Metadata-write failure strands a finished recording ID** —
  `daemon/src/audio.rs:723-735`, `daemon/src/overbridge.rs:216-227`: after
  stems finalize, a failed `recording.json` write makes the same
  `recordingId` unretryable (directory exists, no metadata to replay).
  **deferred**

## Low / process

- **L1 — No LICENSE.** Rights undefined even as a private repo. **owner**
- **L2 — README missing prerequisites** (macOS-only constraint, Rust
  toolchain, Node ≥22.14) and the docs index omitted `ARCHITECTURE.md`.
  **fixed**
- **L3 — No CI.** `npm run check` enforced nowhere. **fixed** (GitHub Actions
  workflow on a macOS runner: TS tests, typecheck, cargo test).
- **L4 — No MSRV declaration.** **fixed** (`rust-version` in Cargo.toml;
  `File::try_lock` requires ≥1.89).
- **L5 — Personal-fork supply chain**: `algonormative/rytm-rs` (git-pinned by full
  revision — good) and `algonormative/elektroid` (pinned only by a commit hash in
  docs/error text) are single points of failure. Mirror or vendor; enforce
  the elektroid version at runtime if feasible. **owner**
- **L6 — No `v0.1.0` tag anchoring the certification milestone.** **owner**
- **L7 — `hardware.rs` (3.5k lines) and `types.ts` (825 lines) are
  monoliths**; several helpers (`TRACK_NAMES`, `error_string`,
  track-index parsing) are duplicated across modules with subtle differences.
  Split by concern when the next feature lands. **deferred**
- **L8 — Fixed 450/750 ms write-pacing sleeps** (`daemon/src/hardware.rs:572-645`)
  are guesswork; prefer readback-with-retry. **deferred**
- **L9 — No standalone MCP server binary**: `RytmMcpAdapter` is in-process
  only (used by tests and the mock demo); an external agent session cannot
  register the 33 tools over the MCP protocol the way `pd-agent-bridge`
  exposes its endpoint. Given the combined-jam plan, this is the
  highest-leverage missing feature. **deferred (feature)**

## Found by the new type checker (fix-session addendum)

Enabling strict `tsc` immediately surfaced, beyond the dead import block:

- `test/validation.test.ts` passed phantom `step: undefined as never`
  properties on `set_track_length` and `assign_sample_slot` operations —
  the excess properties masked what the operation types actually accept
  (removed).
- `src/bin/verify-hardware-songs.ts` compared `appliedName` (statically
  `"BRIDGE ALT" | "BRIDGE CERT"`) against `"QUEUE CERT"` — a dead comparison;
  the intent (pick a queued name differing from the applied one) now works on
  a `string`-typed value.
- Three verify scripts' `requiredNumber` helpers asserted
  `typeof value === "number"` in a way that never narrowed the type.
- `RustDaemonClient` accepted caller request IDs typed as UUID template
  literals only, rejecting the documented "caller owns request IDs" contract
  at the type level.

## Test-coverage gaps (highest value first)

1. Daemon restart does not re-emit persisted events (guards C5).
2. Disconnect during generated clock keeps the daemon alive (guards C1).
3. Roll-forward with an unresolvable boundary rejects per-record (guards C2).
4. Malformed/out-of-range device data through `state_summary` (guards C3/C4).
5. `RustDaemonClient` unit tests with a fake child process: garbage stdout,
   timeout firing, mid-write death, `close()` escalation (guards T1/T5/T6).
6. Crash-between-write-and-persist replay of non-idempotent song ops (H3).
7. SysEx desync via late response (H2).
8. `samples.rs` CLI-level flows (only parsers/validators are tested today).
9. Overbridge tie-break: summary config == capture config (guards H7).

## Done notably well

- Temp-file + fsync + atomic-rename discipline for state persist and all
  audio finalization, with stale-`.partial` detection.
- Optimistic concurrency done right: `expected_revision` re-validated at the
  apply boundary, not just submission; boundary due-ness uses `>=` so a
  missed boundary fires late instead of never.
- Rollback and acknowledgement semantics (`verified` / `rollback_verified` /
  `rollback_failed`) are honest, and readback failure auto-restores baselines.
- Idempotency: stable-payload replay, `request_id_conflict` on divergent
  reuse, identity-guarded sample RAM ops — all tested.
- Repo hygiene: 83 MB of run artifacts correctly gitignored; lockfiles
  committed; single git dependency pinned to a full immutable revision;
  disciplined Implement → Document → Certify commit cadence; firmware-
  compatibility claims consistently scoped as evidence, not guarantees.
- Docs/README claims spot-checked accurately against CLI flags and scripts.
