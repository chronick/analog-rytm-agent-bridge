import type { PatternDecl } from "../bin/build-project.ts";

// Config -> generator -> gate types for the rytm-gen v0 pattern layer. The
// config is the HUMAN/AGENT taste surface: it says what a bank should feel like
// at a high level (style, density, harmonic frame, event budget, palette), and
// the generator turns that into valid PatternDecls the existing gates verify.

export type Style = "driving" | "hypnotic" | "broken" | "ambient" | "tribal" | "ember";

export const STYLES: readonly Style[] = ["driving", "hypnotic", "broken", "ambient", "tribal", "ember"];

// Firing tier: how often a non-anchor element is allowed to sound. The core of
// the event-frequency discipline — cymbals/FX/signature hits must NOT fire every
// loop by default; they earn a reduced tier and a matching trig condition.
export type FiringTier = "anchor" | "backbeat" | "pickup" | "hat" | "bed" | "color" | "event" | "signature";

// A palette entry sourced from a pack.yaml (roles + optional root/firing tags).
// The generator reaches these via per-step sample_number p-locks and tunes
// tonal ones into the harmonic frame via sample_tune.
export interface SampleEntry {
  slot: number; // RAM slot -> sample_number p-lock value (0..127)
  role: string; // "bed" | "tonal" | "perc" | "silt-bed" | "silt-word" | ...
  root?: string; // e.g. "D4", "A", "Am" — tonal reference pitch (for sample_tune)
  firing?: FiringTier; // optional explicit tier override (else inferred from role)
  file?: string; // provenance only (unused by generation)
}

// Per-tier caps on effective firing rate (expected onsets per MASTER loop, i.e.
// onset count weighted by condition probability). Signature stays well under 1
// so a crash/FX voice cannot blanket every loop. anchor/backbeat/pickup/hat are
// structural and uncapped (undefined = no cap).
export interface EventBudget {
  color: number; // default 6
  event: number; // default 3
  signature: number; // default 1.5
}

export const DEFAULT_EVENT_BUDGET: EventBudget = { color: 6, event: 3, signature: 1.5 };

export interface HarmonicFrame {
  root: string; // e.g. "Am" / "A" / "A2"
  pivot?: string; // e.g. "Dm" / "D" — the borrowed-chord pivot for tuned motifs
}

export type DensityHint = "sparse" | "medium" | "dense" | number; // number = 0..1

export interface GenConfig {
  bank: string; // "D" -> slots D01..D12 (single A-H letter)
  style: Style;
  patterns?: number; // how many patterns (default 12, max 16 per bank)
  kit?: number; // 1-based stored kit index (1..128) -> PatternDecl.kit
  tempoFeel?: number; // BPM hint; nudges the density target
  density?: DensityHint; // overall activity dial
  harmonicFrame?: HarmonicFrame; // tonal grounding for tuned motifs
  samplePalette?: SampleEntry[]; // pack.yaml-derived sample roles
  eventBudget?: Partial<EventBudget>; // firing-tier caps (merged over defaults)
  // Optional hard override of the per-style scorer band [low, high].
  scoreBand?: [number, number];
}

// One gate's verdict on a proposed pattern.
export interface GateResult {
  score: number; // danceability composite 0..100
  inBand: boolean;
  lintErrors: string[]; // hard errors from the offline linter (must be empty)
  lintWarnings: number;
  chokeCollisions: ChokeCollision[]; // muted co-hits (must be empty to pass)
  budgetViolations: BudgetViolation[]; // firing-tier overruns (must be empty)
  passed: boolean; // all gates satisfied
}

export interface ChokeCollision {
  pair: string; // e.g. "OH<CH" (right mutes left)
  muted: string; // the track whose hit is lost
  winner: string; // the track that sounds
  count: number; // number of co-hit positions in the LCM unroll
}

export interface BudgetViolation {
  track: string;
  tier: FiringTier;
  firingRate: number; // effective onsets per master loop
  cap: number;
}

export interface GeneratedPattern {
  decl: PatternDecl;
  gate: GateResult;
  intensity: number; // the dial value that produced this pattern
  attempts: number; // how many candidates were tried
}

export interface GeneratedBank {
  config: GenConfig;
  seed: string;
  patterns: GeneratedPattern[];
  // Convenience: the bare PatternDecl[] for scoring/linting/building.
  declaration: { project: string; patterns: PatternDecl[] };
  summary: BankSummary;
}

export interface BankSummary {
  count: number;
  meanScore: number;
  minScore: number;
  maxScore: number;
  band: [number, number];
  allInBand: boolean;
  allLintClean: boolean;
  allChokeClean: boolean;
  allBudgetClean: boolean;
}
