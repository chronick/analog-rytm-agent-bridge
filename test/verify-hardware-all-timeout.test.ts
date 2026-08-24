import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { armProcessTimeout, defaultStepTimeoutMs, resolveStepTimeoutMs } from "../src/bin/verify-hardware-all.ts";

function spawnHungChild(script: string): ChildProcess {
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

test("resolves the step timeout from the flag, then the environment, then the default", () => {
  assert.equal(resolveStepTimeoutMs([], {}), defaultStepTimeoutMs);
  assert.equal(resolveStepTimeoutMs([], { RYTM_STEP_TIMEOUT_MS: "120000" }), 120_000);
  assert.equal(resolveStepTimeoutMs(["--step-timeout-ms=5000"], { RYTM_STEP_TIMEOUT_MS: "120000" }), 5_000);
  assert.throws(() => resolveStepTimeoutMs(["--step-timeout-ms=10"], {}), /between 1000 and 3600000/);
  assert.throws(() => resolveStepTimeoutMs([], { RYTM_STEP_TIMEOUT_MS: "not-a-number" }), /between 1000 and 3600000/);
});

test("an armed step timeout sends SIGTERM when the child overruns", async () => {
  const child = spawnHungChild("setInterval(() => {}, 1000);");
  const timeout = armProcessTimeout(child, { timeoutMs: 50, killGraceMs: 60_000 });
  const { signal } = await exitOf(child);
  timeout.disarm();
  assert.equal(timeout.timedOut, true);
  assert.equal(signal, "SIGTERM");
});

test("an armed step timeout escalates to SIGKILL when SIGTERM is ignored", async () => {
  const child = spawnHungChild("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const timeout = armProcessTimeout(child, { timeoutMs: 50, killGraceMs: 250 });
  const { code, signal } = await exitOf(child);
  timeout.disarm();
  assert.equal(timeout.timedOut, true);
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
});

test("a step that finishes within its budget is never signalled", async () => {
  const child = spawnHungChild("process.exit(0);");
  const timeout = armProcessTimeout(child, { timeoutMs: 60_000 });
  const { code, signal } = await exitOf(child);
  timeout.disarm();
  assert.equal(timeout.timedOut, false);
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test("rejects a non-positive timeout or kill grace", () => {
  const inert = { kill: () => true };
  assert.throws(() => armProcessTimeout(inert, { timeoutMs: 0 }), /timeoutMs must be a positive integer/);
  assert.throws(() => armProcessTimeout(inert, { timeoutMs: 10, killGraceMs: 0 }), /killGraceMs must be a positive integer/);
});
