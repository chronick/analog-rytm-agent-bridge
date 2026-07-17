# Analog Rytm Agent Bridge

Standalone control plane for agentic Analog Rytm work.

This repo is intentionally separate from `pd-agent-bridge`. The two tools are meant to run side by side in a larger human/agent performance setup, but the coding agent is the only glue between them. The Rytm bridge should remain useful on its own for inspecting, validating, queueing, and applying Rytm operations.

## Shape

- TypeScript MCP/API facade for agent-facing semantic tools.
- Rust daemon boundary for hardware state, SysEx, MIDI, snapshots, rollback, and firmware compatibility.
- Standard MIDI for realtime gestures.
- SysEx/state lane for persistent edits.
- Class-compliant CoreAudio stereo capture for closed-loop analysis and archival.
- Delta operations instead of whole-project regeneration.
- Compact state summaries for agents.

The repo contains three connected vertical slices:

- a hardware-independent TypeScript control plane with a mock Rytm transport;
- a Rust/CoreMIDI hardware harness for bidirectional SysEx inspection, realtime MIDI, declarative configuration, verified pattern writes, snapshots, and rollback.
- a versioned JSON-lines process boundary that connects every TypeScript semantic tool to a long-running Rust mock or hardware daemon.

The Rust mock daemon owns revisioned deltas, dry runs, queue scheduling, snapshots, rollback, realtime state, reconciliation, and event acknowledgements. The original TypeScript mock service remains as a daemon-free fallback and parity reference. The hardware daemon adds a durable queue/event/snapshot store, explicit transport epochs, generated or observed MIDI clock, realtime MIDI, reconnect reconciliation, and semantic readback verification.

## Commands

```bash
npm test
npm run rust:test
npm run check
npm run demo
npm run hardware:control
npm run hardware:control -- --execute
npm run hardware:audio
npm run hardware:audio -- --execute
npm run hardware:samples
npm run hardware:samples -- --execute
npm run hardware:scheduler -- --execute
```

No npm install is required for the current mock slice. Rust dependencies are resolved by Cargo.

Hardware commands run from `daemon/` and refuse state-changing operations unless `--execute` is present:

```bash
cargo run -- midi-list
cargo run -- identity
cargo run -- capture-state ../hardware/runs/baseline
cargo run -- configure-midi --execute ../hardware/runs/baseline
cargo run -- validate-realtime --execute ../hardware/runs/baseline
cargo run -- create-demo-patterns --execute ../hardware/runs/demo-patterns
cargo run -- play-demo-patterns --execute ../hardware/runs/baseline
```

Run the long-lived mock daemon directly with:

```bash
cargo run --manifest-path daemon/Cargo.toml -- serve --adapter mock
```

Run the hardware-backed daemon with its default CoreMIDI port match:

```bash
cargo run --manifest-path daemon/Cargo.toml -- serve --adapter hardware --clock-source observed
```

Both modes use the same request/response/event protocol. The hardware adapter reconnects its MIDI session as needed and owns its revision, operation-set idempotency, durable queue, raw snapshots, readback verification, rollback, transport epoch, and event journal. Its default store is `~/.analog-rytm-agent-bridge/hardware-state.json`; `--state-dir` selects an isolated store. See [docs/DAEMON_RPC.md](docs/DAEMON_RPC.md).

See [docs/HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md) before running write tests.
See [docs/CONTROL_SURFACE.md](docs/CONTROL_SURFACE.md) for the current control matrix.
See [docs/AUDIO_CAPTURE.md](docs/AUDIO_CAPTURE.md) for the stereo capture contract and its separation from Overbridge.
See [docs/SAMPLE_MANAGEMENT.md](docs/SAMPLE_MANAGEMENT.md) for sample identity, transfer, RAM resolution, assignment, and rollback boundaries.

## Current Slice

Implemented:

- inspect compact device and pattern state;
- validate persistent operation deltas;
- queue operation sets for musical boundaries;
- simulate transport boundaries with a mock Rytm transport;
- apply queued operations and emit journaled acknowledgements;
- create snapshots and rollback with monotonic revisions;
- send mock realtime MIDI operations;
- expose a standalone MCP-style adapter surface;
- start, monitor, and close a long-running Rust daemon from TypeScript;
- route daemon health and compact state/pattern inspection through versioned JSON-lines RPC;
- route validation, deltas, queues, realtime gestures, snapshots, rollback, reconciliation, and event reads through Rust in mock mode;
- emit asynchronous acknowledgement/state events with monotonic cursors;
- reject in-flight work on daemon disconnect and support a clean process restart;
- replay identical request IDs and reject conflicting ID reuse;
- discover the Analog Rytm through CoreMIDI;
- query and compactly summarize pattern, kit, global, and settings work buffers;
- reconcile a minimal MIDI receive profile idempotently;
- send notes, transport, clock, CC, NRPN, and program changes;
- create and read back trigs, velocities, conditions, microtiming, track lengths, time mode, and filter parameter locks;
- preserve raw SysEx baselines and verify hardware rollback.
- inspect complete work-buffer Sound, Kit, FX, Global, routing, MIDI, sequencer, and Settings state;
- validate and dry-run delta operations against decoded hardware state;
- apply idempotent Sound, machine, Kit, FX, routing, Global, and Settings deltas immediately;
- canonicalize codec-quantized values before desired-vs-observed comparisons;
- snapshot raw Pattern, Kit, Global, and Settings objects and restore them with semantic verification;
- use an immutable maintained-fork `rytm-rs` revision for validated codecs and firmware fixtures;
- persist hardware queues, snapshots, revisions, observations, and events across daemon restart;
- resolve `next_step`, `next_beat`, `next_measure`, `next_pattern`, and pattern-step targets against an explicit transport epoch;
- generate 24 PPQN clock or follow observed MIDI realtime input without wall-clock boundary guesses;
- expose hardware queue, track trigger, track-level CC/NRPN, transport, and pattern-change RPC methods;
- reconcile on reconnect, reject or roll forward stale-epoch work, and clean up transport/notes on shutdown;
- certify multi-object automatic rollback after an injected readback verification failure.
- list CoreAudio inputs and report the Rytm's channel, sample-rate, and sample-format capabilities;
- start, stop, and run bounded 48 kHz stereo WAV captures with atomic finalization and authoritative state sidecars;
- detect silence, clipping, duration mismatch, dropped callback blocks, disconnects, and stale partial files;
- expose class-compliant audio through Rust RPC and four semantic MCP tools;
- certify an audible bounded hardware recording and restore the disposable Pattern/Global baseline.
- inspect +Drive, all 127 RAM slots, and track sample assignments through the pinned Elektroid fork;
- validate, upload, download, and content-identify WAV samples without duplicate transfers;
- resolve managed samples into RAM, assign them declaratively to Sounds, verify readback, roll back the Kit, and clear RAM safely.

Not implemented yet:

- Overbridge multitrack capture or DAW automation;
- scenes, performance macros, and songs.

Those features remain behind capability flags. The current `rytm-rs` adapter targets firmware 1.70; successful decoding on the connected device is recorded as `decoded-unverified` until its exact OS version is independently confirmed.
