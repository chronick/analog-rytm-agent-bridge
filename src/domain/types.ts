export type RytmRevision = number;
export type RytmOperationSetId = string;
export type RytmSnapshotId = string;
export type RytmPatternSlot = string;
export type RytmTrackId =
  | "BD"
  | "SD"
  | "RS"
  | "CP"
  | "BT"
  | "LT"
  | "MT"
  | "HT"
  | "CH"
  | "OH"
  | "CY"
  | "CB";

export type RytmBoundaryKind = "next_step" | "next_beat" | "next_measure" | "next_pattern";
export type RytmLatePolicy = "roll-forward" | "reject";

export type RytmApplyAt =
  | { kind: RytmBoundaryKind }
  | { kind: "pattern_step"; transportEpoch: string; pattern: RytmPatternSlot; step: number };

export interface RytmCapabilities {
  realtimeMidi: boolean;
  sysExState: boolean;
  patternEdit: boolean;
  kitEdit: boolean;
  machineEdit: boolean;
  sampleSlotAssignment: boolean;
  sampleTransfer: boolean;
  sceneMacros: boolean;
  performanceMacros: boolean;
  songs: boolean;
}

export interface RytmFirmwareCompatibility {
  adapter: "mock" | "rytm-rs" | "coremidi";
  adapterTargetFirmware?: string;
  observedFirmware?: string;
  compatibility: "mock" | "verified" | "unverified" | "unsupported";
  notes: string[];
}

export interface RytmDeviceSummary {
  model: "Analog Rytm MKII" | "Analog Rytm MKI" | "unknown";
  connected: boolean;
  firmware: RytmFirmwareCompatibility;
  midiInput?: string;
  midiOutput?: string;
  activePattern: RytmPatternSlot;
  capabilities: RytmCapabilities;
}

export interface RytmTransportState {
  epoch: string;
  playing: boolean;
  pattern: RytmPatternSlot;
  step: number;
  beat: number;
  measure: number;
  stepsPerBeat: number;
  beatsPerMeasure: number;
  tempo: number;
}

export type RytmPersistentOperation =
  | {
      type: "set_trig";
      pattern?: RytmPatternSlot;
      track: RytmTrackId;
      step: number;
      velocity?: number;
      microTiming?: number;
      condition?: string;
      retrig?: boolean;
    }
  | {
      type: "clear_trig";
      pattern?: RytmPatternSlot;
      track: RytmTrackId;
      step: number;
    }
  | {
      type: "set_parameter_lock";
      pattern?: RytmPatternSlot;
      track: RytmTrackId;
      step: number;
      parameter: string;
      value: number;
    }
  | {
      type: "clear_parameter_lock";
      pattern?: RytmPatternSlot;
      track: RytmTrackId;
      step: number;
      parameter: string;
    }
  | {
      type: "set_track_length";
      pattern?: RytmPatternSlot;
      track: RytmTrackId;
      steps: number;
    }
  | {
      type: "set_track_machine";
      pattern?: RytmPatternSlot;
      track: RytmTrackId;
      machine: string;
    }
  | {
      type: "copy_pattern";
      sourcePattern: RytmPatternSlot;
      targetPattern: RytmPatternSlot;
    }
  | {
      type: "set_kit_parameter";
      track?: RytmTrackId;
      parameter: string;
      value: number;
    }
  | {
      type: "assign_sample_slot";
      pattern?: RytmPatternSlot;
      track: RytmTrackId;
      slot: number;
      sampleId: string;
    };

export interface RytmOperationSetInput {
  operationSetId?: RytmOperationSetId;
  expectedRevision: RytmRevision;
  applyAt: RytmApplyAt;
  latePolicy: RytmLatePolicy;
  operations: RytmPersistentOperation[];
  dryRun?: boolean;
}

