import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";
import type { RytmPersistentOperation } from "../domain/types.ts";

// Generic declarative Rytm project builder. Reads a JSON declaration (banks of
// pattern grids + kit/scene/perf/sample/sound sections) and applies it through
// the hardware daemon with snapshot, validation-first, and readback. The
// declaration is content (lives in the vault); this file is mechanism.
//
//   npm run build:project -- <declaration.json>            validate only
//   npm run build:project -- <declaration.json> --execute  apply to hardware
//
// The optional `sounds` section designs each track's kit sound: a machine
// selection plus per-page parameter locks. Shape (all fields optional):
//
//   "sounds": {
//     "<track>": {
//       "machine": "bdplastic",                 // -> set_track_machine
//       "machineParams": { "tun": -14, ... },   // -> set_sound_parameter page:"machine"
//       "sample":   { "start": 0, ... },        // -> set_sound_parameter page:"sample"
//       "filter":   { "cutoff": 90, ... },      //    page:"filter"
//       "amp":      { "overdrive": 8, ... },     //    page:"amp"
//       "lfo":      { "destination": "SampleFineTune", ... }, // page:"lfo"
//       "settings": { "velocity_to_volume": false, ... }     // page:"settings"
//     }
//   }
//
// Parameter names and enum casing are the daemon's (see hardware.rs
// apply_sound_parameter); enum values are CamelCase serde variants
// (`SampleStart`, `Tri`, ...), not the lowercase rytm-rs strings. The
// machine selection is emitted before its params because set_track_machine
// resets the machine page to defaults. Ground values in the sound-design
// corpus (`~/git/vault/corpus/sound-design/`) rather than improvising.
//
// Per-track pattern sugar (all step keys are 1-BASED strings, "1" = step 1,
// matching the `conditions` convention; put these only on trigged steps):
//
//   "BD": {
//     "grid": "X... X... X... X...",  // X=vel120 x=96 o=40, '.'=silent
//     "length": 16,                    // optional per-track length (polymeter)
//     "condition": "50%",             // optional whole-track default
//     "conditions": { "5": "75%" },   // optional per-step override
//     "microtiming": { "3": -6 },     // -24..24, merged into the step's set_trig
//     "retrigs": [5, 13],              // 1-based steps -> set_trig retrig:true
//     "plocks": { "1": { "filter_cutoff": 40 } }  // per-step -> set_parameter_lock
//   }
//
// Emission order per pattern: for each declared track, clears -> set_trigs ->
// set_track_length; then every track's plock-sugar (as set_parameter_lock, step
// keys converted 1-based -> 0-based); then the raw `pattern.plocks` passthrough.
//
// `clear: true` on a pattern emits clear_trig for every '.' position of every
// DECLARED track BEFORE that track's set_trigs (declare an all-dots grid to wipe
// a track). Declare all tracks in every pattern for deterministic rebuilds.
//
// The optional `kit` section is a raw set_kit_parameter (etc.) op array applied
// as one batch after `sounds` and before patterns (e.g. retrig rate/length,
// track levels). The optional `song` section:
//
//   "song": { "name": "MOONSHOT", "rows": [ { "pattern": "A01", "repeats": 2, "mutes": ["BD"] } ] }
//
// emits clear_song, then set_song_name (when `name` is set), then one
// insert_song_row per row (row index 0..n-1), applied after `performances`.
// Mapping onto the daemon's SongRowInput (state.rs): each flat declaration row
// becomes a single-position row -> value = { patterns: [{ pattern, mutedTracks:
// mutes ?? [] }], repeats: repeats ?? 1 }. `mutes` maps to the position's
// `mutedTracks`; `repeats` is required by the daemon (u16, 1..256) so it
// defaults to 1; `target` is omitted (defaults to the work-buffer song).

