# Audio Capture

## Scope

The implemented audio lane records the Analog Rytm MKII class-compliant USB input as one 48 kHz stereo stream on macOS/CoreAudio. It is suitable for agent analysis, previews, and archival of the current main mix.

This lane does not use Overbridge and does not expose individual tracks. Overbridge multitrack capture and optional plugin automation remain a separate capability so audio software cannot become a dependency of the state-control plane.

## Device Setup

1. Connect the Rytm by USB and select USB CONFIG `AUDIO/MIDI`.
2. In GLOBAL > AUDIO ROUTING, select `MAIN OUT` for `USB OUT`.
3. Keep the required tracks routed to Main.
4. Stop DAWs or utilities that hold the Rytm input exclusively.
5. Run `npm run hardware:audio` to verify the detected format before recording.

The maintained `rytm-rs` fork converts the firmware's active-low routing wire masks into semantic flags. In agent payloads, a set bit and a track name in `tracksRoutedToMain` always mean enabled.

## Agent Surface

The RPC methods are `audio.list_inputs`, `audio.start_recording`, `audio.stop_recording`, and `audio.capture_pattern`. Their MCP equivalents are:

- `rytm_list_audio_inputs`
- `rytm_start_recording`
- `rytm_stop_recording`
- `rytm_capture_pattern_audio`

`start_recording` is nonblocking and accepts an optional `expectedDurationMs`. `capture_pattern_audio` is blocking and requires `durationMs`. Use an explicit stable `recordingId` for retries. Reusing the same ID and declaration is idempotent; changing parameters under an active ID rejects.

The daemon owns the output directory and state context. Agents cannot supply Pattern, Kit, revision, routing, tempo, or timestamps.

## Files And Metadata

Audio is written to `<recordingId>.wav.partial` as stereo 32-bit float samples. Stop/finalization writes the WAV header, syncs the file, and atomically renames it to `<recordingId>.wav`. The JSON sidecar follows the same `.json.partial` to `.json` sequence.

The sidecar uses schema `analog-rytm-recording.v1` and includes:

- CoreAudio device ID/name, source/captured channels, sample rate, and source format;
- Pattern slot, Kit identity, daemon revision, tempo, semantic routing, and snapshot ID;
- start/stop timestamps, frames, duration, byte count, and final paths;
- peak, RMS, silence, clipping/sample count, duration tolerance, disconnect, and dropped callback blocks;
- warnings and final `completed` or `failed` status.

Startup inventory reports stale `.partial` files instead of deleting or overwriting them. Existing final or partial paths reject a new capture.

## Failure Behavior

- Silence and clipping produce analysis flags and warnings without discarding a valid recording.
- Duration mismatch and capture failures mark the result failed.
- A full writer queue increments `droppedBlocks`; the realtime callback never blocks on disk I/O.
- A CoreAudio disconnect is reported by the callback and recorded when the capture is finalized.
- Daemon shutdown pauses the stream and finalizes an active capture instead of abandoning its WAV header.
- Hardware certification wraps all persistent test edits in a raw snapshot and emergency rollback path.

After a Rytm power cycle, wait for both CoreMIDI and CoreAudio discovery, inspect current state/revision, and start a new recording. Do not reuse an active pre-disconnect stream.

## Verification

Mock tests generate deterministic tone, silence, clipped, and disconnect cases. The TypeScript integration test drives the actual Rust mock daemon and validates RIFF/WAVE headers plus sidecar equality.

Connected-device certification is reversible:

```bash
npm run hardware:audio -- --execute
```

The command requires audible signal, exact bounded frame count, no clipping/dropouts/disconnect, semantic Main routing, and verified snapshot rollback. Hardware evidence is recorded in `docs/HARDWARE_VALIDATION_2026-07-17_AUDIO.md`.
