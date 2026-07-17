# Hardware Validation: 2026-07-16

## Target

- Device: Elektron Analog Rytm MKII over USB
- USB mode: Audio/MIDI
- Project: new disposable project
- CoreMIDI input/output: `Elektron Analog Rytm MKII`
- Adapter: `rytm-rs` 0.1.3, documented firmware target 1.70
- Observed firmware: unknown; Universal Device Inquiry returned identity data without an OS version
- Compatibility result: `decoded-unverified`

Pattern, Kit, Global, and Settings work-buffer messages all decoded successfully. This validates the exercised object layouts, not every feature or firmware path.

## Passed Controls

| Lane | Exercise | Verification |
| --- | --- | --- |
| Inspect | Pattern, Kit, Global, Settings queries | Compact summaries decoded from device SysEx |
| Daemon RPC | Long-running `hardware` adapter health and `device.inspect_state` | TypeScript-facing protocol returned `ready` and a compact A01/Kit/Global/Settings summary over one CoreMIDI session |
| Snapshot | Raw object capture | `.syx` baselines retained in ignored run directories |
| MIDI config | Enable owned receive fields | Global re-query matched desired state |
| Idempotency | Repeat identical config and pattern declarations | Reported `changed: false` with no write |
| Transport | Stop, start, stop | Messages sent successfully |
| Clock | 24 PPQN at 120 BPM | Absolute-deadline sender completed; Settings restored to 120 BPM |
| Notes | Trigger all 12 tracks at velocity 32 | Messages sent on configured channels; no state acknowledgement exists |
| CC | Track level 100 to 84 | Kit work-buffer readback observed 84, then raw Kit restore observed 100 |
| NRPN | Track level 100 to 84 | Kit work-buffer readback observed 84, then raw Kit restore observed 100 |
| Program change | A01, A02, A03 | Pattern work-buffer re-query matched each requested slot |
| Persistent edits | A01-A03 declarations | Semantic readback matched every desired summary |
| Rollback | MIDI Global and A01-A03 | Original raw objects restored and verified, then desired state reconverged |

## Patterns Left On Device

- A01, straight foundation: 16 steps, 54 swing, kick/snare/hats, one filter-cutoff lock.
- A02, syncopated: 16 steps, 58 swing, alternate hat microtiming, a 50% open-hat condition, and a filter lock.
- A03, polymetric: advanced mode, 64-step master length, 15-step closed hat, 12-step cymbal, 1:2 condition, negative microtiming, and moving filter locks.

The final state capture showed A01 selected, 120 BPM, Kit 1 track levels restored to 100, no muted tracks, and program-change receive enabled.

## Limits And Findings

- Audio was not captured or analyzed. Note triggering is send-confirmed, while state-bearing controls are device-readback verified.
- A live filter-cutoff CC followed by a Sound work-buffer query did not yield reliable value readback. The failed attempt restored its baseline and was replaced by track-level CC/NRPN tests through the Kit object.
- The bridge normalizes the `rytm-rs` microtiming enum offset and ignores empty parameter-lock bytes unless the associated parameter-lock flag is enabled.
- Raw SysEx fingerprints can differ after a rollback/reapply cycle while compact semantic summaries are equal. Idempotency therefore compares owned semantic state, not opaque object bytes.
- Machines, scenes, performance macros, songs, samples, Overbridge automation, and exhaustive parameter mappings were not exercised.
- TypeScript/MCP health and compact inspection can now use the Rust daemon. Persistent writes still run through the Rust CLI immediately; daemon-backed mutation and device-clock-derived boundary scheduling remain future work.

## Evidence Directories

Hardware evidence is intentionally not committed:

- `hardware/runs/2026-07-16-baseline`
- `hardware/runs/2026-07-16-demo-patterns`
- `hardware/runs/2026-07-16-final`

These directories contain device-derived SysEx and may include project data. `.gitignore` excludes `hardware/runs/`.
