import type { PatternDecl, TrackDecl } from "../bin/build-project.ts";
import { PLOCK_SPECS } from "../bin/lint-declaration.ts";
import type { GenConfig, SampleEntry } from "./types.ts";
import type { Prng } from "./prng.ts";
import type { StyleSpec } from "./styles.ts";
import {
  conditionForTier,
  HATS,
  MELODIC_TOMS,
  SUB_TOM,
  TRACKS,
  tunedMotif,
} from "./roles.ts";
import type { TrackId } from "./roles.ts";

// The pattern proposer: a StyleSpec + an intensity dial (0..1) + a seeded PRNG
// -> one PatternDecl. Intensity gates the danceability apparatus (four-on-floor
// completion, tom pickups, hat lift, tiered hat density, colour, signature),
// so the generation loop can search intensity to hit a scorer band. Everything
// is placed to satisfy the offline linter, the choke pairs, and the event
// budget BY CONSTRUCTION; the loop's search is over musical target, not
// validity.

const GRID_LEN = 16;

// Symbol velocities mirror the builder/scorer. We mostly place symbols and let
// them carry velocity; per-step `velocities` overrides sculpt accents/ghosts.
const ACCENT = "X"; // 120
const NORMAL = "x"; // 96
const GHOST = "o"; // 40

interface TrackBuild {
  cells: string[]; // GRID_LEN symbols
  length: number;
  condition?: string;
  conditions: Record<string, string>;
  velocities: Record<string, number>;
  microtiming: Record<string, number>;
  plocks: Record<string, Record<string, number | boolean | string>>;
  retrigs: number[];
}

function emptyTrack(length = GRID_LEN): TrackBuild {
  return {
    cells: Array<string>(GRID_LEN).fill("."),
    length,
    conditions: {},
    velocities: {},
    microtiming: {},
    plocks: {},
    retrigs: [],
  };
}

// Clamp a p-lock value into its linter-declared range so generated locks always
// pass. Integer specs round; float specs clamp.
function clampPlock(parameter: string, value: number): number {
  const spec = PLOCK_SPECS[parameter];
  if (!spec) return value;
  if (spec.kind === "unsigned" || spec.kind === "signed") {
    return Math.max(spec.minimum, Math.min(spec.maximum, Math.round(value)));
  }
  if (spec.kind === "float") {
    return Math.max(spec.minimum, Math.min(spec.maximum, value));
  }
  return value;
}

function addPlock(track: TrackBuild, step1: number, parameter: string, value: number): void {
  const key = String(step1);
  if (!track.plocks[key]) track.plocks[key] = {};
  track.plocks[key][parameter] = clampPlock(parameter, value);
}

// Serialize cells to a spaced grid ("X... X... ...") — spaces are cosmetic
// (the builder/linter strip them) and match the exemplar style.
function serializeGrid(cells: string[]): string {
  const groups: string[] = [];
  for (let index = 0; index < cells.length; index += 4) groups.push(cells.slice(index, index + 4).join(""));
  return groups.join(" ");
}

function finalize(track: TrackBuild): TrackDecl {
  const decl: TrackDecl = { grid: serializeGrid(track.cells), length: track.length };
  if (track.condition) decl.condition = track.condition;
  if (Object.keys(track.conditions).length) decl.conditions = track.conditions;
  if (Object.keys(track.velocities).length) decl.velocities = track.velocities;
  if (Object.keys(track.microtiming).length) decl.microtiming = track.microtiming;
  if (Object.keys(track.plocks).length) decl.plocks = track.plocks;
  if (track.retrigs.length) decl.retrigs = track.retrigs;
  return decl;
}

