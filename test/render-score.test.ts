import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  anchoredPlannedOffset,
  barMsForTempo,
  barToMs,
  buildSchedule,
  computeLagGate,
  expandDrift,
  preflightStateFile,
  renderScore,
  tempoSegments,
  validateScore,
  type Score,
  type SentEntry,
} from "../src/bin/render-score.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));

// Daemon timestamps are "unix:{secs}.{millis}", not ISO. Parse to epoch ms.
function parseTs(ts: string): number {
  const match = /^unix:(\d+)\.(\d+)$/.exec(ts);
  if (match) return Number(match[1]) * 1_000 + Number(match[2]);
  return Date.parse(ts);
}

// Map a scheduled send kind to the daemon journal event type it produces.
const KIND_TO_EVENT: Record<string, string> = {
  pattern: "pattern.changed",
  mute: "live.parameter_sent",
  level: "live.parameter_sent",
  scene: "live.scene_sent",
  perf: "live.performance_sent",
  tempo: "transport.changed",
  stop: "transport.changed",
  start: "transport.changed",
};

// --------------------------------------------------------------------------
// Pure-function tests (no daemon)
// --------------------------------------------------------------------------

test("barMsForTempo: 1 bar = 4 beats", () => {
  assert.equal(barMsForTempo(120), 2000); // 4 * 500ms
  assert.equal(barMsForTempo(240), 1000);
});

test("barToMs honours a mid-score tempo change from that bar forward", () => {
  const score: Score = {
    name: "retempo",
    tempo: 120,
    events: [
      { atBar: 0, pattern: "A01" },
      { atBar: 4, tempo: 240 },
    ],
  };
  const segments = tempoSegments(score);
  assert.equal(barToMs(4, segments), 4 * 2000); // first 4 bars at 120bpm
  // 4 bars @120 (8000ms) + 2 bars @240 (2000ms) = 10000ms
  assert.equal(barToMs(6, segments), 8000 + 2000);
});

test("validateScore accepts the documented example shape", () => {
  const score = {
    name: "ignition-sequence",
    tempo: 132,
    leadInBars: 1,
    tailBars: 4,
    events: [
      { atBar: 0, pattern: "A01", immediate: true },
      { atBar: 0, mute: ["BD", "BT"] },
      { atBar: 16, unmute: ["BD"] },
      { atBar: 24, pattern: "A02" },
      { atBar: 32, scene: 6 },
      { atBar: 40, scene: null },
      { atBar: 44, perf: { n: 9, ramp: [[0, 0], [7.5, 127], [8, 0]] } },
      { atBar: 52, level: { track: "CY", to: 40 } },
      { atBar: 56, tempo: 134 },
    ],
  };
  assert.deepEqual(validateScore(score), []);
});

test("validateScore rejects bad slots, tracks, ranges, order, and multi-action", () => {
  assert.ok(validateScore({ name: "", tempo: 132, events: [] }).some((e) => e.includes("name")));
  assert.ok(validateScore({ name: "x", tempo: 10, events: [] }).some((e) => e.includes("tempo")));
  assert.ok(validateScore({ name: "x", tempo: 132, events: [{ atBar: 0, pattern: "Z99" }] }).some((e) => e.includes("A01-H16")));
  assert.ok(validateScore({ name: "x", tempo: 132, events: [{ atBar: 0, mute: ["ZZ"] }] }).some((e) => e.includes("invalid track")));
  assert.ok(validateScore({ name: "x", tempo: 132, events: [{ atBar: 0, scene: 13 }] }).some((e) => e.includes("scene")));
  assert.ok(validateScore({ name: "x", tempo: 132, events: [{ atBar: 0, perf: { n: 99, ramp: [[0, 0]] } }] }).some((e) => e.includes("perf.n")));
  assert.ok(validateScore({ name: "x", tempo: 132, events: [{ atBar: 0, perf: { n: 1, ramp: [[0, 200]] } }] }).some((e) => e.includes("amount")));
  assert.ok(validateScore({ name: "x", tempo: 132, events: [{ atBar: 4, scene: 1 }, { atBar: 2, scene: 2 }] }).some((e) => e.includes("non-decreasing")));
  assert.ok(validateScore({ name: "x", tempo: 132, events: [{ atBar: 0, mute: ["BD"], scene: 1 }] }).some((e) => e.includes("multiple actions")));
  assert.ok(validateScore({ name: "x", tempo: 132, events: [{ atBar: 0, immediate: true, scene: 1 }] }).some((e) => e.includes("immediate is only valid")));
});

