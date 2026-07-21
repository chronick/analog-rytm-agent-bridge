import type { PatternDecl, TrackDecl } from "../bin/build-project.ts";
import type { BudgetViolation, ChokeCollision, EventBudget, FiringTier } from "./types.ts";
import { CHOKE_PAIRS, conditionWeight, DEFAULT_TIER, TRACKS } from "./roles.ts";
import type { TrackId } from "./roles.ts";

// Offline audits over a PatternDecl that the scorer/linter do not cover:
//   1. choke audit — LCM-unrolled co-hits of a shared-voice pair (a muted hit)
//   2. event budget — effective per-master-loop firing rate vs the tier cap
// Both reason about the symbolic onset grid only (no device, no audio).

const UNROLL_CAP = 768; // matches score-danceability.ts
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : (a / gcd(a, b)) * b);

const stripGrid = (grid: string): string => grid.replace(/\s+/g, "");

interface TrackOnsets {
  effLen: number;
  positions: Set<number>; // 0-based positions within the unrolled sequence
  symbols: string; // stripped grid
  decl: TrackDecl;
}

// Unroll each declared track to the shared analysis length (LCM of loop lengths,
// 16-aligned, capped). Returns per-track onset position sets for co-hit checks.
function unrollTracks(pattern: PatternDecl): { analysisLen: number; tracks: Map<TrackId, TrackOnsets> } {
  const effLens: number[] = [16];
  const raw = new Map<TrackId, { symbols: string; effLen: number; decl: TrackDecl }>();
  for (const [track, decl] of Object.entries(pattern.tracks)) {
    const symbols = stripGrid(decl.grid);
    const effLen = decl.length ?? symbols.length;
    if ([...symbols].some((symbol) => symbol !== ".")) {
      effLens.push(effLen);
      raw.set(track as TrackId, { symbols, effLen, decl });
    }
  }
  const fullLcm = effLens.reduce((a, b) => lcm(a, b), 1);
  const analysisLen = Math.min(UNROLL_CAP, fullLcm);
  const tracks = new Map<TrackId, TrackOnsets>();
  for (const [track, { symbols, effLen, decl }] of raw) {
    const positions = new Set<number>();
    for (let pos = 0; pos < analysisLen; pos += 1) {
      const local = pos % effLen;
      const symbol = local < symbols.length ? symbols[local] : ".";
      if (symbol !== ".") positions.add(pos);
    }
    tracks.set(track, { effLen, positions, symbols, decl });
  }
  return { analysisLen, tracks };
}

// Choke audit: for each shared-voice pair, count unrolled positions where both
// members have an onset — every such position mutes the loser's hit.
export function auditChokes(pattern: PatternDecl): ChokeCollision[] {
  const { tracks } = unrollTracks(pattern);
  const collisions: ChokeCollision[] = [];
  for (const { loser, winner } of CHOKE_PAIRS) {
    const loserOnsets = tracks.get(loser)?.positions;
    const winnerOnsets = tracks.get(winner)?.positions;
    if (!loserOnsets || !winnerOnsets) continue;
    let count = 0;
    for (const pos of loserOnsets) if (winnerOnsets.has(pos)) count += 1;
    if (count > 0) {
      collisions.push({ pair: `${loser}<${winner}`, muted: loser, winner, count });
    }
  }
  return collisions;
}

// Effective firing rate of a track = number of MASTER loops the pattern spans
// times... no: it is the expected onset count per master loop. We compute onsets
// within ONE master loop (the max track length, 16-aligned) weighted by each
// onset's condition probability. A crash with one hit per bar and no condition
// over a 4-bar master reads 4.0; a "1:4" condition brings it to 1.0.
export function firingRate(pattern: PatternDecl, track: TrackId): number {
  const decl = pattern.tracks[track];
  if (!decl) return 0;
  const symbols = stripGrid(decl.grid);
  const effLen = decl.length ?? symbols.length;
  // Master loop length: the longest declared loop (silent-aware), 16-min.
  let master = 16;
  for (const other of Object.values(pattern.tracks)) {
    const otherSymbols = stripGrid(other.grid);
    if ([...otherSymbols].some((symbol) => symbol !== ".")) {
      master = Math.max(master, other.length ?? otherSymbols.length);
    }
  }
  let rate = 0;
  for (let pos = 0; pos < master; pos += 1) {
    const local = pos % effLen;
    const symbol = local < symbols.length ? symbols[local] : ".";
    if (symbol === ".") continue;
    const stepKey = String(local + 1);
    const condition = decl.conditions?.[stepKey] ?? decl.condition;
    rate += conditionWeight(condition);
  }
  return rate;
}

// Resolve the firing tier for a track: explicit override map wins, else the
// structural default.
export function tierFor(track: TrackId, overrides?: Partial<Record<TrackId, FiringTier>>): FiringTier {
  return overrides?.[track] ?? DEFAULT_TIER[track];
}

// Event-budget audit: every color/event/signature track must keep its effective
// firing rate under the tier cap. anchor/backbeat/pickup/hat are uncapped.
export function auditEventBudget(
  pattern: PatternDecl,
  budget: EventBudget,
  overrides?: Partial<Record<TrackId, FiringTier>>,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  const caps: Partial<Record<FiringTier, number>> = {
    color: budget.color,
    event: budget.event,
    signature: budget.signature,
  };
  for (const track of TRACKS) {
    if (!pattern.tracks[track]) continue;
    const tier = tierFor(track, overrides);
    const cap = caps[tier];
    if (cap === undefined) continue;
    const rate = firingRate(pattern, track);
    if (rate > cap + 1e-9) {
      violations.push({ track, tier, firingRate: Number(rate.toFixed(3)), cap });
    }
  }
  return violations;
}
