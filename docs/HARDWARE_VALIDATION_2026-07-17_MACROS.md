# Hardware Validation: Scenes And Performances (2026-07-17)

## Setup

- Device: Analog Rytm MKII
- Device OS: 1.72
- USB mode: AUDIO/MIDI
- Project: disposable new project
- Rytm codec: `chronick/rytm-rs` commit `4d4f497`
- Certification command: `npm run hardware:macros -- --execute`

## Evidence

The read-only pass decoded the work-buffer Kit, found no active Scene, validated ten persistent operations, and projected typed voice and FX locks without writing. The execute pass then verified:

- Scene and Performance replace, targeted set, copy, and clear operations;
- voice parameters on sample, filter, and amp pages;
- FX parameters on Delay and Reverb pages;
- compact inspection of all 12 definitions per family, lock counts, unknown-lock counts, semantic targets, raw IDs, values, and signed depths;
- exact device readback matching the codec-canonical dry-run projection;
- identical `operationSetId` replay without a duplicate write or revision change;
- Scene 2 activation through CC 92 on the configured Performance channel;
- active Scene readback and idempotent replay through the NRPN API path;
- Performance 2 amount through its CC mapping and NRPN 0:1;
- Performance sent-value cache replay at the same amount;
- no persistent revision change for any live macro control;
- restoration of the prior active Scene and Performance amount zero;
- raw Kit snapshot rollback restoring all baseline Scene and Performance definitions exactly.

The successful revision sequence was apply at 1 and rollback at 2. Events included `operation_set.applied`, `live.scene_sent`, `live.performance_sent`, and `snapshot.rolled_back`.

## Software Gates

- TypeScript: 21 tests passed.
- Rust: 41 tests passed.
- Maintained fork: 11 library tests, 7 hardware-fixture tests, and 2 macro documentation tests passed.

## Scope

This certifies Scene and Performance definition codecs, declarative bridge operations, active Scene readback, and Performance sends on the connected OS 1.72 unit. Performance amounts are transient sent-state because the Kit SysEx object does not expose their current values. Songs, Overbridge multitrack audio, and arbitrary project backup/restore remain separate milestones.
