# Overbridge Multitrack Audio

## Boundary

Overbridge is an optional audio provider. It is not used for MIDI, SysEx, project state, validation, scheduling, snapshots, or rollback. The bridge starts and all control tools remain usable when Overbridge is absent or the Rytm is in class-compliant mode.

Use `rytm_inspect_overbridge_audio` before capture. It reports:

- HAL driver, Analog Rytm Audio Unit, and Engine installation;
- Engine process state and installed version;
- current `overbridge`, `class_compliant`, or `unavailable` device mode;
- matching CoreAudio inputs and stream configurations;
- selected channel layout and grouped physical voices;
- external ownership requirements and stale partial files.

The provider owns only a bounded CoreAudio input stream during `rytm_capture_multitrack_audio`. Close DAWs, the Analog Rytm standalone application, and plugin hosts that have claimed the device before capture. The Elektron Overbridge Engine and HAL driver continue to own USB transport.

## Device Mode

On the Rytm, select `SETTINGS > SYSTEM > USB CONFIG > OVERBRIDGE`. This mode is mutually exclusive with `USB AUDIO/MIDI`; changing it is a device UI workflow and is not an agent control operation. Switch back to `USB AUDIO/MIDI` for class-compliant stereo capture.

The provider recognizes explicit 10, 12, 18, and 20-channel CoreAudio layouts. Unknown channel counts reject rather than being mislabeled.

| Stem | Tracks | Rytm voice |
|---|---|---|
| Main | Main L/R | Main stereo mix |
| BD 1 | BD | Voice 1 |
| SD 2 | SD | Voice 2 |
| RS/CP 3/4 | RS, CP | Shared voice 3/4 |
| BT 5 | BT | Voice 5 |
| LT 6 | LT | Voice 6 |
| MT/HT 7/8 | MT, HT | Shared voice 7/8 |
| CH/OH 9/10 | CH, OH | Shared voice 9/10 |
| CY/CB 11/12 | CY, CB | Shared voice 11/12 |
| Input | External input L/R | Present when exposed by the driver |

The names match the installed Analog Rytm Audio Unit 2.25.7 bus registry. The grouped names are physical voice constraints, not bridge aggregation.

## Capture Contract

`rytm_capture_multitrack_audio` is bounded and accepts `durationMs`, plus optional `recordingId`, `deviceName`, and `snapshotId`. It creates:

```text
<audio-dir>/overbridge/<recordingId>/
  main.wav
  bd.wav
  sd.wav
  rs_cp.wav
  bt.wav
  lt.wav
  mt_ht.wav
  ch_oh.wav
  cy_cb.wav
  input.wav              # when exposed
  recording.json
```

All stems are deinterleaved from one CoreAudio callback stream. They therefore share sample rate, start frame, and frame count; structural drift is zero by construction. Each WAV is 32-bit float at the provider sample rate. Files are written as `.partial`, finalized and synced, then renamed before the shared metadata sidecar is published.

The sidecar includes authoritative Pattern, Kit, revision, tempo, routing, snapshot ID, source configuration, exact stem/channel mapping, per-stem peak/RMS/silence/clipping, callback latency, timestamp gaps, writer-queue drops, duration tolerance, and disconnect state. Reusing a completed `recordingId` with the same declaration returns the existing result; conflicting reuse rejects.

The bounded capture occupies its daemon request worker until recording finalization. Persistent state should remain unchanged during capture. The hardware certification generates direct notes through a second isolated realtime daemon so the recorder remains read-only and the realtime/state lanes stay independent.

## Hardware Certification

The provider is certified on Analog Rytm MKII OS 1.72 with Overbridge 2.25.7. The 2026-07-17 run captured a 12-channel 48 kHz `f32` stream for eight seconds: Main and all eight physical voice-group stems were non-silent and unclipped, every stem contained exactly 384,000 frames, and the run reported zero frame drift, timestamp gaps, dropped blocks, or disconnects. The external-input stem was structurally valid and silent because no external source was connected. Recording replay was idempotent and the raw Pattern/Kit/Global/Settings baseline was restored.

Run the same reversible certificate with:

```bash
npm run hardware:all -- --execute --phase=overbridge --duration-ms=8000
```

See [HARDWARE_VALIDATION_2026-07-17_OVERBRIDGE.md](HARDWARE_VALIDATION_2026-07-17_OVERBRIDGE.md) for the measured evidence.

## Failure And Recovery

- Installed Overbridge with a stereo-only Rytm reports `available: false`, `deviceMode: class_compliant`, and does not affect other tools.
- Capture without a multichannel endpoint returns retryable `capability_unavailable`.
- Unknown layouts reject before creating a recording directory.
- Callback disconnects, timestamp gaps, queue drops, and duration errors are preserved in metadata.
- Existing final or partial output is never overwritten.
- After a power cycle or mode change, wait for both CoreMIDI and CoreAudio to reappear, inspect current device state/revision, and inspect the provider again.

Elektron documents that Overbridge mode is required and that the macOS installation includes Core Audio/HAL drivers, Engine, plugins, and standalone hosts. See the [Overbridge manual](https://www.elektron.se/wp-content/uploads/2026/03/Overbridge-User-Manual_ENG_260304.pdf) and [Analog Rytm OS 1.72 manual](https://www.elektron.se/wp-content/uploads/2025/01/Analog-Rytm-MKII-User-Manual_ENG_OS1.72_250130.pdf).
