import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { promisify } from "node:util";
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
  RytmDaemonDescription,
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

/** One row of the host process table, as used by stale-daemon detection. */
export interface ProcessListEntry {
  pid: number;
  ppid: number;
  command: string;
}

export type ProcessLister = () => Promise<ProcessListEntry[]>;

export interface RustDaemonClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /**
   * Lists the host process table so `start()` can spot a daemon left behind by
   * an earlier session. Injectable so tests never depend on real `ps` output.
   */
  listProcesses?: ProcessLister;
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
  private readonly options:
    & Required<Pick<RustDaemonClientOptions, "command" | "args" | "requestTimeoutMs" | "listProcesses">>
    & Omit<RustDaemonClientOptions, "command" | "args" | "requestTimeoutMs" | "listProcesses">;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: RytmRpcEvent) => void>();
  private child?: ChildProcessWithoutNullStreams;
  private stdout?: ReadLineInterface;
  private stderr = "";
  private starting?: Promise<RytmDaemonHealth>;
  private intentionalClose = false;
  private exitHook?: () => void;

  constructor(options: RustDaemonClientOptions = {}) {
    this.options = {
      command: options.command ?? defaultDaemonPath(),
      args: options.args ?? ["serve", "--adapter", "mock"],
      cwd: options.cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      listProcesses: options.listProcesses ?? listSystemProcesses,
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
    this.starting = this.spawnDaemon().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async spawnDaemon(): Promise<RytmDaemonHealth> {
    await this.guardAgainstExistingDaemon();
    return new Promise<RytmDaemonHealth>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.armExitHook(child);
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
      // Unhandled stream "error" events crash the Node process; an async EPIPE
      // while the daemon dies mid-write must degrade to a disconnect instead.
      child.stdin.on("error", (error: Error) => {
        this.rejectAll(this.disconnectError(`Rust daemon stdin failed: ${error.message}`));
      });
      child.stdout.on("error", (error: Error) => {
        this.rejectAll(this.disconnectError(`Rust daemon stdout failed: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        this.stdout?.close();
        this.stdout = undefined;
        this.child = undefined;
        this.disarmExitHook();
        const detail = this.stderr.trim();
        const reason = `Rust daemon disconnected (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : ""}`;
        this.rejectAll(this.disconnectError(reason));
      });

      this.requestWithoutStart<RytmDaemonHealth>("daemon.health", {}).then(resolve, reject);
    });
  }

  /**
   * A daemon owns exclusive hardware (MIDI ports, Overbridge audio); a second
   * one silently fights the first, which is how a build died mid-run against a
   * daemon left behind by an earlier manual session. Hardware starts therefore
   * refuse outright, while mock starts only warn — the test suite legitimately
   * runs several mock daemons in parallel.
   */
  private async guardAgainstExistingDaemon(): Promise<void> {
    const existing = await this.findForeignDaemons();
    if (existing.length === 0) return;
    const summary = existing.map((entry) => `pid ${entry.pid} (${entry.command})`).join("; ");
    const pids = existing.map((entry) => entry.pid);
    if (!this.targetsHardwareAdapter()) {
      console.warn(
        `RustDaemonClient: ${DAEMON_BINARY} is already running — ${summary}; starting another one anyway (non-hardware adapter)`,
      );
      return;
    }
    throw new RytmDaemonRpcError({
      code: "daemon_already_running",
      message:
        `refusing to spawn a second hardware ${DAEMON_BINARY}: ${existing.length} already running — ${summary}. `
        + `Stop it first with: kill ${pids.join(" ")}`,
      retryable: false,
      details: { pids, processes: existing },
    });
  }

  /**
   * Daemons this Node process already owns are not stale — a script that
   * deliberately runs two daemons cleans them up itself. Only foreign ones,
   * from an earlier session, are reported.
   */
  private async findForeignDaemons(): Promise<ProcessListEntry[]> {
    let entries: ProcessListEntry[];
    try {
      entries = await this.options.listProcesses();
    } catch (error) {
      // Detection is advisory; a missing or failing process listing must never
      // be the reason a daemon cannot start.
      console.warn(
        `RustDaemonClient: stale-daemon detection skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    const ours = descendantPids(entries, process.pid);
    return entries.filter((entry) => !ours.has(entry.pid) && isDaemonCommand(entry.command));
  }

  private targetsHardwareAdapter(): boolean {
    const args = this.options.args;
    return args.some((arg, index) => arg === "--adapter=hardware" || (arg === "--adapter" && args[index + 1] === "hardware"));
  }

  /**
   * `process.exit()` in a helper script skips the async `close()` path, which
   * would orphan the spawned cargo/daemon child. An "exit" handler must be
   * synchronous, so SIGKILL is the only option available here.
   */
  private armExitHook(child: ChildProcessWithoutNullStreams): void {
    this.disarmExitHook();
    const hook = (): void => {
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    this.exitHook = hook;
    process.on("exit", hook);
  }

  private disarmExitHook(): void {
    if (!this.exitHook) return;
    process.removeListener("exit", this.exitHook);
    this.exitHook = undefined;
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

  async describe(): Promise<RytmDaemonDescription> {
    return this.request<RytmDaemonDescription>("daemon.describe");
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
    if (!child) {
      this.disarmExitHook();
      return;
    }
    try {
      await this.terminate(child);
    } finally {
      this.disarmExitHook();
    }
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
      child.stdin.end();
      const terminate = setTimeout(() => child.kill("SIGTERM"), 2_000);
      terminate.unref();
      // A daemon wedged in a syscall can ignore SIGTERM; without escalation
      // this promise would never settle.
      const kill = setTimeout(() => child.kill("SIGKILL"), 7_000);
      kill.unref();
      child.once("close", () => {
        clearTimeout(terminate);
        clearTimeout(kill);
      });
    });
  }

  private requestWithoutStart<T>(
    method: string,
    params: Record<string, unknown>,
    requestId: string = randomUUID(),
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
      // A stray non-protocol line (library log, panic backtrace) must not fail
      // in-flight requests while the daemon is still alive; pending requests
      // are rejected only on stream close/error.
      console.error(`RustDaemonClient: ignoring non-JSON daemon output: ${line}`);
      return;
    }
    if (message.schema === RYTM_RPC_SCHEMA && "eventId" in message && typeof message.eventId === "string") {
      for (const listener of this.eventListeners) listener(message);
      return;
    }
    const response = message as RytmRpcResponse;
    if (response.schema !== RYTM_RPC_SCHEMA) return;
    if (response.id === null) {
      // Protocol-level failures not tied to one request would otherwise be
      // silently discarded.
      if (!response.ok) {
        console.error(
          `RustDaemonClient: daemon reported a global error: ${response.error.code}: ${response.error.message}`,
        );
      }
      return;
    }
    if (typeof response.id !== "string") return;
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

const DAEMON_BINARY = "analog-rytm-agent-daemon";
const execFileAsync = promisify(execFile);

function defaultDaemonPath(): string {
  const executable = process.platform === "win32" ? `${DAEMON_BINARY}.exe` : DAEMON_BINARY;
  return fileURLToPath(new URL(`../../daemon/target/debug/${executable}`, import.meta.url));
}

/** Default process lister: the host process table via `ps`. */
async function listSystemProcesses(): Promise<ProcessListEntry[]> {
  if (process.platform === "win32") return [];
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="], { maxBuffer: 8 * 1024 * 1024 });
  return parseProcessList(stdout);
}

export function parseProcessList(stdout: string): ProcessListEntry[] {
  const entries: ProcessListEntry[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() });
  }
  return entries;
}

/**
 * True only for the daemon binary itself, never for the `cargo run … daemon/Cargo.toml`
 * wrapper that launches it — matching the wrapper would flag every build command.
 */
export function isDaemonCommand(command: string): boolean {
  return command.split(/\s+/).some((token) => {
    const name = token.split(/[\\/]/).pop() ?? "";
    return name === DAEMON_BINARY || name === `${DAEMON_BINARY}.exe`;
  });
}

/** Every pid descending from `root`, including `root` itself. */
function descendantPids(entries: ProcessListEntry[], root: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}
