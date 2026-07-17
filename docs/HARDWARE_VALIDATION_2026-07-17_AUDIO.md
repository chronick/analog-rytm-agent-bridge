# Hardware Audio Validation - 2026-07-17

## Environment

- Device: Elektron Analog Rytm MKII
- USB mode: AUDIO/MIDI
- Host: macOS/CoreAudio
- Input: `coreaudio:AppleUSBAudioEngine:Elektron Music Machines:Elektron Analog Rytm MKII:000000000001:1,2`
- Format: stereo f32, 48 kHz
- State adapter: maintained `chronick/rytm-rs` fork commit `63c14d513e7e319a94cff515267387d9a180e4d1`

## Certification

Command:

```bash
npm run hardware:audio -- --execute
```

Result: `hardware-audio-captured-rollback-verified`.

- WAV: `hardware/runs/audio-2026-07-17T04-42-43-875Z/pattern-2026-07-17T04-42-43-875Z.wav`
- Sidecar: `hardware/runs/audio-2026-07-17T04-42-43-875Z/pattern-2026-07-17T04-42-43-875Z.json`
- Frames: 192,000
- Duration: 4,000 ms
- Bytes: 1,536,068
- Peak: 0.0967032
- RMS: 0.0200701
- Silence: false
- Clipping: false, zero clipped samples
- Dropped callback blocks: 0
- Disconnected: false
- Duration within tolerance: true
- Warnings: none
- Pattern/Kit: A01 / KIT 1
- Tempo: 120 BPM
- USB output: Main Out
- Snapshot rollback: restored and verified, revision advanced from 1 to 2

The harness declared a disposable BD/SD/CH Pattern and semantic Main routing, read it back, recorded direct MIDI triggers, finalized WAV/JSON atomically, then restored the raw Pattern/Kit/Global/Settings baseline in `finally`-protected code.

## Routing Codec Finding

Initial captures were valid but silent while headphone triggers remained audible. An independent AVFoundation recording captured the same direct MIDI hits at approximately -20.4 dBFS, isolating the problem from the Rytm and macOS USB path.

Connected Global data demonstrated that `route_to_main` and `send_to_fx` are active-low on the firmware wire: raw zero is the all-enabled state. The maintained fork previously exposed those raw bits as positive semantic flags. Commit `63c14d5` now inverts both fields at decode/encode boundaries while preserving byte-exact SysEx round trips. After repinning the bridge, inspection reports semantic flags `4095` and all 12 routed track names; the bounded capture passed.

Fork verification:

```text
cargo test -p rytm-rs --lib --test firmware_fixtures
6 unit tests passed
5 connected firmware fixture tests passed
```

The fork's legacy full `reverse_engineering` test target still terminates with `SIGBUS` when invoked wholesale; the deterministic library and firmware-fixture suites pass and cover this codec change.

## Software Verification

```text
npm run check
15 TypeScript tests passed
31 Rust tests passed

cargo clippy --manifest-path daemon/Cargo.toml --all-targets --all-features -- -D warnings
passed
```

Both hardware verifier modules were also imported directly under Node 25 and produced no daemon startup, temporary directories, or device traffic. They execute only when used as CLI entrypoints.
