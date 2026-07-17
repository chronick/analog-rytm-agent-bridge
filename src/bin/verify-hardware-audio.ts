import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RytmAudioRecording,
  RytmPersistentOperation,
} from "../domain/types.ts";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

const execute = process.argv.includes("--execute");
const durationArgument = process.argv.find((argument) =>
  argument.startsWith("--duration-ms="),
);
const durationMs =
  durationArgument === undefined
    ? 4_000
    : Number(durationArgument.split("=")[1]);
assert.ok(
  Number.isInteger(durationMs) && durationMs >= 100 && durationMs <= 600_000,
);

const repository = fileURLToPath(new URL("../../", import.meta.url));

const patternOperations: RytmPersistentOperation[] = [
  { type: "set_track_length", track: "BD", steps: 16 },
  { type: "set_track_length", track: "SD", steps: 16 },
  { type: "set_track_length", track: "CH", steps: 16 },
  { type: "set_trig", track: "BD", step: 0, velocity: 118 },
  { type: "set_trig", track: "BD", step: 4, velocity: 105 },
  { type: "set_trig", track: "BD", step: 8, velocity: 114 },
  { type: "set_trig", track: "BD", step: 12, velocity: 102 },
  { type: "set_trig", track: "SD", step: 4, velocity: 108 },
  { type: "set_trig", track: "SD", step: 12, velocity: 112 },
  { type: "set_trig", track: "CH", step: 2, velocity: 92 },
  { type: "set_trig", track: "CH", step: 6, velocity: 88 },
  { type: "set_trig", track: "CH", step: 10, velocity: 94 },
  { type: "set_trig", track: "CH", step: 14, velocity: 86 },
  {
    type: "set_global_parameter",
    section: "routing",
    parameter: "route_to_main",
    track: "BD",
    value: true,
  },
  {
    type: "set_global_parameter",
    section: "routing",
    parameter: "route_to_main",
    track: "SD",
    value: true,
  },
  {
    type: "set_global_parameter",
    section: "routing",
    parameter: "route_to_main",
    track: "CH",
    value: true,
  },
];