test("validateScore ignores unknown TOP-LEVEL keys but rejects unknown EVENT keys", () => {
  const withMetadata = {
    name: "ep-track",
    tempo: 132,
    ep: "moonshot",
    trackNumber: 2,
    notes: "the drop is the unmute",
    events: [{ atBar: 0, pattern: "A01" }],
  };
  assert.deepEqual(validateScore(withMetadata), []);

  const badEventKey = {
    name: "x",
    tempo: 132,
    events: [{ atBar: 0, pattern: "A01", comment: "sneaky" }],
  };
  assert.ok(validateScore(badEventKey).some((e) => e.includes('unknown key "comment"')));
});

test("validateScore stop rules: EP endings", () => {
  // Stop with level/scene ring-out actions after it is valid.
  const ringOut = {
    name: "ep-ending",
    tempo: 132,
    tailBars: 8,
    events: [
      { atBar: 0, pattern: "A01" },
      { atBar: 32, stop: true },
      { atBar: 33, scene: null },
      { atBar: 34, level: { track: "CY", to: 0 } },
    ],
  };
  assert.deepEqual(validateScore(ringOut), []);

  const after = (event: Record<string, unknown>) => validateScore({
    name: "x", tempo: 132,
    events: [{ atBar: 0, stop: true }, { atBar: 1, ...event }],
  });
  assert.ok(after({ pattern: "A02" }).some((e) => e.includes("after stop")));
  assert.ok(after({ mute: ["BD"] }).some((e) => e.includes("after stop")));
  assert.ok(after({ unmuteAll: true }).some((e) => e.includes("after stop")));
  assert.ok(after({ perf: { n: 1, ramp: [[0, 0]] } }).some((e) => e.includes("after stop")));
  assert.ok(after({ tempo: 140 }).some((e) => e.includes("restart the transport")));
  assert.ok(after({ stop: true }).some((e) => e.includes("at most one stop")));
  assert.ok(validateScore({ name: "x", tempo: 132, events: [{ atBar: 0, stop: false }] })
    .some((e) => e.includes("stop must be true")));
});

test("buildSchedule resolves mute deltas, soloKeep, unmuteAll, and perf sampling", () => {
  const score: Score = {
    name: "mute-spine",
    tempo: 240, // 1 bar = 1000ms
    events: [
      { atBar: 0, mute: ["BD", "BT"] },      // 2 sends: BD, BT muted
      { atBar: 1, mute: ["BD"] },            // no-op (already muted) -> 0 sends
      { atBar: 2, unmute: ["BD"] },          // 1 send: BD unmuted
      { atBar: 3, soloKeep: ["CH"] },        // mute all-but-CH; BT already muted, BD re-muted, others muted, CH stays audible
      { atBar: 4, unmuteAll: true },         // unmute everything currently muted
      { atBar: 5, perf: { n: 9, ramp: [[0, 0], [1, 127]] } }, // 0 + 4 steps (0.25 res) = 5 sends
    ],
  };
  const schedule = buildSchedule(score);

  // atBar 1 mute of already-muted BD produces no send (delta-only bookkeeping).
  const bar1 = schedule.sends.filter((s) => s.atBar === 1);
  assert.equal(bar1.length, 0);

  // soloKeep at bar 3: everything except CH must end muted. Before bar 3, muted
  // = {BT} (BD was unmuted at bar 2). BT is already muted (no-op) and CH stays
  // audible, so it mutes the other 10 tracks -> 10 delta sends.
  const bar3 = schedule.sends.filter((s) => s.atBar === 3);
  assert.equal(bar3.length, 10);
  assert.ok(bar3.every((s) => s.kind === "mute" && s.muted === true));
  assert.ok(!bar3.some((s) => s.kind === "mute" && s.track === "CH"));

  // perf ramp [[0,0],[1,127]] at 0.25-bar resolution: 1 initial + 4 interpolated.
  const perf = schedule.sends.filter((s) => s.kind === "perf");
  assert.equal(perf.length, 5);
  assert.equal(perf[0].kind === "perf" && perf[0].amount, 0);
  assert.equal(perf[4].kind === "perf" && perf[4].amount, 127);

  // Schedule is sorted by absolute time.
  for (let i = 1; i < schedule.sends.length; i += 1) {
    assert.ok(schedule.sends[i].offsetMs >= schedule.sends[i - 1].offsetMs);
  }
});

