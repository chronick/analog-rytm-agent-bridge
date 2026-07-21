// rytm-gen v0 — the generative layer over the declarative Rytm bridge. Encodes
// the craft rules established across the moonshot build generations (kick
// anchor, tom pickups, hat lift, velocity tiers, condition webs, choke-safe
// voicing, event-frequency discipline) as a deterministic, seeded generator:
// high-level config in -> valid PatternDecl bank out, self-gated against the
// existing scorer/linter plus choke + event-budget audits.

export { makePrng, hashSeed } from "./prng.ts";
export type { Prng } from "./prng.ts";
export * from "./types.ts";
export { STYLE_SPECS, arcFraction } from "./styles.ts";
export type { StyleSpec, KickMode } from "./styles.ts";
export {
  TRACKS,
  CHOKE_PAIRS,
  DEFAULT_TIER,
  CONDITION_VOCAB,
  conditionForTier,
  conditionWeight,
  tunedMotif,
  pitchClass,
} from "./roles.ts";
export type { TrackId, ChokePair } from "./roles.ts";
export { auditChokes, auditEventBudget, firingRate, tierFor } from "./audit.ts";
export { buildPattern, patternName } from "./pattern.ts";
export { generateBank, gatePattern } from "./generate.ts";
