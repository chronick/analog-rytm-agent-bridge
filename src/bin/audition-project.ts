import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

// Closed-loop pattern audition: for each slot, activate the pattern, run the
// sequencer from the daemon's generated clock at the pattern's tempo, capture
// a bounded stereo WAV, and verify the sidecar analysis. Every Moonshot slot
// carries its own base groove (FILL conditions only gate extra tears), so
// every slot must be audible.
//
//   npm run audition:project                            all Moonshot slots
//   npm run audition:project -- A01 B04 C02             specific slots
//   npm run audition:project -- E01 E02 --tempo 128     one tempo for every slot
//   npm run audition:project -- --tempos tempos.json    per-slot tempo map
//
// Tempo sources, in the order they are chosen (--tempo and --tempos are
// mutually exclusive -- passing both is an error):
//
//   --tempos <path>  a JSON file holding either a bare slot->bpm map
//                    ({"E01": 118, "E02": 120}) or the same map under a
//                    "tempos" key ({"tempos": {"E01": 118}}). A requested
//                    slot missing from the map is a hard error -- an
//                    explicitly declared map is never silently filled in.
//   --tempo <bpm>    one bpm applied to every requested slot.
//   (neither)        the built-in Moonshot table below, which is now
//                    announced on stderr rather than applied silently.
//
// Commanded tempos are labels only -- the device self-clocks -- so a stale
// table does not corrupt a capture, it just mislabels it. That is exactly why
// the built-in default warns instead of staying quiet.

export const MOONSHOT_TEMPO: Record<string, number> = {
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
  // Bank E - DRIFT: compositional drummy ambient (kit 2, Dm swamp lean).
  // NB: commanded tempos are labels only - the device self-clocks (see memory).
  E01: 120, E02: 120, E03: 120, E04: 120, E05: 118, E06: 120,
  E07: 120, E08: 122, E09: 118, E10: 122, E11: 122, E12: 122,
  // Bank F - EMBER: the floor re-emerges through the ambience (kit 2, Am).
  F01: 118, F02: 120, F03: 120, F04: 122, F05: 122, F06: 124,
  F07: 124, F08: 126, F09: 124, F10: 124, F11: 124, F12: 122,
};
const FILL_SLOTS = new Set<string>(); // Moonshot has no fill-only slots.
const CAPTURE_MS = 8_000;
const SLOT_PATTERN = /^[A-H](0[1-9]|1[0-6])$/;
const MOONSHOT_FALLBACK_TEMPO = 130;

export interface TempoPlan {
  /** Slots to audition, in the order they were requested. */
  slots: string[];
  /** Resolved slot -> commanded bpm for every entry in `slots`. */
  tempos: Record<string, number>;
  /** Where those bpm values came from. */
  source: "moonshot" | "uniform" | "file";
  /** Advisory lines the caller should surface (stderr), never fatal. */
  warnings: string[];
}

