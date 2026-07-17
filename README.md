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

The repo contains two vertical slices:

- a hardware-independent TypeScript control plane with a mock Rytm transport;
- a Rust/CoreMIDI hardware harness for bidirectional SysEx inspection, realtime MIDI, declarative configuration, verified pattern writes, snapshots, and rollback.

The hardware harness is intentionally a daemon-side CLI for now. The TypeScript facade does not dispatch to it yet.

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
- discover the Analog Rytm through CoreMIDI;
- query and compactly summarize pattern, kit, global, and settings work buffers;
- reconcile a minimal MIDI receive profile idempotently;
- send notes, transport, clock, CC, NRPN, and program changes;
- create and read back trigs, velocities, conditions, microtiming, track lengths, time mode, and filter parameter locks;
- preserve raw SysEx baselines and verify hardware rollback.

Not implemented yet:

- TypeScript-to-Rust IPC and MCP exposure of the hardware lane;
- device-derived musical-boundary scheduling for persistent hardware edits;
- broad parameter and machine compatibility coverage;
- Overbridge or DAW automation;
- scenes, performance macros, songs, and sample transfer.

Those features remain behind capability flags. The current `rytm-rs` adapter targets firmware 1.70; successful decoding on the connected device is recorded as `decoded-unverified` until its exact OS version is independently confirmed.