export interface TrackDecl {
  grid: string;
  condition?: string;
  conditions?: Record<string, string>;
  length?: number;
  microtiming?: Record<string, number>; // 1-based step -> -24..24
  retrigs?: number[]; // 1-based trigged steps to enable retrig on
  plocks?: Record<string, Record<string, number | boolean | string>>; // 1-based step -> param map
}
export interface PatternDecl {
  slot: string;
  name: string;
  clear?: boolean; // wipe every '.' position of every declared track first
  tracks: Record<string, TrackDecl>;
  plocks?: Array<Record<string, unknown>>; // raw op passthrough (kept)
}
export interface SongDecl {
  name?: string;
  rows: Array<{ pattern: string; repeats?: number; mutes?: string[] }>;
}
interface SoundDecl {
  machine?: string;
  machineParams?: Record<string, number | string>;
  sample?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  amp?: Record<string, unknown>;
  lfo?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}
interface Declaration {
  project: string;
  machines?: Array<{ track: string; machine: string }>;
  patterns: PatternDecl[];
  sounds?: Record<string, SoundDecl>;
  kit?: Array<Record<string, unknown>>; // raw set_kit_parameter (etc.) passthrough
  scenes?: Array<Record<string, unknown>>;
  performances?: Array<Record<string, unknown>>;
  song?: SongDecl;
  samples?: Array<{ file: string; track: string; slot: number }>;
  sampleDirectory?: string;
}

const VELOCITY: Record<string, number> = { X: 120, x: 96, o: 40, ":": 96, c: 96 };

