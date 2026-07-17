import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RytmPersistentOperation } from "../domain/types.ts";
import { RytmDaemonRpcError, RustDaemonClient } from "../rpc/RustDaemonClient.ts";

if (!process.argv.includes("--execute")) {
  throw new Error("refusing hardware scheduler certification without --execute");
}

const repository = fileURLToPath(new URL("../../", import.meta.url));
const stateDirectory = mkdtempSync(join(tmpdir(), "analog-rytm-scheduler-"));
const faultDirectory = mkdtempSync(join(tmpdir(), "analog-rytm-scheduler-fault-"));
let client: RustDaemonClient | undefined;
let faultClient: RustDaemonClient | undefined;

try {
  client = hardwareClient(stateDirectory);
  const health = await client.start();
  assert.equal(health.connected, true);
  for (const method of [
    "operations.queue",
    "realtime.set_parameter",
    "realtime.trigger_track",
    "realtime.set_transport",
    "realtime.change_pattern",
  ]) {
    assert.ok(health.methods.implemented.includes(method), `${method} is not implemented`);
  }

  const baselineState = asRecord(await client.inspectDeviceState());
  const baselineRevision = baselineState.revision as number;
  const baselineLevel = trackLevel(baselineState);
  const changedLevel = baselineLevel >= 64 ? baselineLevel - 7 : baselineLevel + 7;
  const activePattern = asRecord(baselineState.activePattern).pattern as string;

  let transport = asRecord(await client.setTransport({ command: "start", tempo: 90 }));
  await client.triggerTrack({ track: "BD", velocity: 24, durationMs: 60 });
  await client.setLiveParameter({
    track: "BD",
    parameter: "track_level",
    value: baselineLevel,
    lane: "nrpn",
  });
  await client.changePattern({ pattern: activePattern });

  const nextStepInput = {
    operationSetId: "scheduler-next-step",
    expectedRevision: baselineRevision,
    applyAt: { kind: "next_step" as const, transportEpoch: transport.epoch as string },
    latePolicy: "reject" as const,
    operations: [trackLevelOperation(changedLevel)],
  };
  const queued = asRecord(await client.queueOperations(nextStepInput));
  assert.equal(queued.status, "queued");
  assert.equal(asRecord(queued.resolvedBoundary).transportEpoch, transport.epoch);
  const appliedEvent = await waitForOperation(client, "scheduler-next-step", "operation_set.applied");
  assert.equal(appliedEvent.acknowledgement, "verified");
  assert.equal(trackLevel(asRecord(await client.inspectDeviceState())), changedLevel);

  const currentRevision = baselineRevision + 1;
  const staleEpochInput = {
    operationSetId: "scheduler-stale-epoch",
    expectedRevision: currentRevision,
    applyAt: { kind: "next_pattern" as const, transportEpoch: transport.epoch as string },
    latePolicy: "reject" as const,
    operations: [trackLevelOperation(changedLevel)],
  };
  const staleQueued = await client.queueOperations(staleEpochInput);
  const staleReplay = await client.queueOperations(staleEpochInput);
  assert.deepEqual(staleReplay, staleQueued);
  await assert.rejects(
    client.queueOperations({
      ...staleEpochInput,
      operations: [trackLevelOperation(baselineLevel)],
    }),
    (error: unknown) => error instanceof RytmDaemonRpcError
      && error.code === "validation_failed"
      && /different payload/.test(error.message),
  );
  transport = asRecord(await client.setTransport({ command: "start", tempo: 30 }));
  const rejectedEvent = await waitForOperation(
    client,
    "scheduler-stale-epoch",
    "operation_set.rejected",
  );
  assert.match(rejectedEvent.reason as string, /transport epoch changed/);

  const persistentInput = {
    operationSetId: "scheduler-restart-persisted",
    expectedRevision: currentRevision,
    applyAt: { kind: "next_pattern" as const, transportEpoch: transport.epoch as string },
    latePolicy: "roll-forward" as const,
    operations: [trackLevelOperation(baselineLevel)],
  };
  assert.equal(asRecord(await client.queueOperations(persistentInput)).status, "queued");
  await client.close();
  client = undefined;

  client = hardwareClient(stateDirectory);
  await client.start();
  const restoredState = asRecord(await client.inspectDeviceState());
  const persisted = (restoredState.operationSets as unknown[])
    .map(asRecord)
    .find((operationSet) => operationSet.operationSetId === "scheduler-restart-persisted");
  assert.equal(persisted?.status, "queued");
  await client.setTransport({ command: "start", tempo: 120 });
  const restartApplied = await waitForOperation(
    client,
    "scheduler-restart-persisted",
    "operation_set.applied",
    45_000,
  );
  assert.equal(restartApplied.acknowledgement, "verified");
  const rolledForwardReplay = asRecord(await client.queueOperations(persistentInput));
  assert.equal(rolledForwardReplay.status, "applied");
  assert.notEqual(
    asRecord(rolledForwardReplay.resolvedBoundary).transportEpoch,
    transport.epoch,
  );
  assert.equal(trackLevel(asRecord(await client.inspectDeviceState())), baselineLevel);
  const reconciliation = asRecord(await client.reconcileState());
  assert.equal(reconciliation.changed, false, JSON.stringify(reconciliation));
  await client.setTransport({ command: "stop" });

  const normalEvents = await client.getEvents(0, 1000);
  const normalEventTypes = normalEvents.map((entry) => asRecord(entry.event).type as string);
  assert.ok(normalEventTypes.filter((type) => type === "connection.connected").length >= 2);
  assert.ok(normalEventTypes.includes("connection.disconnected"));
  assert.ok(normalEventTypes.includes("operation_set.reconciled"));

  faultClient = hardwareClient(faultDirectory, true);
  await faultClient.start();
  const faultBaselineState = asRecord(await faultClient.inspectDeviceState());
  const faultBaselineRevision = faultBaselineState.revision as number;
  const faultBaselineLevel = trackLevel(faultBaselineState);
  const faultChangedLevel = faultBaselineLevel >= 64 ? faultBaselineLevel - 5 : faultBaselineLevel + 5;
  const faultBaselineFixedVelocity = asRecord(
    asRecord(asRecord(faultBaselineState.evidence).settings).fixedVelocity,
  ).amount as number;
  const faultChangedFixedVelocity = faultBaselineFixedVelocity >= 127
    ? faultBaselineFixedVelocity - 1
    : faultBaselineFixedVelocity + 1;
  const faultTransport = asRecord(await faultClient.setTransport({ command: "start", tempo: 90 }));
  await faultClient.queueOperations({
    operationSetId: "scheduler-forced-verification-failure",
    expectedRevision: faultBaselineRevision,
    applyAt: { kind: "next_step", transportEpoch: faultTransport.epoch as string },
    latePolicy: "reject",
    operations: [
      trackLevelOperation(faultChangedLevel),
      {
        type: "set_global_parameter",
        section: "settings",
        parameter: "fixed_velocity_amount",
        value: faultChangedFixedVelocity,
      },
    ],
  });
  const faultEvent = await waitForOperation(
    faultClient,
    "scheduler-forced-verification-failure",
    "operation_set.rejected",
    45_000,
  );
  assert.equal(faultEvent.acknowledgement, "rollback_verified");
  const faultRestoredState = asRecord(await faultClient.inspectDeviceState());
  assert.equal(trackLevel(faultRestoredState), faultBaselineLevel);
  assert.equal(
    asRecord(asRecord(asRecord(faultRestoredState.evidence).settings).fixedVelocity).amount,
    faultBaselineFixedVelocity,
  );
  await faultClient.setTransport({ command: "stop" });

  console.log(JSON.stringify({
    status: "hardware-scheduler-certified",
    baselineRevision,
    resultingRevision: currentRevision + 1,
    boundaries: ["next_step", "next_pattern"],
    restartPersistence: "verified",
    staleEpochPolicy: "verified",
    duplicateIdempotency: "verified",
    reconnectReconciliation: "verified",
    noOpReconciliation: "verified",
    rollbackAfterVerificationFailure: faultEvent.acknowledgement,
    realtimeTools: ["set_parameter", "trigger_track", "set_transport", "change_pattern"],
    eventTypes: [...new Set(normalEventTypes)].sort(),
  }, null, 2));
} finally {
  await client?.close();
  await faultClient?.close();
  rmSync(stateDirectory, { recursive: true, force: true });
  rmSync(faultDirectory, { recursive: true, force: true });
}

function hardwareClient(stateDirectory: string, forceVerificationFailure = false): RustDaemonClient {
  const args = [
    "run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve",
    "--adapter", "hardware",
    "--state-dir", stateDirectory,
    "--clock-source", "generated",
  ];
  if (forceVerificationFailure) args.push("--test-force-verification-failure");
  return new RustDaemonClient({
    command: "cargo",
    args,
    cwd: repository,
    requestTimeoutMs: 180_000,
  });
}

function trackLevelOperation(value: number): RytmPersistentOperation {
  return { type: "set_kit_parameter", track: "BD", parameter: "track_level", value };
}

function trackLevel(state: Record<string, any>): number {
  const levels = asRecord(state.evidence).kit.trackLevels as number[];
  return levels[0] as number;
}

async function waitForOperation(
  daemon: RustDaemonClient,
  operationSetId: string,
  eventType: "operation_set.applied" | "operation_set.rejected",
  timeoutMs = 30_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await daemon.getEvents(0, 1000);
    const match = events
      .map((entry) => asRecord(entry.event))
      .find((event) => event.type === eventType && event.operationSetId === operationSetId);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${eventType} for ${operationSetId}`);
}

function asRecord(value: unknown): Record<string, any> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}
