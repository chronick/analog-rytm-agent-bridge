import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

type CertificationPhase = "core" | "overbridge";

interface CertificationStep {
  id: string;
  script: string;
  args: string[];
}

const repository = fileURLToPath(new URL("../../", import.meta.url));

/** Wall-clock ceiling for one certification step when nothing overrides it. */
export const defaultStepTimeoutMs = 600_000;
/**
 * Grace between SIGTERM and SIGKILL, mirroring `RustDaemonClient.close()`'s
 * 2s/7s escalation: a certification wedged on a device that never answers can
 * ignore SIGTERM, and without escalation the run would hang forever.
 */
export const stepKillGraceMs = 5_000;

export interface KillableChild {
  kill(signal: NodeJS.Signals): unknown;
}

export interface ArmedProcessTimeout {
  /** True once the timeout fired and termination was requested. */
  readonly timedOut: boolean;
  /** Cancels the timeout and any pending escalation. */
  disarm(): void;
}

/**
 * Arms a wall-clock timeout on a spawned child: SIGTERM when it expires, then
 * SIGKILL after `killGraceMs`. Timers are unref'd so an armed timeout never
 * keeps the process alive on its own.
 */
export function armProcessTimeout(
  child: KillableChild,
  options: { timeoutMs: number; killGraceMs?: number },
): ArmedProcessTimeout {
  const killGrace = options.killGraceMs ?? stepKillGraceMs;
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  if (!Number.isInteger(killGrace) || killGrace < 1) throw new Error("killGraceMs must be a positive integer");
  let timedOut = false;
  let escalation: NodeJS.Timeout | undefined;
  const expiry = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), killGrace);
    escalation.unref();
  }, options.timeoutMs);
  expiry.unref();
  return {
    get timedOut(): boolean {
      return timedOut;
    },
    disarm(): void {
      clearTimeout(expiry);
      if (escalation) clearTimeout(escalation);
    },
  };
}

/** Resolves the per-step timeout from `--step-timeout-ms=` or `RYTM_STEP_TIMEOUT_MS`. */
export function resolveStepTimeoutMs(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): number {
  const flag = argv.find((argument) => argument.startsWith("--step-timeout-ms="))?.slice("--step-timeout-ms=".length);
  const value = flag ?? env.RYTM_STEP_TIMEOUT_MS;
  if (value === undefined || value === "") return defaultStepTimeoutMs;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 3_600_000) {
    throw new Error("step timeout must be an integer between 1000 and 3600000 milliseconds");
  }
  return parsed;
}

export async function runCompleteHardwareVerification(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("refusing complete hardware certification without --execute");
  }
  const phase = readPhase();
  const durationMs = readDurationMs();
  // Resolved once so a malformed override fails before any hardware runs.
  const stepTimeoutMs = resolveStepTimeoutMs();
  const runId = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const outputDirectory = join(repository, "hardware", "runs", `complete-${phase}-${runId}`);
  mkdirSync(outputDirectory, { recursive: true });

  const initial = await inspectSemanticState();
  const results: Array<{ id: string; result: unknown }> = [];
  let failedStep: string | null = null;

  try {
    for (const step of certificationSteps(phase, durationMs)) {
      process.stderr.write(`starting ${step.id} certification\n`);
      try {
        const result = await runStep(step, stepTimeoutMs);
        results.push({ id: step.id, result });
        process.stderr.write(`completed ${step.id} certification\n`);
      } catch (error) {
        failedStep = step.id;
        throw error;
      }
    }
  } finally {
    const final = await inspectSemanticState();
    const restored = deepEqual(initial.semanticState, final.semanticState);
    const stopped = final.playing === false;
    const manifest = {
      schema: "analog-rytm-complete-certification.v1",
      phase,
      runId,
      status: failedStep === null && restored && stopped ? "passed" : "failed",
      failedStep,
      device: {
        model: "Analog Rytm MKII",
        firmware: "1.72",
        finalTransport: stopped ? "stopped" : "playing",
        semanticStateRestored: restored,
      },
      results,
      initial: initial.summary,
      final: final.summary,
    };
    const manifestPath = join(outputDirectory, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(restored, true, "complete certification did not restore semantic device state");
    assert.equal(stopped, true, "complete certification did not leave transport stopped");
    if (failedStep === null) {
      console.log(JSON.stringify({ ...manifest, manifestPath }, null, 2));
    }
  }
}

