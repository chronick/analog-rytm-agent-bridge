import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RytmMcpAdapter } from "../src/mcp/RytmMcpAdapter.ts";
import { RytmDaemonRpcError, RustDaemonClient } from "../src/rpc/RustDaemonClient.ts";
import type { RytmRpcEvent } from "../src/rpc/types.ts";
import { RytmAgentService } from "../src/service/RytmAgentService.ts";

test("TypeScript client completes a real round trip through the Rust mock daemon", async () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const audioDirectory = await mkdtemp(join(tmpdir(), "analog-rytm-rpc-audio-"));
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
      "--audio-dir",
      audioDirectory,
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
    assert.ok(health.methods.implemented.includes("sound.inspect"));
    assert.ok(health.methods.implemented.includes("audio.capture_pattern"));
    assert.ok(health.methods.implemented.includes("audio.inspect_overbridge"));
    assert.ok(health.methods.implemented.includes("audio.capture_multitrack"));
    assert.ok(health.methods.implemented.includes("samples.resolve_ram"));
    assert.ok(health.methods.implemented.includes("realtime.set_scene"));
    assert.ok(health.methods.implemented.includes("realtime.set_performance"));
    assert.ok(health.methods.implemented.includes("song.inspect"));

    const description = await client.describe();
    assert.equal(description.capabilities.patternEdit, true);
    assert.equal(description.capabilityEvidence.persistentPatternCore?.verified, false);
    assert.deepEqual(description.capabilityEvidence.persistentPatternCore?.transport, ["rytm-rs Pattern SysEx"]);

    const state = await client.inspectDeviceState() as {
      device: { activePattern: string };
      activePattern: { trigCount: number };
      revision: number;
    };
    assert.equal(state.device.activePattern, "A01");
    assert.equal(state.activePattern.trigCount, 0);
    assert.equal(state.revision, 0);

    const kit = await client.inspectKit() as { sounds: unknown[] };
    assert.equal(kit.sounds.length, 12);
    const sound = await client.inspectSound("BD") as { track: string; machine: string };
    assert.equal(sound.track, "BD");
    assert.equal(sound.machine, "bdhard");
    const globalState = await client.inspectGlobal() as { global: { routing: { tracksRoutedToMain: string[] } } };
    assert.equal(globalState.global.routing.tracksRoutedToMain.length, 12);

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
    await facade.callTool("rytm_set_active_scene", { scene: 2, lane: "nrpn" });
    await facade.callTool("rytm_set_performance_macro", { performance: 3, amount: 96, lane: "cc" });
    const liveMacroState = await client.inspectDeviceState() as {
      revision: number;
      liveMacros: { activeScene: number | null; performanceAmounts: Record<string, number> };
    };
    assert.equal(liveMacroState.revision, 3);
    assert.equal(liveMacroState.liveMacros.activeScene, 2);
    assert.equal(liveMacroState.liveMacros.performanceAmounts["3"], 96);

    const audioInputs = await facade.callTool("rytm_list_audio_inputs", {}) as {
      inputs: Array<{ name: string; defaultConfig: { channels: number } }>;
      stalePartialFiles: string[];
    };
    assert.equal(audioInputs.inputs[0]?.name, "Mock Analog Rytm Stereo");
    assert.equal(audioInputs.inputs[0]?.defaultConfig.channels, 2);
    assert.deepEqual(audioInputs.stalePartialFiles, []);

    const recording = await facade.callTool("rytm_start_recording", {
      recordingId: "integration-manual",
      snapshotId: "before-pattern",
    }) as { status: string; partialPath: string };
    assert.equal(recording.status, "recording");
    assert.ok((await stat(recording.partialPath)).isFile());
    const finalized = await facade.callTool("rytm_stop_recording", {
      recordingId: "integration-manual",
    }) as {
      status: string;
      pattern: string;
      revision: number;
      tempo: number;
      audio: { path: string; metadataPath: string; frames: number };
    };
    assert.equal(finalized.status, "completed");
    assert.equal(finalized.pattern, "B02");
    assert.equal(finalized.revision, 3);
    assert.equal(finalized.tempo, 132);
    assert.equal(finalized.audio.frames, 4_800);

    const bounded = await facade.callTool("rytm_capture_pattern_audio", {
      recordingId: "integration-bounded",
      durationMs: 125,
    }) as {
      status: string;
      audio: { path: string; metadataPath: string; frames: number };
      analysis: { durationWithinTolerance: boolean; silence: boolean };
    };
    assert.equal(bounded.status, "completed");
    assert.equal(bounded.audio.frames, 6_000);
    assert.equal(bounded.analysis.durationWithinTolerance, true);
    assert.equal(bounded.analysis.silence, false);
    const wavHeader = await readFile(bounded.audio.path);
    assert.equal(wavHeader.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wavHeader.subarray(8, 12).toString("ascii"), "WAVE");
    const sidecar = JSON.parse(await readFile(bounded.audio.metadataPath, "utf8")) as { schema: string };
    assert.equal(sidecar.schema, "analog-rytm-recording.v1");

    const overbridge = await facade.callTool("rytm_inspect_overbridge_audio", {}) as {
      available: boolean;
      deviceMode: string;
      selectedDevice: { layout: unknown[] };
      expectedBuses: unknown[];
    };
    assert.equal(overbridge.available, true);
    assert.equal(overbridge.deviceMode, "mock");
    assert.equal(overbridge.selectedDevice.layout.length, 10);
    assert.equal(overbridge.expectedBuses.length, 10);

    const multitrackInput = {
      recordingId: "integration-overbridge",
      durationMs: 125,
      snapshotId: "before-pattern",
    };
    const multitrack = await facade.callTool("rytm_capture_multitrack_audio", multitrackInput) as {
      status: string;
      stems: Array<{ id: string; path: string; frames: number; analysis: { silence: boolean } }>;
      synchronization: { framesPerStem: number; maxFrameDrift: number };
      metadataPath: string;
    };
    assert.equal(multitrack.status, "completed");
    assert.equal(multitrack.stems.length, 10);
    assert.equal(multitrack.synchronization.framesPerStem, 6_000);
    assert.equal(multitrack.synchronization.maxFrameDrift, 0);
    assert.ok(multitrack.stems.every((stem) => stem.frames === 6_000 && !stem.analysis.silence));
    assert.ok((await stat(multitrack.stems[0]!.path)).isFile());
    const multitrackSidecar = JSON.parse(await readFile(multitrack.metadataPath, "utf8")) as { schema: string };
    assert.equal(multitrackSidecar.schema, "analog-rytm-multitrack-recording.v1");
    assert.deepEqual(
      await facade.callTool("rytm_capture_multitrack_audio", multitrackInput),
      multitrack,
    );

    const samplePath = join(audioDirectory, "integration-sample.wav");
    await writeTestWav(samplePath);
    const uploaded = await facade.callTool("rytm_upload_sample", {
      sourcePath: samplePath,
      deviceDirectory: "/integration-tests",
      name: "bridge-sine",
    }) as {
      status: string;
      transferred: boolean;
      sampleId: string;
      devicePath: string;
      source: { frames: number };
    };
    assert.equal(uploaded.status, "uploaded-and-verified");
    assert.equal(uploaded.transferred, true);
    assert.equal(uploaded.devicePath, "/integration-tests/bridge-sine");
    assert.equal(uploaded.source.frames, 4_800);

    const uploadReplay = await facade.callTool("rytm_upload_sample", {
      sourcePath: samplePath,
      deviceDirectory: "/integration-tests",
      name: "bridge-sine",
    }) as { status: string; transferred: boolean; sampleId: string };
    assert.equal(uploadReplay.status, "already-present");
    assert.equal(uploadReplay.transferred, false);
    assert.equal(uploadReplay.sampleId, uploaded.sampleId);

    const inventory = await facade.callTool("rytm_inspect_samples", {
      drivePath: "/integration-tests",
      includeRam: true,
    }) as {
      entries: Array<{ sampleId?: string }>;
      ram: { capacity: number; occupied: number };
    };
    assert.equal(inventory.entries[0]?.sampleId, uploaded.sampleId);
    assert.equal(inventory.ram.capacity, 127);
    assert.equal(inventory.ram.occupied, 0);

    const resolved = await facade.callTool("rytm_resolve_sample_ram", {
      sampleId: uploaded.sampleId,
      slot: 127,
    }) as { status: string; slot: number; verified: boolean };
    assert.equal(resolved.status, "loaded-and-verified");
    assert.equal(resolved.slot, 127);
    assert.equal(resolved.verified, true);

    await client.snapshotState({ snapshotId: "before-sample-assignment" });
    const sampleAssignment = await facade.callTool("rytm_apply_operations_now", {
      operationSetId: "assign-integration-sample",
      expectedRevision: 3,
      operations: [{
        type: "assign_sample_slot",
        pattern: "B02",
        track: "BD",
        slot: 127,
        sampleId: uploaded.sampleId,
      }],
    }) as { status: string; resultingRevision: number };
    assert.equal(sampleAssignment.status, "applied");
    assert.equal(sampleAssignment.resultingRevision, 4);
    const assignedPattern = await client.inspectPattern("B02") as {
      sampleSlots: { BD?: { slot: number; sampleId: string } };
    };
    assert.equal(assignedPattern.sampleSlots.BD?.slot, 127);
    assert.equal(assignedPattern.sampleSlots.BD?.sampleId, uploaded.sampleId);

    const sampleRollback = await client.rollbackSnapshot({
      snapshotId: "before-sample-assignment",
      expectedRevision: 4,
    });
    assert.equal(sampleRollback.revision, 5);
    const cleared = await facade.callTool("rytm_clear_sample_ram", {
      sampleId: uploaded.sampleId,
      slot: 127,
    }) as { status: string; driveSampleRetained: boolean };
    assert.equal(cleared.status, "cleared-and-verified");
    assert.equal(cleared.driveSampleRetained, true);

    await client.snapshotState({ snapshotId: "before-song" });
    const songProposal = await facade.callTool("rytm_propose_song_delta", {
      operations: [{
        type: "replace_song",
        target: { scope: "stored", song: 1 },
        name: "AGENT SONG",
        rows: [{
          repeats: 2,
          patterns: [
            { pattern: "A01" },
            { pattern: "A02", mutedTracks: ["BD"] },
          ],
        }],
      }],
    }) as { baseSong: { rowCount: number }; projectedSong: { rowCount: number } };
    assert.equal(songProposal.baseSong.rowCount, 0);
    assert.equal(songProposal.projectedSong.rowCount, 1);
    const songInput = {
      operationSetId: "integration-song",
      expectedRevision: 5,
      operations: [{
        type: "replace_song" as const,
        target: { scope: "stored" as const, song: 1 },
        name: "AGENT SONG",
        rows: [{
          repeats: 2,
          patterns: [
            { pattern: "A01" as const },
            { pattern: "A02" as const, mutedTracks: ["BD" as const] },
          ],
        }],
      }],
    };
    const songApplied = await client.applyOperationsNow(songInput);
    assert.ok("resultingRevision" in songApplied, "apply was not a dry run");
    assert.equal(songApplied.resultingRevision, 6);
    assert.deepEqual(await client.applyOperationsNow(songInput), songApplied);
    const storedSong = await facade.callTool("rytm_inspect_song", {
      scope: "stored",
      song: 1,
      resolveReferences: true,
    }) as {
      name: string;
      rowCount: number;
      rows: Array<{ patterns: Array<{ mutedTracksMask: number }> }>;
      references: unknown[];
    };
    assert.equal(storedSong.name, "AGENT SONG");
    assert.equal(storedSong.rowCount, 1);
    assert.equal(storedSong.rows[0]?.patterns[1]?.mutedTracksMask, 1);
    assert.equal(storedSong.references.length, 2);
    const beforeQueuedSong = await client.inspectDeviceState() as { device: { activePattern: string } };
    const queuedSong = await client.queueOperations({
      operationSetId: "integration-song-queue",
      expectedRevision: 6,
      applyAt: { kind: "next_step" },
      latePolicy: "roll-forward",
      operations: [{
        type: "insert_song_row",
        target: { scope: "stored", song: 1 },
        row: 1,
        value: { repeats: 1, patterns: [{ pattern: "B01" }] },
      }],
    });
    assert.equal(queuedSong.status, "queued");
    await client.advanceMockTransport(1);
    const queuedSongApplied = await client.inspectSong({ scope: "stored", song: 1 });
    assert.equal("songs" in queuedSongApplied ? -1 : queuedSongApplied.rowCount, 2);
    const afterQueuedSong = await client.inspectDeviceState() as { device: { activePattern: string }; revision: number };
    assert.equal(afterQueuedSong.device.activePattern, beforeQueuedSong.device.activePattern);
    assert.equal(afterQueuedSong.revision, 7);
    const songRollback = await client.rollbackSnapshot({ snapshotId: "before-song", expectedRevision: 7 });
    assert.equal(songRollback.revision, 8);
    const restoredSong = await client.inspectSong({ scope: "stored", song: 1 });
    assert.equal("songs" in restoredSong ? -1 : restoredSong.rowCount, 0);

    const journal = await client.getEvents();
    const eventTypes = journal.map((entry) => (entry.event as { type: string }).type);
    assert.ok(eventTypes.includes("operation_set.applied"));
    assert.ok(eventTypes.includes("snapshot.rolled_back"));
    assert.ok(eventTypes.includes("live.parameter_sent"));
    assert.ok(eventTypes.includes("live.scene_sent"));
    assert.ok(eventTypes.includes("live.performance_sent"));
    assert.ok(rpcEvents.some((event) => event.type === "operation_set.applied"));
    unsubscribe();

    const reconciliation = await client.reconcileState() as { status: string; revision: number };
    assert.equal(reconciliation.status, "converged");
    assert.equal(reconciliation.revision, 8);

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
    await rm(audioDirectory, { recursive: true, force: true });
  }
});

async function writeTestWav(path: string): Promise<void> {
  const sampleRate = 48_000;
  const frames = 4_800;
  const bytesPerSample = 2;
  const dataBytes = frames * bytesPerSample;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 220 * frame) / sampleRate) * 8_000);
    wav.writeInt16LE(sample, 44 + frame * bytesPerSample);
  }
  await writeFile(path, wav);
}
