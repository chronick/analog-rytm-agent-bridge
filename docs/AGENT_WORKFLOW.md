# Coding-Agent Workflow

The Rytm bridge and `pd-agent-bridge` are independent tools. In a combined set, the coding agent is the only coordinator: inspect each bridge separately, read audio-analysis results separately, and issue operations to the owning bridge. Never infer that one bridge's revision, clock epoch, or rollback covers the other.

## Session Start

1. Call `rytm_daemon_health`. Require `connected: true` and the needed RPC method in `methods.implemented`.
2. Call `rytm_describe_capabilities`. Check the exact control family, `status`, `verified`, transport, firmware evidence, and risk; do not infer complete support from a coarse boolean flag.
3. Call `rytm_inspect_device_state`. Retain the current revision and transport epoch.
4. Inspect only the object needed: Pattern, Song, Kit, Sound, Global, samples, or audio provider.
5. After a power cycle, daemon restart, USB mode change, or external panel edit, call reconciliation and inspect again before writing.

## Persistent State

1. Express the desired result as the smallest delta operation set.
2. Call validation, then a proposal/dry run when available.
3. Use a stable operation-set ID for retries of the identical declaration. Never reuse it for a different payload.
4. Supply the last inspected revision. For a queued operation, also supply the current transport epoch, boundary, and late policy.
5. Snapshot before a new operation family or any change whose musical result has not already been certified.
6. Apply immediately only when a musical boundary is unnecessary; otherwise queue for the next step, beat, measure, Pattern, or explicit Pattern step.
7. Read the acknowledgement/event journal. Treat `verified` or `rollback_verified` as evidence; a sent MIDI message alone is not persistent-state proof.
8. Re-inspect the owning object when the result will drive another decision.

Revision numbers are monotonic bridge history, not device storage versions. Rollback restores device state and increments the revision.

## Realtime State

Notes, transport, Pattern change, track level, Scene activation, and Performance amount use CoreMIDI. They do not mutate the persistent revision. Some values are send-only or send-cache state; consult capability evidence before assuming readback.

On shutdown or recovery, stop transport, release notes, restore any intentionally changed active Scene, and clear Performance amounts used by the agent.

## Audio

- In `USB AUDIO/MIDI`, use class-compliant Main stereo capture.
- In `OVERBRIDGE`, inspect provider availability before requesting synchronized stems.
- Treat USB mode changes as manual operator actions.
- A completed recording must have finalized files, expected duration, non-silent signal when expected, and no disconnect/dropout warning before analysis consumes it.
- Audio capture never owns the MIDI/SysEx control plane.

## Recovery

- `stale_revision`: inspect/reconcile and decide whether the desired delta still applies.
- stale transport epoch: inspect the new epoch; reject or deliberately roll forward according to musical intent.
- `capability_unavailable`: inspect capability/provider state. Do not retry a mode-dependent operation blindly.
- retryable disconnect: wait for the device ports, reconnect, reconcile, and use a new revision/epoch.
- `rollback_verified`: the attempted write failed but the captured baseline was restored. Inspect before continuing.
- `rollback_failed`: stop automated writes and preserve the evidence directory for manual recovery.
- sample RAM after power cycle: re-inspect and resolve by stable sample identity before assignment.

The bridge never exposes OS upgrade, reset, +Drive format, calibration, test mode, or other destructive maintenance as agent tools.
