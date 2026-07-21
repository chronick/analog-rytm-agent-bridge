import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  barMsForTempo,
  barToMs,
  buildSchedule,
  renderScore,
  tempoSegments,
  validateScore,
  type Score,
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