// --------------------------------------------------------------------------
// Dynamic lead-in sizing
// --------------------------------------------------------------------------

test("buildSchedule sizes the lead-in to cover the bar-0 block", () => {
  // leadInBars 0 -> requested 0; bar-0 block = 12 reset sweep + 1 pattern +
  // 2 mutes = 15 sends -> estimate 15*300 = 4500 -> effective 4500 + 750.
  const score: Score = {
    name: "leadin",
    tempo: 120, // 1 bar = 2000ms
    leadInBars: 0,
    events: [
      { atBar: 0, pattern: "A01" },
      { atBar: 0, mute: ["BD", "BT"] },
      { atBar: 4, scene: 1 },
    ],
  };
  const schedule = buildSchedule(score);
  assert.equal(schedule.bar0SendCount, 15);
  assert.equal(schedule.bar0EstimateMs, 4500);
  assert.equal(schedule.requestedLeadInMs, 0);
  assert.equal(schedule.effectiveLeadInMs, 5250); // 4500 + 750
  assert.equal(schedule.leadInMs, 5250); // back-compat alias == effective

  // Transport start sits at the effective lead-in, AFTER the bar-0 block.
  const start = schedule.sends.find((s) => s.kind === "start");
  assert.ok(start && start.offsetMs === 5250);

  // Post-start (music-grid) sends are anchored onto the effective lead-in:
  // scene at bar 4 -> 5250 + 4*2000 = 13250.
  const scene = schedule.sends.find((s) => s.kind === "scene");
  assert.ok(scene && scene.offsetMs === 13250);

  // The reset sweep stays pinned at offset 0 (fires during the lead-in).
  const sweep = schedule.sends.filter((s) => s.offsetMs === 0);
  assert.equal(sweep.length, 12);
  assert.ok(sweep.every((s) => s.kind === "mute" && s.muted === false));
});

test("buildSchedule keeps a large requested lead-in when it exceeds the estimate", () => {
  // leadInBars 8 @120 = 16000ms, well over the bar-0 estimate (13*300+750).
  const score: Score = {
    name: "big-leadin",
    tempo: 120,
    leadInBars: 8,
    events: [{ atBar: 0, pattern: "A01" }],
  };
  const schedule = buildSchedule(score);
  assert.equal(schedule.requestedLeadInMs, 16000);
  assert.equal(schedule.effectiveLeadInMs, 16000);
  const start = schedule.sends.find((s) => s.kind === "start");
  assert.ok(start && start.offsetMs === 16000);
});

// --------------------------------------------------------------------------
// Drift gestures
// --------------------------------------------------------------------------

test("expandDrift: sine period, clamp, and consecutive-value dedupe", () => {
  // center 100, depth 8, period 12, res 1, until 4, sine:
  // bar0..4 -> 100, 104, 107, 108, 107.
  const sine = expandDrift(
    { track: "CH", param: "level", center: 100, depth: 8, periodBars: 12, untilBar: 4, resolutionBars: 1 },
    0,
  );
  assert.deepEqual(sine.map((p) => p.value), [100, 104, 107, 108, 107]);
  assert.deepEqual(sine.map((p) => p.bar), [0, 1, 2, 3, 4]);

  // Huge depth clamps into 0..127; long runs at the rails collapse via dedupe.
  const clamped = expandDrift(
    { perf: 3, center: 64, depth: 200, periodBars: 8, untilBar: 8, resolutionBars: 0.5 },
    0,
  );
  assert.ok(clamped.every((p) => p.value >= 0 && p.value <= 127), "clamped 0..127");
  assert.deepEqual(clamped.map((p) => p.value), [64, 127, 64, 0, 64], "deduped rail runs");

  // A zero-depth drift is constant -> a single send after dedupe.
  const flat = expandDrift(
    { track: "BD", center: 90, depth: 0, periodBars: 4, untilBar: 16, resolutionBars: 0.5 },
    0,
  );
  assert.equal(flat.length, 1);
  assert.equal(flat[0].value, 90);
});

