import { readFileSync } from "node:fs";
import { gridOperations, songOperations, soundOperations } from "./build-project.ts";
import type { PatternDecl, SongDecl } from "./build-project.ts";
import { validatePersistentOperation } from "../domain/validation.ts";
import type { RytmCapabilities, RytmPersistentOperation } from "../domain/types.ts";

// Offline declaration linter for the declarative Rytm project builder. Checks a
// declaration (or a vault content fragment) against the authoring contract AND
// against the daemon's op-level validation, without starting the daemon:
//
//   npm run lint:declaration -- <file.json> [--fragment patterns|kit-scenes]
//
// Accepted shapes (auto-detected when --fragment is omitted):
//   - full declaration object   ({ project, patterns, sounds?, kit?, ... })
//   - bare pattern array        (a bank fragment, e.g. bank-a.json)
//   - kit-scenes fragment       ({ sounds?, kit?, scenes?, performances?, song? })
//
// Layer 1 (declaration/style contract) validates the authored JSON: key
// hygiene, slot/name shapes, grid alphabet and page lengths, per-track length,
// and that every 1-based step map (conditions/microtiming/plocks/retrigs)
// lands on a trigged step inside the grid (trigless locks are unverified on
// this bridge). Layer 2 compiles the declaration through build-project.ts's
// pure functions and validates every emitted op offline: the TS validation
// surface plus mirrors of the daemon's per-parameter p-lock table and trig
// condition set (sources of truth noted inline below).

export interface LintFinding {
  severity: "error" | "warning";
  section: string;
  message: string;
}

const CANONICAL_TRACKS = ["BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CY", "CH", "OH", "CB"] as const;
const PATTERN_SLOT = /^[A-H](0[1-9]|1[0-6])$/;
const GRID_LENGTHS = new Set([16, 32, 48, 64]);
const PATTERN_KEYS = new Set(["slot", "name", "clear", "tracks", "plocks"]);
const TRACK_KEYS = new Set(["grid", "condition", "conditions", "length", "microtiming", "retrigs", "plocks"]);
const SOUND_KEYS = new Set(["machine", "machineParams", "sample", "filter", "amp", "lfo", "settings"]);
const DECLARATION_KEYS = new Set([
  "project", "machines", "patterns", "sounds", "kit", "scenes", "performances", "song", "samples", "sampleDirectory",
]);

// Trig condition strings the daemon accepts. Mirror of rytm-rs f2e8143
// `TryFrom<&str> for TrigCondition` (the daemon parses set_trig conditions with
// it after `swap_fill_condition`, which only swaps within this set) and
// consistent with src/domain/validation.ts assertSafeAtom.
const CONDITION_PERCENTS = [1, 3, 4, 6, 9, 13, 19, 25, 33, 41, 50, 59, 67, 75, 81, 87, 91, 94, 96, 98, 99, 100];
const CONDITIONS = new Set<string>([
  ...CONDITION_PERCENTS.map((percent) => `${percent}%`),
  "fill", "fillnot", "pre", "prenot", "nei", "neinot", "1st", "1stnot", "unset",
]);
for (let base = 2; base <= 8; base += 1) {
  for (let numerator = 1; numerator <= base; numerator += 1) CONDITIONS.add(`${numerator}:${base}`);
}

// The 33-parameter p-lock surface. Mirror of daemon/src/state.rs
// `parameter_lock_value_spec` (~line 2368) — that function is the source of
// truth for names and ranges; update this table when it changes. Enum variant
// lists mirror the serde variant identifiers of the rytm-rs f2e8143 enums the
// daemon deserializes via `parse_enum` (FilterType, LfoMultiplier,
// LfoWaveform, LfoMode, LfoDestination in object/sound/types.rs) — exact
// CamelCase spellings, `Hp1` not `hp1`.
type PlockSpec =
  | { kind: "unsigned"; minimum: number; maximum: number }
  | { kind: "signed"; minimum: number; maximum: number }
  | { kind: "float"; minimum: number; maximum: number }
  | { kind: "boolean" }
  | { kind: "enum"; variants: readonly string[] };

