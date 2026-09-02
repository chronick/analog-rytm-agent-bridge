# Sample Management

The bridge manages Analog Rytm samples through a separate Elektroid CLI process. It does not import Elektroid code into the Rust daemon. The required adapter is the `algonormative/elektroid` fork at commit `681fa8c`, which enables Rytm RAM and track filesystems, adds +Drive-to-RAM copy, and provides `-k` so each short-lived connection leaves transport running.

## Agent Workflow

1. `rytm_inspect_samples` lists one +Drive directory, all 127 RAM slots, and optional track assignments.
2. `rytm_upload_sample` validates an absolute local WAV, uploads it, lists the destination, downloads the canonical Rytm version, and verifies its name, path, checksum, size, format, and digest.
3. `rytm_resolve_sample_ram` loads the managed +Drive sample into a requested or free RAM slot and verifies the observed path.
4. `assign_sample_slot` is submitted through the normal delta API. Validation re-reads RAM immediately before dry run, queueing, and boundary application so a stale or replaced slot cannot silently target different content.
5. `rytm_clear_sample_ram` clears only a slot containing the expected managed sample and refuses a slot still reported as used by a track.

Sample assignment is therefore revision checked, schedulable, idempotent, dry-runnable, and covered by raw Kit snapshots. Upload and RAM resolution are explicit preparatory operations because the Rytm filesystem is outside its SysEx project objects.

Upload, RAM load, and RAM clear require stopped transport. They are preparation operations, not realtime or musical-boundary actions. Read-only inventory remains available, and every Elektroid invocation uses `-k` so it never intentionally sends MIDI Stop.

## Identity And Idempotency

The daemon stores `sample-state.json` beside its hardware scheduler state. A managed ID is derived from the canonical downloaded WAV digest, device path, and Elektron inventory checksum. Inventory exposes rounded display size separately from identity evidence.

- Re-uploading the same source declaration returns `already-present` without transfer.
- Resolving a sample already in RAM returns its observed slot without copying.
- Requesting the same sample in a second slot is rejected as an accidental duplicate.
- An occupied requested slot is never replaced implicitly.
- Assignment requires both the managed ID and its currently observed RAM path.
- Normal JSON-RPC request-ID and operation-set-ID replay rules still apply.

## Formats And Conversion

The current bridge accepts non-empty `.wav` files only. Elektroid performs device conversion where needed. The bridge downloads the device result and requires mono, 48 kHz, 16-bit integer PCM before registering it. The response reports source format, whether conversion was required, source digest, canonical digest, Elektron checksum, and device path.

## Rollback Boundaries

Raw bridge snapshots include the Pattern, Kit, Global, and Settings work buffers. They restore a Sound's selected sample number and verify semantic readback. They do not include the +Drive filesystem or volatile sample RAM.

- Roll back or reassign every Sound before clearing a RAM slot.
- RAM can be cleared explicitly with managed identity verification.
- A successful +Drive upload is retained after snapshot rollback.
- The certification file remains at `/agent-bridge-tests/bridge-certification-sine` so repeated tests prove no-duplicate behavior.

## Failure Modes

- Missing fork CLI or no matching MIDI device returns a retryable `sample_transport_disconnected` error.
- Full RAM, an occupied slot, unknown IDs, duplicate-slot requests, and identity mismatches are non-retryable validation failures.
- If power or USB is interrupted after the Rytm commits an upload but before `sample-state.json` is persisted, the existing path is treated as unmanaged and is not overwritten. Inspect it and remove or rename it with the pinned Elektroid CLI before retrying.
- If assignment readback fails, the normal hardware transaction restores all raw SysEx baselines. If that rollback also fails, do not clear RAM until the Sound has been inspected and restored.
- Every Elektroid invocation uses `-k`; sample inspection and transfer must not send MIDI Stop to a running performance.

The connected certification covers Analog Rytm MKII OS 1.72. This is hardware evidence for that setup, not a general compatibility claim for other firmware.
