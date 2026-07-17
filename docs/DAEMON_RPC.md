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

Reserved asynchronous event envelope:

```json
{"schema":"analog-rytm-rpc.v1","eventId":"event-1","type":"operation_set.applied","payload":{}}
```

Events are part of the versioned contract but are not emitted in the current read-only slice.

## Method Registry

Implemented for both mock and hardware adapters:

- `daemon.health`
- `daemon.describe`
- `device.inspect_state`
- `pattern.inspect`

Declared for subsequent process-boundary patches:

- `operations.validate`
- `operations.propose`
- `operations.queue`
- `operations.apply_now`
- `realtime.set_parameter`
- `realtime.trigger_track`
- `realtime.set_transport`
- `realtime.change_pattern`
- `snapshot.create`
- `snapshot.rollback`
- `events.read`
- `state.reconcile`

Declared methods return `not_implemented` until they have a tested daemon implementation. `daemon.health` reports both lists so callers do not infer support from schema presence.

## Idempotency And Failure

- The caller owns request IDs.
- The daemon retains the latest 1,024 completed request envelopes and responses.
- An identical ID and envelope replays the original response.
- An identical ID with a changed method or parameters returns `request_id_conflict`.
- A TypeScript-side timeout returns `request_timeout` and is retryable.
- A process exit or broken pipe returns `daemon_disconnected` and is retryable unless the client intentionally closed the daemon.
- Hardware query failures return `hardware_error` and are retryable.
- Schema, envelope, and domain validation failures are not retryable without changing the request.

## Safety

The RPC hardware methods in this slice only query device state. Existing state-changing harness commands remain separate and still require their explicit `--execute` flag. Mutation methods will not be marked implemented until they preserve snapshots, readback verification, revision checks, and rollback behavior across this boundary.
