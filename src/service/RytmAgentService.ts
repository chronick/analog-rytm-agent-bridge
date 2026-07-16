import { randomUUID } from "node:crypto";
import type {
  QueuedRytmOperationSet,
  RytmApplyAt,
  RytmBoundaryKind,
  RytmBridgeState,
  RytmCapabilities,
  RytmChangePatternInput,
  RytmDeviceSummary,
  RytmEvent,
  RytmLiveParameterInput,
  RytmOperationSetDryRun,
  RytmOperationSetInput,
  RytmPatternDeltaInput,
  RytmPatternSlot,
  RytmPatternSummary,
  RytmPatternTrigSummary,
  RytmPersistentOperation,
  RytmRollbackInput,
  RytmSetTransportInput,
  RytmSnapshotInput,
  RytmStateSnapshot,
  RytmTrackId,
  RytmTriggerTrackInput,
  RytmValidationResult,
} from "../domain/types.ts";
import {
  assertPatternSlot,
  collectOperationValidation,
  validateChangePatternInput,
  validateLiveParameterInput,
  validateOperationSetInput,
  validateSetTransportInput,
  validateSnapshotInput,
  validateTriggerTrackInput,
} from "../domain/validation.ts";
import { EventJournal, type JournalEntry } from "./EventJournal.ts";
import { MockRytmTransport } from "./MockRytmTransport.ts";

interface InternalTrig {
  track: RytmTrackId;
  step: number;
  velocity: number;
  microTiming?: number;
  condition?: string;
  retrig?: boolean;
  locks: Map<string, number>;
}

interface InternalPattern {
  pattern: RytmPatternSlot;
  length: number;
  trackLengths: Map<RytmTrackId, number>;
  machines: Map<RytmTrackId, string>;
  sampleSlots: Map<RytmTrackId, { slot: number; sampleId: string }>;
  kitParameters: Map<string, number>;
  trigs: Map<string, InternalTrig>;
}

interface SnapshotRecord {
  summary: RytmStateSnapshot;
  revision: number;
  activePattern: RytmPatternSlot;
  transport: RytmBridgeState["transport"];
  patterns: Map<RytmPatternSlot, InternalPattern>;
}

export interface RytmAgentServiceOptions {
  sessionDirectory?: string;
  transport?: MockRytmTransport;
  device?: Partial<RytmDeviceSummary>;
}

const exposedHistoryLimit = 512;

export class RytmAgentService {
  readonly journal: EventJournal<RytmEvent>;
  readonly transport: MockRytmTransport;
  private revision = 0;
  private idCounter = 1;
  private activePattern: RytmPatternSlot = "A01";
  private readonly operationSets = new Map<string, QueuedRytmOperationSet>();
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly patterns = new Map<RytmPatternSlot, InternalPattern>();
  private readonly device: RytmDeviceSummary;
  private transportState: RytmBridgeState["transport"] = {
    epoch: "mock-epoch-1",
    playing: false,
    pattern: "A01",
    step: 0,
    beat: 0,
    measure: 0,
    stepsPerBeat: 4,
    beatsPerMeasure: 4,
    tempo: 120,
  };

  constructor(options: RytmAgentServiceOptions = {}) {
    this.transport = options.transport ?? new MockRytmTransport();
    this.journal = new EventJournal<RytmEvent>({ directory: options.sessionDirectory });
    this.device = {
      model: "Analog Rytm MKII",
      connected: true,
      firmware: {
        adapter: "mock",
        compatibility: "mock",
        notes: ["Mock transport. No hardware SysEx has been sent."],
      },
      activePattern: "A01",
      capabilities: defaultCapabilities(),
      ...options.device,
    };
    this.patterns.set("A01", createEmptyPattern("A01"));
  }

  async init(): Promise<void> {
    await this.journal.init();
  }

