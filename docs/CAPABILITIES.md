# Capabilities

The complete inventory of what the bridge does today, and what it deliberately
does not. Each line below is backed by either a unit/integration test or a
hardware validation certificate in this directory.

"Certified" means the operation was run against a connected Analog Rytm MKII on
OS 1.72, verified by readback, and the device restored to its exact raw
pre-test state. The dated `HARDWARE_VALIDATION_*.md` files are those
certificates.

## Control plane

- Inspect compact device and pattern state.
- Validate persistent operation deltas before anything is dispatched.
- Queue operation sets for musical boundaries.
- Simulate transport boundaries against a mock Rytm transport.
- Apply queued operations and emit journaled acknowledgements.
- Create snapshots and roll back with monotonic revisions.
- Send realtime MIDI operations.
- Expose a standalone MCP-style adapter surface.
- Start, monitor, and close a long-running Rust daemon from TypeScript.
- Route daemon health and compact state/pattern inspection through versioned
  JSON-lines RPC.
- Route validation, deltas, queues, realtime gestures, snapshots, rollback,
  reconciliation, and event reads through Rust in mock mode.
- Emit asynchronous acknowledgement/state events with monotonic cursors.
- Reject in-flight work on daemon disconnect; support a clean process restart.
- Replay identical request IDs and reject conflicting ID reuse.

## Hardware: MIDI and SysEx

- Discover the Analog Rytm through CoreMIDI.
- Query and compactly summarize pattern, kit, global, and settings work
  buffers.
- Reconcile a minimal MIDI receive profile idempotently.
- Send notes, transport, clock, CC, NRPN, and program changes.
- Create and read back trigs, velocities, conditions, microtiming, track
  lengths, time mode, and filter parameter locks.
- Preserve raw SysEx baselines and verify hardware rollback.

## Hardware: state and mutation

- Inspect complete work-buffer Sound, Kit, FX, Global, routing, MIDI,
  sequencer, and Settings state.
- Validate and dry-run delta operations against decoded hardware state.
- Apply idempotent Sound, machine, Kit, FX, routing, Global, and Settings
  deltas immediately.
- Canonicalize codec-quantized values before desired-vs-observed comparison.
- Snapshot raw Pattern, Kit, Global, and Settings objects and restore them with
  semantic verification.
- Persist hardware queues, snapshots, revisions, observations, and events
  across daemon restart.
- Resolve `next_step`, `next_beat`, `next_measure`, `next_pattern`, and
  pattern-step targets against an explicit transport epoch.
- Generate 24 PPQN clock or follow observed MIDI realtime input, without
  wall-clock boundary guesses.
- Expose hardware queue, track trigger, track-level CC/NRPN, transport, and
  pattern-change RPC methods.
- Reconcile on reconnect, reject or roll forward stale-epoch work, and clean up
  transport/notes on shutdown.
- Certified: multi-object automatic rollback after an injected readback
  verification failure.

## Audio capture

- List CoreAudio inputs; report the Rytm's channel, sample-rate, and
  sample-format capabilities.
- Start, stop, and run bounded 48 kHz stereo WAV captures with atomic
  finalization and authoritative state sidecars.
- Detect silence, clipping, duration mismatch, dropped callback blocks,
  disconnects, and stale partial files.
- Expose class-compliant audio through Rust RPC and four semantic MCP tools.
- Certified: an audible bounded hardware recording, with the disposable
  Pattern/Global baseline restored.

## Overbridge multitrack (optional)

- Discover the installed Overbridge provider and capture synchronized Main,
  eight physical voice-group, and external-input stems from one CoreAudio
  stream.
- Certified: non-silent Main and voice-group stems, exact frame alignment,
  callback timing, no drops or disconnects, idempotent recording replay, and
  raw state rollback.

## Samples

- Inspect +Drive, all 127 RAM slots, and track sample assignments through the
  pinned Elektroid fork.
- Validate, upload, download, and content-identify WAV samples without
  duplicate transfers.
- Resolve managed samples into RAM, assign them declaratively to Sounds, verify
  readback, roll back the Kit, and clear RAM safely.

## Scenes and Performance macros

- Inspect all 12 Scene and Performance definitions with semantic voice/FX lock
  targets.
- Declaratively set, replace, copy, and clear Scene and Performance locks
  through revisioned Kit writes.
- Activate or deactivate Scenes and set Performance amounts through transient
  CC/NRPN controls, without changing the persistent revision.
- Certified: macro operation-set replay, device readback, and exact raw Kit
  rollback.

## Songs

- Inspect the work-buffer Song, any stored Song, or all 17 Song objects, with
  optional compact Pattern/Kit references.
- Declaratively name Songs and replace, insert, update, move, copy, remove, or
  clear rows containing chains, repeats, and per-position track mutes.
- Apply Song deltas immediately or at musical boundaries with revision checks,
  idempotent IDs, readback, snapshots, and rollback.
- Certified: all supported Song row operations, next-beat scheduling, unchanged
  Pattern activation, and exact raw rollback.

## Not implemented

- **Overbridge plug-in hosting and DAW automation.** Explicitly unsupported.
  The optional multitrack *capture* provider above is separate and is hardware
  certified.
- **Song tempo/length overrides, jumps, loops, labels, explicit end markers,
  and Song activation.** Unavailable.

## Firmware scope

The `rytm-rs` adapter targets firmware 1.70. The Song and audio workflows above
are hardware-certified on a connected firmware 1.72 device. Neither fact is a
blanket compatibility guarantee for other firmware revisions — the bridge
gates unknown-capability operations rather than guessing.