function parseTempoFile(text: string, path: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--tempos ${path}: not valid JSON (${(error as Error).message})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--tempos ${path}: expected a JSON object of slot -> bpm`);
  }
  const record = parsed as Record<string, unknown>;
  const wrapped = record.tempos;
  const map = wrapped === undefined ? record : wrapped;
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new Error(`--tempos ${path}: "tempos" must be an object of slot -> bpm`);
  }
  const tempos: Record<string, number> = {};
  for (const [slot, value] of Object.entries(map as Record<string, unknown>)) {
    if (!SLOT_PATTERN.test(slot)) throw new Error(`--tempos ${path}: "${slot}" is not a pattern slot (A01-H16)`);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`--tempos ${path}: ${slot} tempo must be a positive number, got ${JSON.stringify(value)}`);
    }
    tempos[slot] = value;
  }
  if (Object.keys(tempos).length === 0) throw new Error(`--tempos ${path}: declares no tempos`);
  return tempos;
}

/**
 * Turn CLI arguments into the tempo plan the audition loop runs against.
 * Pure apart from the injected file reader, so the resolution rules are
 * testable without hardware.
 */
export function resolveTempoPlan(
  argv: string[],
  readTextFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): TempoPlan {
  const requested = argv.filter((argument) => SLOT_PATTERN.test(argument));

  const tempoIndex = argv.indexOf("--tempo");
  const temposIndex = argv.indexOf("--tempos");
  if (tempoIndex >= 0 && temposIndex >= 0) {
    throw new Error("--tempo and --tempos are mutually exclusive: pass one uniform bpm or one map file");
  }

  const warnings: string[] = [];

  if (temposIndex >= 0) {
    const path = argv[temposIndex + 1];
    if (path === undefined || path.startsWith("--")) throw new Error("--tempos requires a path to a JSON tempo map");
    const declared = parseTempoFile(readTextFile(path), path);
    const slots = requested.length > 0 ? requested : Object.keys(declared);
    const missing = slots.filter((slot) => declared[slot] === undefined);
    if (missing.length > 0) {
      throw new Error(`--tempos ${path}: no tempo declared for ${missing.join(", ")}`);
    }
    const tempos: Record<string, number> = {};
    for (const slot of slots) tempos[slot] = declared[slot];
    return { slots, tempos, source: "file", warnings };
  }

  if (tempoIndex >= 0) {
    const raw = argv[tempoIndex + 1];
    const bpm = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(bpm) || bpm <= 0) throw new Error(`--tempo requires a positive bpm, got ${raw ?? "nothing"}`);
    let slots = requested;
    if (slots.length === 0) {
      slots = Object.keys(MOONSHOT_TEMPO);
      warnings.push(
        `no slots given: auditioning the ${slots.length} built-in Moonshot slots at ${bpm} bpm; ` +
          "pass slots (e.g. E01 E02) to narrow the run.",
      );
    }
    const tempos: Record<string, number> = {};
    for (const slot of slots) tempos[slot] = bpm;
    return { slots, tempos, source: "uniform", warnings };
  }

  const slots = requested.length > 0 ? requested : Object.keys(MOONSHOT_TEMPO);
  const tempos: Record<string, number> = {};
  const fallbacks: string[] = [];
  for (const slot of slots) {
    const declared = MOONSHOT_TEMPO[slot];
    if (declared === undefined) fallbacks.push(slot);
    tempos[slot] = declared ?? MOONSHOT_FALLBACK_TEMPO;
  }
  warnings.push(
    "using the built-in Moonshot tempo table; these bpm values are labels only (the device self-clocks) " +
      "and may be stale for a non-Moonshot project. Override with --tempo <bpm> or --tempos <map.json>.",
  );
  if (fallbacks.length > 0) {
    warnings.push(`no Moonshot tempo for ${fallbacks.join(", ")}: falling back to ${MOONSHOT_FALLBACK_TEMPO} bpm.`);
  }
  return { slots, tempos, source: "moonshot", warnings };
}

interface CaptureResult {
  status: string;
  warnings?: string[];
  audio?: { silence?: boolean; clipping?: boolean; peak?: number; rms?: number };
  analysis?: { silence?: boolean; clipping?: boolean; disconnected?: boolean; droppedBlocks?: number; peak?: number; rms?: number };
  audioPath?: string;
  pattern?: string;
}

export async function runProjectAudition(): Promise<void> {
  const plan = resolveTempoPlan(process.argv.slice(2));
  const { slots, tempos } = plan;
  for (const warning of plan.warnings) process.stderr.write(`warning: ${warning}\n`);
  process.stderr.write(`tempo source: ${plan.source}\n`);
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
      await client.setTransport({ command: "start", tempo: tempos[slot] });
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
      results.push({ slot, tempo: tempos[slot], tempoSource: plan.source, expectSilent, silence, verdict, problems });
      process.stderr.write(`${slot} @${tempos[slot]} ${verdict}${problems.length ? ` (${problems.join("; ")})` : ""}\n`);
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
