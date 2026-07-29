import assert from "node:assert/strict";
import test from "node:test";
import { gridOperations, kitOperations, kitsOperations, planSampleSlots, sampleDevicePath, songOperations, soundOperations } from "../src/bin/build-project.ts";
import type { Declaration, RamSlotView } from "../src/bin/build-project.ts";
import { collectOperationValidation } from "../src/domain/validation.ts";
import type { RytmCapabilities, RytmPersistentOperation } from "../src/domain/types.ts";

const capabilities: RytmCapabilities = {
  realtimeMidi: true,
  sysExState: true,
  patternEdit: true,
  kitEdit: true,
  machineEdit: true,
  sampleSlotAssignment: true,
  sampleTransfer: true,
  sceneMacros: true,
  performanceMacros: true,
  songs: true,
  classCompliantAudio: true,
  overbridgeAudio: true,
};

// Narrow helpers so the tests can read fields off the emitted union members.
const setTrigs = (ops: RytmPersistentOperation[]) => ops.filter((op) => op.type === "set_trig");
const plockOps = (ops: RytmPersistentOperation[]) => ops.filter((op) => op.type === "set_parameter_lock");

test("microtiming and retrig merge into the matching trigged step's set_trig", () => {
  // grid "X..x": trigs at index 0 (X=120) and index 3 (x=96); microtiming keyed
  // 1-based ("1","4"); retrig on 1-based step 4 (== index 3) only.
  const ops = gridOperations({
    slot: "A01",
    name: "merge",
    tracks: { BD: { grid: "X..x", microtiming: { "1": -6, "4": 12 }, retrigs: [4] } },
  });
  const trigs = setTrigs(ops) as Array<Extract<RytmPersistentOperation, { type: "set_trig" }>>;
  assert.equal(trigs.length, 2);

  const step0 = trigs.find((op) => op.step === 0)!;
  assert.equal(step0.velocity, 120);
  assert.equal(step0.microTiming, -6);
  assert.equal(step0.retrig, undefined); // step 1 is not in retrigs

  const step3 = trigs.find((op) => op.step === 3)!;
  assert.equal(step3.velocity, 96);
  assert.equal(step3.microTiming, 12);
  assert.equal(step3.retrig, true);
});

test("velocities override the grid symbol's velocity for the matching step's set_trig", () => {
  const ops = gridOperations({
    slot: "A05",
    name: "vel",
    tracks: { SD: { grid: "x..o x..o", velocities: { "1": 127, "4": 20 } } },
  });
  const trigs = setTrigs(ops) as Array<Extract<RytmPersistentOperation, { type: "set_trig" }>>;
  // step 1 (grid 'x' -> default 96) overridden to 127; step 4 (grid 'o' -> 40) to 20.
  assert.equal(trigs.find((op) => op.step === 0)!.velocity, 127);
  assert.equal(trigs.find((op) => op.step === 3)!.velocity, 20);
  // step 5 ('x') keeps the grid-symbol default (no override).
  assert.equal(trigs.find((op) => op.step === 4)!.velocity, 96);
});

test("plock sugar emits set_parameter_lock with 1-based key -> 0-based step, after all trigs", () => {
  const ops = gridOperations({
    slot: "B02",
    name: "sugar",
    tracks: {
      SD: {
        grid: "x...x...x...x...", // trigs at 0,4,8,12
        plocks: { "1": { filter_cutoff: 40, sample_tune: -12 }, "9": { lfo_depth: 96 } },
      },
    },
  });
  const locks = plockOps(ops) as Array<Extract<RytmPersistentOperation, { type: "set_parameter_lock" }>>;
  assert.equal(locks.length, 3);

  // 1-based "1" -> step 0, "9" -> step 8.
  const cutoff = locks.find((op) => op.parameter === "filter_cutoff")!;
  assert.equal(cutoff.step, 0);
  assert.equal(cutoff.value, 40);
  assert.equal(cutoff.pattern, "B02");
  assert.equal(locks.find((op) => op.parameter === "sample_tune")!.step, 0);
  assert.equal(locks.find((op) => op.parameter === "sample_tune")!.value, -12);
  const depth = locks.find((op) => op.parameter === "lfo_depth")!;
  assert.equal(depth.step, 8);
  assert.equal(depth.value, 96);

  // Emission order: every plock op comes after every set_trig op.
  const lastTrig = ops.map((op) => op.type).lastIndexOf("set_trig");
  const firstLock = ops.map((op) => op.type).indexOf("set_parameter_lock");
  assert.ok(firstLock > lastTrig, "plock ops must follow all set_trig ops");
});

