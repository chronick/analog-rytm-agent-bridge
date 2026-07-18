import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

// Closed-loop pattern audition: for each slot, activate the pattern, run the
// sequencer from the daemon's generated clock at the pattern's tempo, capture
// a bounded stereo WAV, and verify the sidecar analysis. FILL-conditioned
// fill slots (x07/x08) are EXPECTED silent in normal playback; arrangement
// slots must be audible.
//
//   npm run audition:project                      all 24 Techno Sessions slots
//   npm run audition:project -- A01 B04 C02      specific slots

const TEMPO: Record<string, number> = {
  A01: 134, A02: 134, A03: 138, A04: 138, A05: 138, A06: 130, A07: 134, A08: 138,
  B01: 140, B02: 140, B03: 136, B04: 132, B05: 138, B06: 142, B07: 138, B08: 134,
  C01: 128, C02: 128, C03: 126, C04: 126, C05: 120, C06: 120, C07: 128, C08: 126,
};
const FILL_SLOTS = new Set(["A07", "A08", "B07", "B08", "C07", "C08"]);
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
        const state = (await client.inspectDeviceState()) as { activePattern?: string };
        if (state.activePattern === slot) break;
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
