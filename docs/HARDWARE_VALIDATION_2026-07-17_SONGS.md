# Song Hardware Validation - 2026-07-17

## Environment

- Device: Analog Rytm MKII
- Device OS: 1.72, confirmed from the device UI
- USB mode: AUDIO/MIDI
- Adapter: Rust hardware daemon over CoreMIDI and SysEx
- Codec: maintained `algonormative/rytm-rs` fork pinned at `f2e8143f4f92f3ba2241dd65753d50f63a906aeb`
- Test target: stored Song 16 in a disposable project

## Result

`npm run hardware:songs -- --execute` completed successfully.

The certificate proved:

- compact inspection of the work-buffer Song and all 16 stored Songs;
- optional compact resolution of referenced Patterns and Kits;
- validation and dry-run projection without a write;
- name, clear, replace, insert, update, copy, move, and remove operations;
- Pattern chains, repeats, and per-position track mutes;
- immediate apply with semantic readback;
- identical operation-set replay without a duplicate write;
- queued next-beat application under a generated transport epoch;
- no Song activation, active Pattern change, or implicit transport change from definition writes;
- raw snapshot coverage for the work-buffer Song and all stored Songs;
- exact baseline rollback with monotonic revision.

Observed revisions were 1 after immediate apply, 2 after the queued write, and 3 after rollback. The active Pattern remained A01. Stored Song 16 returned to its original empty state.

## Limits

The typed codec and bridge do not advertise Song tempo overrides, Pattern-length overrides, jumps, loops, row labels, explicit end markers, or Song activation. The hardware result certifies the supported subset on this firmware and device; it is not a universal compatibility guarantee.
