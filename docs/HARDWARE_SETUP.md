# Analog Rytm MKII Hardware Setup

The Rust harness uses the Analog Rytm CoreMIDI port directly for realtime MIDI and SysEx. In USB AUDIO/MIDI mode it can also capture the class-compliant stereo USB stream. Overbridge is not part of the state-control path and its multitrack lane remains separate.

## Device Preparation

1. Connect the Analog Rytm MKII by USB and select USB CONFIG `AUDIO/MIDI`.
2. Open a disposable project during development.
3. Confirm MIDI input and output are enabled for USB or MIDI+USB.
4. Record the device OS version from the Rytm UI. Universal Device Inquiry identifies the unit but does not report its OS version.
5. Stop any DAW or utility that has exclusive ownership of the Rytm MIDI port.

## Build And Discover

The daemon pins the maintained `chronick/rytm-rs` fork by immutable Git revision. A sibling fork
checkout is optional and is used only while developing codec changes. Update the `rev` in
`daemon/Cargo.toml` only after the fork commit has passed its deterministic and connected-device
fixture tests and has been pushed to `origin`.

Sample operations also require the maintained Elektroid fork at commit `681fa8c`. Install its CLI on macOS with:

```bash
brew install automake libtool pkg-config libzip libsamplerate rtmidi rubberband libsndfile
git clone https://github.com/chronick/elektroid.git ~/git/elektroid
cd ~/git/elektroid
git checkout 681fa8c
autoreconf -fi
./configure CLI_ONLY=yes --prefix="$HOME/.local"
make -j4
make check CPPFLAGS="$(pkg-config --cflags sndfile samplerate)"
make install
```

Ensure `~/.local/bin` is on `PATH`, or set `ANALOG_RYTM_ELEKTROID_CLI` to the absolute executable path. Stock Elektroid does not expose the Rytm RAM/track filesystems or transport-safe connection option required by this bridge.

```bash
cd daemon
cargo run -- midi-list
cargo run -- identity
```

The bridge selects the first input and output whose names contain `Elektron Analog Rytm MKII`. Discovery and inspect commands do not modify device state.

## Capture Before Writing

Use a unique, ignored run directory. A capture stores raw work-buffer SysEx plus compact JSON summaries for the current Pattern, Kit, Global, Settings, and Song objects.

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

## Reversible Control Certification

Run the dry run first. It reads the connected work buffers, validates every operation, and projects the codec-canonical result without writing.

```bash
npm run hardware:control
```

The execute form captures a daemon-owned raw snapshot, mutates a representative field from every supported object/page family, verifies semantic readback, replays the same operation-set ID, rolls back, and compares the restored state to the baseline.

```bash
npm run hardware:control -- --execute
```

The harness performs an emergency rollback in `finally` if any assertion fails. Keep the disposable project open and do not interrupt the process during SysEx writes.

The verification modules are import-safe: importing them does not create a temporary store, start a daemon, or touch the device. They execute only through their CLI entrypoints.

## Scene And Performance Certification

The dry run reads the current Kit, validates all Scene and Performance operations against the decoded firmware object, and projects semantic lock definitions without writing:

```bash
npm run hardware:macros
```

The execute form snapshots the raw Kit, exercises set/replace/copy/clear operations for both macro families, verifies exact device readback and operation-set replay, activates Scene 2 through CC with readback, tests Performance 2 through CC and NRPN, restores transient values, then rolls back and compares all 24 definitions to the baseline:

```bash
npm run hardware:macros -- --execute
```

Scene and Performance definitions are persistent revisioned Kit state. Active Scene and Performance amounts are live MIDI state and do not change revision. Performance values are send-cache evidence rather than device readback. The harness restores the prior active Scene and sends Performance amount zero before raw rollback; emergency restoration also runs from `finally`.

## Song Certification

The dry run reads the work-buffer Song and all 16 stored Songs, validates every supported Song delta, resolves codec-canonical projected state, and confirms the active Pattern is unchanged:

```bash
npm run hardware:songs
```

The execute form snapshots every Song object, exercises name plus clear/replace/insert/update/copy/move/remove row operations on stored Song 16, verifies immediate readback and operation-set replay, queues a name update for the next beat, confirms the active Pattern did not change, and restores the exact raw baseline:

```bash
npm run hardware:songs -- --execute
```

