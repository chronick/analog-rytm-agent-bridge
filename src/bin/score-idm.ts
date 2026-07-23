import { readFileSync } from "node:fs";
import { conditionProbability, extractPatterns } from "./score-danceability.ts";
import type { PatternDecl, TrackDecl } from "./build-project.ts";

// IDM/Autechre-systems pattern scorer over declaration JSON, complementing
// score-danceability (which optimises 4/4 techno and would punish this
// material). Same input contract: a declaration JSON path + optional --slots.
//
//   npm run score:idm -- <declaration.json> [--slots G01,G02] [--json]
//
// Where danceability rewards a regular kick anchor, off-beat hat lift and
// moderate syncopation, this scorer rewards the HYSTERESIS values: two-generator
// interference structure, higher-than-techno syncopation entropy, polymeter
// super-cycles from odd track lengths, a causal trig network (probability seeds
// -> pre/nei chains), disciplined sparse density, and a tight once-only event
// budget. It reasons purely about the declared trigs (grid symbols, per-step
// velocities, conditions, per-track lengths, retrigs) — no audio, no DSP, no new
// dependencies. Condition probabilities are weighted exactly as danceability
// does (its conditionProbability helper is reused).
//
// A CARVE AUDIT section is emitted per pattern (informational, NOT scored): for
// each choke pair it counts LCM-unrolled co-hits ("carve collisions") and steps
// where the carver fires into the ring member's tail ("carves"). In this project
// carving is intentional audio-domain subtraction, so it is reported, not
// penalised.

// Canonical Rytm track order. NEI conditions reference the PRECEDING track index
// in this order, so adjacency here defines the causal response edges.
const TRACKS = ["BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB"] as const;
const TRACK_INDEX = new Map<string, number>(TRACKS.map((t, i) => [t, i] as [string, number]));

// High-frequency texture voices — penalised when they fire unconditioned on
// every cycle at high density (an undifferentiated wall, the anti-IDM move).
const HI_FREQ = new Set(["CH", "OH", "CY", "CB"]);

// Choke pairs as intentional carve relationships. `ring` is the lower-index
// member (the seed / long body that rings: RS, MT, CH, CY); `carver` is the
// higher-index member (the responder that cuts: CP, HT, OH, CB). A "carve" is
// the carver firing while the ring's tail is still sounding (fired within the
// previous CARVE_TAIL steps). Displayed carver<->ring, per the design doc.
const CHOKE_PAIRS: Array<{ ring: string; carver: string }> = [
  { ring: "RS", carver: "CP" },
  { ring: "MT", carver: "HT" },
  { ring: "CH", carver: "OH" },
  { ring: "CY", carver: "CB" },
];
const CARVE_TAIL = 4; // steps a ring is considered "still ringing" behind a hit

// Grid-symbol default velocities (mirror build-project.ts VELOCITY). A per-step
// `velocities` override (1..127) wins when present.
const SYMBOL_VELOCITY: Record<string, number> = { X: 120, x: 96, o: 40 };

// Longuet-Higgins & Lee 16-step metrical weights — the pulse hierarchy used to
// bucket onset mass into four metric-strength classes for the entropy metric.
const METRIC_WEIGHTS = [5, 1, 2, 1, 3, 1, 2, 1, 4, 1, 2, 1, 3, 1, 2, 1] as const;

// Metric weights. Interference + syncopation lead (the IDM signature); the
// causal/polymeter/density/event guards share the rest. They sum to 1.0 so the
// composite lands in 0..100.
export const WEIGHTS = {
  interference_structure: 0.2,
  syncopation_entropy: 0.2,
  polymeter_supercycle: 0.15,
  causal_depth: 0.15,
  density_discipline: 0.15,
  event_budget: 0.15,
} as const;
export type MetricKey = keyof typeof WEIGHTS;

