import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";
import type { RytmPersistentOperation } from "../domain/types.ts";

// Generic declarative Rytm project builder. Reads a JSON declaration (banks of
// pattern grids + kit/scene/perf/sample sections) and applies it through the
// hardware daemon with snapshot, validation-first, and readback. The
// declaration is content (lives in the vault); this file is mechanism.
//
//   npm run build:project -- <declaration.json>            validate only
//   npm run build:project -- <declaration.json> --execute  apply to hardware

interface TrackDecl {
  grid: string;
  condition?: string;
  conditions?: Record<string, string>;
  length?: number;
}
interface PatternDecl {
  slot: string;
  name: string;
  tracks: Record<string, TrackDecl>;
  plocks?: Array<Record<string, unknown>>;
}
interface Declaration {
  project: string;
  machines?: Array<{ track: string; machine: string }>;
  patterns: PatternDecl[];
  scenes?: Array<Record<string, unknown>>;
  performances?: Array<Record<string, unknown>>;
  samples?: Array<{ file: string; track: string; slot: number }>;
  sampleDirectory?: string;
}

const VELOCITY: Record<string, number> = { X: 120, x: 96, o: 40, ":": 96, c: 96 };

function gridOperations(pattern: PatternDecl): RytmPersistentOperation[] {
  const operations: RytmPersistentOperation[] = [];
  for (const [track, decl] of Object.entries(pattern.tracks)) {
    const steps = decl.grid.replace(/\s+/g, "");
    for (let index = 0; index < steps.length; index += 1) {
      const symbol = steps[index] as string;
      if (symbol === ".") continue;
      const condition = decl.conditions?.[String(index + 1)] ?? decl.condition;
      operations.push({
        type: "set_trig",
        pattern: pattern.slot,
        track,
        step: index,
        velocity: VELOCITY[symbol] ?? 96,
        ...(condition ? { condition } : {}),
      } as RytmPersistentOperation);
    }
    if (decl.length !== undefined) {
      operations.push({
        type: "set_track_length",
        pattern: pattern.slot,
        track,
        steps: decl.length,
      } as RytmPersistentOperation);
    }
  }
  for (const plock of pattern.plocks ?? []) {
    operations.push({ ...plock, pattern: pattern.slot } as unknown as RytmPersistentOperation);
  }
  return operations;
}

async function applyBatch(
  client: RustDaemonClient,
  label: string,
  operations: RytmPersistentOperation[],
  execute: boolean,
): Promise<void> {
  if (operations.length === 0) return;
  let hash = 5381;
  for (const character of JSON.stringify(operations)) hash = ((hash * 33) ^ character.charCodeAt(0)) >>> 0;
  const operationSetId = `build-${label}-${hash.toString(16)}`;
  const validation = await client.validateOperations(operations);
  if (!validation.valid) {
    process.stderr.write(`INVALID ${label}:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  if (!execute) {
    process.stderr.write(`ok (validated) ${label}: ${operations.length} ops\n`);
    return;
  }
  const state = (await client.inspectDeviceState()) as { revision: number };
  const applied = (await client.applyOperationsNow({
    operationSetId: `${operationSetId}-r${state.revision}`,
    expectedRevision: state.revision,
    operations,
  })) as { status?: string; acknowledgement?: string };
  assert.ok(
    applied.status === "applied" || applied.acknowledgement === "verified",
    `${label} did not verify: ${JSON.stringify(applied).slice(0, 300)}`,
  );
  process.stderr.write(`applied ${label}: ${operations.length} ops\n`);
}

export async function runProjectBuild(): Promise<void> {
  const declarationPath = process.argv[2];
  assert.ok(declarationPath, "usage: build-project.ts <declaration.json> [--execute]");
  const execute = process.argv.includes("--execute");
  const declaration = JSON.parse(readFileSync(declarationPath, "utf8")) as Declaration;

  const client = new RustDaemonClient({
    command: "cargo",
    args: ["run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve", "--adapter", "hardware", "--clock-source", "observed"],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    requestTimeoutMs: 600_000,
  });
  try {
    const health = await client.start();
    assert.equal(health.adapter, "hardware");

    let snapshotId: string | undefined;
    if (execute) {
      const snapshot = (await client.snapshotState({ label: `pre-${declaration.project}` })) as { snapshotId: string };
      snapshotId = snapshot.snapshotId;
      process.stderr.write(`baseline snapshot ${snapshotId}\n`);
    }

    if (declaration.machines?.length) {
      await applyBatch(
        client,
        "machines",
        declaration.machines.map((entry) => ({ type: "set_track_machine", ...entry }) as unknown as RytmPersistentOperation),
        execute,
      );
    }
    for (const pattern of declaration.patterns) {
      // Pattern deltas target the work buffer, so each slot must be active
      // before its operations validate/apply. Realtime pattern change does
      // not touch the persistent revision.
      if (execute) {
        await client.changePattern({ pattern: pattern.slot, immediate: true });
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const state = (await client.inspectDeviceState()) as { activePattern?: string };
          if (state.activePattern === pattern.slot) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      await applyBatch(client, `pattern-${pattern.slot}`, gridOperations(pattern), execute);
    }
    if (declaration.scenes?.length) {
      await applyBatch(client, "scenes", declaration.scenes as unknown as RytmPersistentOperation[], execute);
    }
    if (declaration.performances?.length) {
      await applyBatch(client, "performances", declaration.performances as unknown as RytmPersistentOperation[], execute);
    }

    if (execute && declaration.samples?.length && declaration.sampleDirectory) {
      for (const sample of declaration.samples) {
        const uploaded = (await client.uploadSample({
          sourcePath: `${declaration.sampleDirectory}/${sample.file}`,
          deviceDirectory: `/${declaration.project}`,
        })) as { sampleId: string };
        const resolved = (await client.resolveSampleRam({ sampleId: uploaded.sampleId, slot: sample.slot })) as { slot: number };
        const state = (await client.inspectDeviceState()) as { revision: number };
        await client.applyOperationsNow({
          operationSetId: `build-sample-${sample.track}-${sample.slot}-r${state.revision}`,
          expectedRevision: state.revision,
          operations: [
            { type: "assign_sample_slot", track: sample.track, slot: resolved.slot, sampleId: uploaded.sampleId } as unknown as RytmPersistentOperation,
          ],
        });
        process.stderr.write(`sample ${sample.file} -> RAM ${resolved.slot} -> ${sample.track}\n`);
      }
    }

    const final = (await client.inspectDeviceState()) as { revision: number };
    process.stdout.write(`${JSON.stringify({ project: declaration.project, executed: execute, finalRevision: final.revision, snapshotId }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) await runProjectBuild();
