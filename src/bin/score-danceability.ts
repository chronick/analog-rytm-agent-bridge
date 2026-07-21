import { readFileSync } from "node:fs";
import type { PatternDecl, TrackDecl } from "./build-project.ts";

// Deterministic, symbolic danceability scorer over declaration pattern grids.
// No audio, no DSP, no new dependencies: this reasons purely about the declared
// trigs (grid symbols, per-step velocity overrides, conditions, microtiming is
// intentionally ignored for the metric — see note below, polymeter lengths).
//
//   npm run score:danceability -- <declaration.json> [--slots D01,D02] [--json]
//
// Default output is a human table (slot, name, composite 0-100, condensed
// subscores, top flags). --json emits the full per-pattern result objects.
//
// Design intent (from the user's ask): "off-beat toms that lead into kicks,
// velocity management with many hits" — danceability here is the interaction of
// a regular kick anchor, an off-beat hat lift, tom pickups that lead into the
// kick, moderate (not stiff, not unmoored) syncopation, dynamic velocity shape,
// and a healthy overall density. Each concern is a subscore in 0..1; the
// composite is a weighted sum times 100.
//
// Microtiming is deliberately NOT modelled: it nudges feel by ±24/384 of a step
// but never moves a trig across a 16th grid boundary, so it cannot change any
// of the positional metrics below. Retrigs likewise add rolls but not new grid
// onsets, so they do not change danceability structure — both are left out to
// keep the metric a function of the symbolic onset grid.

// ---------------------------------------------------------------------------
// Track roles. BD is the kick anchor. The tom family is BT/LT/MT/HT, but BT is
// used as a sub/bass tom — BT hits ON downbeats are a deliberate sub-layer, not
// masking, so BT is excluded from the kick-masking penalty (it still counts as
// a valid pickup). CH/OH are hats (OH weighted slightly above CH: an open hat
// on the off-beat is the classic lift). SD/RS/CP are backbeat/percussion,
// CY/CB ride/bell texture. Only the sets the metrics reference are named.
// ---------------------------------------------------------------------------
const KICK = new Set(["BD"]);
const TOMS_ALL = new Set(["BT", "LT", "MT", "HT"]); // pickup-eligible tom family
const TOMS_MELODIC = new Set(["LT", "MT", "HT"]); // masking-eligible (excludes sub-tom BT)
const HATS = new Set(["CH", "OH"]);
const HAT_ROLE_WEIGHT: Record<string, number> = { OH: 1.25, CH: 1.0 }; // OH lift > CH lift

// Grid-symbol default velocities (mirror build-project.ts VELOCITY). A per-step
// `velocities` override (1..127) wins when present — see rawVelocity().
const SYMBOL_VELOCITY: Record<string, number> = { X: 120, x: 96, o: 40 };

// Longuet-Higgins & Lee metrical weights over a 16-step bar (the strong pulse
// hierarchy: downbeat 5, beats 3-4, off-beats 2, sixteenths 1). Used by the
// syncopation metric and by "is this accent on a strong beat" placement checks.
const METRIC_WEIGHTS = [5, 1, 2, 1, 3, 1, 2, 1, 4, 1, 2, 1, 3, 1, 2, 1] as const;
const STRONG_POSITIONS = new Set(
  METRIC_WEIGHTS.map((w, i) => (w >= 3 ? i : -1)).filter((i) => i >= 0), // 0,4,8,12
);
// Off-beat and on-beat 8th positions within a bar (0-indexed 16ths).
const OFFBEAT_8THS = [2, 6, 10, 14];
const ONBEAT_8THS = [0, 4, 8, 12];

