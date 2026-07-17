# Analog Rytm MKII Hardware Setup

The Rust harness uses the Analog Rytm CoreMIDI port directly for realtime MIDI and SysEx. Overbridge may run alongside it for audio, but is not part of the state-control path.

## Device Preparation

1. Connect the Analog Rytm MKII by USB and select USB CONFIG `AUDIO/MIDI`.
2. Open a disposable project during development.
3. Confirm MIDI input and output are enabled for USB or MIDI+USB.
4. Record the device OS version from the Rytm UI. Universal Device Inquiry identifies the unit but does not report its OS version.
5. Stop any DAW or utility that has exclusive ownership of the Rytm MIDI port.

## Build And Discover

```bash
cd daemon
cargo run -- midi-list
cargo run -- identity
```

The bridge selects the first input and output whose names contain `Elektron Analog Rytm MKII`. Discovery and inspect commands do not modify device state.

## Capture Before Writing

Use a unique, ignored run directory. A capture stores raw work-buffer SysEx plus compact JSON summaries for the current pattern, kit, global, and settings objects.

```bash
cargo run -- capture-state ../hardware/runs/my-baseline
cargo run -- inspect-pattern A01
```

Rollback baselines are write-once within a run directory. Repeating a command does not overwrite the original `before-*.syx` files.

## Declarative MIDI Configuration

The bridge owns only the minimum receive profile it needs:

- transport receive enabled;
- program-change receive enabled;
- note receive enabled;
- CC/NRPN receive enabled.

Unrelated Global settings are preserved. The command reads current state, writes only when the owned fields differ, re-queries the Global object, and verifies convergence.

```bash
cargo run -- configure-midi --execute ../hardware/runs/my-baseline
cargo run -- configure-midi --execute ../hardware/runs/my-baseline
```

The second invocation should report `changed: false` and `already-converged`.

## Realtime Validation

This is audible and changes track level briefly. It uses low-velocity notes, sends transport and 24 PPQN clock, verifies CC and NRPN through Kit SysEx readback, and restores the captured Kit and Settings objects before returning.

```bash
cargo run -- validate-realtime --execute ../hardware/runs/my-baseline
```

## Demo Patterns

The demo declaration targets A01-A03 and exercises trigs, velocities, swing, conditional trigs, microtiming, track lengths, advanced time mode, and filter-cutoff parameter locks. Each slot is captured before its first write, applied only if its compact semantic state differs, then re-read and compared.

```bash
cargo run -- create-demo-patterns --execute ../hardware/runs/my-demo
cargo run -- create-demo-patterns --execute ../hardware/runs/my-demo
cargo run -- play-demo-patterns --execute ../hardware/runs/my-baseline
```

The second create command should be a no-op. Playback supplies 24 PPQN clock at 120 BPM, sends program changes A01-A03 on the configured receive channel, verifies each selected work buffer by SysEx, restores Settings, and stops on A01.

## Rollback

Rollback sends the original raw object and verifies the resulting semantic state. Reapply the declarative commands afterward when the bridge should retain ownership.

```bash
cargo run -- restore-patterns --execute ../hardware/runs/my-demo
cargo run -- restore-midi --execute ../hardware/runs/my-baseline

cargo run -- configure-midi --execute ../hardware/runs/my-baseline
cargo run -- create-demo-patterns --execute ../hardware/runs/my-demo
```

## Safety And Compatibility

- All write commands require the literal `--execute` argument.
- Never use a valuable project for a new firmware or operation class.
- Keep raw baselines until the device state has been manually confirmed.
- The adapter uses `rytm-rs` 0.1.3, whose documented target is firmware 1.70. Successful object decoding on newer firmware is evidence, not a blanket compatibility guarantee.
- Sound work-buffer readback did not provide a reliable proof for live filter CC validation. The harness verifies track level through the Kit work buffer instead.
- Notes have no device-state acknowledgement. Confirm their audio separately when building closed-loop tests.
- Scenes, performance macros, songs, sample transfer, and project-wide writes remain disabled or outside the current harness.