export interface QueuedRytmOperationSet {
  operationSetId: RytmOperationSetId;
  expectedRevision: RytmRevision;
  applyAt: RytmApplyAt;
  latePolicy: RytmLatePolicy;
  operations: RytmPersistentOperation[];
  status: "submitted" | "queued" | "applied" | "rejected" | "cancelled";
  submittedAt: string;
  queuedAt?: string;
  appliedAt?: string;
  appliedAtBoundary?: RytmBoundaryKind | "immediate";
  resultingRevision?: RytmRevision;
  rejectionReason?: string;
}

export interface RytmValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface RytmOperationSetDryRun {
  operationSetId?: RytmOperationSetId;
  expectedRevision: RytmRevision;
  applyAt: RytmApplyAt;
  latePolicy: RytmLatePolicy;
  operations: RytmPersistentOperation[];
  status: "dry_run";
  validation: RytmValidationResult;
  projectedRevision: RytmRevision;
  projectedPattern?: RytmPatternSummary;
}

export type RytmQueueResult = QueuedRytmOperationSet | RytmOperationSetDryRun;

export interface RytmPatternTrigSummary {
  track: RytmTrackId;
  step: number;
  velocity: number;
  microTiming?: number;
  condition?: string;
  retrig?: boolean;
  locks: Record<string, number>;
}

export interface RytmPatternSummary {
  pattern: RytmPatternSlot;
  length: number;
  trackLengths: Partial<Record<RytmTrackId, number>>;
  machines: Partial<Record<RytmTrackId, string>>;
  sampleSlots: Partial<Record<RytmTrackId, { slot: number; sampleId: string }>>;
  kitParameters: Record<string, number>;
  trigCount: number;
  trigs: RytmPatternTrigSummary[];
}

export interface RytmStateSnapshot {
  snapshotId: RytmSnapshotId;
  label?: string;
  revision: RytmRevision;
  createdAt: string;
  activePattern: RytmPatternSlot;
  patternCount: number;
}

export interface RytmBridgeState {
  revision: RytmRevision;
  device: RytmDeviceSummary;
  transport: RytmTransportState;
  activePattern: RytmPatternSummary;
  operationSets: QueuedRytmOperationSet[];
  snapshots: RytmStateSnapshot[];
}

export interface RytmLiveParameterInput {
  track?: RytmTrackId;
  parameter: string;
  value: number;
  lane?: "cc" | "nrpn";
}

export interface RytmTriggerTrackInput {
  track: RytmTrackId;
  velocity?: number;
  durationMs?: number;
}

export interface RytmSetTransportInput {
  command: "start" | "stop" | "continue";
  tempo?: number;
}

export interface RytmChangePatternInput {
  pattern: RytmPatternSlot;
  immediate?: boolean;
}

export interface RytmSnapshotInput {
  snapshotId?: RytmSnapshotId;
  label?: string;
}

export interface RytmRollbackInput {
  snapshotId: RytmSnapshotId;
  expectedRevision?: RytmRevision;
}

export interface RytmPatternDeltaInput {
  pattern?: RytmPatternSlot;
  operations: RytmPersistentOperation[];
}

export type RytmEvent =
  | { type: "operation_set.queued"; operationSetId: RytmOperationSetId; applyAt: RytmApplyAt; queuedAt: string }
  | {
      type: "operation_set.applied";
      operationSetId: RytmOperationSetId;
      boundary: RytmBoundaryKind | "immediate";
      revision: RytmRevision;
      appliedAt: string;
      pattern: RytmPatternSlot;
    }
  | { type: "operation_set.rejected"; operationSetId: RytmOperationSetId; reason: string }
  | { type: "live.parameter_sent"; input: RytmLiveParameterInput }
  | { type: "track.triggered"; input: RytmTriggerTrackInput }
  | { type: "transport.changed"; transport: RytmTransportState }
  | { type: "pattern.changed"; pattern: RytmPatternSlot; transport: RytmTransportState }
  | { type: "snapshot.created"; snapshot: RytmStateSnapshot }
  | { type: "snapshot.rolled_back"; snapshotId: RytmSnapshotId; revision: RytmRevision; pattern: RytmPatternSlot }
  | { type: "warning"; source: string; message: string };