test("clear:true emits clear_pattern_plocks first, then clear_trig for '.' positions before each track's set_trigs", () => {
  const ops = gridOperations({
    slot: "C03",
    name: "clear",
    clear: true,
    tracks: { BD: { grid: "X." }, SD: { grid: ".X" } },
  });
  // Pool-rebuild purge is the FIRST op of the pattern batch: the declaration's
  // locks are the complete intended set, so the p-lock pool is rebuilt from
  // scratch (also retires legacy zero-fill ghosts / orphaned companions).
  assert.deepEqual(ops[0], { type: "clear_pattern_plocks", pattern: "C03" });
  // Then per-track grouping: BD clears+trigs, then SD clears+trigs.
  assert.deepEqual(
    ops.slice(1).map((op) => [op.type, (op as { track: string }).track, (op as { step: number }).step]),
    [
      ["clear_trig", "BD", 1], // BD '.' at index 1
      ["set_trig", "BD", 0], // BD 'X' at index 0
      ["clear_trig", "SD", 0], // SD '.' at index 0
      ["set_trig", "SD", 1], // SD 'X' at index 1
    ],
  );
});

test("without clear, no clear_trig or clear_pattern_plocks ops are emitted", () => {
  const ops = gridOperations({ slot: "A04", name: "noclear", tracks: { BD: { grid: "X..." } } });
  assert.equal(ops.filter((op) => op.type === "clear_trig").length, 0);
  assert.equal(ops.filter((op) => op.type === "clear_pattern_plocks").length, 0);
});

test("track length and raw pattern.plocks passthrough are preserved and ordered last", () => {
  const ops = gridOperations({
    slot: "A01",
    name: "tail",
    tracks: { BD: { grid: "X...", length: 12, plocks: { "1": { filter_cutoff: 50 } } } },
    plocks: [{ type: "set_parameter_lock", track: "BD", step: 0, parameter: "amp_volume", value: 100 }],
  });
  const length = ops.find((op) => op.type === "set_track_length") as Extract<RytmPersistentOperation, { type: "set_track_length" }>;
  assert.equal(length.steps, 12);
  assert.equal(length.track, "BD");

  // Raw passthrough is last and gets the pattern slot merged in.
  const last = ops[ops.length - 1] as Extract<RytmPersistentOperation, { type: "set_parameter_lock" }>;
  assert.equal(last.type, "set_parameter_lock");
  assert.equal(last.parameter, "amp_volume");
  assert.equal(last.pattern, "A01");
});

test("songOperations emits clear_song, set_song_name, then insert_song_row per row (0-based index)", () => {
  const ops = songOperations({
    name: "MOONSHOT",
    rows: [{ pattern: "A01", repeats: 2, mutes: ["BD"] }, { pattern: "A02" }],
  });
  assert.deepEqual(ops, [
    { type: "clear_song" },
    { type: "set_song_name", name: "MOONSHOT" },
    { type: "insert_song_row", row: 0, value: { patterns: [{ pattern: "A01", mutedTracks: ["BD"] }], repeats: 2 } },
    { type: "insert_song_row", row: 1, value: { patterns: [{ pattern: "A02", mutedTracks: [] }], repeats: 1 } },
  ]);
});

test("songOperations omits set_song_name when unnamed", () => {
  const ops = songOperations({ rows: [{ pattern: "A01" }] });
  assert.equal(ops.filter((op) => op.type === "set_song_name").length, 0);
  assert.equal(ops[0].type, "clear_song");
  assert.equal(ops[1].type, "insert_song_row");
});