test("expandDrift: triangle shape and phase offset", () => {
  // triangle center 64 depth 64 period 4 res 1: 64, +peak(127 clamped), 64, 0, 64.
  const tri = expandDrift(
    { track: "BD", center: 64, depth: 64, periodBars: 4, untilBar: 4, resolutionBars: 1, shape: "triangle" },
    0,
  );
  assert.deepEqual(tri.map((p) => p.value), [64, 127, 64, 0, 64]);

  // phase quarter-period shifts a sine peak to bar 0.
  const phased = expandDrift(
    { track: "BD", center: 64, depth: 60, periodBars: 4, untilBar: 1, resolutionBars: 1, phase: 1 },
    0,
  );
  assert.equal(phased[0].value, 124); // sin(2*pi*1/4) = 1 -> 64 + 60
});

test("buildSchedule expands a track drift onto live level sends and a perf drift onto macro sends", () => {
  const score: Score = {
    name: "drift-both",
    tempo: 240, // 1 bar = 1000ms
    leadInBars: 0,
    events: [
      { atBar: 16, drift: { track: "CH", param: "level", center: 100, depth: 8, periodBars: 12, untilBar: 20, resolutionBars: 1 } },
      { atBar: 24, drift: { perf: 3, center: 20, depth: 15, periodBars: 16, untilBar: 28, resolutionBars: 1 } },
    ],
  };
  const schedule = buildSchedule(score);

  const levels = schedule.sends.filter((s) => s.kind === "level");
  assert.ok(levels.length > 0);
  assert.ok(levels.every((s) => s.kind === "level" && s.track === "CH"));
  // Track drift starts at atBar 16: first level send is at bar 16.
  assert.ok(levels.every((s) => s.atBar >= 16 && s.atBar <= 20));

  const perfs = schedule.sends.filter((s) => s.kind === "perf");
  assert.ok(perfs.length > 0);
  assert.ok(perfs.every((s) => s.kind === "perf" && s.performance === 3));
  assert.ok(perfs.every((s) => s.atBar >= 24 && s.atBar <= 28));

  // musicalEndBar extends to the last drift's untilBar so the tail covers it.
  assert.equal(schedule.musicalEndBar, 28);
});

test("validateScore drift errors: missing fields, bad range, resolution, target", () => {
  const err = (event: Record<string, unknown>) =>
    validateScore({ name: "x", tempo: 120, events: [{ atBar: 0, ...event }] });

  assert.ok(err({ drift: { track: "CH", center: 1, depth: 1, periodBars: 4 } })
    .some((e) => e.includes("untilBar is required")));
  assert.ok(err({ drift: { track: "CH", center: 1, depth: 1, untilBar: 8 } })
    .some((e) => e.includes("periodBars is required")));
  assert.ok(validateScore({ name: "x", tempo: 120, events: [{ atBar: 8, drift: { track: "CH", center: 1, depth: 1, periodBars: 4, untilBar: 4 } }] })
    .some((e) => e.includes("must be greater than atBar")));
  assert.ok(err({ drift: { track: "CH", center: 1, depth: 1, periodBars: 4, untilBar: 8, resolutionBars: 0.1 } })
    .some((e) => e.includes("resolutionBars must be a number >= 0.25")));
  assert.ok(err({ drift: { center: 1, depth: 1, periodBars: 4, untilBar: 8 } })
    .some((e) => e.includes("must target either perf")));
  assert.ok(err({ drift: { perf: 3, track: "CH", center: 1, depth: 1, periodBars: 4, untilBar: 8 } })
    .some((e) => e.includes("cannot target both")));
  assert.ok(err({ drift: { perf: 99, center: 1, depth: 1, periodBars: 4, untilBar: 8 } })
    .some((e) => e.includes("drift.perf must be an integer 1-12")));
  assert.ok(err({ drift: { track: "ZZ", center: 1, depth: 1, periodBars: 4, untilBar: 8 } })
    .some((e) => e.includes("drift.track must be a valid track id")));
  assert.ok(err({ drift: { track: "CH", param: "pan", center: 1, depth: 1, periodBars: 4, untilBar: 8 } })
    .some((e) => e.includes('drift.param must be "level"')));
  assert.ok(err({ drift: { track: "CH", center: 1, depth: 1, periodBars: 4, untilBar: 8, wobble: 2 } })
    .some((e) => e.includes('unknown key "wobble"')));
  // drift is an action -> after a stop event it is rejected like other sequenced actions.
  assert.ok(validateScore({ name: "x", tempo: 120, events: [{ atBar: 0, stop: true }, { atBar: 1, drift: { track: "CH", center: 1, depth: 1, periodBars: 4, untilBar: 8 } }] })
    .some((e) => e.includes("after stop")));
  // A well-formed drift validates clean.
  assert.deepEqual(
    validateScore({ name: "x", tempo: 120, events: [{ atBar: 16, drift: { track: "CH", param: "level", center: 100, depth: 8, periodBars: 12, untilBar: 60 } }] }),
    [],
  );
});