// ---------------------------------------------------------------------------
// Kick archetypes. All keep an onset on step 1 (the downbeat) so kick_anchor
// always has a foothold; intensity fills in the rest.
// ---------------------------------------------------------------------------
function kickSteps(spec: StyleSpec, intensity: number, prng: Prng): number[] {
  switch (spec.kick) {
    case "four": {
      const steps = [1, 9]; // always the two half-bar anchors
      if (intensity >= 0.5) steps.push(5, 13); // complete four-on-floor
      return steps;
    }
    case "pocket": {
      const steps = [1, 9];
      if (intensity >= 0.68) steps.push(5, 13);
      return steps;
    }
    case "half":
      return intensity >= 0.85 ? [1, 5, 9, 13] : [1, 9];
    case "rolling": {
      const steps = [1, 9];
      if (intensity >= 0.5) steps.push(7); // the syncopated push
      if (intensity >= 0.72 && prng.bool(0.6)) steps.push(15); // a ghost lead into the loop
      return steps;
    }
    case "broken": {
      // Displaced but the one is present. Pick a couple of off-grid hits.
      const pool = [4, 7, 11, 12, 14];
      const chosen = prng.shuffle(pool).slice(0, intensity >= 0.6 ? 3 : 2);
      return [1, ...chosen].sort((a, b) => a - b);
    }
    case "sparse":
      return intensity >= 0.26 ? [1, 9] : [1];
    default:
      return [1];
  }
}