// Tuning constants (named so re-tuning is a documented one-liner).
const UNROLL_CAP = 768; // hard cap on the polymeter LCM unroll (matches danceability)
const PROM_TARGET = 0.35; // autocorrelation prominence that earns full structure credit
const SYNC_ENTROPY_PEAK = 0.7; // normalized-entropy sweet spot (higher than techno)
const SYNC_ENTROPY_SIGMA = 0.12; // covers the ~0.62-0.78 target band
const DENSITY_LOW = 0.18; // IDM fill band (fraction of active-voice cells firing)
const DENSITY_HIGH = 0.38;
const RETRIG_BUDGET = 2; // retrig steps allowed per pattern before decay

// ---------------------------------------------------------------------------
// Small math helpers.
// ---------------------------------------------------------------------------
const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value));
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : (a / gcd(a, b)) * b);
const velocityEnergy = (raw: number): number => clamp(raw / 127);
type Tier = "accent" | "normal" | "ghost";
const velocityTier = (raw: number): Tier => (raw >= 110 ? "accent" : raw >= 70 ? "normal" : "ghost");

function stripGrid(grid: string): string {
  return grid.replace(/\s+/g, "");
}

// Metric-strength class of a bar position: 0 downbeat, 1 beat, 2 eighth, 3 sixteenth.
function metricClass(posInBar: number): number {
  const w = METRIC_WEIGHTS[posInBar % 16];
  if (w === 5) return 0;
  if (w >= 3) return 1;
  if (w === 2) return 2;
  return 3;
}

// Condition classification (built on top of the shared conditionProbability).
type CondKind = "seed" | "pre" | "nei" | "ratio" | "once" | "other" | "none";
interface CondInfo {
  kind: CondKind;
  percent?: number;
  ratioNum?: number;
}
function classifyCondition(cond: string | undefined): CondInfo {
  if (!cond || cond === "unset") return { kind: "none" };
  const pct = /^(\d+)%$/.exec(cond);
  if (pct) return { kind: "seed", percent: Number(pct[1]) };
  const ratio = /^(\d+):(\d+)$/.exec(cond);
  if (ratio) return { kind: "ratio", ratioNum: Number(ratio[1]) };
  if (/^(pre|prenot)$/.test(cond)) return { kind: "pre" };
  if (/^(nei|neinot)$/.test(cond)) return { kind: "nei" };
  if (/^(1st|1stnot)$/.test(cond)) return { kind: "once" };
  return { kind: "other" };
}