test("emitted pattern + song ops pass the daemon TS validation surface", () => {
  // Realistic combined output exercises microTiming/retrig/plock/clear/length + song rows.
  const patternOps = gridOperations({
    slot: "C11",
    name: "escape",
    clear: true,
    tracks: {
      BD: {
        grid: "X...x...X...x...",
        length: 16,
        condition: "50%",
        conditions: { "5": "75%" },
        microtiming: { "5": -6 },
        retrigs: [13],
        plocks: { "1": { filter_cutoff: 40, sample_number: 3 }, "9": { lfo_depth: 96 } },
      },
    },
  });
  const songOps = songOperations({ name: "MOONSHOT", rows: [{ pattern: "C11", repeats: 4, mutes: ["OH"] }] });
  const result = collectOperationValidation([...patternOps, ...songOps], capabilities);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("soundOperations still emits machine selection before its params", () => {
  const ops = soundOperations({ BD: { machine: "bdhard", machineParams: { tun: -4 }, filter: { cutoff: 90 } } });
  const machineIndex = ops.findIndex((op) => op.type === "set_track_machine");
  const paramIndex = ops.findIndex((op) => op.type === "set_sound_parameter" && op.page === "machine");
  assert.ok(machineIndex >= 0 && paramIndex > machineIndex, "machine selection precedes its params");
});

test("pattern kit emits set_pattern_kit after clear_pattern_plocks and before any trig", () => {
  const ops = gridOperations({
    slot: "E01",
    name: "ambient",
    clear: true,
    kit: 2,
    tracks: { BD: { grid: "X..." } },
  });
  // clear_pattern_plocks stays first; set_pattern_kit is second (before trig ops).
  assert.deepEqual(ops[0], { type: "clear_pattern_plocks", pattern: "E01" });
  assert.deepEqual(ops[1], { type: "set_pattern_kit", pattern: "E01", kit: 2 });
  const kitIndex = ops.findIndex((op) => op.type === "set_pattern_kit");
  const firstTrig = ops.findIndex((op) => op.type === "set_trig");
  assert.ok(kitIndex >= 0 && kitIndex < firstTrig, "set_pattern_kit precedes the first set_trig");
});

test("a pattern without kit emits no set_pattern_kit", () => {
  const ops = gridOperations({ slot: "A01", name: "x", tracks: { BD: { grid: "X..." } } });
  assert.equal(ops.filter((op) => op.type === "set_pattern_kit").length, 0);
});

test("kitsOperations stamps the 1-based kit into every emitted op and validates clean", () => {
  const ops = kitsOperations([
    {
      kit: 2,
      sounds: { BD: { machine: "bdhard", filter: { cutoff: 90 } } },
      ops: [{ type: "set_kit_parameter", track: "BD", parameter: "track_level", value: 100 }],
      scenes: [{ type: "replace_scene", scene: 1, locks: [{ track: "FX", parameter: "delay_time", value: 64 }] }],
      performances: [{ type: "clear_performance", performance: 1 }],
    },
    { kit: 5, ops: [{ type: "set_fx_parameter", effect: "reverb", parameter: "decay", value: 44 }] },
  ]);
  // Every op carries the entry's kit; kit-2 ops precede kit-5 ops.
  assert.ok(ops.every((op) => "kit" in op), "every op is stamped with kit");
  const kits = ops.map((op) => (op as { kit: number }).kit);
  assert.deepEqual([...new Set(kits)], [2, 5]);
  // Machine selection still precedes its params, both stamped kit 2.
  const machine = ops.find((op) => op.type === "set_track_machine") as { kit: number };
  assert.equal(machine.kit, 2);
  // The stamped ops pass the daemon TS validation surface.
  const result = collectOperationValidation(ops, capabilities);
  assert.deepEqual(result.errors, []);
});

// --- RAM-slot preflight (planSampleSlots) --------------------------------
// Device RAM inventory as samples.inspect reports it: slots 1..capacity, the
// ones named in `occupied` holding that device path, everything else free.
const ramInventory = (occupied: Record<number, string>, capacity = 8): RamSlotView[] =>
  Array.from({ length: capacity }, (_, index) => {
    const slot = index + 1;
    const devicePath = occupied[slot];
    return devicePath === undefined
      ? { slot, occupied: false, usedByTrack: false }
      : { slot, occupied: true, devicePath, sampleId: `sample-${slot}`, usedByTrack: false };
  });

// Two declared samples (slots 4 and 6), a sample_number p-lock per declared
// slot, one p-lock on external material (slot 2), and an assign_sample_slot kit
// op on each of a declared and an external slot.
const slotDeclaration = (): Declaration => ({
  project: "basilica",
  sampleDirectory: "/tmp/samples",
  samples: [
    { file: "bd-kick-a.wav", track: "BD", slot: 4 },
    { file: "wall-lumen.wav", slot: 6 },
  ],
  kit: [
    { type: "assign_sample_slot", track: "CH", slot: 6, sampleId: "sample-ours" },
    { type: "assign_sample_slot", track: "CB", slot: 2, sampleId: "sample-external" },
  ],
  patterns: [
    {
      slot: "A01",
      name: "preflight",
      tracks: {
        BD: { grid: "X...", plocks: { "1": { sample_number: 4, filter_cutoff: 40 } } },
        CH: { grid: "X...", plocks: { "1": { sample_number: 6 } } },
        CB: { grid: "X...", plocks: { "1": { sample_number: 2 } } }, // external material
      },
      plocks: [{ type: "set_parameter_lock", track: "BD", step: 2, parameter: "sample_number", value: 6 }],
    },
  ],
});

const declaredSlots = (plan: { declaration: Declaration }) => (plan.declaration.samples ?? []).map((sample) => sample.slot);
const plockValue = (plan: { declaration: Declaration }, track: string) =>
  plan.declaration.patterns[0]?.tracks[track]?.plocks?.["1"]?.sample_number;
const kitSlots = (plan: { declaration: Declaration }) => (plan.declaration.kit ?? []).map((op) => op.slot);

test("sampleDevicePath joins the project directory with the file stem (daemon upload contract)", () => {
  assert.equal(sampleDevicePath("basilica", "bd-kick-a.wav"), "/basilica/bd-kick-a");
  assert.equal(sampleDevicePath("basilica", "nested/dir/oh-hat.wav"), "/basilica/oh-hat");
  assert.equal(sampleDevicePath("basilica", "no-extension"), "/basilica/no-extension");
});

test("planSampleSlots leaves an all-free declaration untouched", () => {
  const declaration = slotDeclaration();
  const plan = planSampleSlots(declaration, ramInventory({}));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.mapping, {});
  // Declared slots are excluded from the assignable pool.
  assert.deepEqual(plan.freeSlots, [1, 2, 3, 5, 7, 8]);
  assert.deepEqual(plan.declaration, declaration);
});

test("planSampleSlots treats a slot holding our own device path as ours, and is idempotent", () => {
  const declaration = slotDeclaration();
  const ram = ramInventory({ 4: "/basilica/bd-kick-a", 6: "/basilica/wall-lumen" });
  const plan = planSampleSlots(declaration, ram);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.mapping, {});
  assert.deepEqual(declaredSlots(plan), [4, 6]);
  // Replanning the returned declaration against the same RAM is a no-op.
  const replan = planSampleSlots(plan.declaration, ram);
  assert.deepEqual(replan.conflicts, []);
  assert.deepEqual(replan.declaration, plan.declaration);
});