  getState(): RytmBridgeState {
    return structuredClone({
      revision: this.revision,
      device: { ...this.device, connected: this.device.connected && this.transport.connected, activePattern: this.activePattern },
      transport: this.transportState,
      activePattern: this.inspectPattern(this.activePattern),
      operationSets: recentValues(this.operationSets, exposedHistoryLimit),
      snapshots: recentValues(this.snapshots, exposedHistoryLimit).map((snapshot) => snapshot.summary),
    });
  }

  inspectDeviceState(): RytmBridgeState {
    return this.getState();
  }

  inspectPattern(pattern = this.activePattern): RytmPatternSummary {
    assertPatternSlot(pattern);
    return summarizePattern(this.ensurePattern(pattern));
  }

  validateOperations(operations: RytmPersistentOperation[]): RytmValidationResult {
    return collectOperationValidation(operations, this.device.capabilities);
  }

  proposePatternDelta(input: RytmPatternDeltaInput): {
    validation: RytmValidationResult;
    basePattern: RytmPatternSummary;
    projectedPattern?: RytmPatternSummary;
  } {
    const pattern = input.pattern ?? this.activePattern;
    assertPatternSlot(pattern);
    const validation = this.validateOperations(input.operations);
    if (!validation.valid) return { validation, basePattern: this.inspectPattern(pattern) };
    const projected = clonePatterns(this.patterns);
    applyOperationsToPatterns(projected, input.operations, pattern);
    return {
      validation,
      basePattern: this.inspectPattern(pattern),
      projectedPattern: summarizePattern(ensurePattern(projected, pattern)),
    };
  }

  async queueOperations(input: RytmOperationSetInput): Promise<QueuedRytmOperationSet | RytmOperationSetDryRun> {
    validateOperationSetInput(input, this.device.capabilities);
    if (input.expectedRevision !== this.revision) {
      throw new Error(`expected revision ${input.expectedRevision}, current revision is ${this.revision}`);
    }
    if (input.dryRun) return this.buildDryRun(input);

    if (input.operationSetId && this.operationSets.has(input.operationSetId)) {
      const existing = this.operationSets.get(input.operationSetId) as QueuedRytmOperationSet;
      if (!sameOperationSet(existing, input)) throw new Error(`operationSetId already exists with a different payload: ${input.operationSetId}`);
      return structuredClone(existing);
    }

    const operationSet: QueuedRytmOperationSet = {
      operationSetId: input.operationSetId ?? this.nextId("ops"),
      expectedRevision: input.expectedRevision,
      applyAt: input.applyAt,
      latePolicy: input.latePolicy,
      operations: structuredClone(input.operations),
      status: "queued",
      submittedAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
    };
    this.operationSets.set(operationSet.operationSetId, operationSet);
    await this.appendEvent({ type: "operation_set.queued", operationSetId: operationSet.operationSetId, applyAt: operationSet.applyAt, queuedAt: operationSet.queuedAt as string });
    return structuredClone(operationSet);
  }

  async applyOperationsNow(input: Omit<RytmOperationSetInput, "applyAt" | "latePolicy"> & Partial<Pick<RytmOperationSetInput, "applyAt" | "latePolicy">>): Promise<QueuedRytmOperationSet | RytmOperationSetDryRun> {
    const normalized: RytmOperationSetInput = {
      ...input,
      applyAt: input.applyAt ?? { kind: "next_step" },
      latePolicy: input.latePolicy ?? "reject",
    };
    validateOperationSetInput(normalized, this.device.capabilities);
    if (normalized.expectedRevision !== this.revision) {
      throw new Error(`expected revision ${normalized.expectedRevision}, current revision is ${this.revision}`);
    }
    if (normalized.dryRun) return this.buildDryRun(normalized);
    if (normalized.operationSetId && this.operationSets.has(normalized.operationSetId)) {
      const existing = this.operationSets.get(normalized.operationSetId) as QueuedRytmOperationSet;
      if (!sameOperationSet(existing, normalized)) throw new Error(`operationSetId already exists with a different payload: ${normalized.operationSetId}`);
      return structuredClone(existing);
    }

    const operationSet: QueuedRytmOperationSet = {
      operationSetId: normalized.operationSetId ?? this.nextId("ops"),
      expectedRevision: normalized.expectedRevision,
      applyAt: normalized.applyAt,
      latePolicy: normalized.latePolicy,
      operations: structuredClone(normalized.operations),
      status: "queued",
      submittedAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
    };
    this.operationSets.set(operationSet.operationSetId, operationSet);
    await this.applyOperationSet(operationSet, "immediate");
    return structuredClone(operationSet);
  }

