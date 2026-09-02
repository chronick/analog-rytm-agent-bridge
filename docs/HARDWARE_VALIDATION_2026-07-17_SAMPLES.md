# Hardware Validation: Samples (2026-07-17)

## Setup

- Device: Analog Rytm MKII
- Device OS: 1.72
- USB mode: AUDIO/MIDI
- Project: disposable new project
- Rytm codec: `algonormative/rytm-rs` commit `63c14d5`
- Sample adapter: `algonormative/elektroid` commit `681fa8c`
- Certification command: `npm run hardware:samples -- --execute`

## Evidence

The read-only pass returned seven root +Drive entries, 127 RAM slots with all 127 free, and 12 track assignments. The execute pass then verified:

- local mono 48 kHz PCM16 WAV validation;
- upload to `/agent-bridge-tests/bridge-certification-sine`;
- +Drive readback checksum `77168b1f`;
- canonical downloaded WAV SHA-256 `9d2f5ce89192a771fab4ca4cc96ee9493f668ad6f18c739c3f4c4b843e6b97b3`;
- stable managed ID `sample-6d8533774accf2949ef3540f`;
- immediate replay returned `already-present` and performed no transfer;
- RAM slot 127 load and replay readback;
- declarative BD Sound assignment read back as sample number 127;
- assigned RAM slot 127 read back with `usedByTrack: true`;
- raw Kit snapshot rollback restored BD sample number 0;
- RAM slot 127 clear read back empty;
- the +Drive sample remained present as the documented rollback boundary.

A second full process run returned `already-present` with `transferred: false`, reused the same sample ID and checksum, repeated assignment/rollback, and again left all RAM slots empty. This certifies cross-process registry persistence and no-duplicate behavior for the tested declaration.

## Software Gates

- TypeScript: 15 tests passed.
- Rust: 37 tests passed.
- Clippy: all targets passed with warnings denied.
- Elektroid: 12 upstream test suites passed before installation.

## Scope

This certifies +Drive inventory and transfer, RAM inventory/load/clear, stable managed identity, and Sound assignment on the connected OS 1.72 unit. Scene definitions, Performance macro definitions, Songs, Overbridge multitrack audio, and arbitrary project backup/restore remain separate milestones.
