import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import {
  RYTM_RPC_SCHEMA,
  type RytmDaemonApi,
  type RytmDaemonHealth,
  type RytmRpcErrorBody,
  type RytmRpcEvent,
  type RytmRpcRequest,
  type RytmRpcResponse,
} from "./types.ts";
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
  RytmRollbackInput,
  RytmSampleInventory,
  RytmSampleInventoryInput,
  RytmResolveSampleRamInput,
  RytmResolvedSampleRam,
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

export interface RustDaemonClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class RytmDaemonRpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(error: RytmRpcErrorBody) {
    super(error.message);
    this.name = "RytmDaemonRpcError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

export class RustDaemonClient implements RytmDaemonApi {
  private readonly options: Required<Pick<RustDaemonClientOptions, "command" | "args" | "requestTimeoutMs">> &
    Omit<RustDaemonClientOptions, "command" | "args" | "requestTimeoutMs">;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: RytmRpcEvent) => void>();
  private child?: ChildProcessWithoutNullStreams;
  private stdout?: ReadLineInterface;
  private stderr = "";
  private starting?: Promise<RytmDaemonHealth>;
  private intentionalClose = false;

  constructor(options: RustDaemonClientOptions = {}) {
    this.options = {
      command: options.command ?? defaultDaemonPath(),
      args: options.args ?? ["serve", "--adapter", "mock"],
      cwd: options.cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    };
  }