function certificationSteps(phase: CertificationPhase, durationMs: number): CertificationStep[] {
  if (phase === "overbridge") {
    return [{
      id: "overbridge",
      script: "verify-hardware-overbridge.ts",
      args: ["--execute", `--duration-ms=${durationMs}`],
    }];
  }
  return [
    { id: "control", script: "verify-hardware-control.ts", args: ["--execute"] },
    { id: "scheduler-reconnect", script: "verify-hardware-scheduler.ts", args: ["--execute"] },
    { id: "scene-performance", script: "verify-hardware-macros.ts", args: ["--execute"] },
    { id: "songs", script: "verify-hardware-songs.ts", args: ["--execute"] },
    { id: "samples", script: "verify-hardware-samples.ts", args: ["--execute"] },
    {
      id: "class-compliant-audio",
      script: "verify-hardware-audio.ts",
      args: ["--execute", `--duration-ms=${durationMs}`],
    },
  ];
}

async function runStep(step: CertificationStep, timeoutMs = resolveStepTimeoutMs()): Promise<unknown> {
  const scriptPath = join(repository, "src", "bin", step.script);
  const child = spawn(process.execPath, ["--experimental-transform-types", scriptPath, ...step.args], {
    cwd: repository,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(text);
  });
  // A certification that wedges on an unresponsive device would otherwise hold
  // the whole run open with no ceiling at all.
  const timeout = armProcessTimeout(child, { timeoutMs });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  }).finally(() => timeout.disarm());
  if (timeout.timedOut) {
    throw new Error(`${step.id} certification timed out after ${timeoutMs} ms and was terminated`);
  }
  if (exitCode !== 0) {
    throw new Error(`${step.id} certification failed with exit ${String(exitCode)}: ${stderr.trim()}`);
  }
  try {
    return JSON.parse(stdout.trim()) as unknown;
  } catch (error) {
    throw new Error(`${step.id} emitted invalid JSON: ${String(error)}; stdout=${stdout.trim()}`);
  }
}

async function inspectSemanticState(): Promise<{
  playing: boolean;
  semanticState: unknown;
  summary: { activePattern: unknown; revision: unknown; playing: boolean };
}> {
  const stateDirectory = mkdtempSync(join(tmpdir(), "analog-rytm-complete-inspect-"));
  const client = new RustDaemonClient({
    command: "cargo",
    args: [
      "run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve",
      "--adapter", "hardware", "--state-dir", stateDirectory,
    ],
    cwd: repository,
    requestTimeoutMs: 180_000,
  });
  try {
    await client.start();
    const state = asRecord(await client.inspectDeviceState());
    const transport = asRecord(state.transport);
    return {
      playing: transport.playing === true,
      semanticState: {
        device: state.device,
        activePattern: state.activePattern,
        workBufferSong: state.workBufferSong,
        evidence: state.evidence,
      },
      summary: {
        activePattern: asRecord(state.device).activePattern,
        revision: state.revision,
        playing: transport.playing === true,
      },
    };
  } finally {
    await client.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

function readPhase(): CertificationPhase {
  const value = process.argv.find((argument) => argument.startsWith("--phase="))?.slice("--phase=".length) ?? "core";
  if (value !== "core" && value !== "overbridge") {
    throw new Error("--phase must be core or overbridge");
  }
  return value;
}

function readDurationMs(): number {
  const value = process.argv.find((argument) => argument.startsWith("--duration-ms="))?.slice("--duration-ms=".length);
  if (value === undefined) return 8_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error("--duration-ms must be an integer between 1000 and 60000");
  }
  return parsed;
}

function deepEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepEqual(right, left);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, any> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCompleteHardwareVerification();
}
