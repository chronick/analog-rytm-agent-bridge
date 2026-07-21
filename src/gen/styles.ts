import type { Style } from "./types.ts";

// A style is a bundle of high-level intent the generator turns into grids: the
// scorer band it must land in, the kick archetype, whether toms carry tuned
// melodies, whether a polymeter loop is used, and the intensity search window
// the band lives in. Editing THESE numbers is the taste knob — the machinery in
// pattern.ts/generate.ts stays fixed.

export type KickMode = "four" | "rolling" | "broken" | "sparse" | "half" | "pocket";

export interface StyleSpec {
  style: Style;
  // Danceability composite target [low, high]. The generation loop searches
  // intensity until a pattern's score lands inside this band.
  scoreBand: [number, number];
  tempoFeel: number; // default BPM (informational; nudges density)
  density: number; // baseline activity 0..1
  kick: KickMode;
  melodicToms: boolean; // tuned tom riffs grounded in the harmonic frame
  polymeter: boolean; // a polymeter color/bell loop (CB length != 16)
  // Intensity search window. Higher intensity = more danceability apparatus
  // (four-on-floor completion, pickups, hat lift, tiered density, colour).
  intensity: [number, number];
}

export const STYLE_SPECS: Record<Style, StyleSpec> = {
  // Four-on-the-floor driving techno: the floor is the point.
  driving: {
    style: "driving",
    scoreBand: [80, 100],
    tempoFeel: 130,
    density: 0.72,
    kick: "four",
    melodicToms: false,
    polymeter: false,
    intensity: [0.42, 1.0],
  },
  // Hypnotic techno: rolling anchored kick, polymeter interlocks, evolving.
  hypnotic: {
    style: "hypnotic",
    scoreBand: [68, 90],
    tempoFeel: 128,
    density: 0.55,
    kick: "rolling",
    melodicToms: true,
    polymeter: true,
    intensity: [0.42, 0.85],
  },
  // Broken / IDM: displaced kicks, drunk placement — still finds the one.
  broken: {
    style: "broken",
    scoreBand: [52, 84],
    tempoFeel: 120,
    density: 0.55,
    kick: "broken",
    melodicToms: true,
    polymeter: false,
    intensity: [0.35, 0.8],
  },
  // Compositional drummy ambient: sparse, textural, a pulse a body can find.
  ambient: {
    style: "ambient",
    scoreBand: [45, 70],
    tempoFeel: 90,
    density: 0.28,
    kick: "sparse",
    melodicToms: true,
    polymeter: false,
    intensity: [0.1, 0.52],
  },
  // Tribal tom-forward: tuned tom riffs lead, kick anchors underneath.
  tribal: {
    style: "tribal",
    scoreBand: [76, 95],
    tempoFeel: 132,
    density: 0.7,
    kick: "half",
    melodicToms: true,
    polymeter: false,
    intensity: [0.58, 1.0],
  },
  // Ember: the floor re-emerges through ambience — dubby danceable pockets.
  ember: {
    style: "ember",
    scoreBand: [70, 92],
    tempoFeel: 122,
    density: 0.6,
    kick: "pocket",
    melodicToms: true,
    polymeter: false,
    intensity: [0.5, 0.95],
  },
};

// Within-bank arc (moonshot idiom): 01-04 establish, 05-08 peak, 09-10
// strip/break, 11-12 transition. Returns a 0..1 fraction of the score band to
// aim this position at, so a bank breathes instead of flat-lining.
export function arcFraction(position: number, count: number): number {
  // position is 1-based. Normalise a 12-slot arc; scale for other counts.
  const p = count <= 1 ? 1 : (position - 1) / (count - 1); // 0..1 across the bank
  // Piecewise: rise to a peak around 0.4-0.6, dip for the break ~0.75, lift back.
  if (p < 0.33) return 0.35 + (p / 0.33) * 0.35; // establish: 0.35 -> 0.70
  if (p < 0.66) return 0.7 + ((p - 0.33) / 0.33) * 0.3; // peak: 0.70 -> 1.0
  if (p < 0.85) return 1.0 - ((p - 0.66) / 0.19) * 0.55; // strip: 1.0 -> 0.45
  return 0.45 + ((p - 0.85) / 0.15) * 0.4; // transition: 0.45 -> 0.85
}
