import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RytmSampleInventory,
  RytmUploadedSample,
} from "../domain/types.ts";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

const execute = process.argv.includes("--execute");
const repository = fileURLToPath(new URL("../../", import.meta.url));
const certificationDirectory = join(
  homedir(),
  ".analog-rytm-agent-bridge",
  "sample-certification",
);
const sourcePath = join(certificationDirectory, "bridge-certification-sine.wav");
const deviceDirectory = "/agent-bridge-tests";
const sampleName = "bridge-certification-sine";

export async function runHardwareSampleVerification(): Promise<void> {
  mkdirSync(certificationDirectory, { recursive: true });
  const runId = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const snapshotId = `hardware-samples-${runId}`;
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
      certificationDirectory,
    ],
    cwd: repository,
    env: process.env,
    requestTimeoutMs: 300_000,
  });
  let snapshotCreated = false;
  let rollbackVerified = false;
  let resolvedSample: { sampleId: string; slot: number } | undefined;
  let ramCleared = false;

  try {
    const health = await client.start();
    assert.equal(health.adapter, "hardware");
    assert.ok(health.methods.implemented.includes("samples.inspect"));
    assert.ok(health.methods.implemented.includes("samples.resolve_ram"));
    process.stderr.write("hardware daemon and sample adapter ready\n");

    const rootInventory = await client.inspectSamples({
      drivePath: "/",
      includeRam: true,
      includeTracks: true,
    });
    verifyInventory(rootInventory);
    process.stderr.write("+Drive, RAM, and track inventory read back\n");

    if (!execute) {
      console.log(JSON.stringify({
        status: "sample-inventory-verified-dry-run",
        adapter: rootInventory.adapter,
        driveEntries: rootInventory.entries.length,
        ram: {
          capacity: rootInventory.ram.capacity,
          occupied: rootInventory.ram.occupied,
          free: rootInventory.ram.free,
        },
        trackAssignments: rootInventory.tracks.length,
        deviceDirectory,
        sourcePath,
      }, null, 2));
      return;
    }

    writeCertificationWav(sourcePath);
    const baselineState = asRecord(await client.inspectDeviceState());
    const baselineRevision = baselineState.revision as number;
    const baselineSound = asRecord(await client.inspectSound("BD"));
    const baselineSliceNumber = sampleSliceNumber(baselineSound);

    const uploadInput = { sourcePath, deviceDirectory, name: sampleName };
    const uploaded = await client.uploadSample(uploadInput);
    assert.ok(
      ["uploaded-and-verified", "already-present"].includes(uploaded.status),
    );
    assert.equal(uploaded.devicePath, `${deviceDirectory}/${sampleName}`);
    assert.equal(uploaded.source.sampleRate, 48_000);
    assert.equal(uploaded.source.channels, 1);
    process.stderr.write("sample upload and canonical readback verified\n");

    const uploadReplay = await client.uploadSample(uploadInput);
    assert.equal(uploadReplay.status, "already-present");
    assert.equal(uploadReplay.transferred, false);
    assert.equal(uploadReplay.sampleId, uploaded.sampleId);
    process.stderr.write("sample upload idempotency verified\n");

    const managedInventory = await client.inspectSamples({
      drivePath: deviceDirectory,
      includeRam: true,
      includeTracks: true,
    });
    const managedEntry = managedInventory.entries.find(
      (entry) => entry.sampleId === uploaded.sampleId,
    );
    assert.equal(managedEntry?.devicePath, uploaded.devicePath);
    const occupied = managedInventory.ram.slots.find(
      (slot) => slot.sampleId === uploaded.sampleId,
    );
    const slot = occupied?.slot ?? highestFreeSlot(managedInventory);

    const resolved = await client.resolveSampleRam({
      sampleId: uploaded.sampleId,
      slot,
    });
    assert.ok(
      ["loaded-and-verified", "already-resolved"].includes(resolved.status),
    );
    assert.equal(resolved.slot, slot);
    assert.equal(resolved.verified, true);
    resolvedSample = { sampleId: uploaded.sampleId, slot };

    const resolveReplay = await client.resolveSampleRam({
      sampleId: uploaded.sampleId,
      slot,
    });
    assert.equal(resolveReplay.status, "already-resolved");
    assert.equal(resolveReplay.slot, slot);
    process.stderr.write("RAM slot resolution and idempotency verified\n");

    await client.snapshotState({
      snapshotId,
      label: "Hardware sample assignment baseline",
    });
    snapshotCreated = true;
    const applied = asRecord(await client.applyOperationsNow({
      operationSetId: `hardware-sample-assignment-${runId}`,
      expectedRevision: baselineRevision,
      operations: [{
        type: "assign_sample_slot",
        track: "BD",
        slot,
        sampleId: uploaded.sampleId,
      }],
    }));
    assert.equal(applied.status, "applied");
    assert.equal(applied.resultingRevision, baselineRevision + 1);
    const assignedSound = asRecord(await client.inspectSound("BD"));
    assert.equal(sampleSliceNumber(assignedSound), slot);
    const assignedInventory = await client.inspectSamples({
      drivePath: deviceDirectory,
      includeRam: true,
      includeTracks: true,
    });
    assert.equal(
      assignedInventory.ram.slots.find((entry) => entry.slot === slot)?.usedByTrack,
      true,
    );
    process.stderr.write("declarative Sound sample assignment read back\n");

    const rolledBack = asRecord(await client.rollbackSnapshot({
      snapshotId,
      expectedRevision: baselineRevision + 1,
    }));
    assert.equal(rolledBack.status, "restored-and-verified");
    assert.equal(sampleSliceNumber(asRecord(await client.inspectSound("BD"))), baselineSliceNumber);
    rollbackVerified = true;
    process.stderr.write("Sound assignment rollback verified\n");

    const cleared = await client.clearSampleRam({
      sampleId: uploaded.sampleId,
      slot,
    });
    assert.ok(["cleared-and-verified", "already-empty"].includes(cleared.status));
    ramCleared = true;
    const finalInventory = await client.inspectSamples({
      drivePath: deviceDirectory,
      includeRam: true,
    });
    assert.equal(finalInventory.ram.slots.find((entry) => entry.slot === slot)?.occupied, false);
    assert.equal(
      finalInventory.entries.find((entry) => entry.sampleId === uploaded.sampleId)?.devicePath,
      uploaded.devicePath,
    );
    process.stderr.write("RAM clear verified; +Drive sample retained\n");

    const eventTypes = (await client.getEvents()).map(
      (entry) => asRecord(entry.event).type,
    );
    assert.ok(eventTypes.includes("sample.uploaded"));
    assert.ok(eventTypes.includes("sample.ram_resolved"));
    assert.ok(eventTypes.includes("sample.ram_cleared"));

    console.log(JSON.stringify({
      status: "sample-upload-assign-rollback-verified",
      sample: compactUpload(uploaded),
      slot,
      baselineSliceNumber,
      restoredRevision: rolledBack.revision,
      driveSampleRetained: true,
      eventTypes,
    }, null, 2));
  } finally {
    if (snapshotCreated && !rollbackVerified) {
      try {
        const rolledBack = asRecord(await client.rollbackSnapshot({ snapshotId }));
        rollbackVerified = rolledBack.status === "restored-and-verified";
        process.stderr.write("emergency Sound assignment rollback completed\n");
      } catch (error) {
        process.stderr.write(`EMERGENCY SNAPSHOT ROLLBACK FAILED: ${String(error)}\n`);
      }
    }
    if (resolvedSample && !ramCleared && (!snapshotCreated || rollbackVerified)) {
      try {
        await client.clearSampleRam(resolvedSample);
        process.stderr.write("emergency RAM clear completed\n");
      } catch (error) {
        process.stderr.write(`EMERGENCY RAM CLEAR FAILED: ${String(error)}\n`);
      }
    }
    await client.close();
  }
}

