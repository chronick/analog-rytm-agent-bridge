import type {
  RytmApplyAt,
  RytmCapabilities,
  RytmChangePatternInput,
  RytmLiveParameterInput,
  RytmMacroTrackId,
  RytmOperationSetInput,
  RytmPerformanceLockInput,
  RytmPersistentOperation,
  RytmSceneLockInput,
  RytmSetActiveSceneInput,
  RytmSetPerformanceMacroInput,
  RytmSetTransportInput,
  RytmSongRowInput,
  RytmSongTarget,
  RytmSnapshotInput,
  RytmTrackId,
  RytmTriggerTrackInput,
  RytmValidationResult,
} from "./types.ts";

const safeId = /^[A-Za-z0-9_.-]+$/;
const safeAtom = /^[^\s;]+$/;
const patternSlot = /^[A-H](0[1-9]|1[0-6])$/;
const trackIds = new Set<RytmTrackId>(["BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB"]);

export function assertSafeId(value: string, label: string): void {
  if (!safeId.test(value)) throw new Error(`${label} must contain only letters, numbers, underscore, dash, and dot: ${value}`);
}

export function assertSafeAtom(value: string, label: string): void {
  if (!safeAtom.test(value)) throw new Error(`${label} cannot contain whitespace or semicolons`);
}

export function assertPatternSlot(value: string, label = "pattern"): void {
  if (!patternSlot.test(value)) throw new Error(`${label} must be A01-H16: ${value}`);
}

export function assertTrackId(value: string, label = "track"): asserts value is RytmTrackId {
  if (!trackIds.has(value as RytmTrackId)) throw new Error(`${label} must be a Rytm track id`);
}

export function assertIntegerRange(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}