Song definitions support Pattern chains, repeats, and per-position track mutes. This command does not activate Song mode or select a Pattern. Unsupported tempo/length overrides, jumps, loops, row labels, explicit end markers, and Song activation remain capability-gated.

## Stereo Audio Certification

Confirm the Rytm is in USB CONFIG `AUDIO/MIDI` and AUDIO ROUTING `USB OUT` is `MAIN OUT`. The dry run lists CoreAudio inputs and validates a stereo 48 kHz f32 configuration without writing device state or recording a file.

```bash
npm run hardware:audio
```

The execute form snapshots the active work buffers, applies a disposable declarative Pattern, starts a bounded recorder, sends direct track notes, writes a stereo f32 WAV plus JSON sidecar, checks signal and duration, then rolls back and verifies the original state.

```bash
npm run hardware:audio -- --execute
npm run hardware:audio -- --execute --duration-ms=8000
```

The sidecar records device/input format, Pattern, Kit, revision, tempo, semantic routing, snapshot ID, timestamps, duration, peak/RMS, clipping, dropped blocks, and disconnect status. WAV and JSON files are written as `.partial` files and renamed only after their contents are finalized and synced. See [AUDIO_CAPTURE.md](AUDIO_CAPTURE.md).

## Sample Certification

The default command reads +Drive, all RAM slots, and track assignments without writing:

```bash
npm run hardware:samples
```

The execute form creates a deterministic mono WAV, uploads and downloads it for verification, repeats the upload without transfer, resolves and re-resolves one RAM slot, snapshots the Kit, assigns the sample to BD through `assign_sample_slot`, verifies Sound readback, restores the baseline, and clears RAM:

```bash
npm run hardware:samples -- --execute
```

The test asset remains at `/agent-bridge-tests/bridge-certification-sine`; a second execution must report `already-present` with `transferred: false`. The harness uses a persistent certification registry under `~/.analog-rytm-agent-bridge/sample-certification`. See [SAMPLE_MANAGEMENT.md](SAMPLE_MANAGEMENT.md).

## Scheduler And Reconnect Certification

The scheduler harness uses an isolated durable state directory, generated 24 PPQN clock, and explicit transport epochs. It verifies next-step application, a queued edit surviving daemon shutdown/restart, stale-epoch reject and roll-forward policies, duplicate ID behavior, realtime RPC, no-op reconciliation, and multi-object raw rollback after an injected verification failure.

```bash
npm run hardware:scheduler -- --execute
```

The test triggers BD once at low velocity and temporarily changes its level. All persistent fields finish at their captured semantic baseline. The fault injection flag is internal to this certification command and should not be used when operating the bridge normally.

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
- Requested values are compared after a local SysEx encode/decode round trip. This makes codec quantization explicit; for example, a requested delay feedback value may converge to the nearest representable value.
- Sound work-buffer readback did not provide a reliable proof for live filter CC validation. The harness verifies track level through the Kit work buffer instead.
- Notes have no device-state acknowledgement. Confirm their audio separately when building closed-loop tests.
- Class-compliant capture is one stereo pair at 48 kHz. Overbridge multitrack capture is a later, independent lane.
- Song names, rows, chains, repeats, and track mutes are certified separately by `hardware:songs`. Tempo/length overrides, jumps, loops, labels, explicit end markers, and Song activation remain unavailable.

## Power Cycle And Refresh

The CLI certification scripts are not part of plugin refresh and never run on import. A long-lived hardware daemon owns the connection lifecycle. If the Rytm is power-cycled, in-flight MIDI/SysEx calls fail as retryable hardware errors; the daemon reconnects when the CoreMIDI ports return, re-queries owned work buffers, opens a new transport epoch, and reconciles durable queued work before accepting writes.

An active audio callback reports a disconnect in the recording analysis. Stop or shut down the daemon to finalize that capture as failed; then start a new recording after CoreAudio exposes the device again. Declarative configuration can be replayed after reconnect: matching operation-set/request IDs replay their prior acknowledgement, while a new operation-set ID with the newly inspected revision converges current device state. Never assume a stale pre-power-cycle revision or transport epoch is valid.

Sample registry state also survives daemon restart. Re-inspect +Drive and RAM after a power cycle before assignment; RAM is volatile and must be resolved again. Every Elektroid call uses `-k`, so reconnecting the sample adapter does not intentionally stop transport.
