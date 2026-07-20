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
export type RytmMacroTrackId = RytmTrackId | "FX";

export interface RytmSceneLockInput {
  track: RytmMacroTrackId;
  parameter: string;
  value: number;
}

export interface RytmPerformanceLockInput {
  track: RytmMacroTrackId;
  parameter: string;
  depth: number;
}

export type RytmSongTarget =
  | { scope: "work_buffer" }
  | { scope: "stored"; song: number };

export interface RytmSongPatternInput {
  pattern: RytmPatternSlot;
  mutedTracks?: RytmTrackId[];
}

export interface RytmSongRowInput {
  patterns: RytmSongPatternInput[];
  repeats: number;
}

export interface RytmInspectSongInput {
  scope?: "work_buffer" | "stored" | "all";
  song?: number;
  resolveReferences?: boolean;
}

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

export interface RytmCapabilityEvidence {
  status: "supported" | "partial" | "implemented-unverified" | "unsupported" | "excluded";
  readable: boolean;
  writable: boolean;
  verified: boolean;
  transport: string[];
  firmwareEvidence: {
    adapterTargetFirmware?: string;
    hardwareVerifiedFirmware: string[];
    certifications: string[];
  };
  risk: {
    level: "low" | "medium" | "high" | "excluded";
    rollback: string;
  };
  notes: string[];
}

