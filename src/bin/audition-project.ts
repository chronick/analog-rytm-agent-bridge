import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

// Closed-loop pattern audition: for each slot, activate the pattern, run the
// sequencer from the daemon's generated clock at the pattern's tempo, capture
// a bounded stereo WAV, and verify the sidecar analysis. Every Moonshot slot
// carries its own base groove (FILL conditions only gate extra tears), so
// every slot must be audible.
//
//   npm run audition:project                      all 36 Moonshot slots
//   npm run audition:project -- A01 B04 C02      specific slots

const TEMPO: Record<string, number> = {
  // Bank A - IGNITION: driving, rising through the peak, easing into the break.
  A01: 132, A02: 132, A03: 134, A04: 134, A05: 136, A06: 136, A07: 138, A08: 138,
  A09: 132, A10: 128, A11: 132, A12: 132,
  // Bank B - ORBIT: steady hypnotic pocket.
  B01: 132, B02: 132, B03: 132, B04: 132, B05: 130, B06: 130, B07: 130, B08: 130,
  B09: 132, B10: 134, B11: 132, B12: 132,
  // Bank C - ESCAPE VELOCITY: broken, dipping for the breakdown, landing at speed.
  C01: 130, C02: 130, C03: 128, C04: 128, C05: 126, C06: 126, C07: 124, C08: 126,
  C09: 118, C10: 118, C11: 130, C12: 132,
  // Bank D - TRIBE: drum-circle momentum, building through the ceremony.
  D01: 128, D02: 130, D03: 132, D04: 130, D05: 132, D06: 134,
};
const FILL_SLOTS = new Set<string>(); // Moonshot has no fill-only slots.
const CAPTURE_MS = 8_000;

interface CaptureResult {
  status: string;
  warnings?: string[];
  audio?: { silence?: boolean; clipping?: boolean; peak?: number; rms?: number };
  analysis?: { silence?: boolean; clipping?: boolean; disconnected?: boolean; droppedBlocks?: number; peak?: number; rms?: number };
  audioPath?: string;
  pattern?: string;
}

export async function runProjectAudition(): Promise<void> {
  const requested = process.argv.slice(2).filter((argument) => /^[A-H](0[1-9]|1[0-6])$/.test(argument));
  const slots = requested.length > 0 ? requested : Object.keys(TEMPO);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const auditionDirectory = `${repository}hardware/runs/audition-${stamp}`;
  mkdirSync(auditionDirectory, { recursive: true });

  const client = new RustDaemonClient({
    command: "cargo",
    args: [
      "run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve",
      "--adapter", "hardware", "--clock-source", "generated", "--audio-dir", auditionDirectory,
    ],
    cwd: repository,
    requestTimeoutMs: 120_000,
  });
  const results: Array<Record<string, unknown>> = [];
  try {
    const health = await client.start();
    assert.equal(health.adapter, "hardware");

    for (const slot of slots) {
      await client.changePattern({ pattern: slot, immediate: true });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const state = (await client.inspectDeviceState()) as { activePattern?: string | { pattern?: string } };
        const active = typeof state.activePattern === "object" ? state.activePattern?.pattern : state.activePattern;
        if (active === slot) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await client.setTransport({ command: "start", tempo: TEMPO[slot] ?? 130 });
      const capture = (await client.capturePatternAudio({
        recordingId: `audition-${stamp}-${slot}`,
        durationMs: CAPTURE_MS,
      })) as CaptureResult;
      await client.setTransport({ command: "stop" });

      const peak = capture.analysis?.peak ?? capture.audio?.peak ?? 0;
      // Treat near-floor bleed as silent for verification (strict silence is peak <= 1e-4).
      const silence = (capture.analysis?.silence ?? capture.audio?.silence ?? false) || peak < 0.005;
      const expectSilent = FILL_SLOTS.has(slot);
      const problems: string[] = [];
      if (capture.status !== "completed") problems.push(`status=${capture.status}`);
      if (capture.analysis?.disconnected) problems.push("disconnected");
      if ((capture.analysis?.droppedBlocks ?? 0) > 0) problems.push(`dropped=${capture.analysis?.droppedBlocks}`);
      if (!expectSilent && silence) problems.push("unexpectedly silent");
      if (expectSilent && !silence) problems.push("fill sounded without FILL held");
      for (const warning of capture.warnings ?? []) {
        if (!(expectSilent && /silen/i.test(warning))) problems.push(warning);
      }
      const verdict = problems.length === 0 ? "ok" : "check";
      results.push({ slot, tempo: TEMPO[slot], expectSilent, silence, verdict, problems });
      process.stderr.write(`${slot} @${TEMPO[slot]} ${verdict}${problems.length ? ` (${problems.join("; ")})` : ""}\n`);
    }
  } finally {
    try {
      await client.setTransport({ command: "stop" });
    } catch {
      // transport already stopped or daemon gone; shutdown cleanup handles it
    }
    await client.close();
  }
  const failed = results.filter((entry) => entry.verdict !== "ok");
  process.stdout.write(`${JSON.stringify({ auditionDirectory, captured: results.length, flagged: failed.length, results }, null, 2)}\n`);
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) await runProjectAudition();
