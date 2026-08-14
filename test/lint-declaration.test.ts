import assert from "node:assert/strict";
import test from "node:test";
import { detectShape, lintDeclaration, lintInput, lintKits, lintKitScenes, lintPatterns, lintSamples } from "../src/bin/lint-declaration.ts";
import type { LintFinding } from "../src/bin/lint-declaration.ts";

// A contract-clean pattern: all 12 canonical tracks, explicit lengths,
// clear: true. The lint helpers below mutate a fresh copy per test.
function cleanPattern(): Record<string, unknown> {
  const silent = { grid: ".... .... .... ....", length: 16 };
  return {
    slot: "A01",
    name: "launch-pad",
    clear: true,
    tracks: {
      BD: {
        grid: "X... X... X... X...",
        length: 16,
        conditions: { "5": "75%" },
        microtiming: { "9": -6 },
        retrigs: [13],
        plocks: { "1": { filter_cutoff: 40, filter_type: "Hp1" } },
      },
      SD: { ...silent },
      RS: { ...silent },
      CP: { ...silent },
      BT: { ...silent },
      LT: { ...silent },
      MT: { ...silent },
      HT: { ...silent },
      CY: { ...silent },
      CH: { grid: "x.x. x.x. x.x. x.x.", length: 16, condition: "50%" },
      OH: { ...silent },
      CB: { ...silent },
    },
  };
}

const errors = (findings: LintFinding[]) => findings.filter((finding) => finding.severity === "error");
const warnings = (findings: LintFinding[]) => findings.filter((finding) => finding.severity === "warning");
const track = (pattern: Record<string, unknown>, name: string) =>
  (pattern.tracks as Record<string, Record<string, unknown>>)[name];

test("a clean minimal pattern passes with no findings", () => {
  const findings = lintPatterns([cleanPattern()]);
  assert.deepEqual(findings, []);
});

test("unknown track-level key is an error", () => {
  const pattern = cleanPattern();
  track(pattern, "BD").swing = 54;
  const found = errors(lintPatterns([pattern]));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /unknown track key "swing"/);
  assert.equal(found[0].section, "pattern A01");
});

test("unknown pattern-level key is an error", () => {
  const pattern = cleanPattern();
  pattern.tempo = 132;
  assert.match(errors(lintPatterns([pattern]))[0].message, /unknown pattern key "tempo"/);
});

test("p-lock value out of range is an error", () => {
  const pattern = cleanPattern();
  track(pattern, "BD").plocks = { "1": { filter_cutoff: 300 } };
  const found = errors(lintPatterns([pattern]));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /filter_cutoff must be an integer between 0 and 127/);
});

test("unknown p-lock parameter is an error pointing at the spec table", () => {
  const pattern = cleanPattern();
  track(pattern, "BD").plocks = { "1": { filter_cutof: 40 } };
  const found = errors(lintPatterns([pattern]));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /unknown p-lock parameter "filter_cutof"/);
  assert.match(found[0].message, /parameter_lock_value_spec/);
});

test("bad enum casing is an error with an exact-variant hint", () => {
  const pattern = cleanPattern();
  track(pattern, "BD").plocks = { "1": { filter_type: "hp1" } };
  const found = errors(lintPatterns([pattern]));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /did you mean "Hp1"/);
});

test("condition string typo is an error (per-step and whole-track)", () => {
  const perStep = cleanPattern();
  track(perStep, "BD").conditions = { "1": "51%" };
  assert.match(errors(lintPatterns([perStep]))[0].message, /"51%" is not an accepted trig condition/);

  const wholeTrack = cleanPattern();
  track(wholeTrack, "CH").condition = "FILL";
  assert.match(errors(lintPatterns([wholeTrack]))[0].message, /"FILL" is not an accepted trig condition/);
});

test("a per-step velocities override on trigged steps lints clean", () => {
  const pattern = cleanPattern();
  track(pattern, "BD").velocities = { "1": 127, "5": 64 }; // both trigged steps
  assert.deepEqual(lintPatterns([pattern]), []);
});

test("velocities on an untrigged step is an error; out-of-range value too", () => {
  const untrigged = cleanPattern();
  track(untrigged, "BD").velocities = { "2": 100 }; // step 2 is '.'
  const found = errors(lintPatterns([untrigged]));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /velocities\["2"\]: step 2 is not trigged/);

  const range = cleanPattern();
  track(range, "BD").velocities = { "1": 200 };
  assert.match(errors(lintPatterns([range]))[0].message, /velocities\["1"\]: must be an integer between 1 and 127/);

  const zero = cleanPattern();
  track(zero, "BD").velocities = { "1": 0 };
  assert.match(errors(lintPatterns([zero]))[0].message, /between 1 and 127/);
});

