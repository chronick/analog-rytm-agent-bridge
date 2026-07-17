# Analog Rytm Agent Bridge Architecture

## Status

Accepted direction. The TypeScript facade, Rust mock control plane, Rust hardware control plane, and versioned process boundary are implemented. Hardware inspection, validation, immediate persistent mutation, snapshots, rollback, reconciliation, and event state live behind the Rust boundary. Hardware queueing, realtime RPC, and incomplete object families remain capability-gated.

## Relationship To Pd Agent Bridge

`pd-agent-bridge` is the reference implementation for the control-plane pattern, not a dependency. Both bridges should work separately. In a combined set, the coding agent coordinates them by reading each tool's compact state, listening to audio analysis, and issuing tool-specific operations.

Reusable ideas from the Pd bridge:

- append-only JSONL event journal;
- compact public state instead of giant project payloads;
- revision-checked transactions;
- idempotent request IDs;
- explicit validation before dispatch;
- musical-boundary scheduling;
- tests that exercise a mock runtime before hardware.

Different for Rytm:

- the device is external hardware, not a patch runtime;
- realtime MIDI and SysEx state writes are separate lanes;
- firmware compatibility is part of the state model;
- rollback must preserve hardware safety and never decrement the public revision;
- incomplete features are capability-gated.

## Process Boundaries

```text
Coding agent / MCP host
  -> TypeScript Rytm API facade
  -> versioned JSON-lines RPC over stdio
  -> long-running Rust Rytm daemon
  -> CoreMIDI / MIDI / SysEx
  -> Analog Rytm

Analog Rytm audio
  -> Overbridge or audio interface
  -> recorder / analyzer
  -> coding agent context
```

The coding agent is the orchestrator across Pd, Rytm, audio analysis, and human-controlled instruments. The Rytm bridge does not import Pd code, call Pd APIs, or assume the Pd bridge is running.

The TypeScript facade may run without the Rust daemon for deterministic fallback tests. When a daemon client is supplied, every MCP tool uses that boundary. Adapter-specific health prevents the mock implementation from implying hardware write support.

## Daemon Protocol

The process protocol is `analog-rytm-rpc.v1`. Every request carries a caller-generated ID, method, and object-valued parameters. Every response echoes the ID and contains either a result or a structured error with a stable code and retryability flag.

The daemon caches the last 1,024 completed requests. Repeating an ID with the same envelope returns the original response. Reusing an ID with a different envelope returns `request_id_conflict`.

The schema defines request, response, and event envelopes. State-changing mock requests emit asynchronous acknowledgements after the response and retain the same events for cursor-based catch-up. Request replay never duplicates an event.

Hardware operation-set IDs are checked before revision guards. An identical replay returns the original acknowledgement without writing again. Desired and observed state are both canonicalized through the local SysEx encoder/decoder so representable-value quantization does not create false drift.

See [DAEMON_RPC.md](DAEMON_RPC.md) for the method registry and examples.

## Lanes

Realtime lane:

- trigger tracks;
- transport start/stop/continue;
- pattern change;
- CC or NRPN parameter changes.

State lane:

- trigs;
- parameter locks;
- track lengths;
- machines;
- kit parameters;
- pattern copies;
- sample slot assignment when supported.

Overbridge is primarily audio and optional plugin automation. It is not the authoritative Rytm project API.

## Scheduler

Queue boundaries:

- `next_step`
- `next_beat`
- `next_measure`
- `next_pattern`

The hardware scheduler must follow observed musical/device time, not wall-clock timers. The mock scheduler advances by explicit simulated steps in tests.

## Failure Policy

- Stale expected revision rejects before dispatch.
- Duplicate operation set ID with the same payload is idempotent.
- Duplicate operation set ID with a different payload rejects.
- Capability-gated operations reject when support is not enabled.
- Dry runs validate and project state without mutating.
- Rollback restores a captured state snapshot and increments revision.
- Firmware support is explicit in `device.firmware.compatibility`.

## Phases

1. Mock TypeScript vertical slice. Complete.
2. Rust daemon scaffold. Complete.
3. CoreMIDI realtime lane. Hardware harness complete; MCP exposure remains.
4. `rytm-rs` SysEx state lane. Pattern, Kit, Global, and Settings vertical slice complete.
5. Hardware test harness with firmware evidence. Initial validation complete; broader compatibility matrix remains.
6. TypeScript/Rust integration. Mock and immediate hardware control planes complete.
7. Hardware-backed scheduler and reconciliation.
8. Capability expansion for scenes, performance macros, songs, and sample transfer.