if (import.meta.main) await runHardwareSampleVerification();

function verifyInventory(inventory: RytmSampleInventory): void {
  assert.equal(inventory.adapter, "elektroid");
  assert.equal(inventory.ram.capacity, 127);
  assert.equal(inventory.ram.slots.length, 127);
  assert.equal(inventory.ram.occupied + inventory.ram.free, 127);
  assert.equal(inventory.tracks.length, 12);
}

function highestFreeSlot(inventory: RytmSampleInventory): number {
  const slot = inventory.ram.slots.findLast((entry) => !entry.occupied)?.slot;
  assert.ok(slot, "Rytm sample RAM is full");
  return slot;
}

function sampleSliceNumber(sound: Record<string, unknown>): number {
  const sample = asRecord(sound.sample);
  const value = sample.number ?? sample.slice_number ?? sample.sliceNumber;
  assert.equal(typeof value, "number", "Sound sample slot was absent from readback");
  return value;
}

function writeCertificationWav(path: string): void {
  const sampleRate = 48_000;
  const frames = 12_000;
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
    const phase = (2 * Math.PI * 110 * frame) / sampleRate;
    const envelope = Math.exp((-5 * frame) / frames);
    wav.writeInt16LE(Math.round(Math.sin(phase) * envelope * 10_000), 44 + frame * 2);
  }
  writeFileSync(path, wav);
}

function compactUpload(uploaded: RytmUploadedSample): Record<string, unknown> {
  return {
    status: uploaded.status,
    transferred: uploaded.transferred,
    sampleId: uploaded.sampleId,
    devicePath: uploaded.devicePath,
    deviceChecksum: uploaded.deviceChecksum,
    sourceSha256: uploaded.sourceSha256,
    canonicalSha256: uploaded.canonicalSha256,
  };
}

function asRecord(value: unknown): Record<string, any> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}
