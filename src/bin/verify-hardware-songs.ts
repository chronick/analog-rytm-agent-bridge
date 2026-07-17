import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RytmPersistentOperation,
  RytmSongSummary,
  RytmSongTarget,
} from "../domain/types.ts";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

const execute = process.argv.includes("--execute");
const repository = fileURLToPath(new URL("../../", import.meta.url));
const snapshotId = "hardware-song-certification";
const target = { scope: "stored", song: 16 } as const satisfies RytmSongTarget;

export async function runHardwareSongVerification(): Promise<void> {
  const stateDirectory = mkdtempSync(join(tmpdir(), "analog-rytm-songs-"));
  const client = new RustDaemonClient({
    command: "cargo",
    args: [
      "run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve",
      "--adapter", "hardware", "--state-dir", stateDirectory,
      "--clock-source", "generated",
    ],
    cwd: repository,
    requestTimeoutMs: 180_000,
  });
  let snapshotCreated = false;
  let rollbackVerified = false;
  let transportPlaying = false;

  try {
    const health = await client.start();
    assert.equal(health.adapter, "hardware");
    assert.ok(health.methods.implemented.includes("song.inspect"));
    assert.ok(health.methods.implemented.includes("operations.queue"));
    process.stderr.write("hardware daemon ready\n");

    const baselineState = asRecord(await client.inspectDeviceState());
    const baselineRevision = requiredNumber(baselineState.revision, "baseline revision");
    const baselinePattern = activePattern(baselineState);
    const baselineSong = asSong(await client.inspectSong({
      scope: "stored",
      song: target.song,
      resolveReferences: true,
    }));
    assertSongCapabilities(baselineSong);
    const allSongs = asRecord(await client.inspectSong({ scope: "all" }));
    assert.equal(allSongs.count, 17);
    assert.equal((allSongs.songs as unknown[]).length, 17);
    process.stderr.write("work-buffer and all stored Songs inspected\n");

    const appliedName = baselineSong.name === "BRIDGE CERT" ? "BRIDGE ALT" : "BRIDGE CERT";
    const queuedName = appliedName === "QUEUE CERT" ? "QUEUE ALT" : "QUEUE CERT";
    const operations = certificationOperations(appliedName);
    const validation = await client.validateOperations(operations);
    assert.equal(validation.valid, true, validation.errors.join("; "));

    const proposal = asRecord(await client.proposeSongDelta({ operations }));
    assert.equal(asRecord(proposal.validation).valid, true);
    assertExpectedSong(projectedStoredSong(proposal, target.song), appliedName);

    const dryRun = asRecord(await client.applyOperationsNow({
      operationSetId: "hardware-song-dry-run",
      expectedRevision: baselineRevision,
      operations,
      dryRun: true,
    }));
    assert.equal(dryRun.status, "dry_run");
    assert.equal(dryRun.projectedRevision, baselineRevision + 1);
    assertExpectedSong(projectedStoredSong(dryRun, target.song), appliedName);
    assert.equal(activePattern(asRecord(await client.inspectDeviceState())), baselinePattern);
    process.stderr.write("Song operations validated and projected without writes\n");

    if (!execute) {
      console.log(JSON.stringify({
        status: "validated-dry-run",
        target,
        operations: operations.length,
        baselineRevision,
        baselinePattern,
        baselineSong: songFields(baselineSong),
      }, null, 2));
      return;
    }

    await client.snapshotState({ snapshotId, label: "Hardware Song certification baseline" });
    snapshotCreated = true;
    process.stderr.write("raw work-buffer and stored Song snapshot captured\n");

    const immediateInput = {
      operationSetId: "hardware-song-apply",
      expectedRevision: baselineRevision,
      operations,
    } as const;
    const applied = asRecord(await client.applyOperationsNow(immediateInput));
    assert.equal(applied.status, "applied");
    assert.equal(applied.changed, true);
    assert.equal(applied.resultingRevision, baselineRevision + 1);
    assert.deepEqual(asRecord(await client.applyOperationsNow(immediateInput)), applied);
    const observed = asSong(await client.inspectSong({
      scope: "stored",
      song: target.song,
      resolveReferences: true,
    }));
    assertExpectedSong(observed, appliedName);
    assert.equal(activePattern(asRecord(await client.inspectDeviceState())), baselinePattern);
    process.stderr.write("all declarative Song row operations applied, replayed, and read back\n");

    const transport = asRecord(await client.setTransport({ command: "start", tempo: 90 }));
    transportPlaying = true;
    const queuedInput = {
      operationSetId: "hardware-song-next-beat",
      expectedRevision: baselineRevision + 1,
      applyAt: { kind: "next_beat" as const, transportEpoch: transport.epoch as string },
      latePolicy: "reject" as const,
      operations: [{ type: "set_song_name" as const, target, name: queuedName }],
    };
    assert.equal(asRecord(await client.queueOperations(queuedInput)).status, "queued");
    const queuedEvent = await waitForOperation(client, queuedInput.operationSetId);
    assert.equal(queuedEvent.acknowledgement, "verified");
    const queuedReplay = asRecord(await client.queueOperations(queuedInput));
    assert.equal(queuedReplay.status, "applied");
    assert.equal(queuedReplay.resultingRevision, baselineRevision + 2);
    const queuedSong = asSong(await client.inspectSong({ scope: "stored", song: target.song }));
    assertExpectedSong(queuedSong, queuedName);
    assert.equal(activePattern(asRecord(await client.inspectDeviceState())), baselinePattern);
    await client.setTransport({ command: "stop" });
    transportPlaying = false;
    process.stderr.write("next-beat Song write and idempotent queued replay verified\n");

    const rolledBack = asRecord(await client.rollbackSnapshot({
      snapshotId,
      expectedRevision: baselineRevision + 2,
    }));
    assert.equal(rolledBack.status, "restored-and-verified");
    assert.equal(rolledBack.revision, baselineRevision + 3);
    rollbackVerified = true;
    const restoredSong = asSong(await client.inspectSong({
      scope: "stored",
      song: target.song,
      resolveReferences: true,
    }));
    assert.deepEqual(songFields(restoredSong), songFields(baselineSong));
    assert.equal(activePattern(asRecord(await client.inspectDeviceState())), baselinePattern);
    process.stderr.write("raw snapshot rollback restored the exact Song baseline\n");

    const events = await client.getEvents(0, 1000);
    const eventTypes = events.map((entry) => asRecord(entry.event).type);
    assert.ok(eventTypes.includes("operation_set.applied"));
    assert.ok(eventTypes.includes("snapshot.rolled_back"));

    console.log(JSON.stringify({
      status: "song-control-readback-scheduling-rollback-verified",
      target,
      operations: operations.length,
      appliedRevision: applied.resultingRevision,
      queuedRevision: queuedReplay.resultingRevision,
      restoredRevision: rolledBack.revision,
      baselinePattern,
      patternActivationChanged: false,
      supported: ["names", "rows", "chains", "repeats", "track_mutes"],
      eventTypes: [...new Set(eventTypes)].sort(),
    }, null, 2));
  } finally {
    if (transportPlaying) {
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
        process.stderr.write("emergency raw Song snapshot rollback completed\n");
      } catch (error) {
        process.stderr.write(`EMERGENCY SONG ROLLBACK FAILED: ${String(error)}\n`);
      }
    }
    await client.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) await runHardwareSongVerification();

