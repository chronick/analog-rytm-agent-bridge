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
  | { kind: RytmBoundaryKind; transportEpoch?: string }
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
  classCompliantAudio: boolean;
  overbridgeAudio: boolean;
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
  clockSource?: "generated" | "observed";
  pattern: RytmPatternSlot;
  step: number;
  beat: number;
  measure: number;
  stepsPerBeat: number;
  beatsPerMeasure: number;
  tempo: number;
  patternLength?: number;
  absoluteStep?: number;
  midiClock?: number;
}

export interface RytmResolvedBoundary {
  transportEpoch: string;
  kind: RytmBoundaryKind | "pattern_step" | "immediate";
  absoluteStep: number;
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
      value: number | boolean | string;
    }
  | {
      type: "set_sound_parameter";
      track: RytmTrackId;
      page: "machine" | "sample" | "filter" | "amp" | "lfo" | "settings";
      parameter: string;
      value: number | boolean | string;
    }
  | {
      type: "set_fx_parameter";
      effect: "delay" | "reverb" | "distortion" | "compressor" | "lfo";
      parameter: string;
      value: number | boolean | string;
    }
  | {
      type: "set_global_parameter";
      section: "routing" | "metronome" | "midi_sync" | "midi_port" | "midi_channels" | "sequencer" | "settings";
      parameter: string;
      track?: RytmTrackId;
      value: number | boolean | string;
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
  resolvedBoundary?: RytmResolvedBoundary;
  changed?: boolean;
  changedObjects?: Partial<Record<"pattern" | "kit" | "global" | "settings", boolean>>;
  writeStatus?: "already-converged" | "applied-and-verified";
  acknowledgement?: "verified" | "not_applied" | "rollback_verified" | "rollback_failed";
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
  kitParameters: Record<string, unknown>;
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

export interface RytmSampleInventoryInput {
  drivePath?: string;
  includeRam?: boolean;
  includeTracks?: boolean;
}

export interface RytmSampleDriveEntry {
  kind: "file" | "directory";
  name: string;
  devicePath: string;
  size: string;
  sizeBytesApproximate: number;
  checksum: string;
  sampleId?: string;
}

export interface RytmSampleRamSlot {
  slot: number;
  occupied: boolean;
  devicePath?: string;
  usedByTrack: boolean;
  sampleId?: string;
}

export interface RytmSampleTrackAssignment {
  track: number;
  slot?: number;
  devicePath?: string;
}

export interface RytmSampleInventory {
  adapter: "mock" | "elektroid";
  drivePath: string;
  entries: RytmSampleDriveEntry[];
  ram: {
    capacity: number;
    occupied: number;
    free: number;
    slots: RytmSampleRamSlot[];
  };
  tracks: RytmSampleTrackAssignment[];
  identity: Record<string, string>;
  rollback: Record<string, string>;
}

export interface RytmUploadSampleInput {
  sourcePath: string;
  deviceDirectory?: string;
  name?: string;
}

export interface RytmUploadedSample {
  status: "uploaded-and-verified" | "already-present";
  transferred: boolean;
  sampleId: string;
  devicePath: string;
  deviceChecksum: string;
  deviceSize: string;
  sourceSha256: string;
  canonicalSha256: string;
  source: {
    path: string;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    sampleFormat: "int" | "float";
    frames: number;
  };
  conversion: {
    applied: boolean;
    targetChannels: 1;
    targetSampleRate: 48_000;
    targetBitsPerSample: 16;
    targetSampleFormat: "int";
  };
  verified: string[];
}

export interface RytmResolveSampleRamInput {
  sampleId: string;
  slot?: number;
}

export interface RytmResolvedSampleRam {
  status: "loaded-and-verified" | "already-resolved";
  sampleId: string;
  devicePath: string;
  slot: number;
  verified: true;
}

export interface RytmClearSampleRamInput {
  sampleId: string;
  slot: number;
}

export interface RytmClearedSampleRam {
  status: "cleared-and-verified" | "already-empty";
  sampleId: string;
  slot: number;
  devicePath?: string;
  driveSampleRetained?: true;
}

export interface RytmAudioStreamCapability {
  channels: number;
  minSampleRate: number;
  maxSampleRate: number;
  sampleFormat: string;
  recorderSupported: boolean;
}

export interface RytmAudioInputInfo {
  id: string;
  name: string;
  isRytm: boolean;
  defaultConfig?: RytmAudioStreamCapability | null;
  configurations: RytmAudioStreamCapability[];
  error?: string;
}

export interface RytmAudioInputInventory {
  inputs: RytmAudioInputInfo[];
  stalePartialFiles: string[];
  outputDirectory: string;
}

export interface RytmStartRecordingInput {
  recordingId?: string;
  deviceName?: string;
  snapshotId?: RytmSnapshotId;
  expectedDurationMs?: number;
}

export interface RytmStopRecordingInput {
  recordingId: string;
}

export interface RytmCapturePatternAudioInput extends RytmStartRecordingInput {
  durationMs: number;
}

export interface RytmAudioRecording {
  schema: "analog-rytm-recording.v1";
  recordingId: string;
  status: "recording" | "completed" | "failed";
  device: {
    model: string;
    inputId: string;
    inputName: string;
    sourceChannels: number;
    capturedChannels: number;
    sampleRate: number;
    sourceSampleFormat: string;
  };
  pattern: RytmPatternSlot;
  kit: { index?: number; name?: string };
  revision: RytmRevision;
  tempo: number;
  routing: unknown;
  snapshotId?: RytmSnapshotId | null;
  startedAt?: string;
  partialPath?: string;
  expectedDurationMs?: number | null;
  timestamps?: { startedAt: string; stoppedAt: string };
  audio?: {
    path: string;
    metadataPath: string;
    container: "wav";
    sampleFormat: "f32le";
    channels: number;
    sampleRate: number;
    frames: number;
    durationMs: number;
    bytes: number;
  };
  analysis?: {
    peak: number;
    rms: number;
    silence: boolean;
    clipping: boolean;
    clippedSamples: number;
    expectedDurationMs?: number | null;
    durationWithinTolerance?: boolean | null;
    disconnected: boolean;
    droppedBlocks: number;
  };
  warnings?: string[];
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
  | { type: "sample.uploaded"; sample: RytmUploadedSample }
  | { type: "sample.ram_resolved"; sample: RytmResolvedSampleRam }
  | { type: "sample.ram_cleared"; sample: RytmClearedSampleRam }
  | { type: "transport.changed"; transport: RytmTransportState }
  | { type: "pattern.changed"; pattern: RytmPatternSlot; transport: RytmTransportState }
  | { type: "snapshot.created"; snapshot: RytmStateSnapshot }
  | { type: "snapshot.rolled_back"; snapshotId: RytmSnapshotId; revision: RytmRevision; pattern: RytmPatternSlot }
  | { type: "warning"; source: string; message: string };