// A "rare" once-only event: 1st/1stnot, a low probability (<=25%), or an A:B with A=1.
function isRareCondition(info: CondInfo): boolean {
  if (info.kind === "once") return true;
  if (info.kind === "seed" && info.percent !== undefined && info.percent <= 25) return true;
  if (info.kind === "ratio" && info.ratioNum === 1) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Per-track precomputation. Each onset-bearing track is reduced to its base
// loop (effLen) with per-local-step onset flags, probability weight and energy,
// plus the base-grid onset list (for condition/tier/carve reasoning).
// ---------------------------------------------------------------------------
interface BaseOnset {
  local: number; // 0-based position within the base loop
  symbol: string;
  raw: number; // raw velocity 1..127
  prob: number; // condition probability weight 0..1
  energy: number; // prob * velocityEnergy
  tier: Tier;
  cond: CondInfo;
}
interface TrackInfo {
  track: string;
  effLen: number;
  onsetAtLocal: boolean[]; // length effLen
  probAtLocal: number[]; // length effLen (0 where no onset)
  energyAtLocal: number[]; // length effLen
  baseOnsets: BaseOnset[];
}

function buildTrackInfo(track: string, decl: TrackDecl): TrackInfo | undefined {
  const symbols = stripGrid(decl.grid);
  const effLen = decl.length ?? symbols.length;
  if (effLen <= 0) return undefined;
  const onsetAtLocal = new Array<boolean>(effLen).fill(false);
  const probAtLocal = new Array<number>(effLen).fill(0);
  const energyAtLocal = new Array<number>(effLen).fill(0);
  const baseOnsets: BaseOnset[] = [];
  let any = false;
  for (let local = 0; local < effLen; local += 1) {
    const symbol = local < symbols.length ? symbols[local] : ".";
    if (symbol === ".") continue;
    any = true;
    const stepKey = String(local + 1);
    const override = decl.velocities?.[stepKey];
    const raw = typeof override === "number" ? override : (SYMBOL_VELOCITY[symbol] ?? 96);
    const condStr = decl.conditions?.[stepKey] ?? decl.condition;
    const prob = conditionProbability(condStr);
    const energy = prob * velocityEnergy(raw);
    onsetAtLocal[local] = true;
    probAtLocal[local] = prob;
    energyAtLocal[local] = energy;
    baseOnsets.push({ local, symbol, raw, prob, energy, tier: velocityTier(raw), cond: classifyCondition(condStr) });
  }
  if (!any) return undefined;
  return { track, effLen, onsetAtLocal, probAtLocal, energyAtLocal, baseOnsets };
}

interface Unrolled {
  infos: TrackInfo[];
  byTrack: Map<string, TrackInfo>;
  masterLen: number;
  fullLcm: number;
  superLen: number; // one super-cycle, capped
  acfLen: number; // autocorrelation window (>= 2 metric bars), capped
  superCycleBars: number;
  onsetTracks: number;
}

function unroll(pattern: PatternDecl): Unrolled {
  const infos: TrackInfo[] = [];
  const byTrack = new Map<string, TrackInfo>();
  let masterLen = 1;
  for (const [track, decl] of Object.entries(pattern.tracks)) {
    const declaredLen = decl.length ?? stripGrid(decl.grid).length;
    if (declaredLen > masterLen) masterLen = declaredLen;
    const info = buildTrackInfo(track, decl);
    if (info) {
      infos.push(info);
      byTrack.set(track, info);
    }
  }
  const fullLcm = infos.length > 0 ? infos.reduce((acc, info) => lcm(acc, info.effLen), 1) : masterLen;
  const superLen = Math.min(UNROLL_CAP, Math.max(fullLcm, 1));
  // Autocorrelation needs at least two metric bars visible to read bar-lock, so
  // extend to the smallest whole number of super-cycles that reaches 32 steps.
  let acfLen = fullLcm > 0 ? fullLcm : masterLen;
  while (acfLen < 32 && acfLen + fullLcm <= UNROLL_CAP && fullLcm > 0) acfLen += fullLcm;
  acfLen = Math.min(UNROLL_CAP, Math.max(acfLen, superLen));
  const superCycleBars = Math.max(1, Math.round(fullLcm / masterLen));
  return { infos, byTrack, masterLen, fullLcm, superLen, acfLen, superCycleBars, onsetTracks: infos.length };
}

// ---------------------------------------------------------------------------
// Metric 1: interference_structure. Kit-wide onset-mass vector over the ACF
// window; circular autocorrelation; reward a prominent secondary peak at a
// non-metric-grid lag (interference/super-cycle structure), penalise both plain
// 16-step bar-lock and flat/no-peak noise.
// ---------------------------------------------------------------------------
function interferenceStructure(u: Unrolled) {
  const L = u.acfLen;
  const mass = new Array<number>(L).fill(0);
  for (const info of u.infos) {
    for (let pos = 0; pos < L; pos += 1) mass[pos] += info.probAtLocal[pos % info.effLen];
  }
  const maxLag = Math.floor(L / 2);
  let energy = 0;
  for (const v of mass) energy += v * v;
  if (energy <= 0 || maxLag < 3) return { score: 0, lag: 0, prominence: 0, barLock: 0 };

  const r = new Array<number>(maxLag + 1).fill(0);
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let acc = 0;
    for (let i = 0; i < L; i += 1) acc += mass[i] * mass[(i + lag) % L];
    r[lag] = acc / energy;
  }
  let sumR = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) sumR += r[lag];
  const meanR = sumR / maxLag;

  // Best self-similarity at a NON-trivial lag: skip 1,2 and all multiples of 4
  // (the 4/4 metric grid), so only genuine cross-length structure counts.
  let bestProm = 0;
  let bestLag = 0;
  for (let lag = 3; lag <= maxLag; lag += 1) {
    if (lag % 4 === 0) continue;
    const prom = r[lag] - meanR;
    if (prom > bestProm) {
      bestProm = prom;
      bestLag = lag;
    }
  }
  const barProm = 16 <= maxLag ? r[16] - meanR : r[maxLag] - meanR;
  const presence = clamp(Math.max(bestProm, barProm, 0) / PROM_TARGET);
  const dominance = clamp((barProm - bestProm) / PROM_TARGET);
  const score = clamp(presence * (1 - dominance));
  return { score, lag: bestLag, prominence: bestProm, barLock: barProm };
}

