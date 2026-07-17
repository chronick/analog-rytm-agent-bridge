# Complete Core Hardware Validation - 2026-07-17

## Environment

- Device: Analog Rytm MKII
- Device OS: 1.72, confirmed from the device UI
- USB mode: USB AUDIO/MIDI
- Project: disposable certification project
- Control adapter: Rust hardware daemon over CoreMIDI and SysEx
- Audio adapter: CoreAudio class-compliant stereo
- Codec: maintained `chronick/rytm-rs` fork pinned at `f2e8143f4f92f3ba2241dd65753d50f63a906aeb`

## Result

`npm run hardware:all -- --execute --phase=core --duration-ms=8000` passed.

The phase executed six isolated harnesses and compared a fresh semantic inspection before and after:

| Harness | Evidence |
| --- | --- |
| Control | 22 representative Sound, machine, Kit, retrig, FX, routing, metronome, MIDI, sequencer, and Settings operations; dry run; apply; replay; readback; raw rollback |
| Scheduler/reconnect | Next-step and next-Pattern boundaries, durable daemon restart, stale-epoch reject/roll-forward, duplicate IDs, reconciliation, and injected verification-failure rollback |
| Scene/Performance | Ten definition operations, CC/NRPN live control, unchanged persistent revision, definition readback, and raw Kit rollback |
| Songs | Work buffer plus all 16 stored Songs, eight row operations, immediate and next-beat apply, replay, unchanged A01 activation, and exact rollback |
| Samples | Existing canonical +Drive asset, no-transfer replay, RAM slot 127 resolve/re-resolve, identity-bound BD assignment, Sound rollback, and RAM clear |
| Audio | Eight-second Main stereo WAV at 48 kHz, 384,000 frames, non-silent signal, zero clipping, zero dropped blocks, no disconnect, and Pattern rollback |

The final inspection matched the initial semantic Pattern, Kit, Global, Settings, and Song state. A01 remained active and transport was stopped. The certification sample remains intentionally retained at `/agent-bridge-tests/bridge-certification-sine`; RAM was empty after the run.

## Migration Finding

The first aggregate run found that the persistent sample-certification state predated Song snapshot coverage. `RawState.song_raw` did not have a deserialization default, so the daemon rejected the old state before any sample operation. The state schema now accepts a missing Song map and legacy snapshot rollback filters Song changes to only targets for which raw bytes were actually captured. A focused unit test and the existing persistent hardware state both pass after migration.

## Remaining Phase

This certificate does not cover Overbridge. The Rytm must be manually changed to USB CONFIG `OVERBRIDGE`; the separate phase is:

```bash
npm run hardware:all -- --execute --phase=overbridge
```

After that phase, return USB CONFIG to `USB AUDIO/MIDI` for the documented final operating state.
