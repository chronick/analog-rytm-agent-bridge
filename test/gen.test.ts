import assert from "node:assert/strict";
import test from "node:test";
import { generateBank } from "../src/gen/generate.ts";
import { makePrng } from "../src/gen/prng.ts";
import { auditChokes, auditEventBudget, firingRate } from "../src/gen/audit.ts";
import { buildPattern } from "../src/gen/pattern.ts";
import { STYLE_SPECS } from "../src/gen/styles.ts";
import { conditionWeight, pitchClass, tunedMotif } from "../src/gen/roles.ts";
import { DEFAULT_EVENT_BUDGET, STYLES } from "../src/gen/types.ts";
import type { GenConfig, Style } from "../src/gen/types.ts";
import { lintPatterns } from "../src/bin/lint-declaration.ts";
import { scorePattern } from "../src/bin/score-danceability.ts";
import type { PatternDecl } from "../src/bin/build-project.ts";

const PALETTE: GenConfig["samplePalette"] = [
  { slot: 14, role: "bed" },
  { slot: 26, role: "tonal", root: "D4" },
  { slot: 36, role: "perc" },
];

function config(style: Style, overrides: Partial<GenConfig> = {}): GenConfig {
  return {
    bank: "D",
    style,
    kit: 2,
    harmonicFrame: { root: "Am", pivot: "Dm" },
    samplePalette: PALETTE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------
test("same seed produces byte-identical output", () => {
  const a = generateBank(config("driving"), 42);
  const b = generateBank(config("driving"), 42);
  assert.equal(JSON.stringify(a.declaration), JSON.stringify(b.declaration));
});

test("a different seed produces different output", () => {
  const a = generateBank(config("tribal"), 1);
  const b = generateBank(config("tribal"), 2);
  assert.notEqual(JSON.stringify(a.declaration), JSON.stringify(b.declaration));
});

test("the PRNG is deterministic and its helpers stay in range", () => {
  const p1 = makePrng("seed:xyz");
  const p2 = makePrng("seed:xyz");
  for (let i = 0; i < 100; i += 1) {
    assert.equal(p1.next(), p2.next());
  }
  const p = makePrng(123);
  for (let i = 0; i < 500; i += 1) {
    const value = p.int(3, 8);
    assert.ok(value >= 3 && value <= 8 && Number.isInteger(value));
  }
  assert.throws(() => makePrng(1).pick([]));
});

// ---------------------------------------------------------------------------
// Per-style banks pass every gate the agent used to enforce by hand.
// ---------------------------------------------------------------------------
for (const style of STYLES) {
  test(`generated ${style} bank lints clean, hits its scorer band, and is choke/budget-clean`, () => {
    const bank = generateBank(config(style), 7);
    const patterns = bank.declaration.patterns;
    const band = STYLE_SPECS[style].scoreBand;

    // (1) lint clean: zero ERRORS across the whole bank (via the real linter).
    const findings = lintPatterns(patterns);
    const errors = findings.filter((finding) => finding.severity === "error");
    assert.equal(errors.length, 0, `lint errors: ${errors.map((e) => `${e.section}: ${e.message}`).slice(0, 4).join(" | ")}`);

    // (2) scorer band: every pattern lands inside the style's band (via the
    //     real scorer, independent of the generator's internal gate).
    for (const pattern of patterns) {
      const score = scorePattern(pattern).composite;
      assert.ok(
        score >= band[0] && score <= band[1],
        `${style} ${pattern.slot} scored ${score}, outside band ${band[0]}-${band[1]}`,
      );
    }

    // (3) choke audit: no muted co-hits in any pattern.
    for (const pattern of patterns) {
      const collisions = auditChokes(pattern);
      assert.equal(collisions.length, 0, `${style} ${pattern.slot} choke collisions: ${collisions.map((c) => c.pair).join(",")}`);
    }

    // (4) event budget: color/event/signature firing rates within caps.
    for (const pattern of patterns) {
      const violations = auditEventBudget(pattern, DEFAULT_EVENT_BUDGET);
      assert.equal(violations.length, 0, `${style} ${pattern.slot} budget violations: ${JSON.stringify(violations)}`);
    }

    // Summary flags agree with the per-pattern checks.
    assert.ok(bank.summary.allInBand && bank.summary.allLintClean && bank.summary.allChokeClean && bank.summary.allBudgetClean);
  });
}

test("driving clears >= 80 and ambient sits in the 45-70 valley (per the brief's targets)", () => {
  const driving = generateBank(config("driving"), 3);
  assert.ok(driving.summary.minScore >= 80, `driving min ${driving.summary.minScore}`);
  const ambient = generateBank(config("ambient"), 3);
  assert.ok(ambient.summary.minScore >= 45 && ambient.summary.maxScore <= 70, `ambient ${ambient.summary.minScore}-${ambient.summary.maxScore}`);
  // The brief's floor: no ambient pattern below 35.
  assert.ok(ambient.summary.minScore >= 35);
});

// ---------------------------------------------------------------------------
// Event-frequency discipline: signature voices (CY/CB) must NOT fire every loop.
// ---------------------------------------------------------------------------
test("signature voices carry a reducing condition (never every loop) when present", () => {
  for (const style of STYLES) {
    const bank = generateBank(config(style), 11);
    for (const pattern of bank.declaration.patterns) {
      for (const track of ["CY", "CB"] as const) {
        const rate = firingRate(pattern, track);
        assert.ok(rate <= DEFAULT_EVENT_BUDGET.signature + 1e-9, `${style} ${pattern.slot} ${track} firing ${rate} over signature cap`);
      }
    }
  }
});

test("a custom event budget is honoured (tighter signature cap still passes)", () => {
  const bank = generateBank(config("driving", { eventBudget: { signature: 1.0 } }), 5);
  for (const pattern of bank.declaration.patterns) {
    const violations = auditEventBudget(pattern, { ...DEFAULT_EVENT_BUDGET, signature: 1.0 });
    assert.equal(violations.length, 0, `${pattern.slot}: ${JSON.stringify(violations)}`);
  }
});

// ---------------------------------------------------------------------------
// Audit positive controls: the audits actually catch the anti-patterns.
// ---------------------------------------------------------------------------
test("choke audit catches a deliberate OH<CH co-hit", () => {
  const pattern: PatternDecl = {
    slot: "A01",
    name: "choke",
    clear: true,
    tracks: {
      OH: { grid: "..x. ..x. ..x. ..x.", length: 16 }, // off-8ths
      CH: { grid: "..x. .... .... ....", length: 16 }, // step 3 collides with OH
    },
  };
  const collisions = auditChokes(pattern);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].pair, "OH<CH");
  assert.equal(collisions[0].muted, "OH");
  assert.ok(collisions[0].count >= 1);
});