export function gridOperations(pattern: PatternDecl): RytmPersistentOperation[] {
  const operations: RytmPersistentOperation[] = [];
  // Pass 1 (per track): clears (for a `clear` pattern) -> set_trigs -> length.
  // microtiming/retrigs merge into the matching trigged step's set_trig.
  for (const [track, decl] of Object.entries(pattern.tracks)) {
    const steps = decl.grid.replace(/\s+/g, "");
    if (pattern.clear) {
      for (let index = 0; index < steps.length; index += 1) {
        if (steps[index] !== ".") continue;
        operations.push({ type: "clear_trig", pattern: pattern.slot, track, step: index } as RytmPersistentOperation);
      }
    }
    for (let index = 0; index < steps.length; index += 1) {
      const symbol = steps[index] as string;
      if (symbol === ".") continue;
      const key = String(index + 1); // step keys are 1-based
      const condition = decl.conditions?.[key] ?? decl.condition;
      const microTiming = decl.microtiming?.[key];
      const retrig = decl.retrigs?.includes(index + 1);
      operations.push({
        type: "set_trig",
        pattern: pattern.slot,
        track,
        step: index,
        velocity: VELOCITY[symbol] ?? 96,
        ...(microTiming !== undefined ? { microTiming } : {}),
        ...(condition ? { condition } : {}),
        ...(retrig ? { retrig: true } : {}),
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
  // Pass 2 (per track): plock sugar -> set_parameter_lock, 1-based key -> 0-based step.
  for (const [track, decl] of Object.entries(pattern.tracks)) {
    for (const [key, params] of Object.entries(decl.plocks ?? {})) {
      const step = Number(key) - 1;
      for (const [parameter, value] of Object.entries(params)) {
        operations.push({ type: "set_parameter_lock", pattern: pattern.slot, track, step, parameter, value } as RytmPersistentOperation);
      }
    }
  }
  // Pass 3: raw pattern-level plock op passthrough (unchanged).
  for (const plock of pattern.plocks ?? []) {
    operations.push({ ...plock, pattern: pattern.slot } as unknown as RytmPersistentOperation);
  }
  return operations;
}

// Song section -> clear_song, set_song_name (when named), one insert_song_row
// per row. Each flat declaration row maps onto the daemon's SongRowInput as a
// single-position row (mutes -> mutedTracks, repeats defaults to 1); target is
// omitted so it edits the work-buffer song.
export function songOperations(song: SongDecl): RytmPersistentOperation[] {
  const operations: RytmPersistentOperation[] = [{ type: "clear_song" } as RytmPersistentOperation];
  if (song.name !== undefined) {
    operations.push({ type: "set_song_name", name: song.name } as RytmPersistentOperation);
  }
  song.rows.forEach((row, index) => {
    operations.push({
      type: "insert_song_row",
      row: index,
      value: { patterns: [{ pattern: row.pattern, mutedTracks: row.mutes ?? [] }], repeats: row.repeats ?? 1 },
    } as RytmPersistentOperation);
  });
  return operations;
}

// Sound-page sections in emission order (machine params are handled first,
// under page "machine", so set_track_machine can precede them per track).
const SOUND_PAGES = ["sample", "filter", "amp", "lfo", "settings"] as const;

export function soundOperations(sounds: Record<string, SoundDecl>): RytmPersistentOperation[] {
  const operations: RytmPersistentOperation[] = [];
  for (const [track, decl] of Object.entries(sounds)) {
    // Machine selection first: set_track_machine resets the sound's machine
    // page to that machine's defaults, so its param locks must follow it.
    if (decl.machine !== undefined) {
      operations.push({ type: "set_track_machine", track, machine: decl.machine } as unknown as RytmPersistentOperation);
    }
    for (const [parameter, value] of Object.entries(decl.machineParams ?? {})) {
      operations.push({ type: "set_sound_parameter", track, page: "machine", parameter, value } as unknown as RytmPersistentOperation);
    }
    for (const page of SOUND_PAGES) {
      for (const [parameter, value] of Object.entries(decl[page] ?? {})) {
        operations.push({
          type: "set_sound_parameter",
          track,
          page,
          parameter,
          value: value as number | boolean | string,
        } as unknown as RytmPersistentOperation);
      }
    }
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
    if (declaration.sounds && Object.keys(declaration.sounds).length) {
      await applyBatch(client, "sounds", soundOperations(declaration.sounds), execute);
    }
    if (declaration.kit?.length) {
      await applyBatch(client, "kit", declaration.kit as unknown as RytmPersistentOperation[], execute);
    }
    // Pattern deltas target the work buffer, so each slot must be active
    // before its operations validate/apply. In validate-only mode nothing is
    // allowed to touch the device, so instead remap each batch onto whatever
    // slot is currently active: content checks (tracks, steps, parameters,
    // ranges) are identical across slots, only the addressing differs.
    let validateSlot: string | undefined;
    if (!execute && declaration.patterns.length) {
      const state = (await client.inspectDeviceState()) as { activePattern?: string | { pattern?: string } };
      validateSlot = typeof state.activePattern === "object" ? state.activePattern?.pattern : state.activePattern;
      if (validateSlot) process.stderr.write(`validate-only: remapping pattern batches onto active slot ${validateSlot}\n`);
    }
    for (const pattern of declaration.patterns) {
      if (execute) {
        await client.changePattern({ pattern: pattern.slot, immediate: true });
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const state = (await client.inspectDeviceState()) as { activePattern?: string | { pattern?: string } };
          const active = typeof state.activePattern === "object" ? state.activePattern?.pattern : state.activePattern;
          if (active === pattern.slot) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      const operations = validateSlot
        ? gridOperations(pattern).map((op) => ({ ...op, pattern: validateSlot }) as RytmPersistentOperation)
        : gridOperations(pattern);
      await applyBatch(client, `pattern-${pattern.slot}`, operations, execute);
    }
    if (declaration.scenes?.length) {
      await applyBatch(client, "scenes", declaration.scenes as unknown as RytmPersistentOperation[], execute);
    }
    if (declaration.performances?.length) {
      await applyBatch(client, "performances", declaration.performances as unknown as RytmPersistentOperation[], execute);
    }
    if (declaration.song?.rows?.length) {
      await applyBatch(client, "song", songOperations(declaration.song), execute);
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
