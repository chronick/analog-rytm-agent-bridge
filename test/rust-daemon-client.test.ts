import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RytmMcpAdapter } from "../src/mcp/RytmMcpAdapter.ts";
import { RytmDaemonRpcError, RustDaemonClient } from "../src/rpc/RustDaemonClient.ts";
import type { RytmRpcEvent } from "../src/rpc/types.ts";
import { RytmAgentService } from "../src/service/RytmAgentService.ts";

test("TypeScript client completes a real round trip through the Rust mock daemon", async () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const client = new RustDaemonClient({
    command: "cargo",
    args: [
      "run",
      "--quiet",
      "--manifest-path",
      fileURLToPath(new URL("../daemon/Cargo.toml", import.meta.url)),
      "--",
      "serve",
      "--adapter",
      "mock",
    ],
    cwd: repository,
    requestTimeoutMs: 60_000,
  });

  try {
    const health = await client.start();
    assert.equal(health.status, "ready");
    assert.equal(health.adapter, "mock");
    assert.ok(health.methods.declared.includes("operations.queue"));
    assert.ok(health.methods.implemented.includes("snapshot.rollback"));

    const state = await client.inspectDeviceState() as {
      device: { activePattern: string };
      activePattern: { trigCount: number };
      revision: number;
    };
    assert.equal(state.device.activePattern, "A01");
    assert.equal(state.activePattern.trigCount, 0);
    assert.equal(state.revision, 0);

    const validation = await client.validateOperations([
      { type: "set_trig", track: "BD", step: 0, velocity: 116 },
      { type: "set_parameter_lock", track: "BD", step: 0, parameter: "filter_frequency", value: 92 },
    ]);
    assert.equal(validation.valid, true);

    const projected = await client.proposePatternDelta({
      operations: [{ type: "set_trig", track: "BD", step: 0 }],
    });
    assert.equal(projected.basePattern.trigCount, 0);
    assert.equal(projected.projectedPattern?.trigCount, 1);

    const rpcEvents: RytmRpcEvent[] = [];
    const unsubscribe = client.onEvent((event) => rpcEvents.push(event));
    await client.snapshotState({ snapshotId: "before-pattern", label: "empty" });
    const queued = await client.queueOperations({
      operationSetId: "integration-queue",
      expectedRevision: 0,
      applyAt: { kind: "next_measure" },
      latePolicy: "roll-forward",
      operations: [
        { type: "set_trig", track: "BD", step: 0, velocity: 116 },
        { type: "set_parameter_lock", track: "BD", step: 0, parameter: "filter_frequency", value: 92 },
      ],
    });
    assert.equal(queued.status, "queued");
    await client.advanceMockTransport(16);

    const appliedState = await client.inspectDeviceState() as {
      revision: number;
      activePattern: { trigCount: number; trigs: Array<{ locks: Record<string, number> }> };
      operationSets: Array<{ status: string; appliedAtBoundary: string }>;
    };
    assert.equal(appliedState.revision, 1);
    assert.equal(appliedState.activePattern.trigCount, 1);
    assert.equal(appliedState.activePattern.trigs[0]?.locks.filter_frequency, 92);
    assert.equal(appliedState.operationSets[0]?.appliedAtBoundary, "next_measure");

    const rolledBack = await client.rollbackSnapshot({ snapshotId: "before-pattern", expectedRevision: 1 });
    assert.equal(rolledBack.revision, 2);
    assert.equal(rolledBack.activePattern.trigCount, 0);

    const facade = new RytmMcpAdapter(new RytmAgentService(), client);
    const applied = await facade.callTool("rytm_apply_operations_now", {
      operationSetId: "facade-now",
      expectedRevision: 2,
      operations: [{ type: "set_trig", track: "SD", step: 4 }],
    }) as { status: string; resultingRevision: number };
    assert.equal(applied.status, "applied");
    assert.equal(applied.resultingRevision, 3);
    const facadePattern = await facade.callTool("rytm_inspect_pattern", { pattern: "A01" }) as { trigCount: number };
    assert.equal(facadePattern.trigCount, 1);

    await facade.callTool("rytm_set_live_parameter", { track: "BD", parameter: "track_level", value: 90, lane: "cc" });
    await facade.callTool("rytm_trigger_track", { track: "BD", velocity: 100 });
    await facade.callTool("rytm_set_transport", { command: "start", tempo: 132 });
    await facade.callTool("rytm_change_pattern", { pattern: "B02", immediate: true });

    const journal = await client.getEvents();
    const eventTypes = journal.map((entry) => (entry.event as { type: string }).type);
    assert.ok(eventTypes.includes("operation_set.applied"));
    assert.ok(eventTypes.includes("snapshot.rolled_back"));
    assert.ok(eventTypes.includes("live.parameter_sent"));
    assert.ok(rpcEvents.some((event) => event.type === "operation_set.applied"));
    unsubscribe();

    const reconciliation = await client.reconcileState() as { status: string; revision: number };
    assert.equal(reconciliation.status, "converged");
    assert.equal(reconciliation.revision, 3);

    const first = await client.request("pattern.inspect", { pattern: "B02" }, { requestId: "integration-replay" });
    const replay = await client.request("pattern.inspect", { pattern: "B02" }, { requestId: "integration-replay" });
    assert.deepEqual(replay, first);

    await assert.rejects(
      client.request("daemon.health", {}, { requestId: "integration-replay" }),
      (error: unknown) => error instanceof RytmDaemonRpcError && error.code === "request_id_conflict",
    );

    const delayed = client.request("test.delay", { milliseconds: 5_000 });
    process.kill(health.processId, "SIGTERM");
    await assert.rejects(
      delayed,
      (error: unknown) => error instanceof RytmDaemonRpcError
        && error.code === "daemon_disconnected"
        && error.retryable,
    );
    const restarted = await client.start();
    assert.notEqual(restarted.processId, health.processId);
    assert.equal(restarted.status, "ready");
  } finally {
    await client.close();
  }
});