function certificationOperations(name: string): RytmPersistentOperation[] {
  return [
    { type: "clear_song", target },
    {
      type: "replace_song",
      target,
      name: "REPLACED",
      rows: [
        { repeats: 2, patterns: [{ pattern: "A01", mutedTracks: ["BD", "CH"] }] },
        { repeats: 1, patterns: [{ pattern: "A02" }, { pattern: "A03", mutedTracks: ["SD"] }] },
      ],
    },
    { type: "set_song_name", target, name },
    {
      type: "insert_song_row",
      target,
      row: 1,
      value: { repeats: 4, patterns: [{ pattern: "B01" }] },
    },
    {
      type: "update_song_row",
      target,
      row: 0,
      value: {
        repeats: 3,
        patterns: [{ pattern: "C01" }, { pattern: "C02", mutedTracks: ["SD", "CB"] }],
      },
    },
    { type: "copy_song_row", target, sourceRow: 0, targetRow: 3 },
    { type: "move_song_row", target, sourceRow: 3, targetRow: 1 },
    { type: "remove_song_row", target, row: 2 },
  ];
}

function assertExpectedSong(song: RytmSongSummary, name: string): void {
  assert.deepEqual(songFields(song), {
    target,
    name,
    rowCount: 3,
    patternPositionCount: 6,
    rows: [
      {
        row: 0,
        repeats: 3,
        patterns: [
          { pattern: "C01", mutedTracks: [] },
          { pattern: "C02", mutedTracks: ["SD", "CB"] },
        ],
      },
      {
        row: 1,
        repeats: 3,
        patterns: [
          { pattern: "C01", mutedTracks: [] },
          { pattern: "C02", mutedTracks: ["SD", "CB"] },
        ],
      },
      {
        row: 2,
        repeats: 1,
        patterns: [
          { pattern: "A02", mutedTracks: [] },
          { pattern: "A03", mutedTracks: ["SD"] },
        ],
      },
    ],
  });
}

function songFields(song: RytmSongSummary): Record<string, unknown> {
  return {
    target: song.target,
    name: song.name,
    rowCount: song.rowCount,
    patternPositionCount: song.patternPositionCount,
    rows: song.rows.map((row) => ({
      row: row.row,
      repeats: row.repeats,
      patterns: row.patterns.map((pattern) => ({
        pattern: pattern.pattern,
        mutedTracks: pattern.mutedTracks,
      })),
    })),
  };
}

function projectedStoredSong(result: Record<string, unknown>, song: number): RytmSongSummary {
  const projectedState = asRecord(result.projectedState);
  return asSong(asRecord(projectedState.songs)[`stored:${song.toString().padStart(2, "0")}`]);
}

function assertSongCapabilities(song: RytmSongSummary): void {
  assert.equal(song.capabilities.name, true);
  assert.equal(song.capabilities.rows, true);
  assert.equal(song.capabilities.patternChains, true);
  assert.equal(song.capabilities.repeats, true);
  assert.equal(song.capabilities.trackMutes, true);
  assert.equal(song.capabilities.tempoOverrides, false);
  assert.equal(song.capabilities.jumps, false);
  assert.equal(song.capabilities.loops, false);
}

function activePattern(state: Record<string, unknown>): string {
  return asRecord(state.activePattern).pattern as string;
}

async function waitForOperation(
  client: RustDaemonClient,
  operationSetId: string,
  timeoutMs = 45_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await client.getEvents(0, 1000);
    const match = events
      .map((entry) => asRecord(entry.event))
      .find((event) => event.type === "operation_set.applied" && event.operationSetId === operationSetId);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for operation_set.applied for ${operationSetId}`);
}

function asSong(value: unknown): RytmSongSummary {
  return asRecord(value) as unknown as RytmSongSummary;
}

function requiredNumber(value: unknown, label: string): number {
  assert.equal(typeof value, "number", `${label} must be numeric`);
  return value;
}

function asRecord(value: unknown): Record<string, any> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}
