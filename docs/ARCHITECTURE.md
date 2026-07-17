# Analog Rytm Agent Bridge Architecture

## Status

Accepted direction. The mock control plane and a standalone Rust hardware harness are implemented. The harness validates CoreMIDI, realtime MIDI, SysEx state reads/writes, semantic reconciliation, snapshots, and rollback on an Analog Rytm MKII. TypeScript-to-Rust IPC and hardware-backed MCP tools are the next process-boundary milestone.

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
  -> Rust Rytm daemon (IPC not wired yet)
  -> CoreMIDI / MIDI / SysEx
  -> Analog Rytm

Analog Rytm audio
  -> Overbridge or audio interface
  -> recorder / analyzer
  -> coding agent context
```

The coding agent is the orchestrator across Pd, Rytm, audio analysis, and human-controlled instruments. The Rytm bridge does not import Pd code, call Pd APIs, or assume the Pd bridge is running.

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
2. Rust daemon scaffold. Complete; IPC contract remains.
3. CoreMIDI realtime lane. Hardware harness complete; MCP exposure remains.
4. `rytm-rs` SysEx state lane. Pattern, Kit, Global, and Settings vertical slice complete.
5. Hardware test harness with firmware evidence. Initial validation complete; broader compatibility matrix remains.
6. Hardware-backed scheduler and TypeScript/Rust integration.
7. Capability expansion for scenes, performance macros, songs, and sample transfer.
