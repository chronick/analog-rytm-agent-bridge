# Hardware Setup Notes

This document is the placeholder harness for real Analog Rytm MKII validation.

## macOS/CoreMIDI

1. Connect Analog Rytm MKII by USB.
2. Confirm the Rytm appears in Audio MIDI Setup.
3. Enable MIDI input and output on the Rytm.
4. Keep Overbridge available for audio/multitrack I/O, but do not rely on it for the core state-control path.
5. Record the device model and firmware version before running any write test.

## First Hardware Tests

Run these only against a disposable project/pattern:

1. Discover MIDI ports.
2. Read device identity and firmware.
3. Send transport start/stop.
4. Trigger one muted or low-volume track.
5. Read a pattern through the Rust daemon.
6. Dry-run encode a single trig change.
7. Snapshot state.
8. Apply one non-destructive test change at a boundary.
9. Roll back from the snapshot.
10. Re-read and compare the compact pattern summary.

## Safety Rules

- Never run SysEx write tests against valuable projects without a snapshot.
- Treat firmware newer than the adapter target as unverified until the hardware test suite passes.
- Keep scenes, performance macros, songs, sample transfer, and destructive project-wide changes behind capability flags.
- Prefer a disposable pattern bank for development.