const LFO_DESTINATIONS = [
  "Unset", "Syn1", "Syn2", "Syn3", "Syn4", "Syn5", "Syn6", "Syn7", "Syn8",
  "SampleTune", "SampleFineTune", "SampleSlice", "SampleBitReduction",
  "SampleStart", "SampleEnd", "SampleLoop", "SampleLevel",
  "FilterEnvelope", "FilterAttack", "FilterDecay", "FilterSustain", "FilterRelease",
  "FilterFrequency", "FilterResonance",
  "AmpAttack", "AmpHold", "AmpDecay", "AmpOverdrive", "AmpVolume", "AmpPan",
  "AmpAccent", "AmpDelaySend", "AmpReverbSend",
] as const;

const unsigned127: PlockSpec = { kind: "unsigned", minimum: 0, maximum: 127 };
const signed64: PlockSpec = { kind: "signed", minimum: -64, maximum: 63 };
export const PLOCK_SPECS: Record<string, PlockSpec> = {
  filter_attack: unsigned127,
  filter_sustain: unsigned127,
  filter_decay: unsigned127,
  filter_release: unsigned127,
  filter_frequency: unsigned127,
  filter_cutoff: unsigned127,
  filter_resonance: unsigned127,
  filter_envelope: signed64,
  filter_type: { kind: "enum", variants: ["Lp2", "Lp1", "Bp", "Hp1", "Hp2", "Bs", "Pk"] },
  amp_attack: unsigned127,
  amp_hold: unsigned127,
  amp_decay: unsigned127,
  amp_overdrive: unsigned127,
  amp_delay_send: unsigned127,
  amp_reverb_send: unsigned127,
  amp_volume: unsigned127,
  amp_pan: signed64,
  lfo_speed: signed64,
  lfo_fade: signed64,
  lfo_phase: unsigned127,
  lfo_depth: { kind: "float", minimum: -128, maximum: 127.99 },
  lfo_multiplier: {
    kind: "enum",
    variants: [
      "X1", "X2", "X4", "X8", "X16", "X32", "X64", "X128", "X256", "X512", "X1k", "X2k",
      "_D1", "_D2", "_D4", "_D8", "_D16", "_D32", "_D64", "_D128", "_D256", "_D512", "_D1k", "_D2k",
    ],
  },
  lfo_waveform: { kind: "enum", variants: ["Tri", "Sin", "Sqr", "Saw", "Exp", "Rmp", "Rnd"] },
  lfo_mode: { kind: "enum", variants: ["Free", "Trig", "Hold", "One", "Half"] },
  lfo_destination: { kind: "enum", variants: LFO_DESTINATIONS },
  sample_tune: { kind: "signed", minimum: -24, maximum: 24 },
  sample_fine_tune: signed64,
  sample_number: unsigned127,
  sample_bit_reduction: unsigned127,
  sample_level: unsigned127,
  sample_start: { kind: "float", minimum: 0, maximum: 120 },
  sample_end: { kind: "float", minimum: 0, maximum: 120 },
  sample_loop: { kind: "boolean" },
};