// ---------------------------------------------------------------------------
// Metric 2: syncopation_entropy. Entropy of onset-energy mass across the four
// metric-strength classes, normalised to 0..1, through an inverted-U whose peak
// sits higher than techno (target ~0.62-0.78).
// ---------------------------------------------------------------------------
function syncopationEntropy(u: Unrolled) {
  const classMass = [0, 0, 0, 0];
  for (const info of u.infos) {
    for (let pos = 0; pos < u.superLen; pos += 1) {
      const local = pos % info.effLen;
      if (!info.onsetAtLocal[local]) continue;
      classMass[metricClass(pos % 16)] += info.energyAtLocal[local];
    }
  }
  const total = classMass.reduce((a, b) => a + b, 0);
  if (total <= 0) return { score: 0, normEntropy: 0 };
  let h = 0;
  for (const m of classMass) {
    if (m <= 0) continue;
    const p = m / total;
    h -= p * Math.log(p);
  }
  const normEntropy = h / Math.log(4);
  const score = Math.exp(-((normEntropy - SYNC_ENTROPY_PEAK) ** 2) / (2 * SYNC_ENTROPY_SIGMA ** 2));
  return { score: clamp(score), normEntropy };
}

// ---------------------------------------------------------------------------
// Metric 3: polymeter_supercycle. LCM(track lengths)/master-length in bars,
// log-scaled toward a 64-bar cap; all-length-16 uniformity scores zero.
// ---------------------------------------------------------------------------
function polymeterSupercycle(u: Unrolled) {
  const bars = u.superCycleBars;
  const uniform = bars <= 1;
  const score = uniform ? 0 : clamp(Math.log2(Math.min(bars, 64)) / 6);
  return { score, bars, uniform };
}

// ---------------------------------------------------------------------------
// Metric 4: causal_depth. Reward a probability seed -> pre continuation chain
// (same track) plus a nei responder that references a conditional preceding
// track (depth >= 2), an A:B slow-structure condition, and conditional breadth
// (diminishing). Zero conditions -> zero (flagged).
// ---------------------------------------------------------------------------
function causalDepth(u: Unrolled) {
  let seeds = 0;
  let pres = 0;
  let neisAll = 0;
  let ratios = 0;
  let onces = 0;
  const hasSeed = new Set<string>();
  const hasPre = new Set<string>();
  const hasNei = new Set<string>();
  const hasAnyCond = new Set<string>();
  for (const info of u.infos) {
    for (const onset of info.baseOnsets) {
      const kind = onset.cond.kind;
      if (kind === "none" || kind === "other") continue;
      hasAnyCond.add(info.track);
      if (kind === "seed") {
        seeds += 1;
        hasSeed.add(info.track);
      } else if (kind === "pre") {
        pres += 1;
        hasPre.add(info.track);
      } else if (kind === "nei") {
        neisAll += 1;
        hasNei.add(info.track);
      } else if (kind === "ratio") {
        ratios += 1;
      } else if (kind === "once") {
        onces += 1;
      }
    }
  }
  const totalCond = seeds + pres + neisAll + ratios + onces;
  const chain = [...hasSeed].some((t) => hasPre.has(t));
  // A nei responder that actually references a conditional preceding track.
  const responder = [...hasNei].some((t) => {
    const idx = TRACK_INDEX.get(t);
    if (idx === undefined || idx === 0) return false;
    return hasAnyCond.has(TRACKS[idx - 1]);
  });
  const score = clamp(
    0.25 * clamp(seeds / 2) +
      0.2 * (chain ? 1 : 0) +
      0.3 * (responder ? 1 : neisAll > 0 ? 0.4 : 0) +
      0.1 * (ratios > 0 ? 1 : 0) +
      0.15 * (1 - Math.exp(-totalCond / 6)),
  );
  return { score, totalCond, seeds, pres, neisAll, ratios, onces, chain, responder };
}

