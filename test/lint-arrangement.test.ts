import assert from "node:assert/strict";
import test from "node:test";
import { buildEpSummary, lintArrangement } from "../src/bin/lint-arrangement.ts";
import type { ArrangementReport } from "../src/bin/lint-arrangement.ts";

// ---------------------------------------------------------------------------
// The five PERIGEE v1 exemplars -- the music-production skill's calibration
// corpus, pinned here verbatim (captured from
// vault/music/rytm/moonshot/scores/*.json). These are inlined rather than
// read from the vault path: the vault is a separate, mutable repo the author
// keeps revising (a "v2" pass had already landed there mid-development of
// this linter), and this suite needs a fixed, reproducible v1 to calibrate
// against -- the whole point of the exercise is "v1 should trip these flags."
// Decorative top-level keys (ep/trackNumber/notes) are dropped; they don't
// affect linting (validateScore ignores unknown top-level keys).
// ---------------------------------------------------------------------------

const FIRST_LIGHT = {
  name: "first-light",
  tempo: 121.43,
  leadInBars: 1,
  tailBars: 6,
  events: [
    { atBar: 0, pattern: "E01", immediate: true },
    { atBar: 0, soloKeep: ["BT"] },
    { atBar: 8, unmute: ["RS"] },
    { atBar: 12, unmute: ["CH"] },
    { atBar: 16, pattern: "E02" },
    { atBar: 16, unmute: ["BD", "LT"] },
    { atBar: 24, pattern: "E04" },
    { atBar: 24, unmute: ["MT"] },
    { atBar: 32, pattern: "E05" },
    { atBar: 32, unmuteAll: true },
    { atBar: 40, scene: 3 },
    { atBar: 46, scene: null },
    { atBar: 48, pattern: "E06" },
    { atBar: 56, perf: { n: 12, ramp: [[0, 0], [4, 84], [8, 24], [10, 0]] } },
    { atBar: 68, pattern: "E09" },
    { atBar: 68, soloKeep: ["BT", "LT", "RS"] },
    { atBar: 76, scene: 12 },
    { atBar: 84, scene: null },
    { atBar: 86, pattern: "E01" },
    { atBar: 86, soloKeep: ["BT"] },
    { atBar: 94, stop: true },
  ],
};

const IGNITION_SEQUENCE = {
  name: "ignition-sequence",
  tempo: 121.43,
  leadInBars: 1,
  tailBars: 4,
  events: [
    { atBar: 0, pattern: "A01", immediate: true },
    { atBar: 0, mute: ["BD", "BT", "SD", "CY"] },
    { atBar: 8, unmute: ["SD"] },
    { atBar: 12, perf: { n: 3, ramp: [[0, 0], [3, 48], [3.9, 0]] } },
    { atBar: 16, unmute: ["BD", "BT"] },
    { atBar: 24, pattern: "A02" },
    { atBar: 32, unmute: ["CY"] },
    { atBar: 36, pattern: "A03" },
    { atBar: 48, pattern: "A05" },
    { atBar: 56, perf: { n: 9, ramp: [[0, 0], [2, 40], [5, 88], [7.5, 127], [8, 0]] } },
    { atBar: 64, pattern: "A08" },
    { atBar: 80, pattern: "A10" },
    { atBar: 80, soloKeep: ["CY", "OH", "LT", "BT"] },
    { atBar: 88, scene: 3 },
    { atBar: 94, scene: null },
    { atBar: 96, pattern: "A11" },
    { atBar: 96, unmuteAll: true },
    { atBar: 96, mute: ["BD"] },
    { atBar: 100, unmute: ["BD"] },
    { atBar: 112, pattern: "A12" },
    { atBar: 120, scene: 6 },
    { atBar: 132, scene: null },
    { atBar: 136, mute: ["SD", "CP", "CY"] },
    { atBar: 140, soloKeep: ["CH", "BD"] },
    { atBar: 144, mute: ["BD"] },
    { atBar: 146, stop: true },
  ],
};