// Field surface of the daemon's PersistentOperation enum (state.rs, serde
// tag="type" + rename camelCase + deny_unknown_fields). Used to shape-check
// raw op passthrough sections (kit/scenes/performances/pattern.plocks) that
// the builder forwards verbatim.
const OPERATION_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  set_trig: { required: ["track", "step"], optional: ["pattern", "velocity", "microTiming", "condition", "retrig"] },
  clear_trig: { required: ["track", "step"], optional: ["pattern"] },
  set_parameter_lock: { required: ["track", "step", "parameter", "value"], optional: ["pattern"] },
  clear_parameter_lock: { required: ["track", "step", "parameter"], optional: ["pattern"] },
  set_track_length: { required: ["track", "steps"], optional: ["pattern"] },
  set_track_machine: { required: ["track", "machine"], optional: ["pattern"] },
  copy_pattern: { required: ["sourcePattern", "targetPattern"], optional: [] },
  set_kit_parameter: { required: ["parameter", "value"], optional: ["track"] },
  set_sound_parameter: { required: ["track", "page", "parameter", "value"], optional: [] },
  set_fx_parameter: { required: ["effect", "parameter", "value"], optional: [] },
  set_global_parameter: { required: ["section", "parameter", "value"], optional: ["track"] },
  assign_sample_slot: { required: ["track", "slot", "sampleId"], optional: ["pattern"] },
  set_scene_lock: { required: ["scene", "track", "parameter", "value"], optional: [] },
  replace_scene: { required: ["scene", "locks"], optional: [] },
  clear_scene: { required: ["scene"], optional: [] },
  copy_scene: { required: ["sourceScene", "targetScene"], optional: [] },
  set_performance_lock: { required: ["performance", "track", "parameter", "depth"], optional: [] },
  replace_performance: { required: ["performance", "locks"], optional: [] },
  clear_performance: { required: ["performance"], optional: [] },
  copy_performance: { required: ["sourcePerformance", "targetPerformance"], optional: [] },
  set_song_name: { required: ["name"], optional: ["target"] },
  replace_song: { required: ["rows"], optional: ["target", "name"] },
  insert_song_row: { required: ["row", "value"], optional: ["target"] },
  update_song_row: { required: ["row", "value"], optional: ["target"] },
  move_song_row: { required: ["sourceRow", "targetRow"], optional: ["target"] },
  copy_song_row: { required: ["sourceRow", "targetRow"], optional: ["target"] },
  remove_song_row: { required: ["row"], optional: ["target"] },
  clear_song: { required: [], optional: ["target"] },
};

