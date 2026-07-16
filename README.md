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

The current implementation is a hardware-independent vertical slice with a mock Rytm transport.

## Commands

```bash
npm test
npm run rust:test
npm run check
npm run demo
```

No npm install is required for the current mock slice.

## Current Slice

Implemented:

- inspect compact device and pattern state;
- validate persistent operation deltas;
- queue operation sets for musical boundaries;
- simulate transport boundaries with a mock Rytm transport;
- apply queued operations and emit journaled acknowledgements;
- create snapshots and rollback with monotonic revisions;
- send mock realtime MIDI operations;
- expose a standalone MCP-style adapter surface.

Not implemented yet:

- CoreMIDI device discovery;
- `rytm-rs` SysEx encode/decode integration;
- real hardware reconciliation;
- Overbridge or DAW automation;
- scenes, performance macros, songs, and sample transfer.

Those features remain behind capability flags.

