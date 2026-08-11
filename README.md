<div align="center">

# analog-rytm-agent-bridge

**A control plane that lets a coding agent operate an Elektron Analog Rytm MKII
as an instrument — and undo everything it did.**

*Hardware is stateful, destructive, and has no ctrl-Z. So nothing here is
fire-and-forget: every persistent change is validated against decoded device
state, snapshotted, applied at a musical boundary, read back, and rolled back
byte-exactly if the readback disagrees.*

[Site](https://chronick.github.io/analog-rytm-agent-bridge/) · [Quick start](#quick-start) · [Safety](#the-safety-model) · [Tools](#the-agent-surface) · [Architecture](#architecture) · [Capabilities](docs/CAPABILITIES.md)

</div>

---

```bash
npm run demo
```

That runs the whole control plane — inspect, propose, validate, queue, apply,
snapshot, roll back — against a mock Rytm transport. No hardware, no MIDI
cable, no risk to a device. It is the honest way to see what the bridge does
before letting it touch an instrument.

## What this is

An Analog Rytm holds twelve voices, 128 patterns, kits, sounds, scenes,
performance macros, songs, and 127 sample slots of state that a person edits by
hand. This bridge exposes that state to a coding agent as a set of semantic
operations: read a compact summary, propose a delta, validate it, and commit it
on the next beat.

The hard part is not sending MIDI. It is that an agent that guesses wrong
overwrites a kit you spent an evening on. So the design is built around a
single assumption — **the agent will be wrong sometimes** — and everything
follows from that: validate before dispatch, snapshot raw SysEx before
mutation, verify by reading the device back, and restore the exact original
bytes when verification fails.

It is also usable without an agent. The daemon and CLI are ordinary tools for
inspecting, validating, queueing, and applying Rytm operations.

## The safety model

Read this before pointing it at hardware.

**Nothing mutates without `--execute`.** Every hardware command runs in
validate-only mode by default: it connects, decodes real device state, checks
the operation against it, and reports what *would* happen. Adding `--execute`
is the only way to write.

**Every persistent write is snapshotted first.** The daemon captures the raw
SysEx of each affected Pattern, Kit, Global, and Settings object before
touching it, and stores it durably.

**Every write is verified by readback.** After applying, the daemon re-reads
the object and compares it to what was asked for, canonicalizing
codec-quantized values first so the comparison is real rather than cosmetic.

**A failed readback rolls back automatically** — restoring the original raw
bytes, across multiple objects, without ever decrementing the public revision.
This path is hardware-certified, not just unit tested: see
[docs/HARDWARE_VALIDATION_2026-07-17_COMPLETE.md](docs/HARDWARE_VALIDATION_2026-07-17_COMPLETE.md).

**What it will still overwrite.** The bridge protects the objects it knows it
is touching. It does not back up your entire device. Before first use, save
your projects to +Drive and take an external backup — this is a tool that
writes to a musical instrument you care about.

**Realtime gestures are deliberately not persistent.** Scene activation,
performance macro amounts, and live parameter moves go out as transient CC/NRPN
and never change the persistent revision, matching how the hardware itself
treats them.

## Requirements

- **macOS.** The daemon depends on CoreMIDI and CoreAudio and does not build
  elsewhere.
- **An Analog Rytm MKII.** Certified against OS 1.72; the codecs target
  firmware 1.70 and unknown-capability operations are gated rather than
  guessed.
- **Rust ≥ 1.89** (`File::try_lock`, used for the single-instance state lock).
- **Node ≥ 22.14** (24+ recommended). The TypeScript side runs on Node's native
  type-stripping and has **zero runtime dependencies**; `npm install` only
  provisions the dev-time type checker.
- **For sample management only:** a pinned Elektroid CLI fork — see
  [docs/HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md).

## Quick start

### 1. Without hardware

```bash
git clone https://github.com/chronick/analog-rytm-agent-bridge
cd analog-rytm-agent-bridge
npm install          # dev-time typechecker only
npm run demo
```

`npm run check` runs the full gate: Node tests, TypeScript typecheck, and the
Rust daemon's `cargo test`.

Run the mock daemon as a long-lived process to exercise the real RPC boundary:

```bash
cargo run --manifest-path daemon/Cargo.toml -- serve --adapter mock
```

### 2. With hardware

Work through [docs/HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md) first — it covers
MIDI port configuration, the device settings the bridge expects, and the backup
you should take before any write test.

Confirm the device is visible and identifies itself:

```bash
cd daemon
cargo run -- midi-list
cargo run -- identity
cargo run -- capture-state ../hardware/runs/baseline
```

Then run the validation suite. Without `--execute` it only reads:

```bash
npm run hardware:control            # validate only
npm run hardware:control -- --execute
npm run hardware:all -- --execute --phase=core
```

Start the hardware daemon:

```bash
cargo run --manifest-path daemon/Cargo.toml -- serve --adapter hardware --clock-source observed
```

State lives in `~/.analog-rytm-agent-bridge/hardware-state.json` by default;
`--state-dir` selects an isolated store. Mock and hardware modes speak the same
request/response/event protocol — see [docs/DAEMON_RPC.md](docs/DAEMON_RPC.md).

## The agent surface

Thirty-two semantic MCP tools, grouped by what they let an agent do:

| Group | Tools |
|---|---|
| Inspect | `rytm_inspect_device_state` · `_pattern` · `_song` · `_kit` · `_track_sound` · `_global` · `_samples` · `_overbridge_audio` |
| Propose & commit | `rytm_propose_pattern_delta` · `rytm_propose_song_delta` · `rytm_validate_operations` · `rytm_queue_operations` · `rytm_apply_operations_now` |
| Play | `rytm_trigger_track` · `rytm_set_transport` · `rytm_change_pattern` · `rytm_set_live_parameter` · `rytm_set_active_scene` · `rytm_set_performance_macro` |
| Undo | `rytm_snapshot_state` · `rytm_rollback_snapshot` |
| Samples | `rytm_upload_sample` · `rytm_resolve_sample_ram` · `rytm_clear_sample_ram` |
| Listen | `rytm_list_audio_inputs` · `rytm_start_recording` · `rytm_stop_recording` · `rytm_capture_pattern_audio` · `rytm_capture_multitrack_audio` |
| Meta | `rytm_daemon_health` · `rytm_describe_capabilities` · `rytm_get_events` |

`rytm_describe_capabilities` is the one an agent should call first: it reports
what the connected device and firmware actually support, so unsupported
operations fail as a refusal rather than a corrupted object.

## Declarative projects

`build:project` applies a whole project — patterns, machines, sounds, scenes,
performance macros, samples — from one JSON declaration, validation-first, with
snapshot and readback:

```bash
npm run build:project -- <declaration.json> [--execute] [--auto-slots]
npm run audition:project [-- A01 B04 ...]
```

A declaration with a `samples` section is preflighted against the device's RAM
inventory before anything is applied. Each declared slot must be free or
already hold that sample's own content; otherwise the run prints a conflict
report and exits non-zero with nothing applied, rather than failing late after
every kit and pattern batch has already landed. `--auto-slots` remaps
conflicting slots in memory (lowest free slot first, and a sample already
loaded elsewhere follows its own slot, so repeat runs are idempotent), rewrites
the `sample_number` p-locks and kit `slot` fields that referenced them, and
prints the final map as one line of JSON. P-lock references to slots the
declaration does not own are never touched.

The `sounds` section designs each track's kit sound — a machine selection plus
per-page parameter locks. Every field is optional. The machine is emitted
before its parameters, because setting a machine resets its page to defaults:

```jsonc
{
  "project": "layered-kick-demo",
  "patterns": [],
  "sounds": {
    "BD": {
      "machine": "bdplastic",
      "machineParams": { "tun": -14, "swt": 54, "swd": 21, "dec": 45, "tic": 32, "lev": 110 },
      "filter": { "filter_type": "Pk", "resonance": 40 },
      "amp": { "overdrive": 8 }
    },
    "BT": {
      "machine": "btclassic",
      "lfo": { "destination": "SampleFineTune", "waveform": "Tri", "mode": "Hold", "depth": 32 }
    }
  }
}
```

Parameter names and enum casing are the daemon's — see `apply_sound_parameter`
in `daemon/src/hardware.rs`. Enum values are the CamelCase serde variants
(`SampleStart`, `Tri`), not the lowercase `rytm-rs` strings.
`audition:project` then plays each pattern from generated clock and captures a
verified bounded recording per slot.

## Architecture

```text
Coding agent / MCP host
  → TypeScript semantic facade          zero runtime deps
  → versioned JSON-lines RPC over stdio
  → long-running Rust daemon             revisions, queue, snapshots, rollback
  → CoreMIDI / SysEx / realtime MIDI
  → Analog Rytm MKII
                    ↘ CoreAudio capture (stereo, or Overbridge multitrack)
```

Two lanes, deliberately separate: **SysEx** for persistent state, **realtime
MIDI** for gestures. Two adapters behind one protocol: a **mock** for
development and a **hardware** adapter that adds a durable queue, explicit
transport epochs, generated or observed MIDI clock, reconnect reconciliation,
and semantic readback verification. Deltas rather than whole-project
regeneration; compact state summaries rather than giant payloads.

This repo is intentionally separate from `pd-agent-bridge`, which is the
reference implementation of the control-plane pattern, not a dependency. They
are meant to run side by side with the coding agent as the only glue, and each
should remain useful alone.

## Documentation

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | The overall design and its rationale |
| [CAPABILITIES.md](docs/CAPABILITIES.md) | Everything implemented, and what is not |
| [HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md) | **Read before any write test** |
| [DAEMON_RPC.md](docs/DAEMON_RPC.md) | The JSON-lines protocol |
| [AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md) | Operation and recovery sequence for an agent |
| [CONTROL_SURFACE.md](docs/CONTROL_SURFACE.md) | The current control matrix |
| [OS_1_72_CONTROL_MAP.md](docs/OS_1_72_CONTROL_MAP.md) | Evidence-driven mapping of every manual control family |
| [AUDIO_CAPTURE.md](docs/AUDIO_CAPTURE.md) | The stereo capture contract |
| [OVERBRIDGE_AUDIO.md](docs/OVERBRIDGE_AUDIO.md) | Optional synchronized multitrack capture |
| [SAMPLE_MANAGEMENT.md](docs/SAMPLE_MANAGEMENT.md) | Sample identity, transfer, RAM resolution, rollback boundaries |
| [UPSTREAM.md](docs/UPSTREAM.md) | The `rytm-rs` fork and its path back upstream |
| [CODE_REVIEW_2026-07-17.md](docs/CODE_REVIEW_2026-07-17.md) | Second-opinion review findings and dispositions |

The dated `HARDWARE_VALIDATION_*.md` files are certificates: each records a
suite run against a connected device, with the device restored to its exact
pre-test state afterward.

## Credits and licensing

SysEx codecs come from [`rytm-rs`](https://github.com/alisomay/rytm-rs) by
alisomay (MIT), pinned to a maintained fork whose changes are being prepared
for upstream — see [docs/UPSTREAM.md](docs/UPSTREAM.md). Sample transfer uses a
pinned fork of [Elektroid](https://github.com/dagargo/elektroid) by dagargo.

`docs/reference/rytm.yaml` is a machine-readable parameter reference distilled
from Elektron's published documentation. Its descriptions are concise
paraphrases, not copies. Elektron's manual is copyrighted and is not
redistributed here; keep your own copy if you want one.

This project is not affiliated with, endorsed by, or supported by Elektron.
"Analog Rytm" and "Overbridge" are Elektron's trademarks, used here only to
describe what the software interoperates with.

Licensed under the [MIT License](LICENSE).
