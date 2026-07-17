# Hardware Validation: Overbridge Multitrack

## Certificate

- Date: 2026-07-17
- Device: Analog Rytm MKII
- Firmware: OS 1.72
- Overbridge: 2.25.7
- Mode during capture: `OVERBRIDGE`
- Command: `npm run hardware:all -- --execute --phase=overbridge --duration-ms=8000`
- Result: passed
- Manifest: `hardware/runs/complete-overbridge-2026-07-17T21-30-22-189Z/manifest.json`
- Recording sidecar: `hardware/runs/overbridge-2026-07-17T21-30-23-534Z/overbridge/stems-2026-07-17T21-30-23-534Z/recording.json`

## Provider And Timing

The installed HAL exposed one recognized 12-channel, 48 kHz, 32-bit float Analog Rytm input. One callback stream was deinterleaved into Main stereo, eight mono physical voice-group stems, and external Input stereo.

| Evidence | Observed |
| --- | ---: |
| Duration | 8,000 ms |
| Frames per stem | 384,000 |
| Callback count | 750 |
| Callback latency, min/average/max | 10.666666 ms |
| Maximum frame drift | 0 |
| Timestamp gaps | 0 |
| Dropped blocks | 0 |
| Disconnects | 0 |

## Signal

The certificate sent direct notes to one track in each physical voice group from an isolated realtime daemon while the state daemon performed the bounded capture. This exercises MIDI and audio concurrently without making Overbridge part of the state-control path.

| Stem | Peak | RMS | Clipped samples |
| --- | ---: | ---: | ---: |
| Main | 0.154374 | 0.040229 | 0 |
| BD | 0.166121 | 0.032727 | 0 |
| SD | 0.239792 | 0.017217 | 0 |
| RS/CP | 0.368048 | 0.009092 | 0 |
| BT | 0.371943 | 0.084949 | 0 |
| LT | 0.181523 | 0.027930 | 0 |
| MT/HT | 0.170747 | 0.018289 | 0 |
| CH/OH | 0.290190 | 0.005355 | 0 |
| CY/CB | 0.160238 | 0.007797 | 0 |

The external Input stem contained the same 384,000 frames but was below the silence threshold because no external source was connected. It is not required to be non-silent for Rytm voice certification.

## Reversibility

The runner inspected A01 with stopped transport, captured a raw snapshot, applied a disposable all-voice Pattern and routing declaration, recorded and replay-checked the same recording ID, then restored and re-queried the baseline. Aggregate inspection before and after the phase matched: A01 remained active, transport remained stopped, and semantic device state was restored.

The USB mode switch itself is a manual device operation. Return to `USB AUDIO/MIDI` after this phase when class-compliant stereo capture is the desired default.