  async advanceMockTransport(steps = 1): Promise<RytmBridgeState["transport"]> {
    if (!Number.isInteger(steps) || steps < 1 || steps > 4096) throw new Error("steps must be an integer between 1 and 4096");
    for (let index = 0; index < steps; index += 1) {
      const previousStep = this.transportState.step;
      const patternLength = this.ensurePattern(this.activePattern).length;
      const nextStep = (previousStep + 1) % patternLength;
      const crossed: RytmBoundaryKind[] = ["next_step"];
      if (nextStep % this.transportState.stepsPerBeat === 0) crossed.push("next_beat");
      if (nextStep % (this.transportState.stepsPerBeat * this.transportState.beatsPerMeasure) === 0) crossed.push("next_measure");
      if (nextStep === 0) crossed.push("next_pattern");

      const absoluteStep = this.transportState.measure * this.transportState.stepsPerBeat * this.transportState.beatsPerMeasure + previousStep + 1;
      this.transportState = {
        ...this.transportState,
        step: nextStep,
        beat: Math.floor((nextStep % (this.transportState.stepsPerBeat * this.transportState.beatsPerMeasure)) / this.transportState.stepsPerBeat),
        measure: Math.floor(absoluteStep / (this.transportState.stepsPerBeat * this.transportState.beatsPerMeasure)),
      };

      await this.applyDueOperationSets(crossed);
    }
    await this.appendEvent({ type: "transport.changed", transport: this.transportState });
    return structuredClone(this.transportState);
  }

  async setLiveParameter(input: RytmLiveParameterInput): Promise<RytmLiveParameterInput> {
    validateLiveParameterInput(input, this.device.capabilities);
    await this.transport.sendLiveParameter(input);
    await this.appendEvent({ type: "live.parameter_sent", input });
    return structuredClone(input);
  }

  async triggerTrack(input: RytmTriggerTrackInput): Promise<RytmTriggerTrackInput> {
    validateTriggerTrackInput(input, this.device.capabilities);
    await this.transport.triggerTrack(input);
    await this.appendEvent({ type: "track.triggered", input });
    return structuredClone(input);
  }

  async setTransport(input: RytmSetTransportInput): Promise<RytmBridgeState["transport"]> {
    validateSetTransportInput(input, this.device.capabilities);
    await this.transport.setTransport(input);
    this.transportState = {
      ...this.transportState,
      playing: input.command !== "stop",
      tempo: input.tempo ?? this.transportState.tempo,
      epoch: input.command === "start" ? this.nextId("epoch") : this.transportState.epoch,
    };
    await this.appendEvent({ type: "transport.changed", transport: this.transportState });
    return structuredClone(this.transportState);
  }

  async changePattern(input: RytmChangePatternInput): Promise<RytmBridgeState["transport"]> {
    validateChangePatternInput(input, this.device.capabilities);
    await this.transport.changePattern(input);
    this.ensurePattern(input.pattern);
    this.activePattern = input.pattern;
    this.device.activePattern = input.pattern;
    this.transportState = { ...this.transportState, pattern: input.pattern, step: input.immediate ? 0 : this.transportState.step };
    await this.appendEvent({ type: "pattern.changed", pattern: input.pattern, transport: this.transportState });
    return structuredClone(this.transportState);
  }