// All capabilities on: the linter checks content, not device capability gates.
const ALL_CAPABILITIES: RytmCapabilities = {
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

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

function plockValueMessage(parameter: string, value: unknown): string | undefined {
  const spec = PLOCK_SPECS[parameter];
  if (!spec) {
    return `unknown p-lock parameter "${parameter}" (33 supported filter_*/amp_*/lfo_*/sample_* names; see parameter_lock_value_spec in daemon/src/state.rs)`;
  }
  switch (spec.kind) {
    case "unsigned":
    case "signed":
      if (typeof value !== "number" || !Number.isInteger(value) || value < spec.minimum || value > spec.maximum) {
        return `${parameter} must be an integer between ${spec.minimum} and ${spec.maximum}, got ${JSON.stringify(value)}`;
      }
      return undefined;
    case "float":
      if (typeof value !== "number" || !Number.isFinite(value) || value < spec.minimum || value > spec.maximum) {
        return `${parameter} must be a finite number between ${spec.minimum} and ${spec.maximum}, got ${JSON.stringify(value)}`;
      }
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${parameter} must be a boolean, got ${JSON.stringify(value)}`;
    case "enum": {
      if (typeof value === "string" && spec.variants.includes(value)) return undefined;
      const casing = typeof value === "string"
        ? spec.variants.find((variant) => variant.toLowerCase() === value.toLowerCase())
        : undefined;
      const hint = casing ? ` (did you mean "${casing}"? enum variants are exact-case serde names)` : "";
      return `${parameter} must be one of ${spec.variants.join(", ")}, got ${JSON.stringify(value)}${hint}`;
    }
  }
}

function conditionMessage(condition: unknown): string | undefined {
  if (typeof condition !== "string" || !CONDITIONS.has(condition)) {
    return `condition ${JSON.stringify(condition)} is not an accepted trig condition (percent like "50%", ratio like "3:4", or fill/fillnot/pre/prenot/nei/neinot/1st/1stnot/unset; see TrigCondition in rytm-rs)`;
  }
  return undefined;
}

// Shape-checks a raw (passthrough) op against the daemon serde surface, then
// runs the TS validation for range/id checks. Returns findings with `context`
// prefixed to every message.
function lintRawOperation(section: string, context: string, op: unknown): LintFinding[] {
  const findings: LintFinding[] = [];
  const error = (message: string) => findings.push({ severity: "error", section, message: `${context}: ${message}` });
  if (!isRecord(op)) {
    error("operation must be a JSON object");
    return findings;
  }
  const type = op.type;
  if (typeof type !== "string" || !(type in OPERATION_FIELDS)) {
    error(`unknown operation type ${JSON.stringify(type)} (must be one of the daemon's snake_case PersistentOperation tags)`);
    return findings;
  }
  const fields = OPERATION_FIELDS[type];
  for (const key of fields.required) {
    if (op[key] === undefined) error(`${type} is missing required field "${key}"`);
  }
  for (const key of Object.keys(op)) {
    if (key !== "type" && !fields.required.includes(key) && !fields.optional.includes(key)) {
      error(`${type} has unknown field "${key}" (the daemon rejects unknown fields)`);
    }
  }
  if (findings.length > 0) return findings;
  findings.push(...lintCompiledOperation(section, context, op as unknown as RytmPersistentOperation));
  return findings;
}

// Validates one already-well-shaped op: the TS validation surface plus the
// mirrored p-lock table and condition set. `lengths` powers the inaudible-step
// warning for tracks with a declared length shorter than the grid.
function lintCompiledOperation(
  section: string,
  context: string,
  op: RytmPersistentOperation,
  lengths?: Map<string, number>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  try {
    validatePersistentOperation(op, ALL_CAPABILITIES);
  } catch (caught) {
    findings.push({
      severity: "error",
      section,
      message: `${context}: ${caught instanceof Error ? caught.message : String(caught)}`,
    });
  }
  if (op.type === "set_trig" && op.condition !== undefined) {
    const message = conditionMessage(op.condition);
    if (message) findings.push({ severity: "error", section, message: `${context}: ${message}` });
  }
  if (op.type === "set_parameter_lock") {
    const message = plockValueMessage(op.parameter, op.value);
    if (message) findings.push({ severity: "error", section, message: `${context}: ${message}` });
  }
  if ((op.type === "set_trig" || op.type === "set_parameter_lock") && lengths !== undefined) {
    const length = lengths.get(op.track);
    if (length !== undefined && op.step >= length) {
      findings.push({
        severity: "warning",
        section,
        message: `${context}: step ${op.step + 1} is beyond ${op.track} length ${length} — trig is inaudible`,
      });
    }
  }
  return findings;
}

// Layer-1 checks for one per-step map (conditions/microtiming/plocks): keys
// must be 1-based integers inside the stripped grid, landing on trigged steps.
function lintStepKeys(
  section: string,
  track: string,
  label: string,
  map: Rec,
  gridLength: number,
  trigged: Set<number>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const key of Object.keys(map)) {
    const step = Number(key);
    if (!Number.isInteger(step) || step < 1 || String(step) !== key) {
      findings.push({ severity: "error", section, message: `${track}.${label}["${key}"]: step keys must be 1-based integer strings` });
    } else if (step > gridLength) {
      findings.push({ severity: "error", section, message: `${track}.${label}["${key}"]: step ${step} is outside the ${gridLength}-step grid` });
    } else if (!trigged.has(step)) {
      findings.push({ severity: "error", section, message: `${track}.${label}["${key}"]: step ${step} is not trigged — ${label} must land on trigged steps (trigless locks are unverified)` });
    }
  }
  return findings;
}

export function lintPattern(pattern: unknown, index: number): LintFinding[] {
  const findings: LintFinding[] = [];
  const fallback = `pattern[${index}]`;
  if (!isRecord(pattern)) {
    return [{ severity: "error", section: fallback, message: "pattern entry must be a JSON object" }];
  }
  const slot = typeof pattern.slot === "string" ? pattern.slot : undefined;
  const section = slot !== undefined ? `pattern ${slot}` : fallback;
  const error = (message: string) => findings.push({ severity: "error", section, message });
  const warn = (message: string) => findings.push({ severity: "warning", section, message });

  for (const key of Object.keys(pattern)) {
    if (!PATTERN_KEYS.has(key)) error(`unknown pattern key "${key}"`);
  }
  if (slot === undefined || !PATTERN_SLOT.test(slot)) {
    error(`slot must match A01-H16, got ${JSON.stringify(pattern.slot)}`);
  }
  if (typeof pattern.name !== "string") error("name is required and must be a string");
  else if (pattern.name.length > 15) error(`name "${pattern.name}" is ${pattern.name.length} chars (max 15)`);
  if (pattern.clear !== true) warn("clear: true is missing — legacy steps in this slot will survive the rebuild");

  if (!isRecord(pattern.tracks)) {
    error("tracks is required and must be an object");
    return findings;
  }

  const declared = Object.keys(pattern.tracks);
  const unknownTracks = declared.filter((track) => !(CANONICAL_TRACKS as readonly string[]).includes(track));
  for (const track of unknownTracks) error(`unknown track "${track}" (tracks are ${CANONICAL_TRACKS.join(" ")})`);
  const missing = CANONICAL_TRACKS.filter((track) => !declared.includes(track));
  if (missing.length > 0) warn(`declares ${declared.length - unknownTracks.length}/12 canonical tracks — missing ${missing.join(" ")} (declare all 12, all-dots for silent, for deterministic rebuilds)`);

  const lengths = new Map<string, number>();
  let compilable = true;
  for (const [track, decl] of Object.entries(pattern.tracks)) {
    if (!isRecord(decl)) {
      error(`${track}: track declaration must be an object`);
      compilable = false;
      continue;
    }
    for (const key of Object.keys(decl)) {
      if (!TRACK_KEYS.has(key)) error(`${track}: unknown track key "${key}"`);
    }
    if (typeof decl.grid !== "string") {
      error(`${track}: grid is required and must be a string`);
      compilable = false;
      continue;
    }
    const grid = decl.grid.replace(/\s+/g, "");
    const badChars = [...new Set([...grid].filter((symbol) => !"Xxo.".includes(symbol)))];
    if (badChars.length > 0) error(`${track}: grid contains invalid characters ${badChars.map((c) => JSON.stringify(c)).join(" ")} (only X x o . allowed)`);
    if (!GRID_LENGTHS.has(grid.length)) error(`${track}: grid is ${grid.length} steps after space-stripping (must be 16, 32, 48, or 64)`);

    if (decl.length === undefined) {
      warn(`${track}: no explicit length — declare length (1..64) per track`);
    } else if (typeof decl.length !== "number" || !Number.isInteger(decl.length) || decl.length < 1 || decl.length > 64) {
      error(`${track}: length must be an integer between 1 and 64, got ${JSON.stringify(decl.length)}`);
    } else {
      lengths.set(track, decl.length);
    }

    const trigged = new Set<number>();
    for (let position = 0; position < grid.length; position += 1) {
      if (grid[position] !== ".") trigged.add(position + 1);
    }

    if (decl.conditions !== undefined) {
      if (!isRecord(decl.conditions)) error(`${track}: conditions must be an object of 1-based steps`);
      else findings.push(...lintStepKeys(section, track, "conditions", decl.conditions, grid.length, trigged));
    }
    if ((decl.condition !== undefined || decl.conditions !== undefined) && trigged.size === 0) {
      warn(`${track}: condition declared but the grid has no trigged steps — it never emits`);
    }
    if (decl.microtiming !== undefined) {
      if (!isRecord(decl.microtiming)) error(`${track}: microtiming must be an object of 1-based steps`);
      else {
        findings.push(...lintStepKeys(section, track, "microtiming", decl.microtiming, grid.length, trigged));
        for (const [key, value] of Object.entries(decl.microtiming)) {
          if (typeof value !== "number" || !Number.isInteger(value) || value < -24 || value > 24) {
            error(`${track}.microtiming["${key}"]: must be an integer between -24 and 24, got ${JSON.stringify(value)}`);
          }
        }
      }
    }
    if (decl.retrigs !== undefined) {
      if (!Array.isArray(decl.retrigs) || decl.retrigs.some((step) => typeof step !== "number" || !Number.isInteger(step))) {
        error(`${track}: retrigs must be an array of 1-based integer steps`);
      } else {
        for (const step of decl.retrigs as number[]) {
          if (step < 1 || step > grid.length) error(`${track}.retrigs: step ${step} is outside the ${grid.length}-step grid`);
          else if (!trigged.has(step)) error(`${track}.retrigs: step ${step} is not trigged — retrigs must land on trigged steps`);
        }
      }
    }
    if (decl.plocks !== undefined) {
      if (!isRecord(decl.plocks)) {
        error(`${track}: plocks must be an object of 1-based steps`);
        compilable = false;
      } else {
        findings.push(...lintStepKeys(section, track, "plocks", decl.plocks, grid.length, trigged));
        for (const [key, params] of Object.entries(decl.plocks)) {
          if (!isRecord(params)) {
            error(`${track}.plocks["${key}"]: must be an object of parameter -> value`);
            compilable = false;
          }
        }
      }
    }
  }
  if (pattern.plocks !== undefined && !Array.isArray(pattern.plocks)) {
    error("pattern.plocks (raw op passthrough) must be an array");
    compilable = false;
  }

  // Layer 2: compile through the builder's pure function and validate every op.
  if (!compilable || slot === undefined || !PATTERN_SLOT.test(slot)) return findings;
  const rawCount = Array.isArray(pattern.plocks) ? pattern.plocks.length : 0;
  const operations = gridOperations(pattern as unknown as PatternDecl);
  operations.forEach((op, position) => {
    const context = `op[${position}] ${op.type}${"track" in op ? ` ${(op as { track: string }).track}` : ""}${"step" in op ? ` step ${(op as { step: number }).step + 1}` : ""}`;
    if (position >= operations.length - rawCount) {
      findings.push(...lintRawOperation(section, context, op)); // raw passthrough: full serde shape check
    } else {
      findings.push(...lintCompiledOperation(section, context, op, lengths));
    }
  });
  return findings;
}

export function lintPatterns(patterns: unknown): LintFinding[] {
  if (!Array.isArray(patterns)) {
    return [{ severity: "error", section: "patterns", message: "patterns fragment must be a JSON array of pattern objects" }];
  }
  const findings = patterns.flatMap((pattern, index) => lintPattern(pattern, index));
  const slots = patterns.filter(isRecord).map((pattern) => pattern.slot).filter((slot) => typeof slot === "string");
  for (const slot of new Set(slots.filter((slot, index) => slots.indexOf(slot) !== index))) {
    findings.push({ severity: "error", section: `pattern ${slot}`, message: "duplicate slot declared" });
  }
  return findings;
}

function lintSounds(sounds: unknown): LintFinding[] {
  const section = "sounds";
  if (!isRecord(sounds)) return [{ severity: "error", section, message: "sounds must be an object keyed by track" }];
  const findings: LintFinding[] = [];
  for (const [track, decl] of Object.entries(sounds)) {
    if (!(CANONICAL_TRACKS as readonly string[]).includes(track)) {
      findings.push({ severity: "error", section, message: `unknown track "${track}"` });
    }
    if (!isRecord(decl)) {
      findings.push({ severity: "error", section, message: `${track}: sound declaration must be an object` });
      continue;
    }
    for (const key of Object.keys(decl)) {
      if (!SOUND_KEYS.has(key)) findings.push({ severity: "error", section, message: `${track}: unknown sound key "${key}"` });
    }
  }
  if (findings.length > 0) return findings;
  const operations = soundOperations(sounds as Parameters<typeof soundOperations>[0]);
  operations.forEach((op, position) => {
    const parameter = isRecord(op) && "parameter" in op ? ` ${(op as Rec).parameter}` : "";
    findings.push(...lintCompiledOperation(section, `op[${position}] ${op.type}${parameter}`, op));
  });
  return findings;
}

function lintRawSection(section: string, ops: unknown): LintFinding[] {
  if (!Array.isArray(ops)) return [{ severity: "error", section, message: `${section} must be an array of raw operations` }];
  return ops.flatMap((op, position) => {
    const type = isRecord(op) && typeof op.type === "string" ? ` ${op.type}` : "";
    return lintRawOperation(section, `op[${position}]${type}`, op);
  });
}

function lintSong(song: unknown): LintFinding[] {
  const section = "song";
  if (!isRecord(song)) return [{ severity: "error", section, message: "song must be an object with rows" }];
  const findings: LintFinding[] = [];
  if (song.name !== undefined && (typeof song.name !== "string" || song.name.length > 15)) {
    findings.push({ severity: "error", section, message: `song name must be a string of at most 15 characters, got ${JSON.stringify(song.name)}` });
  }
  if (!Array.isArray(song.rows)) {
    findings.push({ severity: "error", section, message: "song.rows must be an array" });
    return findings;
  }
  song.rows.forEach((row, index) => {
    if (!isRecord(row)) {
      findings.push({ severity: "error", section, message: `rows[${index}]: must be an object` });
      return;
    }
    if (typeof row.pattern !== "string") {
      findings.push({ severity: "error", section, message: `rows[${index}]: missing required "pattern" slot` });
    }
    for (const key of Object.keys(row)) {
      if (!["pattern", "repeats", "mutes"].includes(key)) {
        findings.push({ severity: "error", section, message: `rows[${index}]: unknown key "${key}"` });
      }
    }
  });
  if (findings.length > 0) return findings;
  const operations = songOperations(song as unknown as SongDecl);
  operations.forEach((op, position) => {
    findings.push(...lintCompiledOperation(section, `op[${position}] ${op.type}`, op));
  });
  return findings;
}

export function lintKitScenes(fragment: unknown): LintFinding[] {
  if (!isRecord(fragment)) {
    return [{ severity: "error", section: "kit-scenes", message: "kit-scenes fragment must be a JSON object" }];
  }
  const findings: LintFinding[] = [];
  for (const key of Object.keys(fragment)) {
    if (!["sounds", "kit", "scenes", "performances", "song"].includes(key)) {
      findings.push({ severity: "warning", section: "kit-scenes", message: `unknown fragment key "${key}"` });
    }
  }
  if (fragment.sounds !== undefined) findings.push(...lintSounds(fragment.sounds));
  if (fragment.kit !== undefined) findings.push(...lintRawSection("kit", fragment.kit));
  if (fragment.scenes !== undefined) findings.push(...lintRawSection("scenes", fragment.scenes));
  if (fragment.performances !== undefined) findings.push(...lintRawSection("performances", fragment.performances));
  if (fragment.song !== undefined) findings.push(...lintSong(fragment.song));
  return findings;
}

export function lintDeclaration(declaration: unknown): LintFinding[] {
  if (!isRecord(declaration)) {
    return [{ severity: "error", section: "declaration", message: "declaration must be a JSON object" }];
  }
  const findings: LintFinding[] = [];
  for (const key of Object.keys(declaration)) {
    if (!DECLARATION_KEYS.has(key)) {
      findings.push({ severity: "warning", section: "declaration", message: `unknown top-level key "${key}"` });
    }
  }
  if (typeof declaration.project !== "string") {
    findings.push({ severity: "error", section: "declaration", message: "project name is required" });
  }
  if (declaration.machines !== undefined) {
    if (!Array.isArray(declaration.machines)) {
      findings.push({ severity: "error", section: "machines", message: "machines must be an array" });
    } else {
      declaration.machines.forEach((entry, index) => {
        findings.push(...lintRawOperation("machines", `machines[${index}]`, { type: "set_track_machine", ...(isRecord(entry) ? entry : {}) }));
      });
    }
  }
  findings.push(...lintPatterns(declaration.patterns));
  findings.push(...lintKitScenes({
    ...(declaration.sounds !== undefined ? { sounds: declaration.sounds } : {}),
    ...(declaration.kit !== undefined ? { kit: declaration.kit } : {}),
    ...(declaration.scenes !== undefined ? { scenes: declaration.scenes } : {}),
    ...(declaration.performances !== undefined ? { performances: declaration.performances } : {}),
    ...(declaration.song !== undefined ? { song: declaration.song } : {}),
  }));
  return findings;
}

export type FragmentShape = "declaration" | "patterns" | "kit-scenes";

export function detectShape(input: unknown): FragmentShape {
  if (Array.isArray(input)) return "patterns";
  if (isRecord(input) && Array.isArray(input.patterns)) return "declaration";
  if (isRecord(input) && ["sounds", "kit", "scenes", "performances", "song"].some((key) => key in input)) return "kit-scenes";
  throw new Error("cannot auto-detect shape: expected a pattern array, a full declaration, or a kit-scenes fragment (pass --fragment)");
}

export function lintInput(input: unknown, fragment?: FragmentShape): { shape: FragmentShape; findings: LintFinding[] } {
  const shape = fragment ?? detectShape(input);
  const raw = shape === "patterns" ? lintPatterns(input) : shape === "kit-scenes" ? lintKitScenes(input) : lintDeclaration(input);
  const seen = new Set<string>();
  const findings = raw.filter((finding) => {
    const key = `${finding.severity}|${finding.section}|${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { shape, findings };
}

export function formatReport(label: string, shape: FragmentShape, findings: LintFinding[]): string {
  const lines: string[] = [`${label} (${shape})`];
  const sections = [...new Set(findings.map((finding) => finding.section))];
  for (const section of sections) {
    lines.push(`  ${section}`);
    for (const finding of findings.filter((entry) => entry.section === section)) {
      lines.push(`    ${finding.severity === "error" ? "ERROR" : "WARN "} ${finding.message}`);
    }
  }
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  lines.push(errors + warnings === 0 ? "  clean: no findings" : `  ${errors} error(s), ${warnings} warning(s)`);
  return lines.join("\n");
}

function runLint(): void {
  const args = process.argv.slice(2);
  const fragmentIndex = args.indexOf("--fragment");
  let fragment: FragmentShape | undefined;
  if (fragmentIndex !== -1) {
    const value = args[fragmentIndex + 1];
    if (value !== "patterns" && value !== "kit-scenes") {
      process.stderr.write("usage: lint-declaration.ts <file.json> [--fragment patterns|kit-scenes]\n");
      process.exitCode = 2;
      return;
    }
    fragment = value;
    args.splice(fragmentIndex, 2);
  }
  const path = args[0];
  if (!path) {
    process.stderr.write("usage: lint-declaration.ts <file.json> [--fragment patterns|kit-scenes]\n");
    process.exitCode = 2;
    return;
  }
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  const { shape, findings } = lintInput(input, fragment);
  process.stdout.write(`${formatReport(path, shape, findings)}\n`);
  if (findings.some((finding) => finding.severity === "error")) process.exitCode = 1;
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) runLint();