// ---------------------------------------------------------------------------
// The proposer.
// ---------------------------------------------------------------------------
export function buildPattern(
  slot: string,
  name: string,
  spec: StyleSpec,
  intensity: number,
  config: GenConfig,
  prng: Prng,
): PatternDecl {
  const tracks: Record<string, TrackBuild> = {};
  for (const track of TRACKS) tracks[track] = emptyTrack();

  const root = config.harmonicFrame?.root ?? "A"; // default Am world
  const palette = config.samplePalette ?? [];
  const beds = palette.filter((entry) => entry.role === "bed" || entry.role.startsWith("silt-bed"));
  const tonals = palette.filter((entry) => entry.role === "tonal");
  const percs = palette.filter((entry) => entry.role === "perc" || entry.role.startsWith("silt"));

  // --- Kick (BD) ---------------------------------------------------------
  const kicks = kickSteps(spec, intensity, prng);
  for (const step of kicks) {
    const cell = step === 1 ? ACCENT : NORMAL;
    tracks.BD.cells[step - 1] = cell;
    // Velocity shape: strong downbeat, slightly softer secondary anchors.
    tracks.BD.velocities[String(step)] = step === 1 ? 127 : step === 9 ? 116 : 104;
  }
  // Ambient kick sits back (softer, and the secondary anchor phases in via a
  // probability condition so density climbs smoothly instead of cliff-jumping
  // when the second kick appears).
  if (spec.kick === "sparse") {
    for (const step of kicks) tracks.BD.velocities[String(step)] = step === 1 ? 96 : 76;
    if (kicks.length > 1 && intensity < 0.45) {
      tracks.BD.conditions[String(kicks[kicks.length - 1])] = intensity < 0.3 ? "50%" : "75%";
    }
  }
  // A signature filter/tone accent on the downbeat kick (audible intent, 1 lock).
  addPlock(tracks.BD, 1, "filter_cutoff", 70 + Math.round(intensity * 30));

  // --- Backbeat (SD) on 2 and 4 -----------------------------------------
  if (intensity >= 0.2 && spec.kick !== "broken") {
    for (const step of [5, 13]) {
      tracks.SD.cells[step - 1] = intensity >= 0.55 ? ACCENT : NORMAL;
    }
  }

  // --- Tom pickups (LT — free of all choke pairs) ------------------------
  // Place a ghost one 16th before a fraction of kicks, wrapping for step 1.
  const pickupCoverage = Math.max(0, Math.min(1, (intensity - 0.12) / 0.5));
  const pickupKicks = prng.shuffle(kicks).slice(0, Math.round(kicks.length * pickupCoverage));
  for (const kick of pickupKicks) {
    const before = kick === 1 ? GRID_LEN : kick - 1; // 1-based step just before the kick
    if (tracks.LT.cells[before - 1] === ".") {
      tracks.LT.cells[before - 1] = GHOST;
      if (prng.bool(0.4)) tracks.LT.microtiming[String(before)] = -3; // a touch early = leaning in
    }
  }

  // --- Melodic tuned toms (MT lead, HT sparse — disjoint to respect HT<MT) ---
  if (spec.melodicToms && intensity >= 0.3) {
    const motifSteps = spec.style === "tribal"
      ? [3, 6, 11, 14, 16]
      : [3, 11, 14];
    const motif = tunedMotif(root, motifSteps.length, prng.fork(`${slot}:motif`));
    motifSteps.forEach((step, index) => {
      if (kicks.includes(step)) return; // never mask the kick with a tom accent
      tracks.MT.cells[step - 1] = index % 3 === 0 ? NORMAL : GHOST;
      addPlock(tracks.MT, step, "sample_tune", motif[index]);
      if (spec.style === "tribal" && prng.bool(0.5)) addPlock(tracks.MT, step, "filter_cutoff", 84 + prng.int(-6, 8));
    });
    // A couple of high-tom colour accents on steps MT/kick do not use.
    if (intensity >= 0.6) {
      const htPool = [4, 7, 12, 15].filter(
        (step) => tracks.MT.cells[step - 1] === "." && !kicks.includes(step),
      );
      for (const step of prng.shuffle(htPool).slice(0, spec.style === "tribal" ? 2 : 1)) {
        tracks.HT.cells[step - 1] = GHOST;
        addPlock(tracks.HT, step, "sample_tune", 12 + prng.int(-2, 4));
      }
    }
  }

  // --- Hats: OH off-beat 8ths (the lift) --------------------------------
  if (intensity >= 0.38) {
    const offbeats = [3, 7, 11, 15];
    // Ramp 1 -> 4 open hats as intensity climbs (smooth hat-lift onset).
    const ohCount = Math.max(1, Math.min(4, 1 + Math.round((intensity - 0.38) / 0.13)));
    for (const step of prng.shuffle(offbeats).slice(0, ohCount).sort((a, b) => a - b)) {
      tracks.OH.cells[step - 1] = intensity >= 0.7 ? NORMAL : GHOST;
      tracks.OH.microtiming[String(step)] = 4; // laid-back open hat
      if (prng.bool(0.5)) addPlock(tracks.OH, step, "amp_reverb_send", 28 + prng.int(0, 12));
    }
  }

  // --- Hats: CH 16th texture, tiered (velocity_shape), on even steps only
  //     (avoids the OH<CH choke — OH lives on odd off-8ths) ---------------
  if (intensity >= 0.45) {
    // Even steps 2..16 are the "e/a" 16ths, ignored by hat_lift's on/off
    // buckets but great for a tiered ghost texture and syncopation.
    const evenSteps = [2, 4, 6, 8, 10, 12, 14, 16];
    const chDensity = Math.min(1, (intensity - 0.4) / 0.5);
    const chCount = Math.round(evenSteps.length * chDensity);
    for (const step of evenSteps.slice(0, chCount)) {
      // Tier: an occasional normal among ghosts (never a flat wall).
      const symbol = step % 8 === 2 ? NORMAL : GHOST;
      tracks.CH.cells[step - 1] = symbol;
    }
    // Guarantee a mixed tier if we placed >=6 (so velocity_shape rewards it).
    if (chCount >= 6) {
      tracks.CH.velocities[String(2)] = 104; // one normal
      tracks.CH.velocities[String(10)] = 96;
    }
  }

  // --- Colour: RS (color) and CP (event) on disjoint steps, thinned by
  //     conditions so they do not blanket every loop (CP<RS respected) ----
  if (intensity >= 0.55) {
    // RS on a strong-ish position (a rim colour), condition-thinned.
    const rsStep = prng.pick([4, 7]);
    tracks.RS.cells[rsStep - 1] = GHOST;
    tracks.RS.condition = conditionForTier("color", prng.fork(`${slot}:rs`));
    if (prng.bool(0.5)) addPlock(tracks.RS, rsStep, "amp_delay_send", 30 + prng.int(0, 20));
    // CP on a different step, thinner (event tier).
    const cpStep = prng.pick([11, 12].filter((step) => step !== rsStep));
    tracks.CP.cells[cpStep - 1] = GHOST;
    tracks.CP.condition = conditionForTier("event", prng.fork(`${slot}:cp`));
  }

  // --- Signature: CY crash + CB bell, sparse and condition-gated so neither
  //     fires every loop (CB<CY respected — disjoint steps) ---------------
  if (intensity >= 0.68) {
    tracks.CY.cells[0] = ACCENT; // crash on the one...
    tracks.CY.condition = conditionForTier("signature", prng.fork(`${slot}:cy`)); // ...but not every loop
    addPlock(tracks.CY, 1, "amp_reverb_send", 40);
    if (spec.style !== "broken") {
      const cbStep = prng.pick([7, 15]);
      tracks.CB.cells[cbStep - 1] = GHOST;
      tracks.CB.condition = conditionForTier("signature", prng.fork(`${slot}:cb`));
    }
  }

  // --- Beds (BT) from the sample palette: switch a bed sample in via a
  //     sample_number p-lock; a second bed mid-pattern if available --------
  if (beds.length > 0 && (spec.style === "ambient" || spec.style === "ember" || spec.style === "hypnotic")) {
    tracks.BT.cells[0] = GHOST;
    addPlock(tracks.BT, 1, "sample_number", beds[0].slot);
    addPlock(tracks.BT, 1, "amp_reverb_send", 40);
    if (intensity < 0.4) tracks.BT.velocities[String(1)] = 70; // soft bed under ambient
    if (beds.length > 1 && intensity >= 0.3) {
      tracks.BT.cells[8] = GHOST; // second bed swell at the half-bar
      addPlock(tracks.BT, 9, "sample_number", beds[1].slot);
    }
  }
  // Tonal one-shot: swap a tonal sample onto a melodic-tom accent and tune it.
  if (tonals.length > 0 && spec.melodicToms) {
    const tonalStep = MELODIC_TOMS.map((track) => ({ track, step: firstOnset(tracks[track].cells) }))
      .find((entry) => entry.step > 0);
    if (tonalStep) {
      const entry = tonals[0];
      addPlock(tracks[tonalStep.track], tonalStep.step, "sample_number", entry.slot);
    }
  }
  // Percussion colour sample onto CB when present (a found-sound bell).
  if (percs.length > 0 && firstOnset(tracks.CB.cells) > 0) {
    addPlock(tracks.CB, firstOnset(tracks.CB.cells), "sample_number", percs[0].slot);
  }

  // --- Polymeter: give CB a non-16 loop so it phases against the bar. CY is
  //     cleared here: a phasing CB against a fixed CY crash would eventually
  //     co-hit over the LCM (a CB<CY choke), so the polymeter bell OWNS the
  //     signature voice for this pattern. ----------------------------------
  if (spec.polymeter && intensity >= 0.5) {
    const polyLen = prng.pick([12, 15]);
    tracks.CY = emptyTrack(); // signature voice goes to the phasing bell
    tracks.CB = emptyTrack(polyLen);
    const step = prng.int(3, polyLen); // 1-based, within the window
    tracks.CB.cells[step - 1] = GHOST;
    tracks.CB.condition = conditionForTier("signature", prng.fork(`${slot}:cbpoly`));
  }

  const decl: PatternDecl = {
    slot,
    name: name.slice(0, 15),
    clear: true,
    tracks: Object.fromEntries(TRACKS.map((track) => [track, finalize(tracks[track])])),
  };
  if (config.kit !== undefined) decl.kit = config.kit;
  return decl;
}

