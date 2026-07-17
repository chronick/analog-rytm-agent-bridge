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

All writes are delta based. They validate the decoded copy, compare codec-canonical desired state to current state, skip identical declarations, snapshot raw objects, write only changed object families, re-query, and automatically restore the raw baseline on mismatch.

## Realtime Lane

The hardware daemon exposes track notes, start/stop/continue, program change, generated or observed MIDI clock, and semantic `track_level` through CC 95 or NRPN 1:100. Note-off timing runs in the daemon poll loop. Graceful shutdown sends Stop and All Notes Off on all channels.

Persistent operation sets can be queued for next step, beat, measure, pattern, or a specific pattern step. Hardware callers must include the current transport epoch. The durable scheduler emits queued, applied, rejected, and reconciled events; reconnect either rejects or rolls stale work forward according to the declared late policy.

## Capability Gaps

- `sample.number` and `assign_sample_slot` are disabled until sample identity and inventory are reconciled; sample transfer is not implemented.
- Scene definitions, Performance macro definitions, Songs, and their codecs remain disabled pending maintained-fork support.
- Overbridge is not a control dependency. Audio and multitrack capture are separate milestones.
- The fork targets firmware 1.70. Successful connected-device round trips are recorded as compatibility evidence, not universal certification for later firmware.
