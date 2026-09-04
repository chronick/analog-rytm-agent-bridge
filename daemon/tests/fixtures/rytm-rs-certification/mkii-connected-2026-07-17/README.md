# Codec Certification Receipts — Analog Rytm MKII, 2026-07-17

Captured on 2026-07-17 over CoreMIDI from an Analog Rytm MKII running **OS 1.72**
(verified on the device by the operator; the MIDI identity and object responses
do not report the OS version). The `rytm-rs` fork's public codec target is
firmware 1.70 — these captures are additional compatibility evidence, not a
claim that every 1.72 field is understood.

These are the receipts for two write/readback/rollback certification runs
against the work buffer. They are checked by
[`daemon/tests/codec_certification.rs`](../../../codec_certification.rs).

## Files

### Scene / Performance macro certification

| File | What it is |
|---|---|
| `macros-baseline-kit.syx` | The work-buffer Kit as captured *before* any write. |
| `macros-defined-kit.syx` | The work-buffer Kit read back *after* the controlled Scene and Performance definitions were written. |
| `macros-restored-kit.syx` | The work-buffer Kit read back *after* rollback. |
| `macros-certification.json` | The receipt: schema `rytm-rs-macro-certification.v1`, run status, firmware, MIDI port names, FNV-1a-64 fingerprints of the three dumps, the active-Scene invariant, and the per-lock readback for Scenes 0/1 and Performances 0/1. |

Definitions written: Scene 0 — one lock (voice track 0, raw parameter 8
`sample_tune`, value 65). Scene 1 — two locks (voice track 1, parameter 20
`filter_frequency`, value 96; FX track, parameter 3 `delay_feedback`, value 80).
Performance 0 — one lock (voice track 0, parameter 8 `sample_tune`, depth 12).
Performance 1 — two locks (voice track 1, parameter 30 `amp_pan`, depth −32;
FX track, parameter 11 `reverb_decay`, depth 24).

`activeSceneDefinitionWriteInvariant` is `255` (0xFF, the inactive-Scene
sentinel): writing definitions did **not** activate a Scene.

### Song certification

| File | What it is |
|---|---|
| `song-certification-baseline.syx` | The work-buffer Song as captured *before* any write. |
| `song-certification-defined.syx` | The work-buffer Song read back *after* the controlled Song was written. |
| `song-certification-restored.syx` | The work-buffer Song read back *after* rollback. |
| `song-certification.json` | The receipt: schema `rytm-rs-song-certification.v1`, run status, firmware, MIDI port names, fingerprints, and the row/repeat/pattern-chain/mute readback. |

Song written: name `AGENT SONG`; row 0 repeats 2 with a pattern chain of
patterns 0 and 1, pattern 1 muting track 0 (mask 1); row 1 repeats 1 with
pattern 16 muting track 1 (mask 2).

> The committed `song-certification.json` also carries a `capabilities` object
> from the fork's `Song::capabilities()`. That API has since been removed, so
> the current `certify_song_codec` example emits a static `certifiedFields`
> list instead. A regenerated receipt will differ in that field only.

## What these prove

`macros-restored-kit.syx` is **byte-identical** to `macros-baseline-kit.syx`,
and `song-certification-restored.syx` is byte-identical to
`song-certification-baseline.syx`. That is the point of the receipts: the
certification wrote real state to the device, read it back through the typed
codec, and then put the work buffer back exactly as it was found. The
`baselineFingerprint == restoredFingerprint` equality in each JSON receipt is
the same fact recorded independently at capture time.

**No sample audio is included.** These captures are Kit and Song objects only —
no personal sample data, project backups, or unrelated user data.

## Regenerating

Connect an Analog Rytm MKII over USB in Audio/MIDI mode and enable SysEx send
and receive. Both tools are read-only without `--execute`; run them that way
first to review the plan.

```sh
cd daemon

# Dry run (read-only, prints the plan as JSON, writes nothing).
cargo run --example certify_macro_codecs -- \
  tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD \
  --observed-firmware 1.72

# Write / readback / rollback, writing the receipt and dumps.
cargo run --example certify_macro_codecs -- \
  tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD \
  --observed-firmware 1.72 \
  --execute

cargo run --example certify_song_codec -- \
  tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD \
  --observed-firmware 1.72 \
  --execute
```

Then re-point `FIXTURE_DIRECTORY` in `daemon/tests/codec_certification.rs` at
the new directory and run `cargo test --test codec_certification`.

Regenerate when certifying against a different verified firmware version, or
when a fork codec change affects object serialization. See
[`docs/CODEC_CERTIFICATION.md`](../../../../../docs/CODEC_CERTIFICATION.md).
