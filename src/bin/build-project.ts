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
//   npm run build:project -- <declaration.json>              validate only
//   npm run build:project -- <declaration.json> --execute    apply to hardware
//   npm run build:project -- <declaration.json> --auto-slots remap conflicted RAM slots
//
// A declaration with a `samples` section is preflighted against the device's
// RAM inventory FIRST (read-only, so it runs in validate-only mode too): every
// declared slot must be free or already hold that sample's own content. A
// conflict aborts the run with exit 1 BEFORE any kit/pattern batch is applied
// (the pre-preflight failure mode was a late `RAM slot N is occupied` from
// samples.resolve_ram, after every op had already landed). With --auto-slots
// each conflicted slot is remapped in memory to a free one, sample_number
// p-locks and kit `slot` fields follow the remap, and the final map is printed
// to stdout as `{"slotMap": {"<file>": <slot>}}`. See planSampleSlots below.
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
//     "velocities": { "5": 112 },     // 1-based step -> 1..127, overrides the grid
//                                      //   symbol's velocity for that step's set_trig
//     "retrigs": [5, 13],              // 1-based steps -> set_trig retrig:true
//     "plocks": { "1": { "filter_cutoff": 40 } }  // per-step -> set_parameter_lock
//   }
//
// Emission order per pattern: for a `clear` pattern, one clear_pattern_plocks
// FIRST (full p-lock pool purge — the declaration's locks are the complete
// intended set, so the pool is rebuilt from scratch; this also retires legacy
// pool debris such as zero-fill ghosts and orphaned compound companion slots);
// then, when the pattern declares `kit` (1-based, 1..128), one set_pattern_kit
// assigning which stored kit the pattern loads; then for each declared track,
// clears -> set_trigs -> set_track_length; then every track's plock-sugar (as
// set_parameter_lock, step keys converted 1-based -> 0-based); then the raw
// `pattern.plocks` passthrough.
//
// `clear: true` on a pattern also emits clear_trig for every '.' position of
// every DECLARED track BEFORE that track's set_trigs (declare an all-dots grid
// to wipe a track). Declare all tracks in every pattern for deterministic
// rebuilds.
//
// The optional `kit` section is a raw set_kit_parameter (etc.) op array applied
// as one batch after `sounds` and before patterns (e.g. retrig rate/length,
// track levels), targeting the WORK-BUFFER kit.
//
// The optional `kits` section addresses distinct STORED kits, each with its own
// scene/performance lock-pool budget (48 + 48):
//
//   "kits": [ { "kit": 2, "sounds": {..like top-level sounds..},
//              "ops": [..raw set_kit_parameter/set_fx_parameter..],
//              "scenes": [..], "performances": [..] } ]
//
// Every op a kit entry compiles to is stamped with its 1-based `kit` field so
// the daemon routes it to project.kits()[kit-1] (send + readback that stored kit
// object) instead of the work buffer. Applied per-kit after the top-level `kit`
// section and before patterns. The optional `song` section:
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
  velocities?: Record<string, number>; // 1-based trigged step -> 1..127, overrides the grid symbol's velocity
  retrigs?: number[]; // 1-based trigged steps to enable retrig on
  plocks?: Record<string, Record<string, number | boolean | string>>; // 1-based step -> param map
}
export interface PatternDecl {
  slot: string;
  name: string;
  clear?: boolean; // wipe every '.' position of every declared track first
  kit?: number; // 1-based kit index (1..128) this pattern loads -> set_pattern_kit
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
// One indexed kit (device kit `kit`, 1-based). Its sub-sections mirror the
// top-level work-buffer sections; every op they compile to is stamped with
// `kit` so the daemon routes it to project.kits()[kit-1] instead of the work
// buffer. Each kit carries its own 48-scene / 48-performance lock-pool budget.
export interface KitDecl {
  kit: number;
  sounds?: Record<string, SoundDecl>;
  ops?: Array<Record<string, unknown>>; // raw kit ops (set_kit_parameter/set_fx_parameter/...)
  scenes?: Array<Record<string, unknown>>;
  performances?: Array<Record<string, unknown>>;
}
export interface Declaration {
  project: string;
  machines?: Array<{ track: string; machine: string }>;
  patterns: PatternDecl[];
  sounds?: Record<string, SoundDecl>;
  kit?: Array<Record<string, unknown>>; // raw set_kit_parameter (etc.) passthrough
  kits?: KitDecl[]; // per-indexed-kit sounds/ops/scenes/performances (kit stamped in)
  scenes?: Array<Record<string, unknown>>;
  performances?: Array<Record<string, unknown>>;
  song?: SongDecl;
  // track omitted = upload + resolve the RAM slot only (no Sound assignment);
  // patterns reach such samples via per-step sample_number p-locks.
  samples?: Array<{ file: string; track?: string; slot: number }>;
  sampleDirectory?: string;
}

const VELOCITY: Record<string, number> = { X: 120, x: 96, o: 40, ":": 96, c: 96 };

export function gridOperations(pattern: PatternDecl): RytmPersistentOperation[] {
  const operations: RytmPersistentOperation[] = [];
  // Pass 0: for a `clear` pattern, purge the whole p-lock pool FIRST so the
  // batch rebuilds it from scratch (the declaration's locks are the complete
  // intended set; the purge also retires legacy pool debris).
  if (pattern.clear) {
    operations.push({ type: "clear_pattern_plocks", pattern: pattern.slot } as RytmPersistentOperation);
  }
  // Pass 0b: assign the pattern's kit BEFORE any trig/plock op. A pattern's kit
  // number selects which stored kit it loads; emit it early so downstream ops
  // (and the on-device audition) see the intended kit.
  if (pattern.kit !== undefined) {
    operations.push({ type: "set_pattern_kit", pattern: pattern.slot, kit: pattern.kit } as RytmPersistentOperation);
  }
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
      // A per-step `velocities` override (1..127) wins over the grid symbol's
      // default velocity for that step; the grid symbol still decides whether
      // there is a trig at all.
      const velocity = decl.velocities?.[key] ?? VELOCITY[symbol] ?? 96;
      operations.push({
        type: "set_trig",
        pattern: pattern.slot,
        track,
        step: index,
        velocity,
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

// One indexed kit -> its sounds/ops/scenes/performances, each stamped with the
// 1-based `kit` field so the daemon routes them to that stored kit. The
// sub-sections reuse the same compilers/shapes as the top-level work-buffer
// sections; only the kit target differs. Emission order mirrors the top-level
// build order (sounds, then raw kit ops, then scenes, then performances).
export function kitOperations(entry: KitDecl): RytmPersistentOperation[] {
  const stamp = (op: RytmPersistentOperation): RytmPersistentOperation =>
    ({ ...(op as Record<string, unknown>), kit: entry.kit }) as unknown as RytmPersistentOperation;
  const operations: RytmPersistentOperation[] = [];
  if (entry.sounds && Object.keys(entry.sounds).length) {
    operations.push(...soundOperations(entry.sounds).map(stamp));
  }
  for (const op of entry.ops ?? []) operations.push(stamp(op as unknown as RytmPersistentOperation));
  for (const op of entry.scenes ?? []) operations.push(stamp(op as unknown as RytmPersistentOperation));
  for (const op of entry.performances ?? []) operations.push(stamp(op as unknown as RytmPersistentOperation));
  return operations;
}

export function kitsOperations(kits: KitDecl[]): RytmPersistentOperation[] {
  return kits.flatMap(kitOperations);
}

// ---------------------------------------------------------------------------
// RAM-slot preflight
// ---------------------------------------------------------------------------
// The subset of RytmSampleRamSlot (domain/types.ts, as returned by
// samples.inspect -> `ram.slots`) the planner reads. Kept structural so tests
// can build an inventory without the daemon.
export interface RamSlotView {
  slot: number;
  occupied: boolean;
  devicePath?: string;
  sampleId?: string;
  usedByTrack?: boolean;
}

// Why a declared slot cannot be used as authored. All three are failures the
// daemon would otherwise raise mid-execute, from samples.resolve_ram:
//   occupied           - foreign content sits in the declared slot
//   resident-elsewhere - this sample's own content is already loaded in a
//                        DIFFERENT slot; resolve_ram matches on device path and
//                        refuses the duplicate slot (so a free declared slot can
//                        conflict too). Remaps onto the slot it already occupies,
//                        which keeps repeated --auto-slots runs idempotent.
//   unknown-slot       - the declared slot is absent from the RAM inventory
//                        (out of range / bad authoring). Never auto-remapped:
//                        that is a declaration bug, not RAM pressure.
export type SlotConflictReason = "occupied" | "resident-elsewhere" | "unknown-slot";

export interface SampleSlotConflict {
  file: string;
  slot: number; // the declared slot
  expectedPath: string; // /<project>/<basename without extension>
  reason: SlotConflictReason;
  occupiedBy?: string; // device path of the squatter (reason "occupied")
  sampleId?: string; // sample id of the squatter, when the device reports one
  usedByTrack: boolean; // squatter is referenced by a track (clearing it is louder)
  residentSlot?: number; // where this sample's content already lives
  remapTo?: number; // chosen replacement; undefined = unresolvable, must exit 1
}

export interface SampleSlotPlan {
  conflicts: SampleSlotConflict[];
  // Assignable pool: unoccupied slots the declaration does not already claim,
  // ascending. Remap targets come from here, so they can never collide with a
  // declared slot (which is what makes the p-lock rewrite a single pass).
  freeSlots: number[];
  mapping: Record<number, number>; // declared slot -> final slot (conflicts only)
  declaration: Declaration; // deep copy, remapped (identical when no conflicts)
}

// Device path build-project gives an uploaded sample: the deviceDirectory
// (`/<project>`) joined with the source file's stem. Mirrors daemon/src/samples.rs
// `upload` (Path::file_stem + join_device_path) — strip the directory and the
// LAST extension only, no case folding.
export function sampleDevicePath(project: string, file: string): string {
  const base = file.split("/").pop() ?? file;
  const dot = base.lastIndexOf(".");
  return `/${project}/${dot > 0 ? base.slice(0, dot) : base}`;
}

// Classify every declared sample slot against the device's RAM inventory and
// plan a conflict-free assignment. Pure: no daemon, no I/O.
//
// Per declared sample, the slot is one of
//   free     - the inventory reports it unoccupied            -> used as authored
//   ours     - occupied by this sample's own device path      -> used as authored
//   conflict - anything else                                  -> remapped (see
//              SlotConflictReason; `occupied` takes the lowest free slot,
//              skipping declared and already-chosen ones)
//
// The returned declaration is a deep copy in which samples[].slot, every
// `sample_number` p-lock value (per-track sugar AND the raw pattern.plocks
// passthrough) and every `slot` field of the raw kit op arrays (`kit`,
// `kits[].ops` — in practice assign_sample_slot) that referenced a REMAPPED
// declared slot are rewritten. Slots that are not declared here (external
// material a pattern p-locks into) are left untouched.
export function planSampleSlots(declaration: Declaration, ramSlots: RamSlotView[]): SampleSlotPlan {
  const samples = declaration.samples ?? [];
  const bySlot = new Map(ramSlots.map((entry) => [entry.slot, entry]));
  const declaredSlots = new Set(samples.map((sample) => sample.slot));
  const pool = ramSlots
    .filter((entry) => !entry.occupied && !declaredSlots.has(entry.slot))
    .map((entry) => entry.slot)
    .sort((left, right) => left - right);

  const conflicts: SampleSlotConflict[] = [];
  const mapping: Record<number, number> = {};
  const chosen = new Set<number>();

  for (const sample of samples) {
    const expectedPath = sampleDevicePath(declaration.project, sample.file);
    const occupant = bySlot.get(sample.slot);
    if (occupant?.occupied && occupant.devicePath === expectedPath) continue; // ours
    // resolve_ram matches an already-loaded sample by device path, so where our
    // own content sits matters even when the declared slot itself looks fine.
    const resident = ramSlots.find((entry) => entry.occupied && entry.devicePath === expectedPath);
    if (resident === undefined && occupant !== undefined && !occupant.occupied) continue; // free
    const shared = { file: sample.file, slot: sample.slot, expectedPath };
    let conflict: SampleSlotConflict;
    if (resident !== undefined) {
      conflict = {
        ...shared,
        reason: "resident-elsewhere",
        usedByTrack: resident.usedByTrack === true,
        residentSlot: resident.slot,
        remapTo: resident.slot,
      };
    } else if (occupant === undefined) {
      conflict = { ...shared, reason: "unknown-slot", usedByTrack: false };
    } else {
      // A slot declared twice reuses its first allocation, so the report and the
      // remapped declaration agree (a duplicate declaration is still a bug).
      const next = mapping[sample.slot] ?? pool.find((slot) => !chosen.has(slot));
      if (next !== undefined) chosen.add(next);
      conflict = {
        ...shared,
        reason: "occupied",
        ...(occupant.devicePath !== undefined ? { occupiedBy: occupant.devicePath } : {}),
        ...(occupant.sampleId !== undefined ? { sampleId: occupant.sampleId } : {}),
        usedByTrack: occupant.usedByTrack === true,
        ...(next !== undefined ? { remapTo: next } : {}),
      };
    }
    conflicts.push(conflict);
    if (conflict.remapTo !== undefined) mapping[sample.slot] = conflict.remapTo;
  }

  // Rewrite the copy in ONE pass keyed on the ORIGINAL slot values: remap
  // targets are never themselves declared slots (except a resident slot, which
  // is only ever reached from its own declaration entry), so no chaining.
  const remapped = structuredClone(declaration);
  const remap = (value: unknown): number | undefined =>
    typeof value === "number" && mapping[value] !== undefined ? mapping[value] : undefined;
  for (const sample of remapped.samples ?? []) {
    const next = remap(sample.slot);
    if (next !== undefined) sample.slot = next;
  }
  for (const pattern of remapped.patterns ?? []) {
    for (const track of Object.values(pattern.tracks ?? {})) {
      for (const params of Object.values(track.plocks ?? {})) {
        const next = remap(params.sample_number);
        if (next !== undefined) params.sample_number = next;
      }
    }
    for (const op of pattern.plocks ?? []) {
      if (op.parameter !== "sample_number") continue;
      const next = remap(op.value);
      if (next !== undefined) op.value = next;
    }
  }
  for (const ops of [remapped.kit, ...(remapped.kits ?? []).map((entry) => entry.ops)]) {
    for (const op of ops ?? []) {
      const next = remap(op.slot);
      if (next !== undefined) op.slot = next;
    }
  }

  return { conflicts, freeSlots: pool, mapping, declaration: remapped };
}

const FREE_SLOTS_SHOWN = 24;

// Conflict report for the abort path: what occupies each declared slot, what it
// would have become, and the free pool to re-declare into. Only ever reached
// with nothing applied — either without --auto-slots, or with at least one
// conflict --auto-slots cannot resolve.
function writeSlotConflictReport(plan: SampleSlotPlan): void {
  const lines = [`RAM slot conflicts (${plan.conflicts.length}) — nothing applied:`];
  for (const conflict of plan.conflicts) {
    const cause =
      conflict.reason === "resident-elsewhere"
        ? `${conflict.expectedPath} is already loaded in RAM slot ${conflict.residentSlot}`
        : conflict.reason === "unknown-slot"
          ? "not present in the RAM inventory (out of range?)"
          : `occupied by ${conflict.occupiedBy ?? "an unresolved sample"}${conflict.usedByTrack ? " (used by a track)" : ""}`;
    const target = conflict.remapTo !== undefined ? `would remap to ${conflict.remapTo}` : "NO FREE SLOT";
    lines.push(`  slot ${conflict.slot} ${conflict.file}: ${cause} -> ${target}`);
  }
  const shown = plan.freeSlots.slice(0, FREE_SLOTS_SHOWN);
  lines.push(`  free slots (${shown.length} of ${plan.freeSlots.length}): ${shown.join(", ") || "none"}`);
  lines.push(
    plan.conflicts.some((conflict) => conflict.remapTo === undefined)
      ? "fix: --auto-slots cannot resolve every conflict — free RAM (samples.clear_ram) or re-declare the listed slots"
      : "fix: re-declare the listed slots, or re-run with --auto-slots to remap them automatically",
  );
  process.stderr.write(`${lines.join("\n")}\n`);
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
  assert.ok(declarationPath, "usage: build-project.ts <declaration.json> [--execute] [--auto-slots]");
  const execute = process.argv.includes("--execute");
  const autoSlots = process.argv.includes("--auto-slots");
  // Reassigned by the RAM-slot preflight under --auto-slots (remapped copy).
  let declaration = JSON.parse(readFileSync(declarationPath, "utf8")) as Declaration;

  const client = new RustDaemonClient({
    command: "cargo",
    args: ["run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve", "--adapter", "hardware", "--clock-source", "observed"],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    requestTimeoutMs: 600_000,
  });
  try {
    const health = await client.start();
    assert.equal(health.adapter, "hardware");

    // RAM-slot preflight, before the baseline snapshot and every batch:
    // samples.inspect is read-only, so it runs in validate-only mode too. A
    // conflict the run cannot resolve aborts here, with nothing applied.
    if (declaration.samples?.length) {
      const declaredCount = declaration.samples.length;
      const inventory = await client.inspectSamples({});
      const plan = planSampleSlots(declaration, inventory.ram.slots);
      const unresolved = plan.conflicts.filter((conflict) => conflict.remapTo === undefined);
      if (plan.conflicts.length > 0 && (!autoSlots || unresolved.length > 0)) {
        writeSlotConflictReport(plan);
        process.exitCode = 1;
        return;
      }
      if (autoSlots) {
        declaration = plan.declaration;
        const slotMap = Object.fromEntries((declaration.samples ?? []).map((sample) => [sample.file, sample.slot]));
        process.stdout.write(`${JSON.stringify({ slotMap })}\n`);
      }
      process.stderr.write(
        `ram preflight: ${declaredCount} declared slots, ${plan.conflicts.length} remapped, ${plan.freeSlots.length} free\n`,
      );
    }

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
    // Indexed kits (each an independent stored kit object). Applied per-kit so a
    // readback failure names the kit; work-buffer sections above are untouched.
    for (const entry of declaration.kits ?? []) {
      const operations = kitOperations(entry);
      if (operations.length) await applyBatch(client, `kit-${entry.kit}`, operations, execute);
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
        if (sample.track === undefined) {
          process.stderr.write(`sample ${sample.file} -> RAM ${resolved.slot} (unassigned; sample_number p-locks)\n`);
          continue;
        }
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