  async snapshotState(input: RytmSnapshotInput = {}): Promise<RytmStateSnapshot> {
    validateSnapshotInput(input);
    const snapshotId = input.snapshotId ?? this.nextId("snapshot");
    if (this.snapshots.has(snapshotId)) return structuredClone((this.snapshots.get(snapshotId) as SnapshotRecord).summary);
    const summary: RytmStateSnapshot = {
      snapshotId,
      label: input.label,
      revision: this.revision,
      createdAt: new Date().toISOString(),
      activePattern: this.activePattern,
      patternCount: this.patterns.size,
    };
    this.snapshots.set(snapshotId, {
      summary,
      revision: this.revision,
      activePattern: this.activePattern,
      transport: structuredClone(this.transportState),
      patterns: clonePatterns(this.patterns),
    });
    await this.appendEvent({ type: "snapshot.created", snapshot: summary });
    return structuredClone(summary);
  }

  async rollbackSnapshot(input: RytmRollbackInput): Promise<RytmBridgeState> {
    const snapshot = this.snapshots.get(input.snapshotId);
    if (!snapshot) throw new Error(`unknown snapshot: ${input.snapshotId}`);
    if (input.expectedRevision !== undefined && input.expectedRevision !== this.revision) {
      throw new Error(`expected revision ${input.expectedRevision}, current revision is ${this.revision}`);
    }
    this.patterns.clear();
    for (const [pattern, data] of clonePatterns(snapshot.patterns)) this.patterns.set(pattern, data);
    this.activePattern = snapshot.activePattern;
    this.device.activePattern = snapshot.activePattern;
    this.transportState = { ...structuredClone(snapshot.transport), pattern: snapshot.activePattern };
    this.revision += 1;
    await this.appendEvent({ type: "snapshot.rolled_back", snapshotId: input.snapshotId, revision: this.revision, pattern: this.activePattern });
    return this.getState();
  }

  getEvents(afterCursor = 0, limit = 100): JournalEntry<RytmEvent>[] {
    return this.journal.page(afterCursor, limit);
  }

  private async applyDueOperationSets(boundaries: RytmBoundaryKind[]): Promise<void> {
    for (const operationSet of this.operationSets.values()) {
      if (operationSet.status !== "queued") continue;
      const boundary = boundaryFor(operationSet.applyAt, this.transportState, boundaries);
      if (!boundary) continue;
      if (operationSet.expectedRevision !== this.revision) {
        operationSet.status = "rejected";
        operationSet.rejectionReason = `expected revision ${operationSet.expectedRevision}, current revision is ${this.revision}`;
        await this.appendEvent({ type: "operation_set.rejected", operationSetId: operationSet.operationSetId, reason: operationSet.rejectionReason });
        continue;
      }
      await this.applyOperationSet(operationSet, boundary);
    }
  }

  private async applyOperationSet(operationSet: QueuedRytmOperationSet, boundary: RytmBoundaryKind | "immediate"): Promise<void> {
    applyOperationsToPatterns(this.patterns, operationSet.operations, this.activePattern);
    this.revision += 1;
    operationSet.status = "applied";
    operationSet.appliedAt = new Date().toISOString();
    operationSet.appliedAtBoundary = boundary;
    operationSet.resultingRevision = this.revision;
    await this.appendEvent({
      type: "operation_set.applied",
      operationSetId: operationSet.operationSetId,
      boundary,
      revision: this.revision,
      appliedAt: operationSet.appliedAt,
      pattern: this.activePattern,
    });
  }