test("choke audit LCM-unrolls polymeter to find phased co-hits", () => {
  // CB length 12 vs CY length 16: onsets on step 1 of each -> collide at pos 0,
  // and phase apart, then re-collide at LCM(12,16)=48. The unroll must catch it.
  const pattern: PatternDecl = {
    slot: "B11",
    name: "poly-choke",
    clear: true,
    tracks: {
      CY: { grid: "X... .... .... ....", length: 16 },
      CB: { grid: "x... .... ....", length: 12 },
    },
  };
  const collisions = auditChokes(pattern);
  assert.ok(collisions.some((c) => c.pair === "CB<CY" && c.count >= 1));
});

test("event budget catches a crash firing every loop", () => {
  const pattern: PatternDecl = {
    slot: "A01",
    name: "over",
    clear: true,
    tracks: {
      // CY (signature) on every downbeat of a 4-bar master, no condition -> 4/loop.
      CY: { grid: "X... .... .... ....", length: 16 },
      BD: { grid: "X... X... X... X...", length: 64 }, // makes the master 64 (4 bars)
    },
  };
  const violations = auditEventBudget(pattern, DEFAULT_EVENT_BUDGET);
  const cy = violations.find((v) => v.track === "CY");
  assert.ok(cy && cy.tier === "signature" && cy.firingRate > DEFAULT_EVENT_BUDGET.signature);
});

test("firingRate weights onsets by condition probability", () => {
  const pattern: PatternDecl = {
    slot: "A01",
    name: "cond",
    clear: true,
    tracks: { CY: { grid: "X... .... .... ....", length: 16, condition: "1:4" } },
  };
  assert.equal(firingRate(pattern, "CY"), conditionWeight("1:4")); // single onset, 0.25
});

// ---------------------------------------------------------------------------
// Harmonic frame -> tuning.
// ---------------------------------------------------------------------------
test("tunedMotif stays within sample_tune range and pitchClass parses roots", () => {
  assert.equal(pitchClass("Am"), 9);
  assert.equal(pitchClass("A"), 9);
  assert.equal(pitchClass("Dm"), 2);
  assert.equal(pitchClass("D4"), 2);
  assert.equal(pitchClass("F#3"), 6);
  const motif = tunedMotif("Am", 8, makePrng("motif"));
  assert.equal(motif.length, 8);
  for (const value of motif) assert.ok(value >= -24 && value <= 24 && Number.isInteger(value));
});

// ---------------------------------------------------------------------------
// The intensity dial is monotone-ish: a peak-position pattern is at least as
// dense/danceable-capable as an establish-position one (arc sanity).
// ---------------------------------------------------------------------------
test("higher intensity yields a higher or equal score within a style window", () => {
  const spec = STYLE_SPECS.driving;
  const low = buildPattern("A01", "x", spec, spec.intensity[0], config("driving"), makePrng("lo"));
  const high = buildPattern("A05", "y", spec, spec.intensity[1], config("driving"), makePrng("hi"));
  assert.ok(scorePattern(high).composite >= scorePattern(low).composite);
});
