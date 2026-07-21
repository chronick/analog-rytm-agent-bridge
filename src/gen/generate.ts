import { scorePattern } from "../bin/score-danceability.ts";
import { lintPattern } from "../bin/lint-declaration.ts";
import type { PatternDecl } from "../bin/build-project.ts";
import { auditChokes, auditEventBudget } from "./audit.ts";
import { buildPattern, patternName } from "./pattern.ts";
import { arcFraction, STYLE_SPECS } from "./styles.ts";
import { makePrng } from "./prng.ts";
import { DEFAULT_EVENT_BUDGET } from "./types.ts";
import type {
  EventBudget,
  GateResult,
  GeneratedBank,
  GeneratedPattern,
  GenConfig,
} from "./types.ts";

// The generation loop: config -> seeded search -> gated PatternDecls -> bank.
// For each pattern position it sweeps the style's intensity window, gates every
// candidate against the SAME executable taste the agent used to use by hand
// (danceability scorer band, offline linter, choke audit, event budget), and
// keeps the passing candidate whose score sits closest to the arc target for
// that position. Deterministic: identical (config, seed) => identical bank.

const INTENSITY_STEPS = 25; // grid resolution of the intensity search

function resolveBand(config: GenConfig): [number, number] {
  return config.scoreBand ?? STYLE_SPECS[config.style].scoreBand;
}

function resolveBudget(config: GenConfig): EventBudget {
  return { ...DEFAULT_EVENT_BUDGET, ...(config.eventBudget ?? {}) };
}

// Gate one proposed pattern. Passing = in band AND lint-error-free AND
// choke-clean AND within the firing budget. (Lint warnings do not fail.)
export function gatePattern(
  decl: PatternDecl,
  band: [number, number],
  budget: EventBudget,
): GateResult {
  const score = scorePattern(decl).composite;
  const findings = lintPattern(decl as unknown, 0);
  const lintErrors = findings.filter((finding) => finding.severity === "error").map((finding) => finding.message);
  const lintWarnings = findings.filter((finding) => finding.severity === "warning").length;
  const chokeCollisions = auditChokes(decl);
  const budgetViolations = auditEventBudget(decl, budget);
  const inBand = score >= band[0] && score <= band[1];
  const passed = inBand && lintErrors.length === 0 && chokeCollisions.length === 0 && budgetViolations.length === 0;
  return { score, inBand, lintErrors, lintWarnings, chokeCollisions, budgetViolations, passed };
}

// Penalty for candidate selection when nothing passes cleanly: validity dwarfs
// musicality so the loop never trades a lint error for a nicer score.
function penalty(gate: GateResult, target: number): number {
  const outOfBand = gate.inBand ? 0 : Math.min(Math.abs(gate.score - target), 100);
  return gate.lintErrors.length * 10_000 + gate.chokeCollisions.length * 1_000 + gate.budgetViolations.length * 1_000 + outOfBand;
}

function generatePattern(
  config: GenConfig,
  seed: string,
  position: number,
  count: number,
): GeneratedPattern {
  const spec = STYLE_SPECS[config.style];
  const band = resolveBand(config);
  const budget = resolveBudget(config);
  const slot = `${config.bank}${String(position).padStart(2, "0")}`;
  const name = patternName(config.style, position);

  // The arc places this position's target inside the band.
  const target = band[0] + arcFraction(position, count) * (band[1] - band[0]);

  const [lo, hi] = spec.intensity;
  let best: GeneratedPattern | undefined;
  let bestPassing: GeneratedPattern | undefined;

  for (let step = 0; step < INTENSITY_STEPS; step += 1) {
    const intensity = lo + (hi - lo) * (step / (INTENSITY_STEPS - 1));
    const prng = makePrng(`${seed}:${slot}:i${step}`);
    const decl = buildPattern(slot, name, spec, intensity, config, prng);
    const gate = gatePattern(decl, band, budget);
    const candidate: GeneratedPattern = { decl, gate, intensity, attempts: INTENSITY_STEPS };

    if (gate.passed) {
      if (!bestPassing || Math.abs(gate.score - target) < Math.abs(bestPassing.gate.score - target)) {
        bestPassing = candidate;
      }
    }
    if (!best || penalty(gate, target) < penalty(best.gate, target)) best = candidate;
  }

  return bestPassing ?? best!;
}

export function generateBank(config: GenConfig, seed: string | number = 0): GeneratedBank {
  const seedStr = String(seed);
  const count = Math.max(1, Math.min(16, config.patterns ?? 12));
  const band = resolveBand(config);

  const patterns: GeneratedPattern[] = [];
  for (let position = 1; position <= count; position += 1) {
    patterns.push(generatePattern(config, seedStr, position, count));
  }

  const scores = patterns.map((pattern) => pattern.gate.score);
  const summary = {
    count,
    meanScore: Number((scores.reduce((sum, value) => sum + value, 0) / count).toFixed(1)),
    minScore: Math.min(...scores),
    maxScore: Math.max(...scores),
    band,
    allInBand: patterns.every((pattern) => pattern.gate.inBand),
    allLintClean: patterns.every((pattern) => pattern.gate.lintErrors.length === 0),
    allChokeClean: patterns.every((pattern) => pattern.gate.chokeCollisions.length === 0),
    allBudgetClean: patterns.every((pattern) => pattern.gate.budgetViolations.length === 0),
  };

  return {
    config,
    seed: seedStr,
    patterns,
    declaration: {
      project: `${config.style}-${config.bank}`,
      patterns: patterns.map((pattern) => pattern.decl),
    },
    summary,
  };
}
