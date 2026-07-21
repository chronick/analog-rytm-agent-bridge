import type { FiringTier } from "./types.ts";
import type { Prng } from "./prng.ts";

// Canonical 12 tracks in the linter's order. Every generated pattern declares
// all 12 (all-dots for silent) for deterministic rebuilds.
export const TRACKS = ["BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CY", "CH", "OH", "CB"] as const;
export type TrackId = (typeof TRACKS)[number];

// Choke pairs (shared-voice mutes). Written [loser, winner]: when both fire on
// the same unrolled position the WINNER (right) sounds and the LOSER (left) is
// muted. Source: moonshot build-log root-cause ("right-hand-mutes-left"; the
// brief had CB<->CY backwards until the CY-wash voice-steal was found).
export interface ChokePair {
  loser: TrackId; // muted when both hit
  winner: TrackId; // sounds
}
export const CHOKE_PAIRS: readonly ChokePair[] = [
  { loser: "CP", winner: "RS" }, // RS mutes CP
  { loser: "HT", winner: "MT" }, // MT mutes HT
  { loser: "OH", winner: "CH" }, // CH mutes OH
  { loser: "CB", winner: "CY" }, // CY mutes CB
] as const;

// The tom family (pickup engine). BT is the sub/bass tom; LT/MT/HT are the
// melodic toms that carry tuned riffs.
export const SUB_TOM: TrackId = "BT";
export const MELODIC_TOMS: readonly TrackId[] = ["LT", "MT", "HT"];
export const HATS: readonly TrackId[] = ["CH", "OH"];

// Default firing tier per track when the config/palette does not override it.
// This is where the event-frequency discipline is encoded structurally: CY/CB
// default to signature (must not fire every loop), RS/CP to color/event.
export const DEFAULT_TIER: Record<TrackId, FiringTier> = {
  BD: "anchor",
  SD: "backbeat",
  RS: "color",
  CP: "event",
  BT: "bed",
  LT: "pickup",
  MT: "pickup",
  HT: "pickup",
  CY: "signature",
  CH: "hat",
  OH: "hat",
  CB: "signature",
};

// Trig conditions the daemon accepts, grouped by how much they thin a voice.
// Every string here is inside the linter's accepted CONDITIONS set (percent
// from the device table, ratio a:b for base 2..8). Reducing a signature/color
// voice below "every loop" means giving it one of these.
export const CONDITION_VOCAB = {
  // ~occasional colour: fires most loops but not all.
  color: ["75%", "67%", "3:4"],
  // ~half-time events.
  event: ["1:2", "50%", "59%"],
  // ~sparse signature gestures (a crash every few loops).
  signature: ["1:4", "1:8", "1:3", "33%"],
} as const;

// Pick a condition string for a firing tier (deterministic via the PRNG). anchor
// / backbeat / pickup / hat get no condition (undefined) — they are structural.
export function conditionForTier(tier: FiringTier, prng: Prng): string | undefined {
  switch (tier) {
    case "color":
      return prng.pick(CONDITION_VOCAB.color);
    case "event":
      return prng.pick(CONDITION_VOCAB.event);
    case "signature":
      return prng.pick(CONDITION_VOCAB.signature);
    default:
      return undefined;
  }
}

// The effective per-loop firing weight a condition implies (mirror of the
// scorer's conditionProbability, kept local so the budget audit does not depend
// on the scorer's CLI module). no condition = 1.0.
export function conditionWeight(condition: string | undefined): number {
  if (!condition) return 1;
  const percent = /^(\d+)%$/.exec(condition);
  if (percent) return Number(percent[1]) / 100;
  const ratio = /^(\d+):(\d+)$/.exec(condition);
  if (ratio) return Number(ratio[1]) / Number(ratio[2]);
  if (condition === "fill" || condition === "fillnot") return 0;
  return 0.5;
}

// ---------------------------------------------------------------------------
// Harmonic frame -> sample_tune semitone offsets. Tonal toms/one-shots get
// tuned into the root's natural-minor world so tuned tom riffs and bed pitches
// sit in key. sample_tune range is -24..24 semitones.
// ---------------------------------------------------------------------------
const PITCH_CLASS: Record<string, number> = {
  C: 0, "C#": 1, DB: 1, D: 2, "D#": 3, EB: 3, E: 4, F: 5,
  "F#": 6, GB: 6, G: 7, "G#": 8, AB: 8, A: 9, "A#": 10, BB: 10, B: 11,
};

// Parse a root spec ("Am" / "A" / "D4" / "F#3") to a pitch class 0..11.
export function pitchClass(root: string): number {
  const match = /^([A-Ga-g])([#b]?)/.exec(root.trim());
  if (!match) return 9; // default A
  const letter = match[1].toUpperCase();
  const accidental = match[2] === "b" ? "B" : match[2]; // normalise flat to our key form
  const key = accidental ? `${letter}${accidental === "B" ? "B" : "#"}` : letter;
  return PITCH_CLASS[key] ?? PITCH_CLASS[letter] ?? 9;
}

// Natural-minor scale degrees (semitone offsets within an octave).
export const NATURAL_MINOR = [0, 2, 3, 5, 7, 8, 10] as const;
// Minor pentatonic (safest for riffs — no leading-tone clashes).
export const MINOR_PENTATONIC = [0, 3, 5, 7, 10] as const;

// Build a short tuned motif (sample_tune values) of `length` notes over the
// minor pentatonic of `root`, relative to the tom's own base tuning (0 = the
// clip's authored pitch). Deterministic via the PRNG. Values stay within
// [-24, 24]. This is the "tuned tom riff engine" from the moonshot brief.
export function tunedMotif(root: string, length: number, prng: Prng): number[] {
  const base = pitchClass(root) - 9; // offset from A (an arbitrary but stable anchor)
  const degrees = MINOR_PENTATONIC;
  const motif: number[] = [];
  let index = 0;
  for (let note = 0; note < length; note += 1) {
    // Walk the scale with small steps (a riff, not random leaps).
    index = Math.max(0, Math.min(degrees.length - 1, index + prng.int(-1, 1)));
    const semis = base + degrees[index];
    motif.push(Math.max(-24, Math.min(24, semis)));
  }
  return motif;
}