test("validateScore budget guard rejects oversized drift expansions naming the culprit", () => {
  // res 0.25 over 400 bars at period 3 -> ~1601 sends, far over the 800 budget.
  const errors = validateScore({
    name: "x",
    tempo: 120,
    events: [{ atBar: 0, drift: { perf: 3, center: 64, depth: 60, periodBars: 3, untilBar: 400, resolutionBars: 0.25 } }],
  });
  const budget = errors.find((e) => e.includes("budget"));
  assert.ok(budget, "budget guard fires");
  assert.ok(budget!.includes("events[0]"), "names the offending drift event");
  assert.ok(budget!.includes("perf 3"), "names the drift target");
  assert.ok(/exceeding the 800 budget/.test(budget!), "names the limit");
});

// --------------------------------------------------------------------------
// Transport re-anchor + lag self-gate
// --------------------------------------------------------------------------

test("anchoredPlannedOffset shifts only post-start sends", () => {
  // Pre-start and the start send itself are never shifted.
  assert.equal(anchoredPlannedOffset(2000, false, 1500), 2000);
  // Post-start sends slide by the whole anchor shift onto the music grid.
  assert.equal(anchoredPlannedOffset(6000, true, 1500), 7500);
  assert.equal(anchoredPlannedOffset(6000, true, 0), 6000);
});

test("computeLagGate: pass, median failure, p95 failure, and empty post-start", () => {
  const entry = (postStart: boolean, actual: number, anchored: number): SentEntry => ({
    seq: 0, kind: "level", atBar: 0, plannedOffsetMs: anchored,
    anchoredPlannedOffsetMs: anchored, actualOffsetMs: actual, postStart,
    lagMs: actual - anchored, payload: {},
  });

  // All post-start lags tiny -> pass. A pre-start outlier is ignored.
  const pass = computeLagGate([
    entry(false, 9000, 0), // huge, but pre-start -> excluded
    entry(true, 102, 100),
    entry(true, 205, 200),
    entry(true, 298, 300),
  ], 3);
  assert.equal(pass.passed, true);
  assert.equal(pass.postStartCount, 3);
  assert.equal(pass.anchorShiftMs, 3);
  assert.ok(pass.medianLagMs <= 60 && pass.p95LagMs <= 500);

  // Median over threshold -> fail (every post-start lag ~100ms).
  const medFail = computeLagGate(
    Array.from({ length: 5 }, () => entry(true, 200, 100)),
    0,
  );
  assert.equal(medFail.medianLagMs, 100);
  assert.equal(medFail.passed, false);

  // Median fine but a single p95 outlier over 500ms -> fail.
  const p95Fail = computeLagGate([
    entry(true, 105, 100),
    entry(true, 210, 200),
    entry(true, 900, 300), // 600ms outlier
  ], 0);
  assert.ok(p95Fail.medianLagMs <= 60);
  assert.ok(p95Fail.p95LagMs > 500);
  assert.equal(p95Fail.passed, false);

  // No post-start sends -> trivially passes.
  const empty = computeLagGate([entry(false, 500, 0)], 0);
  assert.equal(empty.passed, true);
  assert.equal(empty.postStartCount, 0);
});

