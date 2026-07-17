# Complete Hardware Validation

## Scope

This is the release certificate for the reversible Analog Rytm control plane on 2026-07-17. It combines the mutually exclusive Core and Overbridge phases, the evidence-driven OS 1.72 control audit, and the final restored-device inspection.

- Device: Analog Rytm MKII
- Device OS: 1.72
- Codec adapter target: `rytm-rs` 1.70
- Maintained fork branch: `agent-control`
- Bridge Overbridge version: 2.25.7
- Final USB mode: `USB AUDIO/MIDI`
- Final active Pattern: A01
- Final transport: stopped, 120 BPM

OS 1.72 success is connected-device evidence for the tested object and operation families. It is not a blanket firmware-compatibility claim because Universal Device Inquiry did not report the device OS version.

## Release Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| TypeScript tests | 23 passed | `npm test` |
| Rust tests | 50 passed | `cargo test --manifest-path daemon/Cargo.toml` |
| Rust formatting | passed | `cargo fmt --manifest-path daemon/Cargo.toml -- --check` |
| Clippy warnings | 0 | `cargo clippy --manifest-path daemon/Cargo.toml --all-targets --all-features -- -D warnings` |
| Core hardware phase | passed | `hardware/runs/complete-core-2026-07-17T18-47-19-849Z/manifest.json` |
| Overbridge hardware phase | passed | `hardware/runs/complete-overbridge-2026-07-17T21-30-22-189Z/manifest.json` |
| Manual control audit | complete | [OS_1_72_CONTROL_MAP.md](OS_1_72_CONTROL_MAP.md) |
| Agent capability audit | complete | `rytm_describe_capabilities`, 22 evidence families |

The Core phase covered compact inspection, validation, dry run, immediate apply, musical-boundary queues, restart/reconciliation, Scene and Performance definitions and live control, all supported Song definition operations, sample transfer/RAM resolution/Sound assignment, class-compliant stereo capture, snapshots, injected-failure rollback, and aggregate state restoration.

The Overbridge phase discovered the 12-channel HAL layout, captured synchronized non-silent Main and eight physical voice-group stems, replayed the recording ID idempotently, and restored the raw Pattern/Kit/Global/Settings baseline. All stems had exactly 384,000 frames with zero drift, timestamp gaps, dropped blocks, disconnects, or clipped samples. See [HARDWARE_VALIDATION_2026-07-17_OVERBRIDGE.md](HARDWARE_VALIDATION_2026-07-17_OVERBRIDGE.md).

## Final State

After Overbridge certification, the device was manually returned to `USB AUDIO/MIDI`. Read-only provider inspection observed one Rytm stereo input at 48 kHz and reported `deviceMode: class_compliant`; no multitrack endpoint remained selected. A fresh isolated hardware daemon then reported:

```json
{
  "adapter": "hardware",
  "connected": true,
  "activePattern": "A01",
  "playing": false,
  "tempo": 120,
  "overbridgeAudio": true,
  "overbridgeStatus": "supported",
  "overbridgeVerified": true,
  "hardwareVerifiedFirmware": ["1.72"]
}
```

The representative 22-operation Sound/Kit/FX/Global declaration validated and projected successfully in dry-run mode after restoration. Its inspected baseline remained the new-project state; no final-state write was sent.

## Boundaries

Realtime MIDI and persistent SysEx remain separate lanes. Overbridge and class-compliant audio are read-only providers and do not own state, revisions, scheduling, snapshots, or rollback. The bridge and `pd-agent-bridge` are independent processes and repositories; a coding agent is the only coordinator between them and any human-controlled instruments or audio analysis.

Every OS-manual control family is mapped to a supported or partial semantic operation, inspect-only state, an unsupported UI workflow, or an excluded destructive operation. Firmware upgrades, factory reset, calibration, test mode, +Drive formatting, and similar maintenance remain intentionally absent from agent tools.
