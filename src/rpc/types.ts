import type {
  QueuedRytmOperationSet,
  RytmAudioInputInventory,
  RytmAudioRecording,
  RytmBridgeState,
  RytmCapturePatternAudioInput,
  RytmCaptureMultitrackAudioInput,
  RytmChangePatternInput,
  RytmClearSampleRamInput,
  RytmClearedSampleRam,
  RytmLiveParameterInput,
  RytmInspectSongInput,
  RytmOperationSetDryRun,
  RytmOperationSetInput,
  RytmPatternDeltaInput,
  RytmPatternSummary,
  RytmMultitrackRecording,
  RytmOverbridgeProviderInventory,
  RytmPersistentOperation,
  RytmResolveSampleRamInput,
  RytmResolvedSampleRam,
  RytmRollbackInput,
  RytmSampleInventory,
  RytmSampleInventoryInput,
  RytmSetTransportInput,
  RytmSetActiveSceneInput,
  RytmSetPerformanceMacroInput,
  RytmSongDeltaInput,
  RytmSongSummary,
  RytmSnapshotInput,
  RytmStartRecordingInput,
  RytmStateSnapshot,
  RytmStopRecordingInput,
  RytmTransportState,
  RytmTriggerTrackInput,
  RytmUploadedSample,
  RytmUploadSampleInput,
  RytmValidationResult,
} from "../domain/types.ts";

export const RYTM_RPC_SCHEMA = "analog-rytm-rpc.v1" as const;

export interface RytmRpcRequest {
  schema: typeof RYTM_RPC_SCHEMA;
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RytmRpcErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface RytmRpcSuccess<T = unknown> {
  schema: typeof RYTM_RPC_SCHEMA;
  id: string;
  ok: true;
  result: T;
}

export interface RytmRpcFailure {
  schema: typeof RYTM_RPC_SCHEMA;
  id: string | null;
  ok: false;
  error: RytmRpcErrorBody;
}

export type RytmRpcResponse<T = unknown> = RytmRpcSuccess<T> | RytmRpcFailure;

export interface RytmRpcEvent<T = unknown> {
  schema: typeof RYTM_RPC_SCHEMA;
  eventId: string;
  type: string;
  payload: T;
}

export interface RytmDaemonHealth {
  status: "ready";
  connected: boolean;
  adapter: "mock" | "hardware";
  protocolSchema: typeof RYTM_RPC_SCHEMA;
  daemonSchema: "analog-rytm-daemon.v1";
  processId: number;
  methods: {
    declared: string[];
    implemented: string[];
  };
}

export interface RytmDaemonApi {
  health(): Promise<RytmDaemonHealth>;
  inspectDeviceState(): Promise<unknown>;
  inspectPattern(pattern?: string): Promise<unknown>;
  inspectSong(input?: RytmInspectSongInput): Promise<RytmSongSummary | { songs: RytmSongSummary[]; count: number }>;
  inspectKit(): Promise<unknown>;
  inspectSound(track: string): Promise<unknown>;
  inspectGlobal(): Promise<unknown>;
  validateOperations(operations: RytmPersistentOperation[]): Promise<RytmValidationResult>;
  proposePatternDelta(input: RytmPatternDeltaInput): Promise<{
    validation: RytmValidationResult;
    basePattern: RytmPatternSummary;
    projectedPattern?: RytmPatternSummary;
  }>;
  proposeSongDelta(input: RytmSongDeltaInput): Promise<unknown>;
  queueOperations(input: RytmOperationSetInput): Promise<QueuedRytmOperationSet | RytmOperationSetDryRun>;
  applyOperationsNow(
    input: Omit<RytmOperationSetInput, "applyAt" | "latePolicy"> & Partial<Pick<RytmOperationSetInput, "applyAt" | "latePolicy">>,
  ): Promise<QueuedRytmOperationSet | RytmOperationSetDryRun>;
  setLiveParameter(input: RytmLiveParameterInput): Promise<RytmLiveParameterInput>;
  setActiveScene(input: RytmSetActiveSceneInput): Promise<RytmSetActiveSceneInput>;
  setPerformanceMacro(input: RytmSetPerformanceMacroInput): Promise<RytmSetPerformanceMacroInput>;
  triggerTrack(input: RytmTriggerTrackInput): Promise<RytmTriggerTrackInput>;
  setTransport(input: RytmSetTransportInput): Promise<RytmTransportState>;
  changePattern(input: RytmChangePatternInput): Promise<RytmTransportState>;
  snapshotState(input?: RytmSnapshotInput): Promise<RytmStateSnapshot>;
  rollbackSnapshot(input: RytmRollbackInput): Promise<RytmBridgeState>;
  getEvents(afterCursor?: number, limit?: number): Promise<Array<{ cursor: number; receivedAt: string; event: unknown }>>;
  reconcileState(): Promise<unknown>;
  inspectSamples(input?: RytmSampleInventoryInput): Promise<RytmSampleInventory>;
  uploadSample(input: RytmUploadSampleInput): Promise<RytmUploadedSample>;
  resolveSampleRam(input: RytmResolveSampleRamInput): Promise<RytmResolvedSampleRam>;
  clearSampleRam(input: RytmClearSampleRamInput): Promise<RytmClearedSampleRam>;
  listAudioInputs(): Promise<RytmAudioInputInventory>;
  startRecording(input?: RytmStartRecordingInput): Promise<RytmAudioRecording>;
  stopRecording(input: RytmStopRecordingInput): Promise<RytmAudioRecording>;
  capturePatternAudio(input: RytmCapturePatternAudioInput): Promise<RytmAudioRecording>;
  inspectOverbridgeAudio(): Promise<RytmOverbridgeProviderInventory>;
  captureMultitrackAudio(input: RytmCaptureMultitrackAudioInput): Promise<RytmMultitrackRecording>;
}
import type {
  QueuedRytmOperationSet,
  RytmAudioInputInventory,
  RytmAudioRecording,
  RytmBridgeState,
  RytmCapturePatternAudioInput,
  RytmChangePatternInput,
  RytmLiveParameterInput,
  RytmOperationSetDryRun,
  RytmOperationSetInput,
  RytmPatternDeltaInput,
  RytmPatternSummary,
  RytmPersistentOperation,
  RytmRollbackInput,
  RytmSetTransportInput,
  RytmSnapshotInput,
  RytmStartRecordingInput,
  RytmStateSnapshot,
  RytmStopRecordingInput,
  RytmTransportState,
  RytmTriggerTrackInput,
  RytmValidationResult,
} from "../domain/types.ts";
