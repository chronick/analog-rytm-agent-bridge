import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockRytmTransport } from "../src/service/MockRytmTransport.ts";
import { RytmAgentService } from "../src/service/RytmAgentService.ts";

async function createService(directory?: string): Promise<{ service: RytmAgentService; transport: MockRytmTransport; directory: string }> {
  const sessionDirectory = directory ?? await mkdtemp(join(tmpdir(), "analog-rytm-agent-test-"));
  const transport = new MockRytmTransport();
  const service = new RytmAgentService({ sessionDirectory, transport });
  await service.init();
  return { service, transport, directory: sessionDirectory };
}

test("queues a revisioned operation set and applies it at the requested measure boundary", async () => {
  const { service } = await createService();
  const queued = await service.queueOperations({
    operationSetId: "ops-kick",
    expectedRevision: 0,
    applyAt: { kind: "next_measure" },
    latePolicy: "roll-forward",
    operations: [
      { type: "set_trig", track: "BD", step: 0, velocity: 116 },
      { type: "set_parameter_lock", track: "BD", step: 0, parameter: "filter_frequency", value: 92 },
    ],
  });

  assert.equal(queued.status, "queued");
  await service.advanceMockTransport(15);
  assert.equal(service.getState().revision, 0);
  await service.advanceMockTransport(1);

  const state = service.getState();
  assert.equal(state.revision, 1);
  assert.equal(state.operationSets[0].status, "applied");
  assert.equal(state.operationSets[0].appliedAtBoundary, "next_measure");
  assert.deepEqual(state.activePattern.trigs, [{
    track: "BD",
    step: 0,
    velocity: 116,
    locks: { filter_frequency: 92 },
  }]);
});

test("duplicate operation set IDs are idempotent only for matching payloads", async () => {
  const { service } = await createService();
  const input = {
    operationSetId: "ops-idempotent",
    expectedRevision: 0,
    applyAt: { kind: "next_step" as const },
    latePolicy: "reject" as const,
    operations: [{ type: "set_trig" as const, track: "SD" as const, step: 4 }],
  };
  const first = await service.queueOperations(input);
  const second = await service.queueOperations(input);
  assert.deepEqual(first, second);
  await assert.rejects(
    service.queueOperations({ ...input, operations: [{ type: "set_trig", track: "SD", step: 5 }] }),
    /different payload/,
  );
});

test("rejects stale revisions before queueing", async () => {
  const { service } = await createService();
  await service.applyOperationsNow({
    expectedRevision: 0,
    operations: [{ type: "set_trig", track: "BD", step: 0 }],
  });
  await assert.rejects(
    service.queueOperations({
      expectedRevision: 0,
      applyAt: { kind: "next_step" },
      latePolicy: "reject",
      operations: [{ type: "set_trig", track: "SD", step: 1 }],
    }),
    /current revision is 1/,
  );
});

test("dry-run projects a pattern without mutating revision or state", async () => {
  const { service } = await createService();
  const dryRun = await service.queueOperations({
    operationSetId: "ops-dry",
    expectedRevision: 0,
    applyAt: { kind: "next_step" },
    latePolicy: "reject",
    dryRun: true,
    operations: [{ type: "set_trig", track: "CH", step: 12, velocity: 80 }],
  });
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.projectedRevision, 1);
  assert.equal(dryRun.projectedPattern?.trigCount, 1);
  assert.equal(service.getState().revision, 0);
  assert.equal(service.getState().activePattern.trigCount, 0);
});

test("snapshots and rollback restore cached state while revision stays monotonic", async () => {
  const { service } = await createService();
  const snapshot = await service.snapshotState({ snapshotId: "snap-empty", label: "empty pattern" });
  assert.equal(snapshot.revision, 0);
  await service.applyOperationsNow({
    expectedRevision: 0,
    operations: [{ type: "set_trig", track: "OH", step: 8 }],
  });
  assert.equal(service.getState().activePattern.trigCount, 1);

  const rolledBack = await service.rollbackSnapshot({ snapshotId: "snap-empty", expectedRevision: 1 });
  assert.equal(rolledBack.revision, 2);
  assert.equal(rolledBack.activePattern.trigCount, 0);
});

test("sends realtime operations over the mock transport without changing persistent revision", async () => {
  const { service, transport } = await createService();
  await service.setLiveParameter({ track: "BD", parameter: "filter_frequency", value: 90, lane: "cc" });
  await service.triggerTrack({ track: "BD", velocity: 100, durationMs: 40 });
  await service.setTransport({ command: "start", tempo: 132 });
  await service.changePattern({ pattern: "B02", immediate: true });

  assert.equal(service.getState().revision, 0);
  assert.deepEqual(transport.messages.map((message) => message.type), ["live_parameter", "trigger_track", "transport", "change_pattern"]);
  assert.equal(service.getState().transport.pattern, "B02");
});

test("event journal resumes cursors after restart", async () => {
  const first = await createService();
  await first.service.snapshotState({ snapshotId: "snap-1" });
  const second = await createService(first.directory);
  assert.equal(second.service.getEvents()[0].cursor, 1);
  await second.service.snapshotState({ snapshotId: "snap-2" });
  assert.deepEqual(second.service.getEvents().map((entry) => entry.cursor), [1, 2]);
});