test("microtiming on an untrigged step is an error; out-of-range is too", () => {
  const untrigged = cleanPattern();
  track(untrigged, "BD").microtiming = { "2": -6 }; // step 2 is '.'
  const found = errors(lintPatterns([untrigged]));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /microtiming\["2"\]: step 2 is not trigged/);

  const range = cleanPattern();
  track(range, "BD").microtiming = { "1": -30 };
  assert.match(errors(lintPatterns([range]))[0].message, /between -24 and 24/);
});

test("retrig outside the grid is an error; on an untrigged step too", () => {
  const outside = cleanPattern();
  track(outside, "BD").retrigs = [17];
  assert.match(errors(lintPatterns([outside]))[0].message, /retrigs: step 17 is outside the 16-step grid/);

  const untrigged = cleanPattern();
  track(untrigged, "BD").retrigs = [2];
  assert.match(errors(lintPatterns([untrigged]))[0].message, /retrigs: step 2 is not trigged/);
});

test("invalid grid characters and grid length are errors", () => {
  const chars = cleanPattern();
  track(chars, "BD").grid = "X..q X... X... X..!";
  const found = errors(lintPatterns([chars]));
  assert.match(found.map((entry) => entry.message).join("\n"), /grid contains invalid characters/);

  const length = cleanPattern();
  track(length, "BD").grid = "X... X... X... X... X..."; // 20 steps
  assert.match(errors(lintPatterns([length]))[0].message, /20 steps after space-stripping/);
});

test("declaring a subset of the canonical 12 tracks is a warning, wrong names an error", () => {
  const subset = cleanPattern();
  delete (subset.tracks as Record<string, unknown>).CB;
  const subsetFindings = lintPatterns([subset]);
  assert.equal(errors(subsetFindings).length, 0);
  assert.match(warnings(subsetFindings)[0].message, /missing CB/);

  const wrong = cleanPattern();
  (wrong.tracks as Record<string, unknown>).KD = { grid: ".... .... .... ....", length: 16 };
  assert.match(errors(lintPatterns([wrong]))[0].message, /unknown track "KD"/);
});

test("bad slot and long name are errors; missing clear is a warning", () => {
  const pattern = cleanPattern();
  pattern.slot = "A17";
  pattern.name = "way-too-long-pattern-name";
  delete pattern.clear;
  const findings = lintPatterns([pattern]);
  const messages = errors(findings).map((entry) => entry.message).join("\n");
  assert.match(messages, /slot must match A01-H16/);
  assert.match(messages, /max 15/);
  assert.match(warnings(findings).map((entry) => entry.message).join("\n"), /clear: true is missing/);
});

test("trigged step at or beyond the declared track length is a warning, not an error", () => {
  const pattern = cleanPattern();
  track(pattern, "CH").length = 12; // grid has trigs at 13 and 15 (1-based)
  const findings = lintPatterns([pattern]);
  assert.equal(errors(findings).length, 0);
  const inaudible = warnings(findings).filter((entry) => entry.message.includes("inaudible"));
  assert.equal(inaudible.length, 2);
  assert.match(inaudible[0].message, /beyond CH length 12/);
});

test("song row missing its pattern slot is an error", () => {
  const findings = lintKitScenes({ song: { name: "MOONSHOT", rows: [{ repeats: 2 }] } });
  const found = errors(findings);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /rows\[0\]: missing required "pattern" slot/);
});

test("kit-scenes fragment validates raw ops, scenes, performances, and sounds", () => {
  const findings = lintKitScenes({
    sounds: { BD: { machine: "bdhard", machineParams: { tun: -4 } } },
    kit: [{ type: "set_kit_parameter", track: "BD", parameter: "track_level", value: 100 }],
    scenes: [{ type: "set_scene_lock", scene: 1, track: "FX", parameter: "delay_time", value: 64 }],
    performances: [{ type: "set_performance_lock", performance: 1, track: "BD", parameter: "filter_cutoff", depth: -32 }],
    song: { name: "MOONSHOT", rows: [{ pattern: "A01", repeats: 2, mutes: ["BD"] }] },
  });
  assert.deepEqual(findings, []);
});