test("planSampleSlots remaps an occupied declared slot to the lowest free slot and follows it through p-locks and kit ops", () => {
  const declaration = slotDeclaration();
  // Slot 4 is foreign material; slots 1 and 2 are also occupied, so the lowest
  // free slot outside the declaration is 3.
  const plan = planSampleSlots(
    declaration,
    ramInventory({ 1: "/techno-sessions/1-a", 2: "/techno-sessions/2-b", 4: "/techno-sessions/40-silt-breath-swell" }),
  );
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.conflicts[0], {
    file: "bd-kick-a.wav",
    slot: 4,
    expectedPath: "/basilica/bd-kick-a",
    reason: "occupied",
    occupiedBy: "/techno-sessions/40-silt-breath-swell",
    sampleId: "sample-4",
    usedByTrack: false,
    remapTo: 3,
  });
  assert.deepEqual(plan.mapping, { 4: 3 });
  assert.deepEqual(declaredSlots(plan), [3, 6]); // 4 -> 3, 6 untouched
  assert.equal(plockValue(plan, "BD"), 3); // sample_number p-lock follows the remap
  assert.equal(plan.declaration.patterns[0]?.tracks.BD?.plocks?.["1"]?.filter_cutoff, 40); // siblings survive
  assert.equal(plockValue(plan, "CH"), 6); // unremapped declared slot untouched
  assert.deepEqual(kitSlots(plan), [6, 2]); // no kit op referenced slot 4
  // The input declaration is never mutated.
  assert.deepEqual(declaration, slotDeclaration());
});