// ---------------------------------------------------------------------------
// Metric 5: density_discipline. Active-voice fill ratio through an inverted-U
// (IDM band 0.18-0.38) plus a velocity-tier variance reward (flat dense tracks
// penalised, multi-tier tracks rewarded — the danceability velocity_shape idea).
// ---------------------------------------------------------------------------
function densityDiscipline(u: Unrolled) {
  let probMass = 0;
  for (const info of u.infos) {
    for (let pos = 0; pos < u.superLen; pos += 1) probMass += info.probAtLocal[pos % info.effLen];
  }
  const fill = u.onsetTracks > 0 ? probMass / (u.superLen * u.onsetTracks) : 0;
  let densityFit: number;
  if (fill >= DENSITY_LOW && fill <= DENSITY_HIGH) densityFit = 1;
  else if (fill < DENSITY_LOW) densityFit = clamp((fill - 0.05) / (DENSITY_LOW - 0.05));
  else densityFit = clamp(1 - (fill - DENSITY_HIGH) / (0.65 - DENSITY_HIGH));

  const varietyScores: number[] = [];
  const flatTracks: string[] = [];
  for (const info of u.infos) {
    if (info.baseOnsets.length < 6) continue; // dynamics matter only on a "many hits" track (danceability's threshold)
    const tiers = new Set(info.baseOnsets.map((o) => o.tier));
    if (tiers.size === 1) {
      flatTracks.push(info.track);
      varietyScores.push(0.15);
    } else {
      varietyScores.push(tiers.size === 2 ? 0.7 : 1);
    }
  }
  const velVariety = varietyScores.length > 0 ? varietyScores.reduce((a, b) => a + b, 0) / varietyScores.length : 0.6;
  const score = clamp(0.6 * densityFit + 0.4 * velVariety);
  return { score, fill, flatTracks };
}

// ---------------------------------------------------------------------------
// Metric 6: event_budget. Retrig steps <= 2 (decay past that); presence of 1-2
// once-only/rare events rewarded; unconditioned high-frequency walls penalised.
// ---------------------------------------------------------------------------
function eventBudget(u: Unrolled, pattern: PatternDecl) {
  let retrigCount = 0;
  for (const decl of Object.values(pattern.tracks)) retrigCount += decl.retrigs?.length ?? 0;
  const retrigScore = retrigCount <= RETRIG_BUDGET ? 1 : clamp(1 - (retrigCount - RETRIG_BUDGET) / 4);

  let rareCount = 0;
  for (const info of u.infos) {
    for (const onset of info.baseOnsets) if (isRareCondition(onset.cond)) rareCount += 1;
  }
  let rareScore: number;
  if (rareCount === 0) rareScore = 0.35;
  else if (rareCount <= 2) rareScore = 1;
  else rareScore = clamp(1 - (rareCount - 2) * 0.15);

  const walls: string[] = [];
  for (const info of u.infos) {
    if (!HI_FREQ.has(info.track)) continue;
    const uncond = info.baseOnsets.filter((o) => o.cond.kind === "none").length;
    const uncondFrac = uncond / info.baseOnsets.length;
    const trackDensity = info.baseOnsets.length / info.effLen;
    if (uncondFrac > 0.8 && trackDensity > 0.5) walls.push(info.track);
  }
  const score = clamp(0.55 * retrigScore + 0.45 * rareScore - 0.2 * walls.length);
  return { score, retrigCount, rareCount, walls };
}