test("raw ops with unknown type, missing fields, or unknown fields are errors", () => {
  const findings = errors(
    lintKitScenes({
      kit: [
        { type: "set_kit_parametr", parameter: "track_level", value: 100 },
        { type: "set_kit_parameter", track: "BD" },
        { type: "set_scene_lock", scene: 13, track: "ZZ", parameter: "delay_time", value: 400, bogus: 1 },
      ],
    }),
  );
  const messages = findings.map((entry) => entry.message).join("\n");
  assert.match(messages, /unknown operation type "set_kit_parametr"/);
  assert.match(messages, /missing required field "parameter"/);
  assert.match(messages, /missing required field "value"/);
  assert.match(messages, /unknown field "bogus"/);
});

test("shape auto-detection: array, full declaration, kit-scenes fragment", () => {
  assert.equal(detectShape([cleanPattern()]), "patterns");
  assert.equal(detectShape({ project: "moonshot", patterns: [cleanPattern()] }), "declaration");
  assert.equal(detectShape({ song: { rows: [] } }), "kit-scenes");
  assert.throws(() => detectShape({ nothing: true }), /cannot auto-detect shape/);
});

test("a full declaration lints patterns and sections together", () => {
  const { shape, findings } = lintInput({
    project: "moonshot",
    patterns: [cleanPattern()],
    song: { name: "MOONSHOT", rows: [{ pattern: "A01" }] },
  });
  assert.equal(shape, "declaration");
  assert.deepEqual(findings, []);
});

test("a pattern kit in range lints clean; out of range is an error", () => {
  const ok = cleanPattern();
  ok.kit = 2;
  assert.deepEqual(lintPatterns([ok]), []);

  const bad = cleanPattern();
  bad.kit = 200;
  assert.match(errors(lintPatterns([bad]))[0].message, /kit must be a 1-based integer between 1 and 128/);

  const fractional = cleanPattern();
  fractional.kit = 2.5;
  assert.match(errors(lintPatterns([fractional]))[0].message, /1-based integer between 1 and 128/);
});

test("a two-kit kits section compiles clean with correct shapes", () => {
  const findings = lintKits([
    {
      kit: 2,
      sounds: { BD: { machine: "bdhard", machineParams: { tun: -4 } } },
      ops: [{ type: "set_kit_parameter", track: "BD", parameter: "track_level", value: 100 }],
      scenes: [{ type: "replace_scene", scene: 1, locks: [{ track: "FX", parameter: "delay_time", value: 64 }] }],
      performances: [{ type: "clear_performance", performance: 1 }],
    },
    { kit: 3, ops: [{ type: "set_fx_parameter", effect: "reverb", parameter: "decay", value: 44 }] },
  ]);
  assert.deepEqual(findings, []);
});

test("kits section: bad range, duplicate index, and unknown key are errors", () => {
  assert.match(errors(lintKits([{ kit: 0 }]))[0].message, /between 1 and 128/);
  assert.match(
    errors(lintKits([{ kit: 2 }, { kit: 2 }])).map((entry) => entry.message).join("\n"),
    /duplicate kit 2/,
  );
  assert.match(errors(lintKits([{ kit: 2, bogus: 1 }]))[0].message, /unknown kit key "bogus"/);
});

test("a clean samples section lints with no findings", () => {
  const { findings } = lintSamples([
    { file: "bd-kick-a.wav", track: "BD", slot: 1 },
    { file: "rc-vox-dies.wav", slot: 127 },
  ]);
  assert.deepEqual(findings, []);
});

test("sample slot outside 1..127 is an error (mirrors daemon validate_ram_slot)", () => {
  const messages = (samples: unknown[]) =>
    errors(lintSamples(samples).findings).map((entry) => entry.message).join("\n");
  assert.match(messages([{ file: "a.wav", slot: 0 }]), /slot must be an integer between 1 and 127, got 0/);
  assert.match(messages([{ file: "a.wav", slot: 128 }]), /slot must be an integer between 1 and 127, got 128/);
  assert.match(messages([{ file: "a.wav", slot: 4.5 }]), /slot must be an integer between 1 and 127/);
  assert.match(messages([{ file: "a.wav" }]), /slot must be an integer between 1 and 127, got undefined/);
});

test("two samples declaring the same slot is an error", () => {
  const found = errors(lintSamples([
    { file: "a.wav", slot: 44 },
    { file: "b.wav", slot: 44 },
  ]).findings);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /"b.wav": slot 44 is already declared by "a.wav"/);
  assert.match(found[0].message, /silently dropped/);
});