const CEREMONY = {
  name: "ceremony",
  tempo: 121.43,
  leadInBars: 1,
  tailBars: 4,
  events: [
    { atBar: 0, pattern: "D01", immediate: true },
    { atBar: 8, scene: 3 },
    { atBar: 14, scene: null },
    { atBar: 16, pattern: "D02" },
    { atBar: 32, pattern: "D03" },
    { atBar: 36, mute: ["RS"] },
    { atBar: 40, unmute: ["RS"] },
    { atBar: 40, mute: ["CP"] },
    { atBar: 44, unmute: ["CP"] },
    { atBar: 48, pattern: "D04" },
    { atBar: 56, pattern: "D05" },
    { atBar: 60, perf: { n: 12, ramp: [[0, 0], [4, 90], [8, 0]] } },
    { atBar: 72, perf: { n: 12, ramp: [[0, 0], [3, 120], [6, 40], [8, 0]] } },
    { atBar: 80, scene: 8 },
    { atBar: 88, pattern: "D06" },
    { atBar: 88, scene: null },
    { atBar: 104, perf: { n: 3, ramp: [[0, 0], [3.5, 64], [4, 0]] } },
    { atBar: 112, soloKeep: ["LT", "MT", "HT"] },
    { atBar: 116, unmute: ["BD"] },
    { atBar: 118, stop: true },
  ],
};

const ESCAPE_VELOCITY = {
  name: "escape-velocity",
  tempo: 121.43,
  leadInBars: 1,
  tailBars: 4,
  events: [
    { atBar: 0, pattern: "C01", immediate: true },
    { atBar: 0, mute: ["BD"] },
    { atBar: 4, unmute: ["BD"] },
    { atBar: 16, pattern: "C02" },
    { atBar: 28, perf: { n: 4, ramp: [[0, 0], [1.5, 80], [2, 0]] } },
    { atBar: 30, mute: ["BD"] },
    { atBar: 32, pattern: "C04" },
    { atBar: 32, unmute: ["BD"] },
    { atBar: 40, scene: 9 },
    { atBar: 44, scene: null },
    { atBar: 48, scene: 9 },
    { atBar: 52, scene: null },
    { atBar: 56, pattern: "C08" },
    { atBar: 62, mute: ["BD"] },
    { atBar: 64, unmute: ["BD"] },
    { atBar: 70, perf: { n: 4, ramp: [[0, 0], [1.5, 96], [2, 0]] } },
    { atBar: 72, pattern: "C09" },
    { atBar: 72, mute: ["BD", "SD"] },
    { atBar: 80, scene: 12 },
    { atBar: 86, scene: null },
    { atBar: 88, pattern: "C11" },
    { atBar: 88, unmuteAll: true },
    { atBar: 104, pattern: "C12" },
    { atBar: 116, perf: { n: 7, ramp: [[0, 0], [3, 60], [4, 0]] } },
    { atBar: 120, soloKeep: ["BD"] },
    { atBar: 122, unmuteAll: true },
    { atBar: 126, stop: true },
  ],
};

const EMBER = {
  name: "ember",
  tempo: 121.43,
  leadInBars: 1,
  tailBars: 6,
  events: [
    { atBar: 0, pattern: "F01", immediate: true },
    { atBar: 0, mute: ["SD", "CP", "CY", "CB"] },
    { atBar: 8, unmute: ["SD", "CP", "CY"] },
    { atBar: 16, pattern: "F02" },
    { atBar: 24, pattern: "F04" },
    { atBar: 32, pattern: "F05" },
    { atBar: 40, pattern: "F07" },
    { atBar: 48, pattern: "F08" },
    { atBar: 58, perf: { n: 9, ramp: [[0, 0], [3, 56], [6, 118], [7.5, 127], [8, 0]] } },
    { atBar: 66, pattern: "F09" },
    { atBar: 66, unmute: ["CB"] },
    { atBar: 68, mute: ["CB"] },
    { atBar: 74, pattern: "F10" },
    { atBar: 82, pattern: "F11" },
    { atBar: 90, pattern: "F12" },
    { atBar: 90, unmute: ["CB"] },
    { atBar: 92, mute: ["CB"] },
    { atBar: 96, perf: { n: 6, ramp: [[0, 0], [6, 96], [10, 0]] } },
    { atBar: 106, mute: ["CH", "OH", "CY", "HT"] },
    { atBar: 110, mute: ["SD", "CP", "RS"] },
    { atBar: 114, soloKeep: ["BT"] },
    { atBar: 120, stop: true },
  ],
};

const messages = (report: ArrangementReport) => report.findings.map((f) => f.message).join("\n");
const sections = (report: ArrangementReport) => report.findings.filter((f) => f.section === "sections").map((f) => f.message).join("\n");
const eventTierFindings = (report: ArrangementReport) => report.findings.filter((f) => f.section.startsWith("EVENT tier"));

// ---------------------------------------------------------------------------
// v1 calibration: every score should trip the specific flags the autopsy
// names (values pinned against this linter's real output over the exact v1
// content above).
// ---------------------------------------------------------------------------