test("planSampleSlots rewrites the raw pattern.plocks passthrough and kit op slots that reference a remapped slot", () => {
  const declaration = slotDeclaration();
  const plan = planSampleSlots(declaration, ramInventory({ 6: "/techno-sessions/6-c" }));
  assert.deepEqual(plan.mapping, { 6: 1 }); // slot 1 is the lowest free non-declared slot
  assert.deepEqual(declaredSlots(plan), [4, 1]);
  assert.equal(plockValue(plan, "CH"), 1);
  // Raw passthrough op with parameter "sample_number" follows the remap...
  assert.equal(plan.declaration.patterns[0]?.plocks?.[0]?.value, 1);
  // ...as does the kit's assign_sample_slot for the declared slot, while the
  // external one (slot 2) is left alone.
  assert.deepEqual(kitSlots(plan), [1, 2]);
});

test("planSampleSlots leaves p-lock slots outside the declared samples untouched", () => {
  // Slot 2 is external material (occupied, never declared) and slot 4 is ours.
  const plan = planSampleSlots(
    slotDeclaration(),
    ramInventory({ 2: "/techno-sessions/2-external", 6: "/techno-sessions/6-c" }),
  );
  assert.deepEqual(Object.keys(plan.mapping), ["6"]);
  assert.equal(plockValue(plan, "CB"), 2); // external p-lock target unchanged
  assert.equal(plockValue(plan, "BD"), 4); // free declared slot unchanged
  assert.ok(!plan.freeSlots.includes(2), "an occupied slot never enters the free pool");
});

test("planSampleSlots reports a conflict with no remap target when the free pool is exhausted", () => {
  // Every slot but the two declared ones is occupied, and both declared slots
  // hold foreign content: nothing can be remapped.
  const plan = planSampleSlots(
    slotDeclaration(),
    ramInventory(Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, `/full/${index + 1}`]))),
  );
  assert.deepEqual(plan.freeSlots, []);
  assert.equal(plan.conflicts.length, 2);
  assert.deepEqual(plan.conflicts.map((conflict) => conflict.remapTo), [undefined, undefined]);
  assert.deepEqual(plan.mapping, {});
  assert.deepEqual(declaredSlots(plan), [4, 6]); // nothing rewritten
});

test("planSampleSlots remaps onto the slot our content already occupies (resolve_ram matches by device path)", () => {
  // Declared slot 4 is foreign, but bd-kick-a is already loaded at slot 7:
  // resolve_ram would refuse slot 4, so the plan follows RAM instead of the
  // free pool (which keeps repeated --auto-slots runs idempotent).
  const plan = planSampleSlots(
    slotDeclaration(),
    ramInventory({ 4: "/techno-sessions/40-silt-breath-swell", 7: "/basilica/bd-kick-a" }),
  );
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0]?.reason, "resident-elsewhere");
  assert.equal(plan.conflicts[0]?.residentSlot, 7);
  assert.deepEqual(plan.mapping, { 4: 7 });
  assert.deepEqual(declaredSlots(plan), [7, 6]);
  assert.equal(plockValue(plan, "BD"), 7);
});

test("planSampleSlots refuses to auto-remap a declared slot the RAM inventory does not report", () => {
  const declaration = slotDeclaration();
  declaration.samples = [{ file: "bd-kick-a.wav", slot: 200 }];
  const plan = planSampleSlots(declaration, ramInventory({}));
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0]?.reason, "unknown-slot");
  assert.equal(plan.conflicts[0]?.remapTo, undefined);
  assert.deepEqual(plan.mapping, {});
});

test("planSampleSlots is a no-op for a declaration without a samples section", () => {
  const declaration: Declaration = { project: "empty", patterns: [{ slot: "A01", name: "x", tracks: { BD: { grid: "X..." } } }] };
  const plan = planSampleSlots(declaration, ramInventory({ 1: "/other/thing" }));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.mapping, {});
  assert.deepEqual(plan.declaration, declaration);
});

test("kitOperations emits sounds then ops then scenes then performances", () => {
  const ops = kitOperations({
    kit: 3,
    sounds: { BD: { machine: "bdhard" } },
    ops: [{ type: "set_kit_parameter", track: "BD", parameter: "track_level", value: 90 }],
    scenes: [{ type: "clear_scene", scene: 1 }],
    performances: [{ type: "clear_performance", performance: 1 }],
  });
  assert.deepEqual(
    ops.map((op) => op.type),
    ["set_track_machine", "set_kit_parameter", "clear_scene", "clear_performance"],
  );
  assert.ok(ops.every((op) => (op as { kit: number }).kit === 3));
});