  get connected(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  async start(): Promise<RytmDaemonHealth> {
    if (this.starting) return this.starting;
    if (this.connected) return this.requestWithoutStart<RytmDaemonHealth>("daemon.health", {});

    this.intentionalClose = false;
    this.stderr = "";
    this.starting = new Promise<RytmDaemonHealth>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.stdout = createInterface({ input: child.stdout });
      this.stdout.on("line", (line) => this.handleLine(line));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-16_384);
      });
      child.once("error", (error) => {
        this.rejectAll(this.disconnectError(`failed to start Rust daemon: ${error.message}`));
        reject(this.disconnectError(`failed to start Rust daemon: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        this.stdout?.close();
        this.stdout = undefined;
        this.child = undefined;
        const detail = this.stderr.trim();
        const reason = `Rust daemon disconnected (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : ""}`;
        this.rejectAll(this.disconnectError(reason));
      });

      this.requestWithoutStart<RytmDaemonHealth>("daemon.health", {}).then(resolve, reject);
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { requestId?: string } = {},
  ): Promise<T> {
    if (!this.connected) await this.start();
    return this.requestWithoutStart<T>(method, params, options.requestId);
  }

  async health(): Promise<RytmDaemonHealth> {
    return this.request<RytmDaemonHealth>("daemon.health");
  }

  async describe(): Promise<unknown> {
    return this.request("daemon.describe");
  }

  async inspectDeviceState(): Promise<unknown> {
    return this.request("device.inspect_state");
  }

  async inspectPattern(pattern?: string): Promise<unknown> {
    return this.request("pattern.inspect", pattern === undefined ? {} : { pattern });
  }

  async inspectSong(input: RytmInspectSongInput = {}): Promise<RytmSongSummary | { songs: RytmSongSummary[]; count: number }> {
    return this.request("song.inspect", input as unknown as Record<string, unknown>);
  }

  async inspectKit(): Promise<unknown> {
    return this.request("kit.inspect");
  }

  async inspectSound(track: string): Promise<unknown> {
    return this.request("sound.inspect", { track });
  }

  async inspectGlobal(): Promise<unknown> {
    return this.request("global.inspect");
  }

  async validateOperations(operations: RytmPersistentOperation[]): Promise<RytmValidationResult> {
    return this.request("operations.validate", { operations });
  }

  async proposePatternDelta(input: RytmPatternDeltaInput): Promise<{
    validation: RytmValidationResult;
    basePattern: RytmPatternSummary;
    projectedPattern?: RytmPatternSummary;
  }> {
    return this.request("operations.propose", input as unknown as Record<string, unknown>);
  }

  async proposeSongDelta(input: RytmSongDeltaInput): Promise<unknown> {
    return this.request("operations.propose", input as unknown as Record<string, unknown>);
  }

  async queueOperations(input: RytmOperationSetInput): Promise<QueuedRytmOperationSet | RytmOperationSetDryRun> {
    return this.request("operations.queue", input as unknown as Record<string, unknown>);
  }

  async applyOperationsNow(
    input: Omit<RytmOperationSetInput, "applyAt" | "latePolicy"> & Partial<Pick<RytmOperationSetInput, "applyAt" | "latePolicy">>,
  ): Promise<QueuedRytmOperationSet | RytmOperationSetDryRun> {
    return this.request("operations.apply_now", input as unknown as Record<string, unknown>);
  }

  async setLiveParameter(input: RytmLiveParameterInput): Promise<RytmLiveParameterInput> {
    return this.request("realtime.set_parameter", input as unknown as Record<string, unknown>);
  }

  async setActiveScene(input: RytmSetActiveSceneInput): Promise<RytmSetActiveSceneInput> {
    return this.request("realtime.set_scene", input as unknown as Record<string, unknown>);
  }

  async setPerformanceMacro(input: RytmSetPerformanceMacroInput): Promise<RytmSetPerformanceMacroInput> {
    return this.request("realtime.set_performance", input as unknown as Record<string, unknown>);
  }

  async triggerTrack(input: RytmTriggerTrackInput): Promise<RytmTriggerTrackInput> {
    return this.request("realtime.trigger_track", input as unknown as Record<string, unknown>);
  }

  async setTransport(input: RytmSetTransportInput): Promise<RytmTransportState> {
    return this.request("realtime.set_transport", input as unknown as Record<string, unknown>);
  }

  async changePattern(input: RytmChangePatternInput): Promise<RytmTransportState> {
    return this.request("realtime.change_pattern", input as unknown as Record<string, unknown>);
  }

  async snapshotState(input: RytmSnapshotInput = {}): Promise<RytmStateSnapshot> {
    return this.request("snapshot.create", input as unknown as Record<string, unknown>);
  }

  async rollbackSnapshot(input: RytmRollbackInput): Promise<RytmBridgeState> {
    return this.request("snapshot.rollback", input as unknown as Record<string, unknown>);
  }

  async getEvents(afterCursor = 0, limit = 100): Promise<Array<{ cursor: number; receivedAt: string; event: unknown }>> {
    return this.request("events.read", { afterCursor, limit });
  }

  async reconcileState(): Promise<unknown> {
    return this.request("state.reconcile");
  }

  async inspectSamples(input: RytmSampleInventoryInput = {}): Promise<RytmSampleInventory> {
    return this.request("samples.inspect", input as Record<string, unknown>);
  }

  async uploadSample(input: RytmUploadSampleInput): Promise<RytmUploadedSample> {
    return this.request("samples.upload", input as unknown as Record<string, unknown>);
  }

  async resolveSampleRam(input: RytmResolveSampleRamInput): Promise<RytmResolvedSampleRam> {
    return this.request("samples.resolve_ram", input as unknown as Record<string, unknown>);
  }

  async clearSampleRam(input: RytmClearSampleRamInput): Promise<RytmClearedSampleRam> {
    return this.request("samples.clear_ram", input as unknown as Record<string, unknown>);
  }

  async listAudioInputs(): Promise<RytmAudioInputInventory> {
    return this.request("audio.list_inputs");
  }

  async startRecording(input: RytmStartRecordingInput = {}): Promise<RytmAudioRecording> {
    return this.request("audio.start_recording", input as unknown as Record<string, unknown>);
  }

  async stopRecording(input: RytmStopRecordingInput): Promise<RytmAudioRecording> {
    return this.request("audio.stop_recording", input as unknown as Record<string, unknown>);
  }

  async capturePatternAudio(input: RytmCapturePatternAudioInput): Promise<RytmAudioRecording> {
    return this.request("audio.capture_pattern", input as unknown as Record<string, unknown>);
  }

  async inspectOverbridgeAudio(): Promise<RytmOverbridgeProviderInventory> {
    return this.request("audio.inspect_overbridge");
  }

  async captureMultitrackAudio(input: RytmCaptureMultitrackAudioInput): Promise<RytmMultitrackRecording> {
    return this.request("audio.capture_multitrack", input as unknown as Record<string, unknown>);
  }

  async advanceMockTransport(steps = 1): Promise<RytmTransportState> {
    return this.request("test.advance_mock_transport", { steps });
  }

  onEvent(listener: (event: RytmRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
      child.stdin.end();
      const timeout = setTimeout(() => child.kill("SIGTERM"), 2_000);
      timeout.unref();
      child.once("close", () => clearTimeout(timeout));
    });
  }

  private requestWithoutStart<T>(
    method: string,
    params: Record<string, unknown>,
    requestId = randomUUID(),
  ): Promise<T> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.stdin.destroyed) {
      return Promise.reject(this.disconnectError("Rust daemon is not connected"));
    }
    if (this.pending.has(requestId)) {
      return Promise.reject(new RytmDaemonRpcError({
        code: "request_id_in_flight",
        message: `request ID is already in flight: ${requestId}`,
        retryable: false,
      }));
    }

    const request: RytmRpcRequest = {
      schema: RYTM_RPC_SCHEMA,
      id: requestId,
      method,
      params,
    };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RytmDaemonRpcError({
          code: "request_timeout",
          message: `Rust daemon did not respond to ${method} within ${this.options.requestTimeoutMs} ms`,
          retryable: true,
        }));
      }, this.options.requestTimeoutMs);
      timeout.unref();
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout });
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.reject(this.disconnectError(`failed to write RPC request: ${error.message}`));
      });
    });
  }

  private handleLine(line: string): void {
    let message: RytmRpcResponse | RytmRpcEvent;
    try {
      message = JSON.parse(line) as RytmRpcResponse | RytmRpcEvent;
    } catch {
      this.rejectAll(new RytmDaemonRpcError({
        code: "invalid_daemon_response",
        message: `Rust daemon emitted non-JSON output: ${line}`,
        retryable: false,
      }));
      return;
    }
    if (message.schema === RYTM_RPC_SCHEMA && "eventId" in message && typeof message.eventId === "string") {
      for (const listener of this.eventListeners) listener(message);
      return;
    }
    const response = message as RytmRpcResponse;
    if (response.schema !== RYTM_RPC_SCHEMA || typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new RytmDaemonRpcError(response.error));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private disconnectError(message: string): RytmDaemonRpcError {
    return new RytmDaemonRpcError({
      code: "daemon_disconnected",
      message: this.intentionalClose ? "Rust daemon was closed" : message,
      retryable: !this.intentionalClose,
    });
  }
}

function defaultDaemonPath(): string {
  const executable = process.platform === "win32" ? "analog-rytm-agent-daemon.exe" : "analog-rytm-agent-daemon";
  return fileURLToPath(new URL(`../../daemon/target/debug/${executable}`, import.meta.url));
}