  private buildDryRun(input: RytmOperationSetInput): RytmOperationSetDryRun {
    const validation = this.validateOperations(input.operations);
    const projected = clonePatterns(this.patterns);
    if (validation.valid) applyOperationsToPatterns(projected, input.operations, this.activePattern);
    return {
      operationSetId: input.operationSetId,
      expectedRevision: input.expectedRevision,
      applyAt: input.applyAt,
      latePolicy: input.latePolicy,
      operations: structuredClone(input.operations),
      status: "dry_run",
      validation,
      projectedRevision: this.revision + (validation.valid ? 1 : 0),
      projectedPattern: validation.valid ? summarizePattern(ensurePattern(projected, this.activePattern)) : undefined,
    };
  }

  private ensurePattern(pattern: RytmPatternSlot): InternalPattern {
    return ensurePattern(this.patterns, pattern);
  }

  private async appendEvent(event: RytmEvent): Promise<void> {
    await this.journal.append(event);
  }

  private nextId(prefix: string): string {
    const suffix = this.idCounter++;
    return `${prefix}-${suffix}-${randomUUID().slice(0, 8)}`;
  }
}

function boundaryFor(
  applyAt: RytmApplyAt,
  transport: RytmBridgeState["transport"],
  boundaries: RytmBoundaryKind[],
): RytmBoundaryKind | undefined {
  if (applyAt.kind === "pattern_step") {
    if (applyAt.transportEpoch === transport.epoch && applyAt.pattern === transport.pattern && applyAt.step === transport.step) return "next_step";
    return undefined;
  }
  return boundaries.includes(applyAt.kind) ? applyAt.kind : undefined;
}

function createEmptyPattern(pattern: RytmPatternSlot): InternalPattern {
  return {
    pattern,
    length: 64,
    trackLengths: new Map(),
    machines: new Map(),
    sampleSlots: new Map(),
    kitParameters: new Map(),
    trigs: new Map(),
  };
}

function ensurePattern(patterns: Map<RytmPatternSlot, InternalPattern>, pattern: RytmPatternSlot): InternalPattern {
  assertPatternSlot(pattern);
  const existing = patterns.get(pattern);
  if (existing) return existing;
  const created = createEmptyPattern(pattern);
  patterns.set(pattern, created);
  return created;
}

function applyOperationsToPatterns(
  patterns: Map<RytmPatternSlot, InternalPattern>,
  operations: RytmPersistentOperation[],
  activePattern: RytmPatternSlot,
): void {
  for (const operation of operations) {
    switch (operation.type) {
      case "set_trig": {
        const pattern = ensurePattern(patterns, operation.pattern ?? activePattern);
        const key = trigKey(operation.track, operation.step);
        const existing = pattern.trigs.get(key);
        pattern.trigs.set(key, {
          track: operation.track,
          step: operation.step,
          velocity: operation.velocity ?? existing?.velocity ?? 100,
          microTiming: operation.microTiming ?? existing?.microTiming,
          condition: operation.condition ?? existing?.condition,
          retrig: operation.retrig ?? existing?.retrig,
          locks: existing?.locks ? new Map(existing.locks) : new Map(),
        });
        break;
      }
      case "clear_trig":
        ensurePattern(patterns, operation.pattern ?? activePattern).trigs.delete(trigKey(operation.track, operation.step));
        break;
      case "set_parameter_lock": {
        const pattern = ensurePattern(patterns, operation.pattern ?? activePattern);
        const key = trigKey(operation.track, operation.step);
        const trig = pattern.trigs.get(key) ?? {
          track: operation.track,
          step: operation.step,
          velocity: 100,
          locks: new Map<string, number>(),
        };
        trig.locks.set(operation.parameter, operation.value);
        pattern.trigs.set(key, trig);
        break;
      }
      case "clear_parameter_lock": {
        const pattern = ensurePattern(patterns, operation.pattern ?? activePattern);
        pattern.trigs.get(trigKey(operation.track, operation.step))?.locks.delete(operation.parameter);
        break;
      }
      case "set_track_length":
        ensurePattern(patterns, operation.pattern ?? activePattern).trackLengths.set(operation.track, operation.steps);
        break;
      case "set_track_machine":
        ensurePattern(patterns, operation.pattern ?? activePattern).machines.set(operation.track, operation.machine);
        break;
      case "copy_pattern":
        patterns.set(operation.targetPattern, clonePattern(ensurePattern(patterns, operation.sourcePattern), operation.targetPattern));
        break;
      case "set_kit_parameter": {
        const key = operation.track ? `${operation.track}.${operation.parameter}` : operation.parameter;
        ensurePattern(patterns, activePattern).kitParameters.set(key, operation.value);
        break;
      }
      case "assign_sample_slot":
        ensurePattern(patterns, operation.pattern ?? activePattern).sampleSlots.set(operation.track, { slot: operation.slot, sampleId: operation.sampleId });
        break;
    }
  }
}

