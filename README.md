# Analog Rytm Agent Bridge

Standalone control plane for agentic Analog Rytm work.

This repo is intentionally separate from `pd-agent-bridge`. The two tools are meant to run side by side in a larger human/agent performance setup, but the coding agent is the only glue between them. The Rytm bridge should remain useful on its own for inspecting, validating, queueing, and applying Rytm operations.

## Shape

- TypeScript MCP/API facade for agent-facing semantic tools.
- Rust daemon boundary for hardware state, SysEx, MIDI, snapshots, rollback, and firmware compatibility.
- Standard MIDI for realtime gestures.
- SysEx/state lane for persistent edits.
- Delta operations instead of whole-project regeneration.
- Compact state summaries for agents.

The repo contains three connected vertical slices:

- a hardware-independent TypeScript control plane with a mock Rytm transport;
- a Rust/CoreMIDI hardware harness for bidirectional SysEx inspection, realtime MIDI, declarative configuration, verified pattern writes, snapshots, and rollback.
- a versioned JSON-lines process boundary that connects every TypeScript semantic tool to a long-running Rust mock or hardware daemon.

The Rust mock daemon owns revisioned deltas, dry runs, queue scheduling, snapshots, rollback, realtime state, reconciliation, and event acknowledgements. The original TypeScript mock service remains as a daemon-free fallback and parity reference. Hardware mutation methods use the same RPC names but return `capability_unavailable` until their write, readback, snapshot, and rollback paths are verified.

## Commands

```bash
npm test
npm run rust:test
npm run check
npm run demo
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
cargo run --manifest-path daemon/Cargo.toml -- serve --adapter hardware
```

Both modes use the same request/response/event protocol. The hardware adapter opens one long-lived MIDI session; its implemented RPC methods are read-only inspection, validation, and reconciliation. See [docs/DAEMON_RPC.md](docs/DAEMON_RPC.md).

See [docs/HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md) before running write tests.

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

Not implemented yet:

- hardware mutation, queue, snapshot, rollback, and event dispatch across TypeScript-to-Rust RPC;
- durable daemon queue/snapshot recovery after a process restart;
- device-derived musical-boundary scheduling for persistent hardware edits;
- broad parameter and machine compatibility coverage;
- Overbridge or DAW automation;
- scenes, performance macros, songs, and sample transfer.

Those features remain behind capability flags. The current `rytm-rs` adapter targets firmware 1.70; successful decoding on the connected device is recorded as `decoded-unverified` until its exact OS version is independently confirmed.