test("a device-unsafe sample stem is an error; the extension is not part of it", () => {
  const messages = (file: string) =>
    errors(lintSamples([{ file, slot: 1 }]).findings).map((entry) => entry.message).join("\n");
  assert.match(messages("rc vox dies.wav"), /device name "rc vox dies" is not device-safe/);
  assert.match(messages("rc-vöx.wav"), /device name "rc-vöx" is not device-safe/);
  assert.match(messages(".hidden.wav"), /not device-safe/);
  assert.match(messages(`${"x".repeat(64)}.wav`), /is 64 bytes \(must be 1 to 63\)/);
  // A safe stem under a nested source directory, with dots in the name, is fine.
  assert.deepEqual(lintSamples([{ file: "packs/tm-909/01-bd.kick_a:1.wav", slot: 1 }]).findings, []);
});

test("a non-canonical samples[].track is an error", () => {
  const found = errors(lintSamples([{ file: "a.wav", track: "FX", slot: 1 }]).findings);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /track "FX" is not a canonical track/);
});

test("a sample_number p-lock on an undeclared slot is a warning, not an error", () => {
  const pattern = cleanPattern();
  track(pattern, "BD").plocks = { "1": { sample_number: 44 }, "5": { sample_number: 44 }, "9": { sample_number: 45 } };
  const declaration = {
    project: "basilica",
    samples: [{ file: "rc-vox-dies.wav", slot: 44 }],
    patterns: [pattern],
  };
  const findings = lintDeclaration(declaration);
  assert.deepEqual(errors(findings), []);
  const undeclared = warnings(findings).filter((entry) => entry.section === "samples");
  assert.equal(undeclared.length, 1); // slot 44 is declared; 45 is not
  assert.match(undeclared[0].message, /sample_number 45 \(A01 BD step 9\) is not declared by any samples\[\] entry/);

  // The raw pattern.plocks passthrough is covered too, and repeats collapse.
  const raw = cleanPattern();
  raw.plocks = [
    { type: "set_parameter_lock", track: "BD", step: 0, parameter: "sample_number", value: 60 },
    { type: "set_parameter_lock", track: "BD", step: 4, parameter: "sample_number", value: 60 },
  ];
  const rawFindings = lintDeclaration({ project: "basilica", samples: [], patterns: [raw] });
  const rawUndeclared = warnings(rawFindings).filter((entry) => entry.section === "samples");
  assert.equal(rawUndeclared.length, 1);
  assert.match(rawUndeclared[0].message, /sample_number 60 \(A01 plocks\[0\] and 1 more\)/);
});

test("a declaration whose samples cover every sample_number p-lock lints clean", () => {
  const pattern = cleanPattern();
  track(pattern, "BD").plocks = { "1": { sample_number: 94 } };
  const findings = lintDeclaration({
    project: "basilica",
    samples: [{ file: "bd-kick-a-t.wav", track: "BD", slot: 94 }],
    patterns: [pattern],
  });
  assert.deepEqual(findings, []);
});

test("samples must be an array", () => {
  const found = errors(lintDeclaration({ project: "p", samples: {}, patterns: [] }));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /samples must be an array of \{ file, slot, track\? \} entries/);
});

test("kits section: each kit gets its own 48+48 lock-pool budget", () => {
  // Two scenes of 30 distinct-target locks each = 60 total > 48, without
  // tripping the per-scene 48-lock cap or duplicate-target check.
  const locks = (offset: number) =>
    Array.from({ length: 30 }, (_, index) => ({ track: "FX", parameter: `delay_time_${offset + index}`, value: 64 }));
  const overBudget = lintKits([
    {
      kit: 2,
      scenes: [
        { type: "replace_scene", scene: 1, locks: locks(0) },
        { type: "replace_scene", scene: 2, locks: locks(100) },
      ],
    },
  ]);
  assert.match(
    errors(overBudget).map((entry) => entry.message).join("\n"),
    /scene lock pool uses 60 locks, over the per-kit budget of 48/,
  );

  // The identical shape on separate kits stays within each kit's own budget.
  const perKit = lintKits([
    { kit: 2, scenes: [{ type: "replace_scene", scene: 1, locks: locks(0) }] },
    { kit: 3, scenes: [{ type: "replace_scene", scene: 1, locks: locks(0) }] },
  ]);
  assert.deepEqual(errors(perKit), []);
});
