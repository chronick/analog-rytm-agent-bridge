import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gridOperations } from "../src/bin/build-project.ts";
import type { PatternDecl } from "../src/bin/build-project.ts";
import { RustDaemonClient } from "../src/rpc/RustDaemonClient.ts";

interface InspectedPattern {
  pattern: string;
  trigs: Array<{ track: string; step: number; locks: Record<string, unknown> }>;
}

// A probe pattern in the shape the 2026-08-05 hardware probe used: a per-step
// LT sample_tune ladder, a sample_number probe, and locks on a second track, so
// the readback has to key locks by (track, step) rather than smear them.
const probe: PatternDecl = {
  slot: "B01",
  name: "plock-readback-probe",
  clear: true,
  tracks: {
    LT: {
      grid: "x...x...x...x...",
      plocks: {
        "1": { sample_tune: -12, sample_number: 3 },
        "5": { sample_tune: 0 },
        "9": { sample_tune: 12, filter_cutoff: 90 },
        "13": { sample_tune: 24, sample_loop: true, filter_type: "Hp1" },
      },
    },
    BD: {
      grid: "X...............",
      plocks: { "1": { amp_pan: -40, amp_volume: 100, lfo_mode: "Trig" } },
    },
  },
};

test("pattern.inspect reports exactly the locks a declaration wrote", async () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const audioDirectory = await mkdtemp(join(tmpdir(), "analog-rytm-plock-readback-"));
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
    await client.start();
    const operations = gridOperations(probe);
    const validation = await client.validateOperations(operations);
    assert.deepEqual(validation.errors, []);

    const state = (await client.inspectDeviceState()) as { revision: number };
    const applied = (await client.applyOperationsNow({
      operationSetId: "plock-readback-probe",
      expectedRevision: state.revision,
      operations,
    })) as { status: string };
    assert.equal(applied.status, "applied");

    const inspected = (await client.inspectPattern(probe.slot)) as InspectedPattern;
    assert.equal(inspected.pattern, "B01");

    // Every declared lock comes back, on the right trig, with the declared value.
    const locksAt = (track: string, step: number) =>
      inspected.trigs.find((trig) => trig.track === track && trig.step === step)?.locks;
    assert.deepEqual(locksAt("LT", 0), { sample_tune: -12, sample_number: 3 });
    assert.deepEqual(locksAt("LT", 4), { sample_tune: 0 });
    assert.deepEqual(locksAt("LT", 8), { sample_tune: 12, filter_cutoff: 90 });
    assert.deepEqual(locksAt("LT", 12), { sample_tune: 24, sample_loop: true, filter_type: "Hp1" });
    assert.deepEqual(locksAt("BD", 0), { amp_pan: -40, amp_volume: 100, lfo_mode: "Trig" });

    // ...and nothing else does: trigs the declaration left unlocked report {}.
    const declared = new Set(["LT:0", "LT:4", "LT:8", "LT:12", "BD:0"]);
    for (const trig of inspected.trigs) {
      if (declared.has(`${trig.track}:${trig.step}`)) continue;
      assert.deepEqual(trig.locks, {}, `unexpected locks on ${trig.track} step ${trig.step}`);
    }
  } finally {
    await client.close();
    await rm(audioDirectory, { recursive: true, force: true });
  }
});