// Subscore weights. Named + rationale so re-tuning is a one-line, documented
// change. They sum to 1.0 so the composite lands in 0..100.
//   kick_anchor 0.25 — the floor of danceability: without a regular anchor the
//                      body has nothing to lock to. Highest single weight.
//   pickup_flow 0.20 — the user's headline ask (off-beat toms leading into the
//                      kick); the second-highest weight.
//   hat_lift    0.15 — the "&"-placement bounce.
//   syncopation 0.15 — moderate tension keeps it moving without unmooring it.
//   velocity    0.15 — the user's second ask (velocity management with many hits).
//   density     0.10 — a guard band: reward a healthy amount of activity, punish
//                      mud and emptiness. Lowest weight — it gates, not drives.
export const WEIGHTS = {
  kick_anchor: 0.25,
  pickup_flow: 0.2,
  hat_lift: 0.15,
  syncopation_balance: 0.15,
  velocity_shape: 0.15,
  density_balance: 0.1,
} as const;
export type SubscoreKey = keyof typeof WEIGHTS;

// Syncopation inverted-U: score = exp(-(ratio-PEAK)^2 / (2 SIGMA^2)). The ratio
// is the share of non-kick percussion energy sitting on metrically WEAK
// positions (weakness derived from the LHL weights below): ~0.2 means almost
// everything is on strong pulses (stiff), a uniform-coverage pattern lands
// ~0.77, and ~0.95 means the percussion has abandoned the strong beats
// (unmoored). PEAK/SIGMA are tuned against the moonshot corpus so the bank A
// driving patterns (measured ratios ~0.50-0.77) all clear 0.6+, while the two
// extremes fall away. A moderate ratio (a little strong-beat anchoring plus
// plenty of off-beat life) scores best.
const SYNC_PEAK = 0.58;
const SYNC_SIGMA = 0.28;

const UNROLL_CAP = 768; // hard cap on the polymeter LCM unroll (spec)

// ---------------------------------------------------------------------------
// Small math helpers.
// ---------------------------------------------------------------------------
const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value));
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : (a / gcd(a, b)) * b);

// Cosine similarity of two equal-length vectors. Two zero vectors are treated
// as identical (1.0 — "consistently empty"); a zero vs non-zero pair is 0.
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 && nb === 0) return 1;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Mean cosine similarity between consecutive per-bar vectors. A single bar is
// trivially self-consistent (1.0): its content repeats every loop.
function meanConsecutiveCosine(vectors: number[][]): number {
  if (vectors.length <= 1) return 1;
  let total = 0;
  for (let i = 0; i < vectors.length - 1; i += 1) total += cosine(vectors[i], vectors[i + 1]);
  return total / (vectors.length - 1);
}

// Condition -> playback probability weight. no condition = 1.0; "NN%" = NN/100;
// ratio "a:b" fires 1 of every b cycles = a/b; fill/fillnot = 0.0 (not in normal
// playback, per spec); neighbour/pre/1st forms = 0.5 (fire about half the time
// in a call-response context); unknown-but-present defaults to 0.5.
export function conditionProbability(condition: string | undefined): number {
  if (!condition || condition === "unset") return 1;
  const percent = /^(\d+)%$/.exec(condition);
  if (percent) return clamp(Number(percent[1]) / 100);
  const ratio = /^(\d+):(\d+)$/.exec(condition);
  if (ratio) return clamp(Number(ratio[1]) / Number(ratio[2]));
  if (condition === "fill" || condition === "fillnot") return 0;
  if (/^(nei|neinot|pre|prenot|1st|1stnot)$/.test(condition)) return 0.5;
  return 0.5;
}

// Loudness-normalised velocity energy (0..1) and coarse tier. The tier drives
// hierarchy checks (accent/normal/ghost); the energy drives every "where does
// the weight sit" metric. Thresholds match the velocities-override doc: an
// accent lives at >=110, a normal hit at >=70, a ghost below.
const velocityEnergy = (raw: number): number => clamp(raw / 127);
type Tier = "accent" | "normal" | "ghost";
const velocityTier = (raw: number): Tier => (raw >= 110 ? "accent" : raw >= 70 ? "normal" : "ghost");

// Per-step raw velocity: a `velocities` override wins, else the grid symbol's
// default, else 96 (a normal hit) as a defensive fallback.
function rawVelocity(decl: TrackDecl, stepKey: string, symbol: string): number {
  const override = decl.velocities?.[stepKey];
  if (typeof override === "number") return override;
  return SYMBOL_VELOCITY[symbol] ?? 96;
}

