# Codec Certification

Codec certification is the bridge's evidence that the maintained `rytm-rs`
fork's typed Scene, Performance, and Song codecs match what the hardware
actually stores — not just what the codec believes it wrote.

A certification run is a single controlled experiment against the work buffer:

1. **Snapshot** the current work-buffer object (Kit or Song) exactly as the
   device reports it.
2. **Write** a controlled definition — specific locks on specific tracks and
   parameters, or a specific Song name, row set, pattern chain, repeats, and
   mute masks.
3. **Read back** the object and verify it through the *typed* codec: the locks,
   rows, and masks the device returns must be the ones that were requested.
4. **Restore** the snapshot and confirm the readback is byte-identical to the
   captured baseline.
5. **Record a receipt** — a JSON file with the run status, the observed
   firmware, the MIDI port names, FNV-1a-64 fingerprints of the baseline,
   defined, and restored dumps, and the per-lock or per-row readback — alongside
   the three SysEx dumps themselves.

This tooling lives here rather than in the fork. The fork is a codec library
offered upstream; write/readback/rollback certification is agent-workflow
tooling that belongs to the application that owns the workflow.

## The tools

Three examples under `daemon/examples/`. All take an output directory as their
first argument.

**`certify_macro_codecs`** — Scene and Performance definitions on the
work-buffer Kit.

```sh
cd daemon

# Read-only. Queries the Kit, builds the proposed definitions in memory,
# prints the plan as JSON. Writes nothing to the device or to disk.
cargo run --example certify_macro_codecs -- \
  tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD \
  --observed-firmware 1.72

# Write / readback / rollback, emitting the receipt and the three dumps.
cargo run --example certify_macro_codecs -- \
  tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD \
  --observed-firmware 1.72 \
  --execute
```

**`certify_song_codec`** — name, rows, pattern chain, repeats, and per-pattern
track mutes on the work-buffer Song. Same shape:

```sh
cargo run --example certify_song_codec -- \
  tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD \
  --observed-firmware 1.72          # read-only plan

cargo run --example certify_song_codec -- \
  tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD \
  --observed-firmware 1.72 \
  --execute                          # write / readback / rollback
```

**`capture_song_transitions`** — records work-buffer Song states while an
operator makes one front-panel edit at a time, writing a dump plus a byte-diff
for every unique state. This is how unattributed Song bytes get attributed to UI
features. It is **read-only against the device in every mode** — it only issues
queries, so it has no `--execute` flag.

```sh
cargo run --example capture_song_transitions -- \
  tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD \
  --duration-seconds 180 --interval-ms 400 \
  --observed-firmware 1.72
```

All three accept `--port-match <name>` (default `Elektron Analog Rytm MKII`).
`--observed-firmware` is the version the operator read off the device; omit it
and the receipt records the version as explicitly unknown rather than inferring
one, because neither the MIDI identity response nor the object responses report
the OS version.

Connect the device over USB in Audio/MIDI mode with SysEx send and receive
enabled. Run the query-only form first and read the plan before adding
`--execute`.

## Where the receipts live

`daemon/tests/fixtures/rytm-rs-certification/<device>-<date>/`. The committed
set is `mkii-connected-2026-07-17` — an Analog Rytm MKII on OS 1.72. See that
directory's `README.md` for a file-by-file description.

`daemon/tests/codec_certification.rs` is the offline regression cover over those
receipts. It asserts the rollback dumps are byte-equal to their baselines, that
each receipt still says `write-readback-rollback-verified` with matching
baseline and restored fingerprints, and that the defined dumps still decode
through the *currently pinned* fork revision to the values the receipts
recorded. A codec change that would silently reinterpret certified bytes fails
that test.

```sh
cargo test -p analog-rytm-agent-daemon --test codec_certification
```

## Invariants

**Definition writes never activate a Scene.** Writing Scene definitions changes
stored definitions only; the active-Scene selector must come back unchanged.
The receipt records it as `activeSceneDefinitionWriteInvariant`, and the
committed run holds it at `255` (0xFF — the inactive sentinel). The example
fails the run if the device's active Scene moved.

**Rollback failure is reported separately.** Certification and restoration are
evaluated independently. A certification failure with a successful rollback is
an ordinary failed experiment. A *rollback* failure is reported as its own
error — and when both fail, the message is explicit about the emergency
rollback failure, because at that point the operator's work buffer is left
holding certification state and needs manual attention. Never treat "the run
failed" as "the device was left untouched" without reading which of the two
failed.

**Captures carry no personal data.** Certification dumps are Kit and Song
objects only: no sample audio, no project backups, no unrelated user data.

## See also

- [`UPSTREAM.md`](UPSTREAM.md) — why the `rytm-rs` dependency is a fork, what it
  changes, and how the revision pin relates to these certificates.
- [`HARDWARE_VALIDATION_2026-07-17_MACROS.md`](HARDWARE_VALIDATION_2026-07-17_MACROS.md)
  and [`HARDWARE_VALIDATION_2026-07-17_SONGS.md`](HARDWARE_VALIDATION_2026-07-17_SONGS.md)
  — the validation reports from the session these receipts came from.