test("v1 first-light: missing long-held section, score-wide empty EVENT tier, build monotony, no silence", () => {
  const report = lintArrangement(FIRST_LIGHT);
  assert.ok(report.metrics);
  assert.deepEqual(report.metrics!.sectionLengths.lengths, [16, 8, 8, 16, 20, 18, 8]);
  assert.equal(report.metrics!.sectionLengths.median, 16);
  assert.equal(report.metrics!.sectionLengths.gridLocked, false);
  assert.equal(report.metrics!.sectionLengths.missingLongHold, true);
  assert.match(sections(report), /missing one long-held section: longest is 20 bars, only 1\.25x the median \(16\)/);

  const eventFindings = eventTierFindings(report);
  assert.equal(eventFindings.length, 1);
  assert.match(eventFindings[0].message, /score-wide/);

  assert.equal(report.metrics!.drops.length, 3);
  assert.equal(report.metrics!.drops.every((d) => !d.weak), true); // all 3 stack pattern+mute-family (2 dims)
  assert.match(messages(report), /build-type monotony: all 3 pre-drop builds classify as "none"/);
  assert.equal(report.metrics!.silence.length, 0);
  assert.match(messages(report), /no silent bar detected/);
  assert.equal(report.metrics!.unattended.longestGapBars, 12); // well under the 24-bar flag
});

test("v1 ignition-sequence: score-wide empty EVENT tier, a weak one-dimension drop, no section-length flag", () => {
  const report = lintArrangement(IGNITION_SEQUENCE);
  assert.ok(report.metrics);
  assert.deepEqual(report.metrics!.sectionLengths.lengths, [24, 12, 12, 16, 16, 16, 16, 34]);
  assert.equal(report.metrics!.sectionLengths.gridLocked, false);
  assert.equal(report.metrics!.sectionLengths.missingLongHold, false); // 34 is 2.1x the 16-bar median
  assert.equal(sections(report), "");

  assert.equal(eventTierFindings(report).length, 1); // score-wide aggregate

  assert.equal(report.metrics!.drops.length, 2);
  const weak = report.metrics!.drops.find((d) => d.atBar === 16);
  assert.ok(weak?.weak);
  assert.deepEqual(weak!.dimensions, ["mute-family"]);
  const strong = report.metrics!.drops.find((d) => d.atBar === 96);
  assert.equal(strong?.weak, false);
  assert.match(messages(report), /weak drop: only 1 contrast dimension\(s\) \[mute-family\]/);

  assert.equal(report.metrics!.silence.length, 0);
});

test("v1 ceremony: zero drops detected at all (every pattern change happens at full density)", () => {
  const report = lintArrangement(CEREMONY);
  assert.ok(report.metrics);
  assert.deepEqual(report.metrics!.sectionLengths.lengths, [16, 16, 16, 8, 32, 30]);
  assert.equal(report.metrics!.sectionLengths.gridLocked, false);
  assert.equal(report.metrics!.sectionLengths.missingLongHold, false); // 32 is 2x the 16-bar median
  assert.equal(sections(report), "");

  assert.equal(eventTierFindings(report).length, 1); // score-wide aggregate
  assert.equal(report.metrics!.drops.length, 0);
  assert.equal(report.metrics!.builds.length, 0);
  assert.equal(messages(report).includes("weak drop"), false);
  assert.equal(messages(report).includes("build-type monotony"), false); // <2 builds, check doesn't apply
  assert.match(messages(report), /no silent bar detected/);
});

test("v1 escape-velocity: grid-locked (71% of sections at 16 bars) and a weak unmuteAll-only drop", () => {
  const report = lintArrangement(ESCAPE_VELOCITY);
  assert.ok(report.metrics);
  assert.deepEqual(report.metrics!.sectionLengths.lengths, [16, 16, 24, 16, 16, 16, 22]);
  assert.equal(report.metrics!.sectionLengths.gridLocked, true);
  assert.match(sections(report), /grid-locked: 71% of 7 sections are 16 bars/);

  assert.equal(eventTierFindings(report).length, 1); // score-wide aggregate (0 once-only gestures)
  assert.match(eventTierFindings(report)[0].message, /score-wide/);

  assert.equal(report.metrics!.drops.length, 2);
  const weak = report.metrics!.drops.find((d) => d.atBar === 122);
  assert.ok(weak?.weak);
  // Two near-identical perf-4 spike candidates (bar28, bar70) disqualify each
  // other under the "not repeated" rule -- neither counts as an EVENT.
  assert.equal(report.metrics!.eventTiers.perfSpikeCount, 0);
  assert.equal(report.metrics!.eventTiers.perfSpikeDisqualifiedByRepeat, 2);
});