export interface RytmDaemonDescription {
  schema: "analog-rytm-daemon.v1";
  model: "Analog Rytm MKII";
  firmware: RytmFirmwareCompatibility;
  capabilities: RytmCapabilities;
  capabilityEvidence: Record<string, RytmCapabilityEvidence>;
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
      value: number | boolean | string;
    }
  | {
      type: "clear_parameter_lock";
      pattern?: RytmPatternSlot;
      track: RytmTrackId;
      step: number;
      parameter: string;
    }
  | {
      // Full parameter-lock pool purge for one pattern (all tracks, all steps).
      // Pool-rebuild primitive: also retires slot debris granular clears cannot
      // reach (legacy zero-fill ghosts, orphaned compound companion slots).
      type: "clear_pattern_plocks";
      pattern?: RytmPatternSlot;
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
    }
  | {
      type: "set_scene_lock";
      scene: number;
      track: RytmMacroTrackId;
      parameter: string;
      value: number;
    }
  | {
      type: "replace_scene";
      scene: number;
      locks: RytmSceneLockInput[];
    }
  | {
      type: "clear_scene";
      scene: number;
    }
  | {
      type: "copy_scene";
      sourceScene: number;
      targetScene: number;
    }
  | {
      type: "set_performance_lock";
      performance: number;
      track: RytmMacroTrackId;
      parameter: string;
      depth: number;
    }
  | {
      type: "replace_performance";
      performance: number;
      locks: RytmPerformanceLockInput[];
    }
  | {
      type: "clear_performance";
      performance: number;
    }
  | {
      type: "copy_performance";
      sourcePerformance: number;
      targetPerformance: number;
    }
  | {
      type: "set_song_name";
      target?: RytmSongTarget;
      name: string;
    }
  | {
      type: "replace_song";
      target?: RytmSongTarget;
      name?: string;
      rows: RytmSongRowInput[];
    }
  | {
      type: "insert_song_row";
      target?: RytmSongTarget;
      row: number;
      value: RytmSongRowInput;
    }
  | {
      type: "update_song_row";
      target?: RytmSongTarget;
      row: number;
      value: RytmSongRowInput;
    }
  | {
      type: "move_song_row";
      target?: RytmSongTarget;
      sourceRow: number;
      targetRow: number;
    }
  | {
      type: "copy_song_row";
      target?: RytmSongTarget;
      sourceRow: number;
      targetRow: number;
    }
  | {
      type: "remove_song_row";
      target?: RytmSongTarget;
      row: number;
    }
  | {
      type: "clear_song";
      target?: RytmSongTarget;
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
  changedObjects?: Partial<Record<"pattern" | "kit" | "global" | "settings", boolean>> & { songs?: string[] };
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
  locks: Record<string, number | boolean | string>;
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

export interface RytmSongPatternSummary {
  pattern: RytmPatternSlot;
  mutedTracks: RytmTrackId[];
  mutedTracksMask: number;
}

export interface RytmSongRowSummary {
  row: number;
  repeats: number;
  patterns: RytmSongPatternSummary[];
}

export interface RytmSongReferenceSummary {
  pattern: RytmPatternSlot;
  available: boolean;
  kitNumber?: number;
  kitName?: string;
  patternLength?: number;
}

export interface RytmSongSummary {
  target: RytmSongTarget;
  name: string;
  rowCount: number;
  patternPositionCount: number;
  rows: RytmSongRowSummary[];
  capabilities: {
    name: boolean;
    rows: boolean;
    patternChains: boolean;
    repeats: boolean;
    trackMutes: boolean;
    tempoOverrides: boolean;
    patternLengthOverrides: boolean;
    jumps: boolean;
    loops: boolean;
    rowLabels: boolean;
    explicitEnd: boolean;
  };
  references?: RytmSongReferenceSummary[];
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
  liveMacros: RytmLiveMacroState;
  activePattern: RytmPatternSummary;
  workBufferSong?: RytmSongSummary;
  operationSets: QueuedRytmOperationSet[];
  snapshots: RytmStateSnapshot[];
}

export interface RytmLiveParameterInput {
  track?: RytmTrackId;
  parameter: string;
  value: number;
  lane?: "cc" | "nrpn";
}

export interface RytmSetActiveSceneInput {
  scene: number | null;
  lane?: "cc" | "nrpn";
}

export interface RytmSetPerformanceMacroInput {
  performance: number;
  amount: number;
  lane?: "cc" | "nrpn";
}

export interface RytmLiveMacroState {
  activeScene: number | null;
  activeSceneSource: "mock" | "observed" | "sent";
  performanceAmounts: Record<string, number>;
  performanceAmountsSource: "mock" | "sent" | "unknown";
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

export interface RytmSongDeltaInput {
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

export interface RytmCaptureMultitrackAudioInput {
  recordingId?: string;
  deviceName?: string;
  snapshotId?: RytmSnapshotId;
  durationMs: number;
}

export interface RytmOverbridgeBus {
  id: string;
  name: string;
  tracks: RytmTrackId[];
  sourceChannelIndices: number[];
  channels: number;
}

export interface RytmOverbridgeProviderInventory {
  schema: "analog-rytm-overbridge-provider.v1";
  provider: {
    id: "elektron-overbridge-coreaudio";
    name: "Elektron Overbridge";
    kind: "coreaudio_hal";
    optional: true;
    controlDependency: false;
  };
  available: boolean;
  deviceMode: "mock" | "overbridge" | "class_compliant" | "unavailable";
  selectedDevice?: {
    id: string;
    name: string;
    channels?: number;
    sampleRate?: number;
    sampleFormat?: string;
    layout?: RytmOverbridgeBus[];
  } | null;
  installation: {
    driverInstalled: boolean;
    pluginInstalled: boolean;
    engineInstalled: boolean;
    engineRunning?: boolean | null;
    version?: string | null;
  };
  expectedBuses: RytmOverbridgeBus[];
  stalePartialFiles: string[];
  outputDirectory: string;
}

export interface RytmMultitrackStem {
  id: string;
  name: string;
  tracks: RytmTrackId[];
  sourceChannelIndices: number[];
  channels: number;
  path: string;
  frames: number;
  durationMs: number;
  bytes: number;
  analysis: {
    peak: number;
    rms: number;
    silence: boolean;
    clipping: boolean;
    clippedSamples: number;
  };
}

export interface RytmMultitrackRecording {
  schema: "analog-rytm-multitrack-recording.v1";
  recordingId: string;
  status: "completed" | "failed";
  declaration: RytmCaptureMultitrackAudioInput;
  device: {
    model: string;
    inputId: string;
    inputName: string;
    sourceChannels: number;
    sampleRate: number;
    sourceSampleFormat: string;
  };
  pattern: RytmPatternSlot;
  kit: { index?: number; name?: string };
  revision: RytmRevision;
  tempo: number;
  routing: unknown;
  snapshotId?: RytmSnapshotId | null;
  stems: RytmMultitrackStem[];
  synchronization: {
    clockDomain: "single_coreaudio_input_stream";
    commonStartFrame: 0;
    framesPerStem: number;
    maxFrameDrift: 0;
    callbackCount: number;
    timestampGapCount: number;
    maxTimestampGapMs: number;
  };
  latency: {
    source: "coreaudio_callback_timestamp";
    samples: number;
    minimumMs?: number | null;
    averageMs?: number | null;
    maximumMs?: number | null;
  };
  analysis: {
    expectedDurationMs: number;
    durationMs: number;
    durationWithinTolerance: boolean;
    disconnected: boolean;
    droppedBlocks: number;
  };
  metadataPath: string;
  warnings: string[];
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
  | { type: "live.scene_sent"; input: RytmSetActiveSceneInput }
  | { type: "live.performance_sent"; input: RytmSetPerformanceMacroInput }
  | { type: "track.triggered"; input: RytmTriggerTrackInput }
  | { type: "sample.uploaded"; sample: RytmUploadedSample }
  | { type: "sample.ram_resolved"; sample: RytmResolvedSampleRam }
  | { type: "sample.ram_cleared"; sample: RytmClearedSampleRam }
  | { type: "transport.changed"; transport: RytmTransportState }
  | { type: "pattern.changed"; pattern: RytmPatternSlot; transport: RytmTransportState }
  | { type: "snapshot.created"; snapshot: RytmStateSnapshot }
  | { type: "snapshot.rolled_back"; snapshotId: RytmSnapshotId; revision: RytmRevision; pattern: RytmPatternSlot }
  | { type: "warning"; source: string; message: string };
