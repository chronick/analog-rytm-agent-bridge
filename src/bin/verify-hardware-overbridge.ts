import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RytmMultitrackRecording,
  RytmOverbridgeProviderInventory,
  RytmPatternSlot,
  RytmPersistentOperation,
} from "../domain/types.ts";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

const execute = process.argv.includes("--execute");
const durationArgument = process.argv.find((argument) => argument.startsWith("--duration-ms="));
const durationMs = durationArgument === undefined ? 8_000 : Number(durationArgument.split("=")[1]);
assert.ok(Number.isInteger(durationMs) && durationMs >= 2_000 && durationMs <= 600_000);

const repository = fileURLToPath(new URL("../../", import.meta.url));
const representativeTracks = ["BD", "SD", "RS", "BT", "LT", "MT", "CH", "CY"] as const;
const requiredStems = ["main", "bd", "sd", "rs_cp", "bt", "lt", "mt_ht", "ch_oh", "cy_cb"];

export async function runHardwareOverbridgeVerification(): Promise<void> {
  const runId = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const audioDirectory = join(repository, "hardware", "runs", `overbridge-${runId}`);
  const stateDirectory = mkdtempSync(join(tmpdir(), "analog-rytm-overbridge-state-"));
  const snapshotId = `hardware-overbridge-${runId}`;
  const recordingId = `stems-${runId}`;
  mkdirSync(audioDirectory, { recursive: true });
  const client = new RustDaemonClient({
    command: "cargo",
    args: [
      "run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve",
      "--adapter", "hardware", "--state-dir", stateDirectory, "--audio-dir", audioDirectory,
    ],
    cwd: repository,
    requestTimeoutMs: Math.max(180_000, durationMs + 120_000),
  });
  let snapshotCreated = false;
  let rollbackVerified = false;
  let transportStarted = false;

  try {
    const health = await client.start();
    assert.equal(health.adapter, "hardware");
    assert.ok(health.methods.implemented.includes("audio.inspect_overbridge"));
    assert.ok(health.methods.implemented.includes("audio.capture_multitrack"));
    process.stderr.write("hardware daemon ready\n");

    const provider = await client.inspectOverbridgeAudio();
    assertInstallation(provider);
    if (!execute) {
      console.log(JSON.stringify({
        status: provider.available ? "overbridge-ready" : "overbridge-mode-required",
        provider,
      }, null, 2));
      return;
    }
    assert.equal(
      provider.available,
      true,
      `Overbridge provider unavailable in device mode ${provider.deviceMode}; select USB CONFIG > OVERBRIDGE and close DAWs/standalone hosts`,
    );
    assert.equal(provider.deviceMode, "overbridge");
    const selectedLayout = provider.selectedDevice?.layout ?? [];
    for (const stem of requiredStems) {
      assert.ok(selectedLayout.some((bus) => bus.id === stem), `missing Overbridge bus ${stem}`);
    }
    process.stderr.write("Overbridge installation, ownership, and channel layout verified\n");

    const baseline = asRecord(await client.inspectDeviceState());
    const baselineRevision = requiredNumber(baseline.revision, "baseline revision");
    const activePattern = asRecord(baseline.activePattern).pattern as RytmPatternSlot;
    const tempo = requiredNumber(asRecord(baseline.transport).tempo, "transport tempo");
    const operations = patternOperations(activePattern);
    const validation = await client.validateOperations(operations);
    assert.equal(validation.valid, true, validation.errors.join("; "));
    await client.snapshotState({ snapshotId, label: "Overbridge multitrack certification baseline" });
    snapshotCreated = true;
    const applied = asRecord(await client.applyOperationsNow({
      operationSetId: `hardware-overbridge-pattern-${runId}`,
      expectedRevision: baselineRevision,
      operations,
    }));
    assert.equal(applied.status, "applied");
    const preparedRevision = requiredNumber(applied.resultingRevision, "prepared revision");
    process.stderr.write("disposable all-voice capture pattern applied\n");

    await client.setTransport({ command: "start", tempo });
    transportStarted = true;
    await delay(250);
    const recording = await client.captureMultitrackAudio({
      recordingId,
      snapshotId,
      durationMs,
    });
    await client.setTransport({ command: "stop" });
    transportStarted = false;
    verifyRecording(recording, durationMs, activePattern, preparedRevision, snapshotId);
    assert.deepEqual(
      await client.captureMultitrackAudio({ recordingId, snapshotId, durationMs }),
      recording,
    );
    process.stderr.write("synchronized non-silent Main and voice-group stems verified\n");

    const rolledBack = asRecord(await client.rollbackSnapshot({
      snapshotId,
      expectedRevision: preparedRevision,
    }));
    assert.equal(rolledBack.status, "restored-and-verified");
    rollbackVerified = true;
    const restored = asRecord(await client.inspectDeviceState());
    assert.equal(asRecord(restored.activePattern).pattern, activePattern);
    process.stderr.write("capture Pattern and raw state baseline restored\n");

    console.log(JSON.stringify({
      status: "overbridge-multitrack-captured-rollback-verified",
      provider,
      recording,
      restoredRevision: rolledBack.revision,
    }, null, 2));
  } finally {
    if (transportStarted) {
      try {
        await client.setTransport({ command: "stop" });
        process.stderr.write("emergency transport stop completed\n");
      } catch (error) {
        process.stderr.write(`EMERGENCY TRANSPORT STOP FAILED: ${String(error)}\n`);
      }
    }
    if (snapshotCreated && !rollbackVerified) {
      try {
        await client.rollbackSnapshot({ snapshotId });
        process.stderr.write("emergency Overbridge snapshot rollback completed\n");
      } catch (error) {
        process.stderr.write(`EMERGENCY OVERBRIDGE ROLLBACK FAILED: ${String(error)}\n`);
      }
    }
    await client.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) await runHardwareOverbridgeVerification();

function patternOperations(pattern: RytmPatternSlot): RytmPersistentOperation[] {
  const operations: RytmPersistentOperation[] = [];
  for (const track of representativeTracks) {
    operations.push({ type: "set_track_length", pattern, track, steps: 16 });
  }
  representativeTracks.forEach((track, index) => {
    operations.push({
      type: "set_trig",
      pattern,
      track,
      step: index * 2,
      velocity: 116 - index * 3,
    });
    operations.push({
      type: "set_global_parameter",
      section: "routing",
      parameter: "route_to_main",
      track,
      value: true,
    });
  });
  return operations;
}

function assertInstallation(provider: RytmOverbridgeProviderInventory): void {
  assert.equal(provider.installation.driverInstalled, true, "Overbridge HAL driver is not installed");
  assert.equal(provider.installation.pluginInstalled, true, "Analog Rytm Audio Unit is not installed");
  assert.equal(provider.installation.engineInstalled, true, "Overbridge Engine is not installed");
  assert.equal(provider.installation.engineRunning, true, "Overbridge Engine is not running");
}

function verifyRecording(
  recording: RytmMultitrackRecording,
  expectedDurationMs: number,
  expectedPattern: string,
  expectedRevision: number,
  expectedSnapshotId: string,
): void {
  assert.equal(recording.status, "completed", recording.warnings.join("; "));
  assert.equal(recording.pattern, expectedPattern);
  assert.equal(recording.revision, expectedRevision);
  assert.equal(recording.snapshotId, expectedSnapshotId);
  assert.equal(recording.device.sampleRate, 48_000);
  assert.ok([10, 12, 18, 20].includes(recording.device.sourceChannels));
  assert.equal(recording.synchronization.framesPerStem, expectedDurationMs * 48);
  assert.equal(recording.synchronization.maxFrameDrift, 0);
  assert.equal(recording.synchronization.timestampGapCount, 0);
  assert.equal(recording.analysis.durationWithinTolerance, true);
  assert.equal(recording.analysis.disconnected, false);
  assert.equal(recording.analysis.droppedBlocks, 0);
  assert.ok(recording.latency.samples > 0);

  for (const id of requiredStems) {
    const stem = recording.stems.find((candidate) => candidate.id === id);
    assert.ok(stem, `recording omitted ${id} stem`);
    assert.equal(stem.frames, recording.synchronization.framesPerStem);
    assert.equal(stem.analysis.silence, false, `${stem.name} stem was silent`);
    assert.ok(statSync(stem.path).size > 44);
    const header = readFileSync(stem.path);
    assert.equal(header.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(header.subarray(8, 12).toString("ascii"), "WAVE");
  }
  const sidecar = JSON.parse(readFileSync(recording.metadataPath, "utf8")) as RytmMultitrackRecording;
  assert.deepEqual(sidecar, recording);
}

function requiredNumber(value: unknown, label: string): number {
  assert.equal(typeof value, "number", `${label} must be numeric`);
  return value;
}

function asRecord(value: unknown): Record<string, any> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