function summarizePattern(pattern: InternalPattern): RytmPatternSummary {
  const trigs: RytmPatternTrigSummary[] = [...pattern.trigs.values()]
    .map((trig) => summarizeTrig(trig))
    .sort((a, b) => a.step - b.step || a.track.localeCompare(b.track));

  return {
    pattern: pattern.pattern,
    length: pattern.length,
    trackLengths: Object.fromEntries(pattern.trackLengths),
    machines: Object.fromEntries(pattern.machines),
    sampleSlots: Object.fromEntries(pattern.sampleSlots),
    kitParameters: Object.fromEntries([...pattern.kitParameters.entries()].sort(([a], [b]) => a.localeCompare(b))),
    trigCount: trigs.length,
    trigs,
  };
}

function summarizeTrig(trig: InternalTrig): RytmPatternTrigSummary {
  const summary: RytmPatternTrigSummary = {
    track: trig.track,
    step: trig.step,
    velocity: trig.velocity,
    locks: Object.fromEntries([...trig.locks.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  if (trig.microTiming !== undefined) summary.microTiming = trig.microTiming;
  if (trig.condition !== undefined) summary.condition = trig.condition;
  if (trig.retrig !== undefined) summary.retrig = trig.retrig;
  return summary;
}

function clonePatterns(patterns: Map<RytmPatternSlot, InternalPattern>): Map<RytmPatternSlot, InternalPattern> {
  const clone = new Map<RytmPatternSlot, InternalPattern>();
  for (const [pattern, value] of patterns) clone.set(pattern, clonePattern(value, pattern));
  return clone;
}

function clonePattern(pattern: InternalPattern, slot: RytmPatternSlot): InternalPattern {
  return {
    pattern: slot,
    length: pattern.length,
    trackLengths: new Map(pattern.trackLengths),
    machines: new Map(pattern.machines),
    sampleSlots: new Map([...pattern.sampleSlots.entries()].map(([track, value]) => [track, { ...value }])),
    kitParameters: new Map(pattern.kitParameters),
    trigs: new Map([...pattern.trigs.entries()].map(([key, trig]) => [key, { ...trig, locks: new Map(trig.locks) }])),
  };
}

function defaultCapabilities(): RytmCapabilities {
  return {
    realtimeMidi: true,
    sysExState: true,
    patternEdit: true,
    kitEdit: true,
    machineEdit: true,
    sampleSlotAssignment: false,
    sampleTransfer: false,
    sceneMacros: false,
    performanceMacros: false,
    songs: false,
  };
}

function recentValues<T>(records: Map<string, T>, limit: number): T[] {
  return [...records.values()].slice(-limit);
}

function trigKey(track: RytmTrackId, step: number): string {
  return `${track}:${step}`;
}

function sameOperationSet(existing: QueuedRytmOperationSet, input: RytmOperationSetInput): boolean {
  return stableStringify({
    expectedRevision: existing.expectedRevision,
    applyAt: existing.applyAt,
    latePolicy: existing.latePolicy,
    operations: existing.operations,
  }) === stableStringify({
    expectedRevision: input.expectedRevision,
    applyAt: input.applyAt,
    latePolicy: input.latePolicy,
    operations: input.operations,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
