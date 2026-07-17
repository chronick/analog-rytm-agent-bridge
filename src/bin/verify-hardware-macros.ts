import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RytmPersistentOperation } from "../domain/types.ts";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

const execute = process.argv.includes("--execute");
const repository = fileURLToPath(new URL("../../", import.meta.url));
const snapshotId = "hardware-macro-certification";

const operations: RytmPersistentOperation[] = [
  {
    type: "replace_scene",
    scene: 1,
    locks: [
      { track: "BD", parameter: "sample_tune", value: 65 },
      { track: "FX", parameter: "delay_feedback", value: 80 },
    ],
  },
  { type: "set_scene_lock", scene: 1, track: "BD", parameter: "sample_tune", value: 66 },
  { type: "copy_scene", sourceScene: 1, targetScene: 2 },
  { type: "clear_scene", scene: 1 },
  { type: "set_scene_lock", scene: 1, track: "SD", parameter: "filter_frequency", value: 96 },
  {
    type: "replace_performance",
    performance: 1,
    locks: [
      { track: "SD", parameter: "amp_pan", depth: -32 },
      { track: "FX", parameter: "reverb_decay", depth: 24 },
    ],
  },
  { type: "set_performance_lock", performance: 1, track: "SD", parameter: "amp_pan", depth: -31 },
  { type: "copy_performance", sourcePerformance: 1, targetPerformance: 2 },
  { type: "clear_performance", performance: 1 },
  { type: "set_performance_lock", performance: 1, track: "BD", parameter: "sample_tune", depth: 12 },
];

