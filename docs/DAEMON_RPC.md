# Rust Daemon RPC

## Transport

The TypeScript facade starts one Rust child process and exchanges one JSON object per line over stdin/stdout. Standard output is reserved for protocol messages. Diagnostics and startup failures use standard error.

```bash
cargo run --manifest-path daemon/Cargo.toml -- serve --adapter mock
cargo run --manifest-path daemon/Cargo.toml -- serve --adapter hardware
```

The hardware adapter accepts an optional CoreMIDI name match:

```bash
cargo run --manifest-path daemon/Cargo.toml -- serve --adapter hardware --port-match "Elektron Analog Rytm MKII"
```

## Envelopes

Request:

```json
{"schema":"analog-rytm-rpc.v1","id":"request-1","method":"pattern.inspect","params":{"pattern":"A01"}}
```

Success:

```json
{"schema":"analog-rytm-rpc.v1","id":"request-1","ok":true,"result":{}}
```

Failure:

```json
{"schema":"analog-rytm-rpc.v1","id":"request-1","ok":false,"error":{"code":"validation_failed","message":"pattern slot must be A01 through H16","retryable":false}}
```

Asynchronous event envelope:

```json
{"schema":"analog-rytm-rpc.v1","eventId":"event-1","type":"operation_set.applied","payload":{}}
```

After a successful state-changing response, the daemon emits the resulting acknowledgement and state events as separate envelopes. The TypeScript client exposes these through `onEvent`; `events.read` provides cursor-based catch-up in mock mode.

## Method Registry

Implemented for both mock and hardware adapters:

- `daemon.health`
- `daemon.describe`
- `device.inspect_state`
- `pattern.inspect`
- `kit.inspect`
- `sound.inspect`
- `global.inspect`
- `operations.validate`
- `operations.propose`
- `operations.apply_now`
- `snapshot.create`
- `snapshot.rollback`
- `events.read`
- `state.reconcile`

Also implemented by the mock adapter:

- `operations.queue`
- `realtime.set_parameter`
- `realtime.trigger_track`
- `realtime.set_transport`
- `realtime.change_pattern`

The mock adapter also has `test.advance_mock_transport` and `test.delay` methods for deterministic scheduler and disconnect tests. They are not MCP tools.

Hardware `operations.apply_now` supports persistent Sound, machine, Kit, FX, Global, routing, MIDI, sequencer, and Settings deltas. Hardware queueing, realtime RPC, pattern deltas, and sample assignment still return `capability_unavailable`. `daemon.health` reports adapter-specific implemented methods so callers do not infer support from protocol presence.

## Idempotency And Failure

- The caller owns request IDs.
- The daemon retains the latest 1,024 completed request envelopes and responses.
- An identical ID and envelope replays the original response.
- An identical ID with a changed method or parameters returns `request_id_conflict`.
- A TypeScript-side timeout returns `request_timeout` and is retryable.
- A process exit or broken pipe returns `daemon_disconnected` and is retryable unless the client intentionally closed the daemon.
- Hardware query failures return `hardware_error` and are retryable.
- Schema, envelope, and domain validation failures are not retryable without changing the request.
- Replaying a state-changing request does not emit duplicate events.

## Restart And Reconciliation

The TypeScript client can start a new process after an unexpected disconnect. Mock queue, snapshot, event, and revision state is currently in memory and starts fresh with the new process. Hardware `state.reconcile` re-queries Pattern, Kit, Global, and Settings from the connected device.

Durable daemon-owned queue and snapshot recovery is intentionally not claimed yet. Callers must inspect/reconcile after a restart before submitting revision-checked writes.

## Safety

Hardware mutation first reads all four raw objects, applies validated operations to a decoded copy, canonicalizes through the SysEx codec, writes only changed objects, re-queries semantic state, and restores the raw baseline automatically on mismatch. Snapshot rollback increments the public revision and verifies the restored state. The certification harness requires `--execute`; direct RPC callers are expected to use validation, dry run, expected revisions, and snapshots deliberately.