// ---------------------------------------------------------------------------
// Carve audit (informational). Per choke pair over one super-cycle: co-hit steps
// ("carve collisions") and carver-into-ring-tail steps ("carves"). Uses placed
// trigs (grid onsets), so counts are potential, condition-gated in playback.
// ---------------------------------------------------------------------------
interface CarveEntry {
  pair: string;
  collisions: number[];
  carves: number[];
}
function carveAudit(u: Unrolled): CarveEntry[] {
  const L = u.superLen;
  const entries: CarveEntry[] = [];
  for (const { ring, carver } of CHOKE_PAIRS) {
    const ringInfo = u.byTrack.get(ring);
    const carverInfo = u.byTrack.get(carver);
    const pair = `${carver}↔${ring}`;
    if (!ringInfo || !carverInfo) {
      entries.push({ pair, collisions: [], carves: [] });
      continue;
    }
    const collisions: number[] = [];
    const carves: number[] = [];
    for (let pos = 0; pos < L; pos += 1) {
      const carverFires = carverInfo.onsetAtLocal[pos % carverInfo.effLen];
      if (!carverFires) continue;
      const ringFires = ringInfo.onsetAtLocal[pos % ringInfo.effLen];
      if (ringFires) collisions.push(pos + 1); // 1-based unrolled step
      let tail = false;
      for (let d = 1; d <= CARVE_TAIL; d += 1) {
        const prev = (pos - d + L) % L;
        if (ringInfo.onsetAtLocal[prev % ringInfo.effLen]) {
          tail = true;
          break;
        }
      }
      if (tail) carves.push(pos + 1);
    }
    entries.push({ pair, collisions, carves });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Flags: concrete, actionable strings that drive the redesign.
// ---------------------------------------------------------------------------
function buildFlags(parts: {
  interference: ReturnType<typeof interferenceStructure>;
  sync: ReturnType<typeof syncopationEntropy>;
  poly: ReturnType<typeof polymeterSupercycle>;
  causal: ReturnType<typeof causalDepth>;
  density: ReturnType<typeof densityDiscipline>;
  event: ReturnType<typeof eventBudget>;
}): string[] {
  const flags: string[] = [];
  if (parts.interference.score < 0.15) {
    if (parts.interference.barLock > parts.interference.prominence) flags.push("no interference: kit is bar-locked (16-periodic)");
    else flags.push("no interference structure (flat/no autocorrelation peak)");
  }
  if (parts.poly.uniform) flags.push("no polymeter (all onset tracks share length; super-cycle = 1 bar)");
  if (parts.causal.totalCond === 0) flags.push("no conditions (no causal structure)");
  else if (!parts.causal.chain && !parts.causal.responder) flags.push("shallow causal net (no seed->pre chain, no nei responder)");
  if (parts.event.retrigCount > RETRIG_BUDGET) flags.push(`${parts.event.retrigCount} retrig steps (budget <= ${RETRIG_BUDGET})`);
  if (parts.event.rareCount === 0) flags.push("no once-only/rare event");
  for (const track of parts.event.walls) flags.push(`${track}: unconditioned wall (fires every cycle, density > 0.5)`);
  for (const track of parts.density.flatTracks) flags.push(`${track}: many hits all at one velocity`);
  if (parts.sync.normEntropy > 0 && parts.sync.normEntropy < 0.45) flags.push(`syncopation too regular (entropy ${parts.sync.normEntropy.toFixed(2)})`);
  return flags;
}

// ---------------------------------------------------------------------------
// Per-pattern and whole-declaration scoring.
// ---------------------------------------------------------------------------
export interface IdmResult {
  slot: string;
  name: string;
  composite: number; // 0..100
  subscores: Record<MetricKey, number>; // each 0..1
  flags: string[];
  carve: CarveEntry[];
  meta: {
    masterLen: number;
    superCycleBars: number;
    analysisLen: number;
    onsetTracks: number;
    fillRatio: number;
    normEntropy: number;
    conditions: number;
    retrigSteps: number;
  };
}

export function scorePattern(pattern: PatternDecl): IdmResult {
  const u = unroll(pattern);
  const interference = interferenceStructure(u);
  const sync = syncopationEntropy(u);
  const poly = polymeterSupercycle(u);
  const causal = causalDepth(u);
  const density = densityDiscipline(u);
  const event = eventBudget(u, pattern);

  const subscores: Record<MetricKey, number> = {
    interference_structure: interference.score,
    syncopation_entropy: sync.score,
    polymeter_supercycle: poly.score,
    causal_depth: causal.score,
    density_discipline: density.score,
    event_budget: event.score,
  };
  let composite = 0;
  for (const key of Object.keys(WEIGHTS) as MetricKey[]) composite += WEIGHTS[key] * subscores[key];

  return {
    slot: pattern.slot,
    name: pattern.name,
    composite: Math.round(composite * 100),
    subscores,
    flags: buildFlags({ interference, sync, poly, causal, density, event }),
    carve: carveAudit(u),
    meta: {
      masterLen: u.masterLen,
      superCycleBars: u.superCycleBars,
      analysisLen: u.superLen,
      onsetTracks: u.onsetTracks,
      fillRatio: Number(density.fill.toFixed(3)),
      normEntropy: Number(sync.normEntropy.toFixed(3)),
      conditions: causal.totalCond,
      retrigSteps: event.retrigCount,
    },
  };
}

export function scoreDeclaration(patterns: PatternDecl[], slots?: Set<string>): IdmResult[] {
  return patterns.filter((p) => !slots || slots.has(p.slot)).map(scorePattern);
}

// ---------------------------------------------------------------------------
// CLI: human table + carve audit by default, --json for full result objects.
// ---------------------------------------------------------------------------
const SUB_ABBR: Array<[MetricKey, string]> = [
  ["interference_structure", "is"],
  ["syncopation_entropy", "se"],
  ["polymeter_supercycle", "ps"],
  ["causal_depth", "cd"],
  ["density_discipline", "dd"],
  ["event_budget", "eb"],
];

function formatSteps(steps: number[]): string {
  if (steps.length === 0) return "-";
  const shown = steps.slice(0, 16).join(",");
  return steps.length > 16 ? `${shown},...` : shown;
}

function formatTable(results: IdmResult[]): string {
  const header = `slot  ${"name".padEnd(15)}  comp  ${SUB_ABBR.map(([, a]) => a.padStart(3)).join(" ")}  cyc  flags`;
  const lines = [header, "-".repeat(header.length)];
  for (const r of results) {
    const subs = SUB_ABBR.map(([key]) => String(Math.round(r.subscores[key] * 100)).padStart(3)).join(" ");
    const flags = r.flags.slice(0, 3).join("; ");
    const cyc = `${r.meta.superCycleBars}b`.padStart(3);
    lines.push(`${r.slot.padEnd(4)}  ${r.name.slice(0, 15).padEnd(15)}  ${String(r.composite).padStart(4)}  ${subs}  ${cyc}  ${flags}`);
  }
  const avg = results.length > 0 ? results.reduce((s, r) => s + r.composite, 0) / results.length : 0;
  lines.push("-".repeat(header.length));
  lines.push(`mean composite: ${avg.toFixed(1)} over ${results.length} pattern(s)`);
  return lines.join("\n");
}

function formatCarve(results: IdmResult[]): string {
  const lines = ["", "CARVE AUDIT (informational — intentional audio-domain subtraction; steps are 1-based, unrolled to the super-cycle)"];
  for (const r of results) {
    const active = r.carve.filter((c) => c.collisions.length > 0 || c.carves.length > 0);
    lines.push(`${r.slot}  ${r.name}`);
    if (active.length === 0) {
      lines.push("  (no carve activity)");
      continue;
    }
    for (const c of active) {
      lines.push(`  ${c.pair}  collisions ${c.collisions.length} [${formatSteps(c.collisions)}]  carves ${c.carves.length} [${formatSteps(c.carves)}]`);
    }
  }
  return lines.join("\n");
}

export function runScore(argv = process.argv.slice(2)): void {
  const args = [...argv];
  const json = args.includes("--json");
  const slotsIndex = args.indexOf("--slots");
  let slots: Set<string> | undefined;
  if (slotsIndex !== -1) {
    const value = args[slotsIndex + 1];
    if (!value) {
      process.stderr.write("usage: score-idm.ts <declaration.json> [--slots G01,G02] [--json]\n");
      process.exitCode = 2;
      return;
    }
    slots = new Set(
      value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    args.splice(slotsIndex, 2);
  }
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    process.stderr.write("usage: score-idm.ts <declaration.json> [--slots G01,G02] [--json]\n");
    process.exitCode = 2;
    return;
  }
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  const results = scoreDeclaration(extractPatterns(input), slots);
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTable(results)}\n${formatCarve(results)}\n`);
  }
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) runScore();