export async function runHardwareMacroVerification(): Promise<void> {
  const stateDirectory = mkdtempSync(join(tmpdir(), "analog-rytm-macros-"));
  const client = new RustDaemonClient({
    command: "cargo",
    args: [
      "run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve",
      "--adapter", "hardware", "--state-dir", stateDirectory,
    ],
    cwd: repository,
    requestTimeoutMs: 180_000,
  });
  let snapshotCreated = false;
  let persistentRollbackVerified = false;
  let baselineScene: number | null = null;
  let transientSceneChanged = false;

  try {
    const health = await client.start();
    assert.equal(health.adapter, "hardware");
    assert.ok(health.methods.implemented.includes("realtime.set_scene"));
    assert.ok(health.methods.implemented.includes("realtime.set_performance"));
    process.stderr.write("hardware daemon ready\n");

    const baselineState = asRecord(await client.inspectDeviceState());
    const baselineRevision = requiredNumber(baselineState.revision, "baseline revision");
    const baselineKit = asRecord(await client.inspectKit());
    const baselineMacros = macroDefinitions(baselineKit);
    baselineScene = optionalNumber(asRecord(baselineKit.macros).activeScene, "baseline active Scene");
    process.stderr.write("baseline macro definitions inspected\n");

    const validation = await client.validateOperations(operations);
    assert.equal(validation.valid, true, validation.errors.join("; "));
    const dryRun = asRecord(await client.applyOperationsNow({
      operationSetId: "hardware-macros-dry-run",
      expectedRevision: baselineRevision,
      operations,
      dryRun: true,
    }));
    assert.equal(dryRun.status, "dry_run");
    assert.equal(dryRun.projectedRevision, baselineRevision + 1);
    const projectedMacros = macroDefinitions(asRecord(asRecord(dryRun.projectedState).kit));
    assertExpectedDefinitions(projectedMacros);
    process.stderr.write("macro operations validated and projected\n");

    if (!execute) {
      console.log(JSON.stringify({
        status: "validated-dry-run",
        operations: operations.length,
        baselineRevision,
        baselineScene,
      }, null, 2));
      return;
    }

    await client.snapshotState({ snapshotId, label: "Hardware Scene and Performance baseline" });
    snapshotCreated = true;
    const input = {
      operationSetId: "hardware-macros-apply",
      expectedRevision: baselineRevision,
      operations,
    } as const;
    const applied = asRecord(await client.applyOperationsNow(input));
    assert.equal(applied.status, "applied");
    assert.equal(applied.changed, true);
    assert.equal(applied.resultingRevision, baselineRevision + 1);
    assert.deepEqual(asRecord(await client.applyOperationsNow(input)), applied);
    const observedMacros = macroDefinitions(asRecord(await client.inspectKit()));
    assert.deepEqual(observedMacros, projectedMacros);
    assertExpectedDefinitions(observedMacros);
    process.stderr.write("persistent macro definitions applied, replayed, and read back\n");

    const persistentRevision = baselineRevision + 1;
    const activeScene = asRecord(await client.setActiveScene({ scene: 2, lane: "cc" }));
    assert.equal(activeScene.verified, true);
    transientSceneChanged = baselineScene !== 2;
    const sceneState = asRecord(await client.inspectDeviceState());
    assert.equal(sceneState.revision, persistentRevision);
    assert.equal(asRecord(sceneState.liveMacros).activeScene, 2);
    const sceneReplay = asRecord(await client.setActiveScene({ scene: 2, lane: "nrpn" }));
    assert.equal(sceneReplay.status, "already-active");

    const performance = asRecord(await client.setPerformanceMacro({ performance: 2, amount: 96, lane: "cc" }));
    assert.equal(performance.status, "sent");
    const performanceReplay = asRecord(await client.setPerformanceMacro({ performance: 2, amount: 96, lane: "cc" }));
    assert.equal(performanceReplay.status, "already-sent");
    const performanceNrpn = asRecord(await client.setPerformanceMacro({ performance: 2, amount: 0, lane: "nrpn" }));
    assert.equal(performanceNrpn.status, "sent");
    const liveState = asRecord(await client.inspectDeviceState());
    assert.equal(liveState.revision, persistentRevision);
    assert.equal(asRecord(asRecord(liveState.liveMacros).performanceAmounts)["2"], 0);
    process.stderr.write("realtime Scene and Performance controls verified without revision changes\n");

    await client.setActiveScene({ scene: baselineScene, lane: "cc" });
    transientSceneChanged = false;
    const restoredSceneState = asRecord(await client.inspectDeviceState());
    assert.equal(asRecord(restoredSceneState.liveMacros).activeScene, baselineScene);

    const rolledBack = asRecord(await client.rollbackSnapshot({
      snapshotId,
      expectedRevision: persistentRevision,
    }));
    assert.equal(rolledBack.status, "restored-and-verified");
    assert.equal(rolledBack.revision, baselineRevision + 2);
    persistentRollbackVerified = true;
    const restoredMacros = macroDefinitions(asRecord(await client.inspectKit()));
    assert.deepEqual(restoredMacros, baselineMacros);
    process.stderr.write("raw snapshot rollback restored exact baseline definitions\n");

    const events = await client.getEvents();
    const eventTypes = events.map((entry) => asRecord(entry.event).type);
    assert.ok(eventTypes.includes("operation_set.applied"));
    assert.ok(eventTypes.includes("live.scene_sent"));
    assert.ok(eventTypes.includes("live.performance_sent"));
    assert.ok(eventTypes.includes("snapshot.rolled_back"));

    console.log(JSON.stringify({
      status: "definitions-live-control-readback-rollback-verified",
      operations: operations.length,
      appliedRevision: applied.resultingRevision,
      restoredRevision: rolledBack.revision,
      activeSceneMapping: { none: 0, scenes: "1-12" },
      realtimeRevisionUnchanged: true,
      eventTypes,
    }, null, 2));
  } finally {
    if (transientSceneChanged) {
      try {
        await client.setActiveScene({ scene: baselineScene, lane: "cc" });
        process.stderr.write("emergency active Scene restore completed\n");
      } catch (error) {
        process.stderr.write(`EMERGENCY ACTIVE SCENE RESTORE FAILED: ${String(error)}\n`);
      }
    }
    if (snapshotCreated && !persistentRollbackVerified) {
      try {
        await client.rollbackSnapshot({ snapshotId });
        process.stderr.write("emergency raw snapshot rollback completed\n");
      } catch (error) {
        process.stderr.write(`EMERGENCY RAW SNAPSHOT ROLLBACK FAILED: ${String(error)}\n`);
      }
    }
    await client.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) await runHardwareMacroVerification();

function macroDefinitions(kit: Record<string, unknown>): Record<string, unknown> {
  const macros = asRecord(kit.macros);
  return {
    scenes: macros.scenes,
    performances: macros.performances,
    sceneLockCount: macros.sceneLockCount,
    performanceLockCount: macros.performanceLockCount,
  };
}

function assertExpectedDefinitions(macros: Record<string, unknown>): void {
  const scenes = macros.scenes as Array<Record<string, unknown>>;
  const performances = macros.performances as Array<Record<string, unknown>>;
  assert.deepEqual(asRecord(scenes[0]), {
    id: 1,
    lockCount: 1,
    unknownLockCount: 0,
    locks: [{ track: "SD", page: "filter", parameter: "filter_frequency", rawParameterId: 20, value: 96 }],
  });
  assert.deepEqual(asRecord(scenes[1]), {
    id: 2,
    lockCount: 2,
    unknownLockCount: 0,
    locks: [
      { track: "BD", page: "sample", parameter: "sample_tune", rawParameterId: 8, value: 66 },
      { track: "FX", page: "delay", parameter: "delay_feedback", rawParameterId: 3, value: 80 },
    ],
  });
  assert.deepEqual(asRecord(performances[0]), {
    id: 1,
    lockCount: 1,
    unknownLockCount: 0,
    locks: [{ track: "BD", page: "sample", parameter: "sample_tune", rawParameterId: 8, depth: 12 }],
  });
  assert.deepEqual(asRecord(performances[1]), {
    id: 2,
    lockCount: 2,
    unknownLockCount: 0,
    locks: [
      { track: "SD", page: "amp", parameter: "amp_pan", rawParameterId: 30, depth: -31 },
      { track: "FX", page: "reverb", parameter: "reverb_decay", rawParameterId: 11, depth: 24 },
    ],
  });
}

function requiredNumber(value: unknown, label: string): number {
  assert.equal(typeof value, "number", `${label} must be numeric`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  return requiredNumber(value, label);
}

function asRecord(value: unknown): Record<string, any> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}