test("v1 ember: the one score with a real once-only gesture (CB:2, not flagged) still nets a single weak drop", () => {
  const report = lintArrangement(EMBER);
  assert.ok(report.metrics);
  const cb = report.metrics!.eventTiers.tracks.find((t) => t.track === "CB");
  assert.equal(cb?.onceOnlyCount, 2);
  assert.equal(cb?.empty, false);
  assert.equal(eventTierFindings(report).length, 0); // CB:2 satisfies the score-wide 2-4 target

  // modal length 8 occurs in 7/10 sections -- exactly the 0.7 boundary, and
  // the strict `>` means it does NOT trip grid-locked.
  assert.equal(report.metrics!.sectionLengths.modalFraction, 0.7);
  assert.equal(report.metrics!.sectionLengths.gridLocked, false);

  assert.equal(report.metrics!.drops.length, 1);
  assert.equal(report.metrics!.drops[0].atBar, 8);
  assert.equal(report.metrics!.drops[0].weak, true);
  assert.equal(report.metrics!.silence.length, 0);
});

test("v1 EP summary: zero silent-bar coverage across all five scores (the skill's exact claim)", () => {
  const reports = [FIRST_LIGHT, IGNITION_SEQUENCE, CEREMONY, ESCAPE_VELOCITY, EMBER].map(lintArrangement);
  const summary = buildEpSummary(reports);
  assert.equal(summary.scoreCount, 5);
  assert.equal(summary.silentScoreCount, 0);
  assert.equal(summary.silentCoverageFraction, 0);
});

// ---------------------------------------------------------------------------
// A synthetic, deliberately clean score: varied + grid-broken sections with
// one long hold, two tracks each with 2 once-only gestures, two drops with
// >=2 stacked contrast dimensions and two DIFFERENT build types feeding them
// (silence, then a perf ramp), an explicit silent bar, and no long gaps.
// ---------------------------------------------------------------------------
const CLEAN_SYNTHETIC = {
  name: "clean-synthetic",
  tempo: 128,
  leadInBars: 1,
  tailBars: 4,
  events: [
    { atBar: 0, pattern: "A01", immediate: true },
    { atBar: 4, unmute: ["CY"] },
    { atBar: 6, mute: ["CY"] },
    { atBar: 8, unmute: ["CB"] },
    { atBar: 10, mute: ["CB"] },
    { atBar: 12, pattern: "A02" },
    { atBar: 20, pattern: "A03" },
    { atBar: 24, unmute: ["CY"] },
    { atBar: 26, mute: ["CY"] },
    { atBar: 30, unmute: ["CB"] },
    { atBar: 32, mute: ["CB"] },
    { atBar: 40, soloKeep: [] },
    { atBar: 44, pattern: "A04" },
    { atBar: 44, unmuteAll: true },
    { atBar: 44, scene: 5 },
    { atBar: 44, level: { track: "CY", to: 100 } },
    { atBar: 52, pattern: "A05" },
    { atBar: 62, perf: { n: 5, ramp: [[0, 0], [4, 100], [6, 0]] } },
    { atBar: 64, mute: ["CY"] },
    { atBar: 68, unmuteAll: true },
    { atBar: 68, scene: 7 },
    { atBar: 76, stop: true },
  ],
};

test("a synthetic well-arranged score passes every gate clean", () => {
  const report = lintArrangement(CLEAN_SYNTHETIC);
  assert.deepEqual(report.findings, []);
  assert.ok(report.metrics);
  assert.equal(report.metrics!.sectionLengths.gridLocked, false);
  assert.equal(report.metrics!.sectionLengths.missingLongHold, false);
  assert.equal(report.metrics!.eventTiers.tracks.every((t) => !t.empty), true);
  assert.equal(report.metrics!.drops.length, 2);
  assert.equal(report.metrics!.drops.every((d) => !d.weak), true);
  assert.deepEqual(report.metrics!.builds.map((b) => b.primary), ["silence", "perf-ramp"]);
  assert.equal(report.metrics!.silence.length, 1);
  assert.ok(report.metrics!.unattended.longestGapBars <= 24);
});

// ---------------------------------------------------------------------------
// Targeted boundary/unit coverage beyond the calibration corpus.
// ---------------------------------------------------------------------------

test("an invalid score surfaces validateScore's errors and skips metrics", () => {
  const report = lintArrangement({ name: "broken", tempo: 500, events: [] });
  assert.equal(report.metrics, undefined);
  assert.ok(report.findings.length > 0);
  assert.equal(report.findings.every((f) => f.severity === "error"), true);
  assert.match(messages(report), /tempo must be a number between 30 and 300/);
});