// ---------------------------------------------------------------------------
// Onset model. A pattern is unrolled to the LCM of its onset-bearing track
// lengths (bars kept 16-aligned by folding 16 into the LCM), capped at 768,
// then every grid position is expanded to a weighted onset.
// ---------------------------------------------------------------------------
interface Onset {
  track: string;
  pos: number; // 0-based position in the unrolled sequence
  posInBar: number; // pos % 16
  bar: number; // floor(pos / 16)
  raw: number; // raw velocity 1..127
  prob: number; // condition probability weight 0..1
  energy: number; // prob * velocityEnergy(raw)
  tier: Tier;
}

interface UnrolledPattern {
  onsets: Onset[];
  numBars: number;
  analysisLen: number;
  gridOnsets: Record<string, string>; // track -> stripped base grid (for authoring-step flags)
}

function stripGrid(grid: string): string {
  return grid.replace(/\s+/g, "");
}

function unroll(pattern: PatternDecl): UnrolledPattern {
  const gridOnsets: Record<string, string> = {};
  const effLens: number[] = [16]; // fold 16 in so bars stay 16-aligned even with no length-16 track
  const trackData: Array<{ track: string; symbols: string; effLen: number; decl: TrackDecl }> = [];
  for (const [track, decl] of Object.entries(pattern.tracks)) {
    const symbols = stripGrid(decl.grid);
    gridOnsets[track] = symbols;
    // Effective loop length: the declared length (polymeter), else the grid
    // length. Positions past the grid string are silent (padded rests).
    const effLen = decl.length ?? symbols.length;
    if ([...symbols].some((s) => s !== ".")) {
      effLens.push(effLen);
      trackData.push({ track, symbols, effLen, decl });
    }
  }
  const fullLcm = effLens.reduce((a, b) => lcm(a, b), 1);
  const analysisLen = Math.min(UNROLL_CAP, fullLcm); // already a multiple of 16 (16 is a factor)
  const numBars = Math.max(1, Math.round(analysisLen / 16));

  const onsets: Onset[] = [];
  for (const { track, symbols, effLen, decl } of trackData) {
    for (let pos = 0; pos < analysisLen; pos += 1) {
      const local = pos % effLen;
      const symbol = local < symbols.length ? symbols[local] : ".";
      if (symbol === ".") continue;
      const stepKey = String(local + 1);
      const raw = rawVelocity(decl, stepKey, symbol);
      const cond = decl.conditions?.[stepKey] ?? decl.condition;
      const prob = conditionProbability(cond);
      onsets.push({
        track,
        pos,
        posInBar: pos % 16,
        bar: Math.floor(pos / 16),
        raw,
        prob,
        energy: prob * velocityEnergy(raw),
        tier: velocityTier(raw),
      });
    }
  }
  return { onsets, numBars, analysisLen, gridOnsets };
}

