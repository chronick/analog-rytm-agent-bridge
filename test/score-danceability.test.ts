import assert from "node:assert/strict";
import test from "node:test";
import {
  conditionProbability,
  extractPatterns,
  scoreDeclaration,
  scorePattern,
  WEIGHTS,
} from "../src/bin/score-danceability.ts";
import type { PatternDecl } from "../src/bin/build-project.ts";

// A hit at every 8th to make a track "dense" (>=6 weighted hits/bar) where a
// test needs the velocity-shape metric to engage.

test("subscore weights sum to 1 so the composite lands in 0..100", () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

test("condition probability: percent, ratio, fill, neighbour, none", () => {
  assert.equal(conditionProbability(undefined), 1);
  assert.equal(conditionProbability("75%"), 0.75);
  assert.equal(conditionProbability("50%"), 0.5);
  assert.equal(conditionProbability("1:4"), 0.25);
  assert.equal(conditionProbability("fill"), 0);
  assert.equal(conditionProbability("fillnot"), 0);
  assert.equal(conditionProbability("nei"), 0.5);
});

// (a) Four-on-floor kick + off-beat open hats + ghost-tom pickups must score
// as strongly danceable (>=75). LT ghosts sit one 16th before each kick (with
// step 16 wrapping to lead into the downbeat).
test("four-on-floor + off-beat open hats + ghost-tom pickups scores >= 75", () => {
  const pattern: PatternDecl = {
    slot: "A01",
    name: "danceable",
    clear: true,
    tracks: {
      BD: { grid: "X... X... X... X...", length: 16 },
      SD: { grid: ".... X... .... X...", length: 16 }, // backbeat anchor
      LT: { grid: "...o ...o ...o ...o", length: 16 }, // ghost pickups into each kick
      OH: { grid: "..x. ..x. ..x. ..x.", length: 16 }, // open hats on the off-beat 8ths
    },
  };
  const result = scorePattern(pattern);
  assert.ok(result.composite >= 75, `expected >=75, got ${result.composite}`);
  assert.equal(result.subscores.kick_anchor, 1); // perfect four-on-floor
  assert.ok(result.subscores.pickup_flow >= 0.9, `pickup_flow ${result.subscores.pickup_flow}`);
  assert.ok(result.subscores.hat_lift >= 0.9, `hat_lift ${result.subscores.hat_lift}`);
  assert.equal(result.flags.length, 0, `unexpected flags: ${result.flags.join("; ")}`);
});

// (b) A flat wall of same-velocity toms with no kick is the anti-pattern: no
// anchor, no pickups, no hats, flat velocity. Must score <= 40.
test("flat wall of same-velocity toms with no kick scores <= 40", () => {
  const pattern: PatternDecl = {
    slot: "D09",
    name: "wall",
    clear: true,
    tracks: {
      LT: { grid: "xxxx xxxx xxxx xxxx", length: 16 },
      MT: { grid: "xxxx xxxx xxxx xxxx", length: 16 },
    },
  };
  const result = scorePattern(pattern);
  assert.ok(result.composite <= 40, `expected <=40, got ${result.composite}`);
  assert.equal(result.subscores.kick_anchor, 0);
  assert.equal(result.subscores.pickup_flow, 0);
  // both dense toms flagged as flat velocity
  assert.ok(result.flags.some((f) => f.startsWith("LT:") && f.includes("one velocity")));
  assert.ok(result.flags.some((f) => f.startsWith("MT:") && f.includes("one velocity")));
});

// (c) The v2 D01 "gather": no kick at all, flat CH ghosts across every 16th,
// sparse toms. Must score low on kick_anchor (no kick) and hat_lift (uniform
// ghost coverage is not a lift), and low overall.
test("D01-style gather (no kick, flat CH ghosts) scores low on kick_anchor and hat_lift", () => {
  const pattern: PatternDecl = {
    slot: "D01",
    name: "gather",
    clear: true,
    tracks: {
      RS: { grid: "X..x ..x. ..x. X...", length: 16 },
      LT: { grid: "X... ..x. X... ..x.", length: 16 },
      MT: { grid: ".... xo.. ..x. ....", length: 16 },
      CH: { grid: "oooo oooo oooo oooo", length: 16 }, // flat ghost wall
    },
  };
  const result = scorePattern(pattern);
  assert.equal(result.subscores.kick_anchor, 0, "no kick -> zero anchor");
  assert.ok(result.subscores.hat_lift < 0.1, `hat_lift ${result.subscores.hat_lift} should be ~0`);
  assert.ok(result.composite < 40, `expected < 40, got ${result.composite}`);
  assert.ok(result.flags.includes("no kick anchor (BD silent)"));
});

// (e) A polymeter pattern (a length-12 track against length-16 tracks) must
// unroll to the LCM without error and analyse whole bars.
test("polymeter track (length 12 vs 16) unrolls to the LCM without error", () => {
  const pattern: PatternDecl = {
    slot: "B11",
    name: "poly",
    clear: true,
    tracks: {
      BD: { grid: "X... X... X... X...", length: 16 },
      CB: { grid: "x..x ..x. ...x", length: 12 }, // 12-step polymeter loop
    },
  };
  const result = scorePattern(pattern);
  // LCM(16, 12) = 48 -> 3 bars.
  assert.equal(result.meta.analysisLen, 48);
  assert.equal(result.meta.numBars, 3);
  assert.ok(result.composite > 0);
});

// velocities override feeds the scorer: raising ghost pickups to accent removes
// the lightness bonus (pickups are no longer lighter than the kick).
test("velocities override changes the velocity tier the scorer sees", () => {
  const base: PatternDecl = {
    slot: "A02",
    name: "vel-base",
    clear: true,
    tracks: {
      BD: { grid: "X... X... X... X...", length: 16 },
      LT: { grid: "...o ...o ...o ...o", length: 16 },
    },
  };
  const accented: PatternDecl = {
    ...base,
    slot: "A03",
    tracks: {
      BD: base.tracks.BD,
      // same grid, but every pickup forced to accent velocity via override
      LT: { grid: "...o ...o ...o ...o", length: 16, velocities: { "4": 120, "8": 120, "12": 120, "16": 120 } },
    },
  };
  const light = scorePattern(base);
  const loud = scorePattern(accented);
  // both fully cover the kicks, but ghost pickups keep the lightness bonus that
  // accented pickups lose -> ghost version scores higher on pickup_flow.
  assert.ok(
    light.subscores.pickup_flow > loud.subscores.pickup_flow,
    `light ${light.subscores.pickup_flow} should beat loud ${loud.subscores.pickup_flow}`,
  );
});

test("scoreDeclaration honours a --slots filter and extractPatterns accepts both shapes", () => {
  const patterns: PatternDecl[] = [
    { slot: "A01", name: "one", clear: true, tracks: { BD: { grid: "X... X... X... X...", length: 16 } } },
    { slot: "A02", name: "two", clear: true, tracks: { BD: { grid: "X... X... X... X...", length: 16 } } },
  ];
  assert.deepEqual(extractPatterns(patterns), patterns); // bare array
  assert.deepEqual(extractPatterns({ project: "x", patterns }), patterns); // full declaration
  const filtered = scoreDeclaration(patterns, new Set(["A02"]));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].slot, "A02");
  assert.throws(() => extractPatterns({ nope: true }), /expected a full declaration/);
});