test("grid-locked also trips when every section length is drawn from {8,16}, even without a 70% majority", () => {
  const score = {
    name: "alternating",
    tempo: 120,
    events: [
      { atBar: 0, pattern: "A01" },
      { atBar: 8, pattern: "A02" },
      { atBar: 24, pattern: "A03" },
      { atBar: 32, pattern: "A04" },
      { atBar: 48, stop: true },
    ],
  };
  const report = lintArrangement(score);
  assert.deepEqual(report.metrics!.sectionLengths.lengths, [8, 16, 8, 16]);
  assert.equal(report.metrics!.sectionLengths.modalFraction, 0.5); // no majority length...
  assert.equal(report.metrics!.sectionLengths.gridLocked, true); // ...but every length is 8 or 16
});

test("once-only EVENT gesture: counts an unmute->mute pair exactly at the 2-bar boundary, not beyond it", () => {
  const atBoundary = {
    name: "boundary-ok",
    tempo: 120,
    events: [
      { atBar: 0, pattern: "A01" },
      { atBar: 10, unmute: ["CB"] },
      { atBar: 12, mute: ["CB"] }, // exactly 2 bars
      { atBar: 40, stop: true },
    ],
  };
  const okReport = lintArrangement(atBoundary);
  assert.equal(okReport.metrics!.eventTiers.tracks.find((t) => t.track === "CB")?.onceOnlyCount, 1);

  const overBoundary = {
    name: "boundary-over",
    tempo: 120,
    events: [
      { atBar: 0, pattern: "A01" },
      { atBar: 10, unmute: ["CB"] },
      { atBar: 13, mute: ["CB"] }, // 3 bars -- too slow to be a once-only flash
      { atBar: 40, stop: true },
    ],
  };
  const overReport = lintArrangement(overBoundary);
  assert.equal(overReport.metrics!.eventTiers.tracks.find((t) => t.track === "CB")?.onceOnlyCount, 0);
});

test("unattended span flags a continuous ride over 24 bars, and not one at or under it", () => {
  const rideOver = {
    name: "long-ride",
    tempo: 120,
    events: [
      { atBar: 0, pattern: "A01" },
      { atBar: 8, mute: ["CB"] },
      { atBar: 33, unmute: ["CB"] }, // 25-bar gap
      { atBar: 40, stop: true },
    ],
  };
  const overReport = lintArrangement(rideOver);
  assert.equal(overReport.metrics!.unattended.longestGapBars, 25);
  assert.match(messages(overReport), /continuous ride: 25 bars with no events starting at bar 8/);

  const rideAtLimit = {
    name: "ride-at-limit",
    tempo: 120,
    events: [
      { atBar: 0, pattern: "A01" },
      { atBar: 8, mute: ["CB"] },
      { atBar: 32, unmute: ["CB"] }, // exactly 24 bars -- not > 24
      { atBar: 40, stop: true },
    ],
  };
  const atLimitReport = lintArrangement(rideAtLimit);
  assert.equal(atLimitReport.metrics!.unattended.longestGapBars, 24);
  assert.equal(messages(atLimitReport).includes("continuous ride"), false);
});

test("buildEpSummary flags build-type monotony when one type dominates >70% of drops", () => {
  const monotone: ArrangementReport = {
    name: "a",
    findings: [],
    metrics: {
      sectionLengths: { patternChangeCount: 0, lengths: [], median: 0, mean: 0, variance: 0, longestSection: 0, longestRatioToMedian: 0, modalLength: 0, modalFraction: 0, gridLocked: false, missingLongHold: false },
      eventTiers: { tracks: [], sceneFlashCount: 0, perfSpikeCount: 0, perfSpikeDisqualifiedByRepeat: 0 },
      drops: [],
      builds: [
        { dropAtBar: 1, types: ["perf-ramp"], primary: "perf-ramp" },
        { dropAtBar: 2, types: ["perf-ramp"], primary: "perf-ramp" },
        { dropAtBar: 3, types: ["perf-ramp"], primary: "perf-ramp" },
        { dropAtBar: 4, types: ["scene-hold"], primary: "scene-hold" },
      ],
      silence: [{ atBar: 1, durationBars: 1 }],
      unattended: { longestGapBars: 0, atBar: 0 },
    },
  };
  const summary = buildEpSummary([monotone]);
  assert.equal(summary.dominantBuildType, "perf-ramp");
  assert.equal(summary.dominantBuildFraction, 0.75);
  assert.equal(summary.buildDiversityFlag, true);
  assert.equal(summary.silentScoreCount, 1);
  assert.equal(summary.silentCoverageFraction, 1);
});