// First 1-based onset step in a cells array, or 0 if silent.
function firstOnset(cells: string[]): number {
  for (let index = 0; index < cells.length; index += 1) if (cells[index] !== ".") return index + 1;
  return 0;
}

// Sample-palette-aware default names per style, cycled by position.
const NAME_POOLS: Record<string, string[]> = {
  driving: ["launch", "propel", "thrust", "drive-on", "afterburn", "full-throttle", "redline", "overdrive", "strip-back", "tunnel", "handoff", "ascent"],
  hypnotic: ["orbit", "drift-lock", "interlock", "phase-web", "deep-cycle", "tidal", "undertow", "spiral", "hollow", "suspend", "creep", "bleed"],
  broken: ["fracture", "stagger", "drunk-step", "glitch-run", "shatter", "misfire", "reslice", "jitter", "vapor", "collapse", "reassemble", "escape"],
  ambient: ["drift", "haze", "room-tone", "negative", "underswell", "slow-build", "murk", "distant", "breath", "still", "surface", "handback"],
  tribal: ["gather", "circle", "stomp", "call-answer", "trance-toms", "ceremony", "procession", "invoke", "descent", "clearing", "ritual", "return"],
  ember: ["rekindle", "smoulder", "warm-floor", "forge", "dub-pocket", "reforge", "white-heat", "temper", "cooldown", "afterglow", "handoff", "home"],
};

export function patternName(style: string, position: number): string {
  const pool = NAME_POOLS[style] ?? ["pattern"];
  return pool[(position - 1) % pool.length];
}