export function assertFiniteRange(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number between ${minimum} and ${maximum}`);
  }
}

export function validateApplyAt(applyAt: RytmApplyAt): void {
  if (applyAt.kind === "next_step" || applyAt.kind === "next_beat" || applyAt.kind === "next_measure" || applyAt.kind === "next_pattern") {
    if (applyAt.transportEpoch !== undefined) assertSafeId(applyAt.transportEpoch, "applyAt.transportEpoch");
    return;
  }
  if (applyAt.kind !== "pattern_step") throw new Error("unsupported applyAt kind");
  assertSafeId(applyAt.transportEpoch, "applyAt.transportEpoch");
  assertPatternSlot(applyAt.pattern, "applyAt.pattern");
  assertIntegerRange(applyAt.step, "applyAt.step", 0, 63);
}

export function validatePersistentOperation(operation: RytmPersistentOperation, capabilities: RytmCapabilities): void {
  switch (operation.type) {
    case "set_trig":
      requireCapability(capabilities.patternEdit, "patternEdit");
      validateTrackStep(operation.track, operation.step);
      if (operation.pattern) assertPatternSlot(operation.pattern);
      if (operation.velocity !== undefined) assertIntegerRange(operation.velocity, "velocity", 1, 127);
      if (operation.microTiming !== undefined) assertIntegerRange(operation.microTiming, "microTiming", -24, 24);
      if (operation.condition !== undefined) assertSafeAtom(operation.condition, "condition");
      return;

    case "clear_trig":
      requireCapability(capabilities.patternEdit, "patternEdit");
      validateTrackStep(operation.track, operation.step);
      if (operation.pattern) assertPatternSlot(operation.pattern);
      return;

    case "set_parameter_lock":
      requireCapability(capabilities.patternEdit, "patternEdit");
      validateTrackStep(operation.track, operation.step);
      if (operation.pattern) assertPatternSlot(operation.pattern);
      assertSafeId(operation.parameter, "parameter");
      // Full p-lock surface carries signed/float/bool/enum-string values; the
      // Rust daemon does the authoritative per-parameter range validation.
      assertControlValue(operation.value, "value");
      return;

    case "clear_parameter_lock":
      requireCapability(capabilities.patternEdit, "patternEdit");
      validateTrackStep(operation.track, operation.step);
      if (operation.pattern) assertPatternSlot(operation.pattern);
      assertSafeId(operation.parameter, "parameter");
      return;

    case "clear_pattern_plocks":
      requireCapability(capabilities.patternEdit, "patternEdit");
      if (operation.pattern) assertPatternSlot(operation.pattern);
      return;

    case "set_track_length":
      requireCapability(capabilities.patternEdit, "patternEdit");
      assertTrackId(operation.track);
      if (operation.pattern) assertPatternSlot(operation.pattern);
      assertIntegerRange(operation.steps, "steps", 1, 64);
      return;

    case "set_track_machine":
      requireCapability(capabilities.machineEdit, "machineEdit");
      assertTrackId(operation.track);
      if (operation.pattern) assertPatternSlot(operation.pattern);
      assertSafeId(operation.machine, "machine");
      assertOptionalKit(operation.kit);
      return;

    case "set_pattern_kit":
      requireCapability(capabilities.patternEdit, "patternEdit");
      if (operation.pattern) assertPatternSlot(operation.pattern);
      assertKit(operation.kit);
      return;

    case "copy_pattern":
      requireCapability(capabilities.patternEdit, "patternEdit");
      assertPatternSlot(operation.sourcePattern, "sourcePattern");
      assertPatternSlot(operation.targetPattern, "targetPattern");
      if (operation.sourcePattern === operation.targetPattern) throw new Error("copy_pattern source and target must differ");
      return;

    case "set_kit_parameter":
      requireCapability(capabilities.kitEdit, "kitEdit");
      if (operation.track) assertTrackId(operation.track);
      assertSafeId(operation.parameter, "parameter");
      assertControlValue(operation.value, "value");
      assertOptionalKit(operation.kit);
      return;

    case "set_sound_parameter":
      requireCapability(capabilities.kitEdit, "kitEdit");
      assertTrackId(operation.track);
      if (!["machine", "sample", "filter", "amp", "lfo", "settings"].includes(operation.page)) {
        throw new Error("unsupported Sound page");
      }
      assertSafeId(operation.parameter, "parameter");
      assertControlValue(operation.value, "value");
      assertOptionalKit(operation.kit);
      return;

    case "set_fx_parameter":
      requireCapability(capabilities.kitEdit, "kitEdit");
      if (!["delay", "reverb", "distortion", "compressor", "lfo"].includes(operation.effect)) {
        throw new Error("unsupported Kit FX effect");
      }
      assertSafeId(operation.parameter, "parameter");
      assertControlValue(operation.value, "value");
      assertOptionalKit(operation.kit);
      return;

    case "set_global_parameter":
      requireCapability(capabilities.sysExState, "sysExState");
      if (!["routing", "metronome", "midi_sync", "midi_port", "midi_channels", "sequencer", "settings"].includes(operation.section)) {
        throw new Error("unsupported Global section");
      }
      if (operation.track) assertTrackId(operation.track);
      assertSafeId(operation.parameter, "parameter");
      assertControlValue(operation.value, "value");
      return;

    case "assign_sample_slot":
      requireCapability(capabilities.sampleSlotAssignment, "sampleSlotAssignment");
      assertTrackId(operation.track);
      if (operation.pattern) assertPatternSlot(operation.pattern);
      assertIntegerRange(operation.slot, "slot", 0, 127);
      assertSafeId(operation.sampleId, "sampleId");
      assertOptionalKit(operation.kit);
      return;

    case "set_scene_lock":
      requireCapability(capabilities.sceneMacros, "sceneMacros");
      validateMacroId(operation.scene, "scene");
      validateSceneLock(operation);
      assertOptionalKit(operation.kit);
      return;

    case "replace_scene":
      requireCapability(capabilities.sceneMacros, "sceneMacros");
      validateMacroId(operation.scene, "scene");
      validateMacroLocks(operation.locks, validateSceneLock);
      assertOptionalKit(operation.kit);
      return;

    case "clear_scene":
      requireCapability(capabilities.sceneMacros, "sceneMacros");
      validateMacroId(operation.scene, "scene");
      assertOptionalKit(operation.kit);
      return;

    case "copy_scene":
      requireCapability(capabilities.sceneMacros, "sceneMacros");
      validateMacroId(operation.sourceScene, "sourceScene");
      validateMacroId(operation.targetScene, "targetScene");
      assertOptionalKit(operation.kit);
      if (operation.sourceScene === operation.targetScene) throw new Error("copy_scene source and target must differ");
      return;

    case "set_performance_lock":
      requireCapability(capabilities.performanceMacros, "performanceMacros");
      validateMacroId(operation.performance, "performance");
      validatePerformanceLock(operation);
      assertOptionalKit(operation.kit);
      return;

    case "replace_performance":
      requireCapability(capabilities.performanceMacros, "performanceMacros");
      validateMacroId(operation.performance, "performance");
      validateMacroLocks(operation.locks, validatePerformanceLock);
      assertOptionalKit(operation.kit);
      return;

    case "clear_performance":
      requireCapability(capabilities.performanceMacros, "performanceMacros");
      validateMacroId(operation.performance, "performance");
      assertOptionalKit(operation.kit);
      return;

    case "copy_performance":
      requireCapability(capabilities.performanceMacros, "performanceMacros");
      validateMacroId(operation.sourcePerformance, "sourcePerformance");
      validateMacroId(operation.targetPerformance, "targetPerformance");
      assertOptionalKit(operation.kit);
      if (operation.sourcePerformance === operation.targetPerformance) {
        throw new Error("copy_performance source and target must differ");
      }
      return;

    case "set_song_name":
      requireCapability(capabilities.songs, "songs");
      validateSongTarget(operation.target);
      validateSongName(operation.name);
      return;

    case "replace_song":
      requireCapability(capabilities.songs, "songs");
      validateSongTarget(operation.target);
      if (operation.name !== undefined) validateSongName(operation.name);
      validateSongRows(operation.rows);
      return;

    case "insert_song_row":
      requireCapability(capabilities.songs, "songs");
      validateSongTarget(operation.target);
      assertIntegerRange(operation.row, "row", 0, 64);
      validateSongRow(operation.value);
      return;

    case "update_song_row":
      requireCapability(capabilities.songs, "songs");
      validateSongTarget(operation.target);
      assertIntegerRange(operation.row, "row", 0, 63);
      validateSongRow(operation.value);
      return;

    case "move_song_row":
      requireCapability(capabilities.songs, "songs");
      validateSongTarget(operation.target);
      assertIntegerRange(operation.sourceRow, "sourceRow", 0, 63);
      assertIntegerRange(operation.targetRow, "targetRow", 0, 63);
      if (operation.sourceRow === operation.targetRow) throw new Error("move_song_row source and target must differ");
      return;

    case "copy_song_row":
      requireCapability(capabilities.songs, "songs");
      validateSongTarget(operation.target);
      assertIntegerRange(operation.sourceRow, "sourceRow", 0, 63);
      assertIntegerRange(operation.targetRow, "targetRow", 0, 64);
      return;

    case "remove_song_row":
      requireCapability(capabilities.songs, "songs");
      validateSongTarget(operation.target);
      assertIntegerRange(operation.row, "row", 0, 63);
      return;

    case "clear_song":
      requireCapability(capabilities.songs, "songs");
      validateSongTarget(operation.target);
      return;
  }
}

export function validateOperationSetInput(input: RytmOperationSetInput, capabilities: RytmCapabilities): void {
  if (input.operationSetId) assertSafeId(input.operationSetId, "operationSetId");
  assertIntegerRange(input.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER);
  validateApplyAt(input.applyAt);
  if (input.latePolicy !== "roll-forward" && input.latePolicy !== "reject") throw new Error("latePolicy must be roll-forward or reject");
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new Error("operation set must contain at least one operation");
  for (const operation of input.operations) validatePersistentOperation(operation, capabilities);
  validateSongOperationTargetConsistency(input.operations);
}

export function collectOperationValidation(
  operations: RytmPersistentOperation[],
  capabilities: RytmCapabilities,
): RytmValidationResult {
  const errors: string[] = [];
  for (const operation of operations) {
    try {
      validatePersistentOperation(operation, capabilities);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    validateSongOperationTargetConsistency(operations);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

export function validateLiveParameterInput(input: RytmLiveParameterInput, capabilities: RytmCapabilities): void {
  requireCapability(capabilities.realtimeMidi, "realtimeMidi");
  if (input.track) assertTrackId(input.track);
  assertSafeId(input.parameter, "parameter");
  assertFiniteRange(input.value, "value", 0, 127);
  if (input.lane !== undefined && input.lane !== "cc" && input.lane !== "nrpn") throw new Error("lane must be cc or nrpn");
}

export function validateSetActiveSceneInput(input: RytmSetActiveSceneInput, capabilities: RytmCapabilities): void {
  requireCapability(capabilities.realtimeMidi, "realtimeMidi");
  requireCapability(capabilities.sceneMacros, "sceneMacros");
  if (input.scene !== null) validateMacroId(input.scene, "scene");
  validateRealtimeLane(input.lane);
}

export function validateSetPerformanceMacroInput(
  input: RytmSetPerformanceMacroInput,
  capabilities: RytmCapabilities,
): void {
  requireCapability(capabilities.realtimeMidi, "realtimeMidi");
  requireCapability(capabilities.performanceMacros, "performanceMacros");
  validateMacroId(input.performance, "performance");
  assertIntegerRange(input.amount, "amount", 0, 127);
  validateRealtimeLane(input.lane);
}

export function validateTriggerTrackInput(input: RytmTriggerTrackInput, capabilities: RytmCapabilities): void {
  requireCapability(capabilities.realtimeMidi, "realtimeMidi");
  assertTrackId(input.track);
  if (input.velocity !== undefined) assertIntegerRange(input.velocity, "velocity", 1, 127);
  if (input.durationMs !== undefined) assertIntegerRange(input.durationMs, "durationMs", 1, 60_000);
}

export function validateSetTransportInput(input: RytmSetTransportInput, capabilities: RytmCapabilities): void {
  requireCapability(capabilities.realtimeMidi, "realtimeMidi");
  if (!["start", "stop", "continue"].includes(input.command)) throw new Error("command must be start, stop, or continue");
  if (input.tempo !== undefined) assertFiniteRange(input.tempo, "tempo", 30, 300);
}

export function validateChangePatternInput(input: RytmChangePatternInput, capabilities: RytmCapabilities): void {
  requireCapability(capabilities.realtimeMidi, "realtimeMidi");
  assertPatternSlot(input.pattern);
}

export function validateSnapshotInput(input: RytmSnapshotInput): void {
  if (input.snapshotId) assertSafeId(input.snapshotId, "snapshotId");
  if (input.label !== undefined && input.label.length > 80) throw new Error("label must be 80 characters or fewer");
}

function validateTrackStep(track: string, step: number): void {
  assertTrackId(track);
  assertIntegerRange(step, "step", 0, 63);
}

function validateMacroId(value: number, label: string): void {
  assertIntegerRange(value, label, 1, 12);
}

// A 1-based kit index (1..128); device index = kit - 1.
export function assertKit(value: number): void {
  assertIntegerRange(value, "kit", 1, 128);
}

function assertOptionalKit(kit: number | undefined): void {
  if (kit !== undefined) assertKit(kit);
}

function validateMacroTrack(track: RytmMacroTrackId): void {
  if (track !== "FX") assertTrackId(track, "macro track");
}

function validateSceneLock(lock: RytmSceneLockInput): void {
  validateMacroTrack(lock.track);
  assertSafeId(lock.parameter, "parameter");
  assertIntegerRange(lock.value, "value", 0, 127);
}

function validatePerformanceLock(lock: RytmPerformanceLockInput): void {
  validateMacroTrack(lock.track);
  assertSafeId(lock.parameter, "parameter");
  assertIntegerRange(lock.depth, "depth", -128, 127);
}

function validateMacroLocks<T extends RytmSceneLockInput | RytmPerformanceLockInput>(
  locks: T[],
  validate: (lock: T) => void,
): void {
  if (!Array.isArray(locks)) throw new Error("locks must be an array");
  if (locks.length > 48) throw new Error("a Kit has at most 48 locks per macro family");
  const targets = new Set<string>();
  for (const lock of locks) {
    validate(lock);
    const target = lock.track + "." + lock.parameter;
    if (targets.has(target)) throw new Error("macro locks contain duplicate target: " + target);
    targets.add(target);
  }
}

function validateSongTarget(target: RytmSongTarget | undefined): void {
  if (target === undefined || target.scope === "work_buffer") return;
  if (target.scope !== "stored") throw new Error("Song target scope must be work_buffer or stored");
  assertIntegerRange(target.song, "target.song", 1, 16);
}

function validateSongName(name: string): void {
  if (!/^[\x20-\x7E]{0,15}$/.test(name)) throw new Error("Song name must be at most 15 printable ASCII characters");
}

function validateSongRows(rows: RytmSongRowInput[]): void {
  if (!Array.isArray(rows)) throw new Error("Song rows must be an array");
  if (rows.length > 64) throw new Error("a Song has at most 64 rows");
  for (const row of rows) validateSongRow(row);
  const positions = rows.reduce((total, row) => total + row.patterns.length, 0);
  if (positions > 256) throw new Error("a Song has at most 256 pattern positions");
}

function validateSongRow(row: RytmSongRowInput): void {
  if (!Array.isArray(row.patterns) || row.patterns.length < 1 || row.patterns.length > 255) {
    throw new Error("a Song row must contain between 1 and 255 pattern positions");
  }
  assertIntegerRange(row.repeats, "repeats", 1, 256);
  for (const position of row.patterns) {
    assertPatternSlot(position.pattern, "Song pattern");
    if (position.mutedTracks === undefined) continue;
    if (!Array.isArray(position.mutedTracks)) throw new Error("mutedTracks must be an array");
    const unique = new Set<string>();
    for (const track of position.mutedTracks) {
      assertTrackId(track, "muted track");
      if (unique.has(track)) throw new Error(`mutedTracks contains duplicate track: ${track}`);
      unique.add(track);
    }
  }
}

function validateSongOperationTargetConsistency(operations: RytmPersistentOperation[]): void {
  const targets = new Set<string>();
  for (const operation of operations) {
    const target = songOperationTarget(operation);
    if (target === undefined) continue;
    targets.add(target.scope === "work_buffer" ? "work_buffer" : `stored:${target.song}`);
  }
  if (targets.size > 1) throw new Error("one operation set may edit only one Song target");
}

function songOperationTarget(operation: RytmPersistentOperation): RytmSongTarget | undefined {
  switch (operation.type) {
    case "set_song_name":
    case "replace_song":
    case "insert_song_row":
    case "update_song_row":
    case "move_song_row":
    case "copy_song_row":
    case "remove_song_row":
    case "clear_song":
      return operation.target ?? { scope: "work_buffer" };
    default:
      return undefined;
  }
}

function validateRealtimeLane(lane: "cc" | "nrpn" | undefined): void {
  if (lane !== undefined && lane !== "cc" && lane !== "nrpn") throw new Error("lane must be cc or nrpn");
}

function requireCapability(enabled: boolean, name: keyof RytmCapabilities): void {
  if (!enabled) throw new Error(`device capability is not enabled: ${name}`);
}

function assertControlValue(value: number | boolean | string, label: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
    return;
  }
  if (typeof value === "string") {
    assertSafeAtom(value, label);
    return;
  }
  if (typeof value !== "boolean") throw new Error(`${label} must be a number, boolean, or enum string`);
}