export async function runHardwareAudioVerification(): Promise<void> {
  const runId = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const audioDirectory = join(repository, "hardware", "runs", `audio-${runId}`);
  const stateDirectory = mkdtempSync(
    join(tmpdir(), "analog-rytm-audio-state-"),
  );
  mkdirSync(audioDirectory, { recursive: true });
  const snapshotId = `hardware-audio-${runId}`;
  const recordingId = `pattern-${runId}`;
  const client = new RustDaemonClient({
    command: "cargo",
    args: [
      "run",
      "--quiet",
      "--manifest-path",
      "daemon/Cargo.toml",
      "--",
      "serve",
      "--adapter",
      "hardware",
      "--state-dir",
      stateDirectory,
      "--audio-dir",
      audioDirectory,
    ],
    cwd: repository,
    requestTimeoutMs: Math.max(180_000, durationMs + 120_000),
  });
  let snapshotCreated = false;
  let rollbackVerified = false;
  let transportStarted = false;
  let recordingActive = false;

  try {
    const health = await client.start();
    assert.equal(health.adapter, "hardware");
    assert.ok(health.methods.implemented.includes("audio.capture_pattern"));
    process.stderr.write("hardware daemon ready\n");

    const inventory = await client.listAudioInputs();
    const rytmInput = inventory.inputs.find((input) => input.isRytm);
    assert.ok(rytmInput, "CoreAudio did not expose an Analog Rytm input");
    assert.ok(
      rytmInput.configurations.some(
        (configuration) => configuration.recorderSupported,
      ),
    );
    assert.deepEqual(inventory.stalePartialFiles, []);
    process.stderr.write("CoreAudio Rytm stereo input verified\n");

    const baseline = asRecord(await client.inspectDeviceState());
    const baselineRevision = baseline.revision as number;
    const activePattern = asRecord(baseline.activePattern).pattern as string;
    const transport = asRecord(baseline.transport);
    const tempo = transport.tempo as number;

    if (!execute) {
      console.log(
        JSON.stringify(
          {
            status: "audio-input-verified-dry-run",
            input: rytmInput,
            outputDirectory: audioDirectory,
            activePattern,
            revision: baselineRevision,
            tempo,
            playing: transport.playing,
          },
          null,
          2,
        ),
      );
    } else {
      const validation = await client.validateOperations(patternOperations);
      assert.equal(validation.valid, true, validation.errors.join("; "));
      await client.snapshotState({
        snapshotId,
        label: "Hardware audio capture baseline",
      });
      snapshotCreated = true;

      await client.applyOperationsNow({
        operationSetId: `hardware-audio-pattern-${runId}`,
        expectedRevision: baselineRevision,
        operations: patternOperations,
      });
      const preparedState = asRecord(await client.inspectDeviceState());
      const preparedRevision = preparedState.revision as number;
      process.stderr.write("disposable capture pattern applied and verified\n");

      await client.startRecording({
        recordingId,
        snapshotId,
        expectedDurationMs: durationMs,
      });
      recordingActive = true;
      process.stderr.write("bounded CoreAudio recording started\n");
      await client.setTransport({ command: "start", tempo });
      transportStarted = true;
      process.stderr.write("Rytm transport started\n");
      const triggerTracks = ["BD", "CH", "BD", "SD"] as const;
      const triggerIntervalMs = 250;
      const triggerCount = Math.max(
        1,
        Math.ceil(durationMs / triggerIntervalMs),
      );
      for (let index = 0; index < triggerCount; index += 1) {
        await client.triggerTrack({
          track: triggerTracks[index % triggerTracks.length],
          velocity: 108 - (index % 4) * 4,
          durationMs: 90,
        });
        await delay(triggerIntervalMs);
      }
      await client.setTransport({ command: "stop" });
      transportStarted = false;
      const recording = await client.stopRecording({ recordingId });
      recordingActive = false;
      verifyRecording(
        recording,
        durationMs,
        activePattern,
        preparedRevision,
        snapshotId,
      );
      process.stderr.write("bounded Rytm WAV captured and analyzed\n");

      const rolledBack = asRecord(
        await client.rollbackSnapshot({
          snapshotId,
          expectedRevision: preparedRevision,
        }),
      );
      assert.equal(rolledBack.status, "restored-and-verified");
      rollbackVerified = true;
      process.stderr.write("capture pattern baseline restored and verified\n");

      console.log(
        JSON.stringify(
          {
            status: "hardware-audio-captured-rollback-verified",
            input: rytmInput,
            recording,
            restoredRevision: rolledBack.revision,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    if (transportStarted) {
      try {
        await client.setTransport({ command: "stop" });
      } catch (error) {
        process.stderr.write(
          `EMERGENCY TRANSPORT STOP FAILED: ${String(error)}\n`,
        );
      }
    }
    if (recordingActive) {
      try {
        await client.stopRecording({ recordingId });
        process.stderr.write("emergency audio recording finalized\n");
      } catch (error) {
        process.stderr.write(
          `EMERGENCY AUDIO FINALIZE FAILED: ${String(error)}\n`,
        );
      }
    }
    if (snapshotCreated && !rollbackVerified) {
      try {
        await client.rollbackSnapshot({ snapshotId });
        process.stderr.write("emergency audio snapshot rollback completed\n");
      } catch (error) {
        process.stderr.write(
          `EMERGENCY AUDIO ROLLBACK FAILED: ${String(error)}\n`,
        );
      }
    }
    await client.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) await runHardwareAudioVerification();

function verifyRecording(
  recording: RytmAudioRecording,
  expectedDurationMs: number,
  expectedPattern: string,
  expectedRevision: number,
  expectedSnapshotId: string,
): void {
  assert.equal(recording.status, "completed", recording.warnings?.join("; ") ?? "recording did not complete");
  assert.equal(recording.pattern, expectedPattern);
  assert.equal(recording.revision, expectedRevision);
  assert.equal(recording.snapshotId, expectedSnapshotId);
  assert.equal(recording.audio?.channels, 2);
  assert.equal(recording.audio?.sampleRate, 48_000);
  assert.equal(recording.audio?.frames, expectedDurationMs * 48);
  assert.equal(recording.analysis?.durationWithinTolerance, true);
  assert.equal(recording.analysis?.disconnected, false);
  assert.equal(recording.analysis?.droppedBlocks, 0);
  assert.equal(
    recording.analysis?.silence,
    false,
    "hardware capture was silent",
  );
  const path = recording.audio?.path;
  const metadataPath = recording.audio?.metadataPath;
  assert.ok(path && metadataPath);
  assert.ok(statSync(path).size > 44);
  const header = readFileSync(path);
  assert.equal(header.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(header.subarray(8, 12).toString("ascii"), "WAVE");
  const sidecar = JSON.parse(
    readFileSync(metadataPath, "utf8"),
  ) as RytmAudioRecording;
  assert.deepEqual(sidecar, recording);
}

function asRecord(value: unknown): Record<string, any> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, any>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
