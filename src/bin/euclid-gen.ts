import { readFileSync } from "node:fs";
import { makePrng } from "../gen/prng.ts";
import type { Prng } from "../gen/prng.ts";
import type { TrackDecl } from "./build-project.ts";

// Deterministic two-generator Boolean Euclidean pattern generator for the
// HYSTERESIS interference layer. It computes two Euclidean (Bjorklund) rhythms
// agent-side, combines them with a Boolean operator, assigns velocity tiers,
// and FREEZES the result into a declaration TrackDecl fragment ({ grid, length })
// ready to paste into a pattern's track (generate -> freeze -> mutate, the
// Autechre-systems methodology). No device, no DSP, no external dependencies.
//
//   npm run euclid:gen -- --gen1 5,16 --gen2 7,16 --op xor --rot2 3 --len 16
//   npm run euclid:gen -- --spec recipes.json [--seed 1]
//
// SINGLE MODE (flags): prints the two generator grids, the combined tiered grid
// (grouped in 4s), the onset/accent counts, and a ready TrackDecl JSON fragment.
//   --gen1 k,n   first generator E(k,n)            (required)
//   --gen2 k,n   second generator E(k,n)           (required)
//   --op         or | xor | and | sub              (default xor)
//   --rot1 N     rotate generator 1 right by N     (default 0)
//   --rot2 N     rotate generator 2 right by N     (default 0)
//   --len N      output loop length                (default max(n1,n2))
//   --seed N     PRNG seed for soft-tier draws     (default 1)
//   --soft-prob p   optional: soft ("o") tier probability for non-accent onsets
//   --accent-every N  optional: also accent every Nth onset (interference reinforcement)
//   --json       print only the TrackDecl fragment JSON (pipeable)
//
// SPEC MODE (--spec file.json): emits a JSON object mapping track id -> TrackDecl
// fragment. The spec is
//   { "tracks": { "CY": { "gen1":[5,16], "gen2":[7,16], "op":"xor", "rot2":3,
//                         "len":16, "tiers": { "accentEvery": 4, "softProb": 0.2 } }, ... } }
// All randomness (soft tiers only) flows through a seeded PRNG forked per track
// id, so identical (spec, seed) always produces byte-identical output.
//
// Conventions frozen here:
// - bjorklund(k,n) is the canonical Euclidean spread; the returned array is
//   rotated so it STARTS WITH AN ONSET (index 0 is true whenever 0 < k < n).
// - rotate(arr, r) rotates RIGHT by r (an onset at index j moves to (j+r) mod n),
//   i.e. it delays the pattern by r steps. Negative and out-of-range r wrap.
// - combine ops over two equal-length boolean arrays: OR = union, XOR = symmetric
//   difference (interference), AND = both fired, SUB = a AND NOT b (a carved by b).
// - Tier assignment: every onset defaults to normal "x". An onset is accented
//   "X" where BOTH generators fired (the AND overlap = interference reinforcement
//   points) or, if accentEvery is set, on every Nth onset. Remaining normal
//   onsets become soft "o" with probability softProb (seeded, drawn in ascending
//   step order). XOR/SUB patterns have no AND overlap, so they carry no accents
//   unless accentEvery is supplied.

export type BooleanOp = "or" | "xor" | "and" | "sub";
const OPS: readonly BooleanOp[] = ["or", "xor", "and", "sub"];

// The declaration fragment this tool freezes: the onset grid plus its loop
// length. Tied to the builder's TrackDecl so the schema stays in lockstep.
export type EuclidFragment = Pick<TrackDecl, "grid" | "length">;

// ---------------------------------------------------------------------------
// Pure pattern algebra (exported for tests / reuse).
// ---------------------------------------------------------------------------

// Standard Bjorklund/Euclidean spread of k onsets across n steps, distributed as
// evenly as possible via the recursive-remainder merge. Canonically rotated to
// begin with an onset. Degenerate inputs are clamped (k<=0 -> all rests,
// k>=n -> all onsets, n<=0 -> empty).
export function bjorklund(k: number, n: number): boolean[] {
  if (n <= 0) return [];
  const pulses = Math.max(0, Math.min(Math.trunc(k), n));
  if (pulses === 0) return new Array<boolean>(n).fill(false);
  if (pulses === n) return new Array<boolean>(n).fill(true);

  let groups: boolean[][] = [];
  let remainders: boolean[][] = [];
  for (let i = 0; i < pulses; i += 1) groups.push([true]);
  for (let i = 0; i < n - pulses; i += 1) remainders.push([false]);

  // Repeatedly fold the remainder buckets into the groups until at most one
  // remainder bucket is left; the concatenation is the canonical spread.
  while (remainders.length > 1) {
    const count = Math.min(groups.length, remainders.length);
    const merged: boolean[][] = [];
    for (let i = 0; i < count; i += 1) merged.push([...groups[i], ...remainders[i]]);
    const leftover = groups.length > remainders.length ? groups.slice(count) : remainders.slice(count);
    groups = merged;
    remainders = leftover;
  }

  const out: boolean[] = [];
  for (const group of groups) out.push(...group);
  for (const group of remainders) out.push(...group);
  return out;
}

