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

Hardware runtime state defaults to `~/.analog-rytm-agent-bridge/hardware-state.json`. Use `--state-dir <directory>` for an isolated project or test store. `--clock-source observed` follows incoming MIDI realtime messages; `--clock-source generated` makes the daemon send 24 PPQN clock at the transport tempo.

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

After a successful state-changing response, the daemon emits the resulting acknowledgement and state events as separate envelopes. Boundary events can arrive while no request is in flight because the stdio loop polls the hardware scheduler. The TypeScript client exposes these through `onEvent`; `events.read` provides durable cursor-based catch-up on hardware.

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

Also implemented by both adapters:

- `operations.queue`
- `realtime.set_parameter`
- `realtime.trigger_track`
- `realtime.set_transport`
- `realtime.change_pattern`

The mock adapter also has `test.advance_mock_transport` and `test.delay` methods for deterministic scheduler and disconnect tests. They are not MCP tools.

Hardware `operations.apply_now` and `operations.queue` support persistent Pattern, Sound, machine, Kit, FX, Global, routing, MIDI, sequencer, and Settings deltas. Realtime RPC supports track notes, transport, program change, and validated `track_level` through CC 95 or NRPN 1:100. Sample assignment remains capability-gated.

Hardware queue calls require `applyAt.transportEpoch`. Obtain it from `device.inspect_state.transport.epoch` after transport start. A boundary is resolved to an absolute step in that epoch; it is never inferred from request arrival time.

## Idempotency And Failure

- The caller owns request IDs.
- The daemon retains the latest 1,024 completed request envelopes and responses.
- An identical ID and envelope replays the original response.
- An identical ID with a changed method or parameters returns `request_id_conflict`.
- A TypeScript-side timeout returns `request_timeout` and is retryable.
- A process exit or broken pipe returns `daemon_disconnected` and is retryable unless the client intentionally closed the daemon.
- MIDI disconnects and SysEx timeouts return retryable `hardware_error` responses.
- Stale revisions, stale epochs, invalid values, and conflicting operation-set IDs return non-retryable `validation_failed` responses.
- A failed write whose raw baseline was restored reports `hardware_write_failed` with `acknowledgement: rollback_verified`.
- Schema, envelope, and domain validation failures are not retryable without changing the request.
- Replaying a state-changing request does not emit duplicate events.

## Restart And Reconciliation

The TypeScript client can start a new process after an unexpected disconnect. Mock state starts fresh. Hardware queue, snapshot, event, revision, last observation, and transport metadata reload from the durable store.

Every hardware reconnect opens a new transport epoch and re-queries Pattern, Kit, Global, and Settings before accepting writes. Queued work with `latePolicy: reject` is rejected when its epoch is stale. `latePolicy: roll-forward` resolves the same boundary kind in the new epoch and emits `operation_set.reconciled`. An external semantic state change increments revision, causing old revision-checked work to reject before dispatch.

During active external clock, the device-reported Pattern and Settings BPM are treated as transport-derived observations rather than persistent drift. The daemon still reconciles every other field normally.

## Safety

Hardware mutation first reads all four raw objects, applies validated operations to a decoded copy, canonicalizes through the SysEx codec, writes only changed objects, re-queries semantic state, and restores the raw baseline automatically on mismatch. Snapshot rollback increments the public revision and verifies the restored state. The certification harness requires `--execute`; direct RPC callers are expected to use validation, dry run, expected revisions, and snapshots deliberately.