// Build per-bar 16-slot vectors by summing valueFn over a subset of onsets.
function barVectors(onsets: Onset[], numBars: number, valueFn: (o: Onset) => number): number[][] {
  const vectors = Array.from({ length: numBars }, () => new Array<number>(16).fill(0));
  for (const onset of onsets) {
    if (onset.bar < numBars) vectors[onset.bar][onset.posInBar] += valueFn(onset);
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// Subscores. Each returns { score: 0..1, ...detail } used for flags.
// ---------------------------------------------------------------------------

// kick_anchor: periodicity + downbeat presence, NOT density. Four-on-floor
// scores max, but a sparse-but-regular pocket (e.g. kicks on 1 and 11 every
// bar) still scores well because bar-to-bar consistency and downbeat presence
// dominate; density only tops it off.
function kickAnchor(onsets: Onset[], numBars: number) {
  const kicks = onsets.filter((o) => KICK.has(o.track));
  const totalProb = kicks.reduce((s, o) => s + o.prob, 0);
  if (totalProb === 0) return { score: 0, downbeat: 0, kicksPerBar: 0 };
  const vecs = barVectors(kicks, numBars, (o) => o.prob);
  // Downbeat-of-bar presence: mean over bars of the (prob-weighted) kick sitting
  // on position 0. A conditional downbeat kick counts partially.
  const downbeat = vecs.reduce((s, v) => s + clamp(v[0]), 0) / numBars;
  // Bar-to-bar consistency: does the kick play the same shape every bar?
  const barConsistency = meanConsecutiveCosine(vecs);
  // Density fit: reward up to four kicks per bar, saturating (four-on-floor).
  const kicksPerBar = totalProb / numBars;
  const densityFit = clamp(kicksPerBar / 4);
  const score = 0.45 * downbeat + 0.3 * barConsistency + 0.25 * densityFit;
  return { score: clamp(score), downbeat, kicksPerBar };
}

// hat_lift: off-beat-8th hat energy that EXCEEDS the on-beat-8th energy. Uniform
// coverage (equal on/off, e.g. ghosts on every 16th) produces zero lift; the
// score climbs only as the off-beats are emphasised, and scales with how much
// real (non-ghost) energy sits there. OH is weighted above CH via role weight.
function hatLift(onsets: Onset[], numBars: number) {
  const hats = onsets.filter((o) => HATS.has(o.track));
  if (hats.length === 0) return { score: 0, contrast: 0, present: false };
  const weighted = (o: Onset) => o.energy * (HAT_ROLE_WEIGHT[o.track] ?? 1);
  let onEnergy = 0;
  let offEnergy = 0;
  for (const o of hats) {
    if (OFFBEAT_8THS.includes(o.posInBar)) offEnergy += weighted(o);
    else if (ONBEAT_8THS.includes(o.posInBar)) onEnergy += weighted(o);
    // odd 16th positions ("e"/"a") belong to neither 8th bucket — ignored here.
  }
  const contrast = offEnergy + onEnergy > 0 ? offEnergy / (offEnergy + onEnergy) : 0;
  // shape: 0 until off exceeds on (contrast 0.5), ramping to 1 at strong
  // off-beat emphasis (contrast 0.8). Uniform coverage -> 0.5 -> 0.
  const shape = clamp((contrast - 0.5) / 0.3);
  // presence: enough absolute off-beat energy per bar (an open hat on the two
  // off-beats of a bar ~= 1.2). Ghost-only off-beats never reach full presence.
  const presence = clamp(offEnergy / numBars / 1.2);
  return { score: clamp(presence * shape), contrast, present: true };
}

// pickup_flow: the user's headline ask. For each kick, look back 1-2 sixteenths
// (wrapping to the loop end for a downbeat kick) for a tom-family onset. Score =
// saturating coverage of kicks-with-pickups, bonused when pickups are lighter
// than the kick (ghost/normal, not accent), penalised when melodic toms land ON
// a kick step at accent velocity (masking). BT is excluded from masking (sub).
function pickupFlow(unrolled: UnrolledPattern) {
  const { onsets, analysisLen } = unrolled;
  const kicks = onsets.filter((o) => KICK.has(o.track));
  const totalKickProb = kicks.reduce((s, o) => s + o.prob, 0);
  if (totalKickProb === 0) return { score: 0, coverage: 0, noKicks: true };

  // Position lookups: nearest tom onset (any tom) and melodic-tom-accent flag.
  const tomAt = new Map<number, Onset>();
  const melodicAccentAt = new Set<number>();
  for (const o of onsets) {
    if (TOMS_ALL.has(o.track)) {
      const existing = tomAt.get(o.pos);
      // prefer the louder tom at a shared position for the lightness check
      if (!existing || o.raw > existing.raw) tomAt.set(o.pos, o);
    }
    if (TOMS_MELODIC.has(o.track) && o.tier === "accent") melodicAccentAt.add(o.pos);
  }

  let coverProb = 0;
  let lightProb = 0;
  let maskProb = 0;
  for (const kick of kicks) {
    const p1 = (kick.pos - 1 + analysisLen) % analysisLen;
    const p2 = (kick.pos - 2 + analysisLen) % analysisLen;
    const pickup = tomAt.get(p1) ?? tomAt.get(p2);
    if (pickup) {
      coverProb += kick.prob;
      if (pickup.tier !== "accent") lightProb += kick.prob; // lighter than the kick it leads into
    }
    if (melodicAccentAt.has(kick.pos)) maskProb += kick.prob;
  }
  const coverage = coverProb / totalKickProb;
  const lightnessFrac = coverProb > 0 ? lightProb / coverProb : 0;
  const maskFrac = maskProb / totalKickProb;
  // Saturate coverage at 50% (not every kick needs a pickup). The lightness
  // bonus scales the coverage reward 0.7..1.0; masking subtracts up to 0.4.
  const coverageScore = clamp(coverage / 0.5);
  const score = clamp(coverageScore * (0.7 + 0.3 * lightnessFrac) - 0.4 * maskFrac);
  return { score, coverage, noKicks: false };
}

// syncopation_balance: share of non-kick percussion energy on metrically weak
// positions, mapped through an inverted-U. Weakness of a position is derived
// from the LHL metric weights (strongest pulse -> 0 weakness, weakest 16th ->
// 1). A pure note-before-empty-stronger-beat LHL count reads ~0 on dense techno
// grids (the strong beats are rarely empty), so this energy-share form is used
// instead: it keeps the LHL weighting but produces a usable spread. Too little
// weak-position energy reads stiff; too much reads unmoored; moderate scores
// best (see SYNC_PEAK/SYNC_SIGMA).
function syncopationBalance(onsets: Onset[]) {
  const perc = onsets.filter((o) => !KICK.has(o.track));
  const posEnergy = new Array<number>(16).fill(0);
  for (const o of perc) posEnergy[o.posInBar] += o.energy;
  let totalE = 0;
  let weakE = 0;
  for (let pos = 0; pos < 16; pos += 1) {
    const e = posEnergy[pos];
    if (e <= 0) continue;
    totalE += e;
    // weakness in 0..1: METRIC_WEIGHTS runs 1..5, so (w-1)/4 is strongness.
    weakE += e * (1 - (METRIC_WEIGHTS[pos] - 1) / 4);
  }
  const ratio = totalE > 0 ? weakE / totalE : 0;
  const score = Math.exp(-((ratio - SYNC_PEAK) ** 2) / (2 * SYNC_SIGMA ** 2));
  return { score: clamp(score), ratio };
}

// velocity_shape: the user's "velocity management with many hits" ask. Only
// tracks with >=6 weighted hits/bar qualify (dynamics matter when there are
// many hits). A single-tier (flat) dense track is penalised hard; a track with
// a real hierarchy — sparse accents (<=30%), ghosts present, accents on strong
// beats or in a consistent placement — is rewarded. No dense track -> neutral.
function velocityShape(onsets: Onset[], numBars: number) {
  const byTrack = new Map<string, Onset[]>();
  for (const o of onsets) {
    if (!byTrack.has(o.track)) byTrack.set(o.track, []);
    byTrack.get(o.track)!.push(o);
  }
  const scores: number[] = [];
  const flatTracks: Array<{ track: string; hits: number }> = [];
  for (const [track, list] of byTrack) {
    const perBar = list.reduce((s, o) => s + o.prob, 0) / numBars;
    if (perBar < 6) continue; // not a "many hits" track
    const tiers = new Set(list.map((o) => o.tier));
    if (tiers.size === 1) {
      flatTracks.push({ track, hits: list.length });
      scores.push(0.15); // flat wall of one velocity — the anti-pattern
      continue;
    }
    const accents = list.filter((o) => o.tier === "accent");
    const ghosts = list.filter((o) => o.tier === "ghost");
    const accentFrac = accents.length / list.length;
    // Accents should be sparse (<=30%): they are punctuation, not the texture.
    const accentScore = accentFrac <= 0.3 ? 1 : clamp(1 - (accentFrac - 0.3) / 0.4);
    const ghostScore = ghosts.length > 0 ? 1 : 0.3; // ghosts give the groove its floor
    let placementScore: number;
    if (accents.length === 0) {
      placementScore = 0.7; // no accents to misplace (still has ghost/normal hierarchy)
    } else {
      const strongFrac = accents.filter((o) => STRONG_POSITIONS.has(o.posInBar)).length / accents.length;
      const repeatConsistency = meanConsecutiveCosine(barVectors(accents, numBars, () => 1));
      // Reward accents on strong beats OR deliberately consistent placement.
      placementScore = Math.max(strongFrac, repeatConsistency);
    }
    scores.push(clamp(0.4 * accentScore + 0.3 * ghostScore + 0.3 * placementScore));
  }
  const score = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.6;
  return { score, flatTracks };
}

// density_balance: total weighted onsets/bar in a healthy band (8..28) scores 1;
// it ramps up from emptiness (0 at ~2/bar) and down into mud (0 at ~40/bar),
// so both a near-silent and a wall-of-noise pattern are penalised smoothly.
function densityBalance(onsets: Onset[], numBars: number) {
  const perBar = onsets.reduce((s, o) => s + o.prob, 0) / numBars;
  let score: number;
  if (perBar < 8) score = clamp((perBar - 2) / 6);
  else if (perBar <= 28) score = 1;
  else score = clamp(1 - (perBar - 28) / 12);
  return { score, perBar };
}

// ---------------------------------------------------------------------------
// Flags: concrete, grid-level, actionable strings that drive the redesign.
// ---------------------------------------------------------------------------
function buildFlags(
  unrolled: UnrolledPattern,
  parts: {
    kick: ReturnType<typeof kickAnchor>;
    hat: ReturnType<typeof hatLift>;
    pickup: ReturnType<typeof pickupFlow>;
    velocity: ReturnType<typeof velocityShape>;
    density: ReturnType<typeof densityBalance>;
  },
): string[] {
  const flags: string[] = [];
  if (parts.pickup.noKicks) flags.push("no kick anchor (BD silent)");
  else {
    if (parts.pickup.coverage === 0) flags.push("no pickups into any kick");
    if (parts.kick.downbeat < 0.5) flags.push("kick weak on the downbeat");
  }
  // Masking: melodic tom (LT/MT/HT) accent sharing a base-grid step with the
  // kick. Reported in 1-based authoring steps so the fix is obvious.
  const grids = unrolled.gridOnsets;
  const bd = grids.BD ?? "";
  const maskSteps: number[] = [];
  for (let i = 0; i < bd.length; i += 1) {
    if (bd[i] === ".") continue;
    for (const tom of TOMS_MELODIC) {
      if (grids[tom]?.[i] === "X") {
        maskSteps.push(i + 1);
        break;
      }
    }
  }
  if (maskSteps.length > 0) flags.push(`toms mask kick on step${maskSteps.length > 1 ? "s" : ""} ${maskSteps.join(",")}`);
  // Hat lift missing while hats are present.
  if (parts.hat.present && parts.hat.score < 0.1) flags.push("off-beat 8ths weak/empty on hats");
  // Flat dense tracks — the "velocity management" anti-pattern.
  for (const { track, hits } of parts.velocity.flatTracks) {
    flags.push(`${track}: ${hits} hits all at one velocity`);
  }
  if (parts.density.perBar < 5) flags.push(`sparse: ${parts.density.perBar.toFixed(1)} onsets/bar`);
  else if (parts.density.perBar > 36) flags.push(`muddy: ${parts.density.perBar.toFixed(1)} onsets/bar`);
  return flags;
}

// ---------------------------------------------------------------------------
// Per-pattern and whole-declaration scoring.
// ---------------------------------------------------------------------------
export interface DanceabilityResult {
  slot: string;
  name: string;
  composite: number; // 0..100
  subscores: Record<SubscoreKey, number>; // each 0..1
  flags: string[];
  meta: { numBars: number; analysisLen: number; kicksPerBar: number; densityPerBar: number };
}

export function scorePattern(pattern: PatternDecl): DanceabilityResult {
  const unrolled = unroll(pattern);
  const { onsets, numBars } = unrolled;

  const kick = kickAnchor(onsets, numBars);
  const pickup = pickupFlow(unrolled);
  const hat = hatLift(onsets, numBars);
  const sync = syncopationBalance(onsets);
  const velocity = velocityShape(onsets, numBars);
  const density = densityBalance(onsets, numBars);

  const subscores: Record<SubscoreKey, number> = {
    kick_anchor: kick.score,
    pickup_flow: pickup.score,
    hat_lift: hat.score,
    syncopation_balance: sync.score,
    velocity_shape: velocity.score,
    density_balance: density.score,
  };
  let composite = 0;
  for (const key of Object.keys(WEIGHTS) as SubscoreKey[]) composite += WEIGHTS[key] * subscores[key];

  return {
    slot: pattern.slot,
    name: pattern.name,
    composite: Math.round(composite * 100),
    subscores,
    flags: buildFlags(unrolled, { kick, hat, pickup, velocity, density }),
    meta: {
      numBars,
      analysisLen: unrolled.analysisLen,
      kicksPerBar: Number(kick.kicksPerBar.toFixed(2)),
      densityPerBar: Number(density.perBar.toFixed(2)),
    },
  };
}

export function scoreDeclaration(patterns: PatternDecl[], slots?: Set<string>): DanceabilityResult[] {
  return patterns.filter((p) => !slots || slots.has(p.slot)).map(scorePattern);
}

// Accept a full declaration ({ patterns: [...] }) or a bare pattern array.
export function extractPatterns(input: unknown): PatternDecl[] {
  if (Array.isArray(input)) return input as PatternDecl[];
  if (input && typeof input === "object" && Array.isArray((input as { patterns?: unknown }).patterns)) {
    return (input as { patterns: PatternDecl[] }).patterns;
  }
  throw new Error("expected a full declaration ({ patterns: [...] }) or a bare pattern array");
}

// ---------------------------------------------------------------------------
// CLI: human table by default, --json for the full result objects.
// ---------------------------------------------------------------------------
const SUB_ABBR: Array<[SubscoreKey, string]> = [
  ["kick_anchor", "ka"],
  ["hat_lift", "hl"],
  ["pickup_flow", "pf"],
  ["syncopation_balance", "sb"],
  ["velocity_shape", "vs"],
  ["density_balance", "db"],
];

function formatTable(results: DanceabilityResult[]): string {
  const header = `slot  ${"name".padEnd(15)}  comp  ${SUB_ABBR.map(([, a]) => a.padStart(3)).join(" ")}  flags`;
  const lines = [header, "-".repeat(header.length)];
  for (const r of results) {
    const subs = SUB_ABBR.map(([key]) => String(Math.round(r.subscores[key] * 100)).padStart(3)).join(" ");
    const flags = r.flags.slice(0, 3).join("; ");
    lines.push(`${r.slot.padEnd(4)}  ${r.name.slice(0, 15).padEnd(15)}  ${String(r.composite).padStart(4)}  ${subs}  ${flags}`);
  }
  const avg = results.length > 0 ? results.reduce((s, r) => s + r.composite, 0) / results.length : 0;
  lines.push("-".repeat(header.length));
  lines.push(`mean composite: ${avg.toFixed(1)} over ${results.length} pattern(s)`);
  return lines.join("\n");
}

export function runScore(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const slotsIndex = args.indexOf("--slots");
  let slots: Set<string> | undefined;
  if (slotsIndex !== -1) {
    const value = args[slotsIndex + 1];
    if (!value) {
      process.stderr.write("usage: score-danceability.ts <declaration.json> [--slots D01,D02] [--json]\n");
      process.exitCode = 2;
      return;
    }
    slots = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
    args.splice(slotsIndex, 2);
  }
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    process.stderr.write("usage: score-danceability.ts <declaration.json> [--slots D01,D02] [--json]\n");
    process.exitCode = 2;
    return;
  }
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  const results = scoreDeclaration(extractPatterns(input), slots);
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTable(results)}\n`);
  }
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) runScore();