// Rotate RIGHT by r: result[i] = arr[(i - r) mod n]. An onset at j lands at j+r.
export function rotate(arr: boolean[], r: number): boolean[] {
  const n = arr.length;
  if (n === 0) return [];
  const shift = ((Math.trunc(r) % n) + n) % n;
  const out = new Array<boolean>(n);
  for (let i = 0; i < n; i += 1) out[i] = arr[(i - shift + n) % n];
  return out;
}

// Boolean combine over the longer of the two arrays (missing positions = rest).
// OR union, XOR symmetric difference, AND intersection, SUB = a AND NOT b.
export function combine(a: boolean[], b: boolean[], op: BooleanOp): boolean[] {
  const n = Math.max(a.length, b.length);
  const out = new Array<boolean>(n);
  for (let i = 0; i < n; i += 1) {
    const x = i < a.length ? a[i] : false;
    const y = i < b.length ? b[i] : false;
    out[i] = op === "or" ? x || y : op === "and" ? x && y : op === "xor" ? x !== y : x && !y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grid assembly.
// ---------------------------------------------------------------------------

// Tile (repeat) a pattern out to a target length so a combine can run over a
// declared --len that differs from the generators' step counts.
function tile(arr: boolean[], len: number): boolean[] {
  if (len <= 0) return [];
  if (arr.length === 0) return new Array<boolean>(len).fill(false);
  const out = new Array<boolean>(len);
  for (let i = 0; i < len; i += 1) out[i] = arr[i % arr.length];
  return out;
}

function groupInFours(symbols: string): string {
  return (symbols.match(/.{1,4}/g) ?? []).join(" ");
}

interface TierOptions {
  accentEvery?: number;
  softProb?: number;
}

// Build the tiered grid string from the combined onsets + the AND overlap.
// Default "x"; "X" on AND-overlap onsets (and every accentEvery-th onset); "o"
// on softProb-selected non-accent onsets (seeded, ascending order).
function buildGrid(combined: boolean[], overlap: boolean[], opts: TierOptions, prng?: Prng): string {
  const accentEvery = opts.accentEvery && opts.accentEvery > 0 ? Math.trunc(opts.accentEvery) : 0;
  const softProb = opts.softProb && opts.softProb > 0 ? Math.min(1, opts.softProb) : 0;
  let onsetIndex = 0;
  const chars: string[] = [];
  for (let i = 0; i < combined.length; i += 1) {
    if (!combined[i]) {
      chars.push(".");
      continue;
    }
    onsetIndex += 1;
    const reinforced = i < overlap.length && overlap[i];
    const periodic = accentEvery > 0 && onsetIndex % accentEvery === 0;
    if (reinforced || periodic) {
      chars.push("X");
      continue;
    }
    if (softProb > 0 && prng && prng.next() < softProb) {
      chars.push("o");
      continue;
    }
    chars.push("x");
  }
  return groupInFours(chars.join(""));
}

interface GenSpec {
  gen1: [number, number];
  gen2: [number, number];
  op: BooleanOp;
  rot1: number;
  rot2: number;
  len: number;
  tiers: TierOptions;
}

interface PatternResult {
  fragment: EuclidFragment;
  onsets: number;
  accents: number;
  gen1Grid: string;
  gen2Grid: string;
}

// Compute one two-generator pattern: freeze the combined, tiered onsets into a
// TrackDecl fragment plus the individual (rotated) generator grids for display.
export function computePattern(spec: GenSpec, prng?: Prng): PatternResult {
  const [k1, n1] = spec.gen1;
  const [k2, n2] = spec.gen2;
  const raw1 = rotate(bjorklund(k1, n1), spec.rot1);
  const raw2 = rotate(bjorklund(k2, n2), spec.rot2);
  const a1 = tile(raw1, spec.len);
  const a2 = tile(raw2, spec.len);
  const combined = combine(a1, a2, spec.op);
  const overlap = combine(a1, a2, "and");
  const grid = buildGrid(combined, overlap, spec.tiers, prng);
  return {
    fragment: { grid, length: spec.len },
    onsets: combined.reduce((sum, on) => sum + (on ? 1 : 0), 0),
    accents: (grid.match(/X/g) ?? []).length,
    gen1Grid: groupInFours(raw1.map((on) => (on ? "x" : ".")).join("")),
    gen2Grid: groupInFours(raw2.map((on) => (on ? "x" : ".")).join("")),
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

interface CliArgs {
  spec?: string;
  gen1?: string;
  gen2?: string;
  op: string;
  rot1: number;
  rot2: number;
  len?: number;
  seed: number;
  softProb?: number;
  accentEvery?: number;
  json: boolean;
}

interface SpecTrack {
  gen1: [number, number];
  gen2: [number, number];
  op?: string;
  rot1?: number;
  rot2?: number;
  len?: number;
  tiers?: TierOptions;
}

const USAGE =
  "usage: euclid-gen.ts (--gen1 k,n --gen2 k,n [--op xor] [--rot1 N] [--rot2 N] [--len N] [--soft-prob p] [--accent-every N] [--json]) | (--spec file.json [--seed N])\n";

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { op: "xor", rot1: 0, rot2: 0, seed: 1, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec") args.spec = argv[(i += 1)];
    else if (arg === "--gen1") args.gen1 = argv[(i += 1)];
    else if (arg === "--gen2") args.gen2 = argv[(i += 1)];
    else if (arg === "--op") args.op = (argv[(i += 1)] ?? "").toLowerCase();
    else if (arg === "--rot1") args.rot1 = toInt(argv[(i += 1)], 0);
    else if (arg === "--rot2") args.rot2 = toInt(argv[(i += 1)], 0);
    else if (arg === "--len") args.len = toInt(argv[(i += 1)], 0);
    else if (arg === "--seed") args.seed = toInt(argv[(i += 1)], 1);
    else if (arg === "--soft-prob") args.softProb = Number(argv[(i += 1)]);
    else if (arg === "--accent-every") args.accentEvery = toInt(argv[(i += 1)], 0);
    else if (arg === "--json") args.json = true;
  }
  return args;
}

function asOp(value: string | undefined): BooleanOp | undefined {
  const lower = (value ?? "").toLowerCase();
  return (OPS as readonly string[]).includes(lower) ? (lower as BooleanOp) : undefined;
}

function isPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

function formatSingle(spec: GenSpec, result: PatternResult): string {
  const [k1, n1] = spec.gen1;
  const [k2, n2] = spec.gen2;
  return [
    `E(${k1},${n1}) rot${spec.rot1}  ${spec.op.toUpperCase()}  E(${k2},${n2}) rot${spec.rot2}   len ${spec.len}`,
    `  gen1  ${result.gen1Grid}`,
    `  gen2  ${result.gen2Grid}`,
    `  grid  ${result.fragment.grid}`,
    `  onsets ${result.onsets}  accents ${result.accents}`,
    `  fragment ${JSON.stringify(result.fragment)}`,
  ].join("\n");
}

function runSpec(specPath: string, seed: number): void {
  const raw = JSON.parse(readFileSync(specPath, "utf8")) as { tracks?: Record<string, SpecTrack> };
  if (!raw.tracks || typeof raw.tracks !== "object") {
    process.stderr.write("spec must be an object with a `tracks` map\n");
    process.exitCode = 2;
    return;
  }
  const out: Record<string, EuclidFragment> = {};
  for (const [track, entry] of Object.entries(raw.tracks)) {
    if (!isPair(entry.gen1) || !isPair(entry.gen2)) {
      process.stderr.write(`${track}: gen1 and gen2 must both be [k, n] pairs\n`);
      process.exitCode = 2;
      return;
    }
    const op = asOp(entry.op);
    if (entry.op !== undefined && op === undefined) {
      process.stderr.write(`${track}: op must be one of ${OPS.join(", ")}, got ${JSON.stringify(entry.op)}\n`);
      process.exitCode = 2;
      return;
    }
    const len = entry.len ?? Math.max(entry.gen1[1], entry.gen2[1]);
    const tiers: TierOptions = { accentEvery: entry.tiers?.accentEvery, softProb: entry.tiers?.softProb };
    const spec: GenSpec = {
      gen1: entry.gen1,
      gen2: entry.gen2,
      op: op ?? "xor",
      rot1: Math.trunc(entry.rot1 ?? 0),
      rot2: Math.trunc(entry.rot2 ?? 0),
      len,
      tiers,
    };
    // Fork the PRNG per track id so track order is irrelevant and adding a track
    // never shifts another track's soft-tier draws.
    const prng = tiers.softProb && tiers.softProb > 0 ? makePrng(`euclid:${seed}:${track}`) : undefined;
    out[track] = computePattern(spec, prng).fragment;
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

export function runEuclid(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  if (args.spec) {
    runSpec(args.spec, args.seed);
    return;
  }
  const g1 = args.gen1?.split(",").map((s) => Number(s.trim()));
  const g2 = args.gen2?.split(",").map((s) => Number(s.trim()));
  if (!isPair(g1) || !isPair(g2)) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const op = asOp(args.op);
  if (op === undefined) {
    process.stderr.write(`--op must be one of ${OPS.join(", ")}, got ${JSON.stringify(args.op)}\n`);
    process.exitCode = 2;
    return;
  }
  const len = args.len && args.len > 0 ? args.len : Math.max(g1[1], g2[1]);
  const tiers: TierOptions = { accentEvery: args.accentEvery, softProb: args.softProb };
  const spec: GenSpec = { gen1: g1, gen2: g2, op, rot1: args.rot1, rot2: args.rot2, len, tiers };
  const prng = args.softProb && args.softProb > 0 ? makePrng(`euclid:${args.seed}:single`) : undefined;
  const result = computePattern(spec, prng);
  if (args.json) process.stdout.write(`${JSON.stringify(result.fragment, null, 2)}\n`);
  else process.stdout.write(`${formatSingle(spec, result)}\n`);
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) runEuclid();