// --------------------------------------------------------------------------
// State-file preflight
// --------------------------------------------------------------------------

test("preflightStateFile: missing ok, under-limit ok, over-limit aborts with size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rytm-state-"));
  try {
    const missing = preflightStateFile(join(dir, "nope.json"), 6 * 1024 * 1024);
    assert.equal(missing.ok, true);
    assert.equal(missing.sizeBytes, null);

    const small = join(dir, "small.json");
    await writeFile(small, "x".repeat(100));
    assert.equal(preflightStateFile(small, 6 * 1024 * 1024).ok, true);

    // Use a tiny maxBytes so we don't have to write a 6 MB file.
    const over = preflightStateFile(small, 10);
    assert.equal(over.ok, false);
    assert.equal(over.sizeBytes, 100);
    assert.ok(over.message && over.message.includes("prune"), "message tells operator to prune");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// End-to-end against the Rust MOCK daemon
// --------------------------------------------------------------------------

test("renders a tiny score end-to-end through the mock daemon", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "rytm-render-score-"));
  // Fast tempo keeps wall-clock small: 300bpm -> 1 bar = 800ms.
  const score: Score = {
    name: "e2e",
    tempo: 300,
    leadInBars: 0,
    tailBars: 0.25,
    events: [
      { atBar: 0, pattern: "A01", immediate: true },   // pattern.changed
      { atBar: 0, mute: ["BD", "BT"] },                // 2x live.parameter_sent
      { atBar: 0.5, unmute: ["BD"] },                  // live.parameter_sent
      { atBar: 1, scene: 3 },                          // live.scene_sent
      { atBar: 1.5, level: { track: "CY", to: 40 } },  // live.parameter_sent
      { atBar: 2, perf: { n: 9, ramp: [[0, 0], [0.25, 127]] } }, // 2x live.performance_sent
      { atBar: 2.5, stop: true },                      // transport.changed (EP ending)
      { atBar: 2.625, scene: null },                   // live.scene_sent (ring-out release)
    ],
  };

  try {
    const summary = await renderScore({
      score,
      outDir,
      adapter: "mock",
      repository: REPOSITORY,
      requestTimeoutMs: 60_000,
    });

    // Recording completed and produced a real WAV on disk.
    assert.equal(summary.adapter, "mock");
    assert.equal(summary.recording.status, "completed");
    assert.ok(summary.wavPath, "expected a WAV path");
    const wavStat = await stat(summary.wavPath as string);
    assert.ok(wavStat.size > 0, "WAV file should be non-empty");

    // The sent sequence is what we planned, in time order, preceded by the
    // 12-track unmute reset sweep (device mutes persist across takes). Then:
    // mute ["BD","BT"] -> two mute sends; unmute ["BD"] -> one mute-kind send.
    const sentKinds = summary.sent.map((s) => s.kind);
    const resetSweep = Array.from({ length: 12 }, () => "mute");
    // Transport start is scheduled AFTER the bar-0 state (leadIn 0 here, so it
    // sorts behind every offset-0 send: reset sweep + bar-0 pattern/mutes).
    assert.deepEqual(sentKinds, [...resetSweep, "pattern", "mute", "mute", "start", "mute", "scene", "level", "perf", "perf", "stop", "scene"]);
    assert.ok(
      summary.sent.slice(0, 12).every((s) => {
        const payload = (s as { payload?: { value?: number } }).payload;
        return s.kind === "mute" && payload?.value === 0;
      }),
      "reset sweep unmutes all 12 tracks",
    );
    assert.equal(summary.schedule.sendCount, summary.sent.length);

    // Dynamic lead-in: leadInBars 0 forces the lead-in to cover the bar-0 block
    // (12 reset + pattern + 2 mutes = 15 sends -> 4500ms estimate + 750ms).
    assert.equal(summary.schedule.requestedLeadInMs, 0);
    assert.equal(summary.schedule.bar0SendCount, 15);
    assert.equal(summary.schedule.bar0EstimateMs, 4500);
    assert.equal(summary.schedule.effectiveLeadInMs, 5250);
    assert.equal(summary.schedule.leadInMs, 5250);

    // Transport re-anchor bookkeeping: exactly one start send, flagged
    // pre-start; the shift is the start send's own lateness.
    const starts = summary.sent.filter((s) => s.kind === "start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].postStart, false);
    const anchorShiftMs = starts[0].actualOffsetMs - starts[0].plannedOffsetMs;
    assert.equal(summary.schedule.anchorShiftMs, Math.round(anchorShiftMs));
    assert.equal(summary.lagGate.anchorShiftMs, Math.round(anchorShiftMs));

    // Every send carries the additive anchor fields, and the shift is applied
    // to post-start (music-grid) sends only. Pre-start sends keep raw offsets.
    let seenStart = false;
    for (const entry of summary.sent) {
      assert.equal(typeof entry.postStart, "boolean");
      assert.equal(entry.lagMs, entry.actualOffsetMs - entry.anchoredPlannedOffsetMs);
      if (seenStart) {
        assert.equal(entry.postStart, true, `${entry.kind} after start is post-start`);
        assert.equal(entry.anchoredPlannedOffsetMs, entry.plannedOffsetMs + Math.round(anchorShiftMs));
      } else {
        assert.equal(entry.postStart, false);
        assert.equal(entry.anchoredPlannedOffsetMs, entry.plannedOffsetMs);
      }
      if (entry.kind === "start") seenStart = true;
    }

    // Lag self-gate is always recorded. With the generous dynamic lead-in the
    // mock keeps the start on time, so the take passes its own gate.
    assert.equal(summary.lagGate.thresholds.medianMs, 60);
    assert.equal(summary.lagGate.thresholds.p95Ms, 500);
    assert.equal(summary.lagGate.passed, true);
    assert.ok(summary.lagGate.postStartCount > 0);

    // events.json is additive/back-compat: original schema plus the new blocks.
    const log = JSON.parse(await readFile(summary.eventsLogPath, "utf8")) as {
      schema: string;
      schedule: { effectiveLeadInMs: number; anchorShiftMs: number; bar0SendCount: number };
      lagGate: { passed: boolean };
      sent: Array<{ postStart: boolean; anchoredPlannedOffsetMs: number }>;
    };
    assert.equal(log.schema, "analog-rytm-score-render.v1");
    assert.equal(log.schedule.effectiveLeadInMs, 5250);
    assert.equal(log.schedule.bar0SendCount, 15);
    assert.equal(typeof log.schedule.anchorShiftMs, "number");
    assert.equal(log.lagGate.passed, true);
    assert.ok(log.sent.every((s) => typeof s.postStart === "boolean" && typeof s.anchoredPlannedOffsetMs === "number"));

    // The daemon journal carries the events in the exact order they were sent
    // (transport start is now IN the sequence, after the bar-0 state). The
    // score's stop event cut the sequencer itself, so the renderer adds no
    // extra trailing transport stop.
    const journalTypes = summary.daemonEvents.map((e) => e.type);
    const expectedAll = summary.sent.map((s) => KIND_TO_EVENT[s.kind]);
    assert.deepEqual(journalTypes, expectedAll);

    // Timestamps are sane (finite) and monotonic non-decreasing (sane ordering).
    const times = summary.daemonEvents.map((e) => parseTs(e.receivedAt));
    assert.ok(times.every((t) => Number.isFinite(t)), "every journal timestamp parses");
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i] >= times[i - 1], `journal timestamps must be non-decreasing at ${i}`);
    }

    // Recording start/stop bracket every event (generous CI tolerance).
    const TOLERANCE_MS = 1_000;
    const startedAt = parseTs(summary.recording.startedAt as string);
    const stoppedAt = parseTs(summary.recording.stoppedAt as string);
    assert.ok(Number.isFinite(startedAt) && Number.isFinite(stoppedAt));
    assert.ok(startedAt <= times[0] + TOLERANCE_MS, "recording started before the first event");
    assert.ok(stoppedAt >= times[times.length - 1] - TOLERANCE_MS, "recording stopped after the last event");
    assert.ok(stoppedAt >= startedAt, "stop is after start");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
