# Control Surface

This matrix describes the hardware adapter. The mock adapter additionally supports deterministic scheduler advancement without a MIDI device.

## Inspect

The agent can read compact summaries through `device.inspect_state`, `pattern.inspect`, `kit.inspect`, `sound.inspect`, and `global.inspect`. The device summary includes the work-buffer Pattern, all 12 Kit Sounds, machine-specific parameters, sample/filter/amp/LFO/settings pages, track levels and retrig, all Kit FX, control inputs, Global routing, metronome, MIDI sync/ports/channels, sequencer settings, and UI/recorder Settings.

Full project regeneration is intentionally absent. Summaries describe the active work buffers and bridge capabilities, while raw SysEx stays inside the daemon snapshot boundary.

## Persistent Writes

`set_track_machine` selects any machine accepted for the target track. `set_sound_parameter` supports:

- `machine`: every generated numeric machine parameter and the enum-backed `wav`, `wav1`, `wav2`, and `spd` fields exposed by the maintained fork;
- `sample`: `tune`, `fine_tune`, `bit_reduction`, `start`, `end`, `loop_flag`, and `volume`;
- `filter`: envelope stages, cutoff, resonance, type, and envelope amount;
- `amp`: envelope, overdrive, delay/reverb sends, pan, and volume;
- `lfo`: speed, multiplier, fade, destination, waveform, depth, phase/slew, and mode;
- `settings`: name, accent, chromatic mode, envelope/velocity/legacy flags, and velocity/aftertouch modulation amounts and targets.

`set_kit_parameter` supports name, track and FX levels, retrig rate/length/velocity curve, and retrig always-on. `set_fx_parameter` covers Delay, Reverb, Distortion, Compressor, and FX LFO fields returned by inspection.

`set_global_parameter` covers routing flags and USB levels, metronome, MIDI sync, MIDI port behavior, channel assignments, pad/pressure/encoder/mute destinations, sequencer settings, tempo, UI selection, mutes, fixed velocity, and recorder settings.

Scene and Performance definitions are part of the Kit state lane. `set_*_lock`, `replace_*`, `copy_*`, and `clear_*` address public macro IDs 1 through 12. Voice locks use tracks `BD` through `CB`; FX locks use track `FX`. Inspection returns compact semantic parameter names, pages, raw parameter IDs, values or signed depths, per-macro lock counts, unknown-lock counts, and active Scene state. Each macro family has 48 lock slots per Kit; replacement rejects duplicate track/parameter targets before writing.

All writes are delta based. They validate the decoded copy, compare codec-canonical desired state to current state, skip identical declarations, snapshot raw objects, write only changed object families, re-query, and automatically restore the raw baseline on mismatch.

## Realtime Lane

The hardware daemon exposes track notes, start/stop/continue, program change, generated or observed MIDI clock, and semantic `track_level` through CC 95 or NRPN 1:100. It also activates/deactivates Scenes through CC 92 or NRPN 1:104 and sets Performance 1-12 amounts through their documented CC or NRPN 0:0-11 mappings on the configured Performance channel. Scene activation is read back through the Kit; Performance amounts are transient send-cache state because the device does not expose their current values through the Kit dump. Note-off timing runs in the daemon poll loop. Graceful shutdown sends Stop and All Notes Off on all channels.

Persistent operation sets can be queued for next step, beat, measure, pattern, or a specific pattern step. Hardware callers must include the current transport epoch. The durable scheduler emits queued, applied, rejected, and reconciled events; reconnect either rejects or rolls stale work forward according to the declared late policy.

## Audio Lane

The bridge lists CoreAudio inputs and records the Rytm's class-compliant 48 kHz stereo stream through start/stop or bounded-capture tools. Final WAV files have authoritative state sidecars and signal/duration/disconnect analysis. This is one Main/selected stereo pair; individual Overbridge streams are not part of this lane.

## Sample Lane

The bridge can inspect +Drive sample directories, all 127 RAM slots, and current track assignments. It validates and uploads WAV files through a pinned Elektroid fork, downloads the canonical device result, assigns stable IDs, resolves samples into RAM without duplication, and clears only identity-matched slots that are no longer used by a track.

Filesystem writes require stopped transport and are intended for preparation, not realtime use.

`assign_sample_slot` changes a track Sound's selected sample number through the normal persistent operation path. Validation and boundary dispatch re-read RAM identity, while raw Kit snapshots cover assignment rollback. +Drive uploads and RAM contents are not part of SysEx snapshots. See [SAMPLE_MANAGEMENT.md](SAMPLE_MANAGEMENT.md).

## Capability Gaps

- Songs remain disabled pending typed maintained-fork codec and hardware validation.
- Overbridge is not a control dependency. Class-compliant stereo capture is implemented; Overbridge multitrack capture is a separate milestone.
- The fork targets firmware 1.70. Successful connected-device round trips are recorded as compatibility evidence, not universal certification for later firmware.
