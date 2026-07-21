// Seeded, deterministic PRNG for the generative layer. No Math.random anywhere
// in src/gen — every stochastic choice flows through one of these, so the same
// (config, seed) always produces byte-identical output. mulberry32 core (fast,
// well-distributed for our purposes) fed by a FNV-1a string hash so a run can
// be keyed by structured strings ("bankSeed:D:pattern-3:attempt-2") without the
// caller juggling raw 32-bit integers.

// FNV-1a 32-bit hash of a string -> unsigned 32-bit seed. Deterministic and
// stable across platforms (pure integer math, no locale/encoding surprises).
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // FNV prime 16777619, kept in 32-bit space via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface Prng {
  // Next float in [0, 1).
  next(): number;
  // Integer in [min, max] inclusive.
  int(min: number, max: number): number;
  // Boolean true with probability p (default 0.5).
  bool(p?: number): boolean;
  // Uniform pick from a non-empty array.
  pick<T>(items: readonly T[]): T;
  // Weighted pick: items with matching weights (weights need not sum to 1).
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  // Fisher-Yates shuffle returning a new array (does not mutate input).
  shuffle<T>(items: readonly T[]): T[];
  // A derived child PRNG keyed by a label — for isolating sub-streams so adding
  // a choice in one place does not shift every later draw elsewhere.
  fork(label: string): Prng;
}

// mulberry32: 32-bit state, one imul + a few shifts per draw. Deterministic.
export function makePrng(seed: number | string): Prng {
  let state = (typeof seed === "string" ? hashSeed(seed) : seed >>> 0) || 1;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const prng: Prng = {
    next,
    int(min, max) {
      if (max < min) return min;
      return min + Math.floor(next() * (max - min + 1));
    },
    bool(p = 0.5) {
      return next() < p;
    },
    pick(items) {
      if (items.length === 0) throw new Error("pick from empty array");
      return items[Math.floor(next() * items.length)];
    },
    weighted(items, weights) {
      if (items.length === 0) throw new Error("weighted pick from empty array");
      const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
      if (total <= 0) return items[0];
      let target = next() * total;
      for (let index = 0; index < items.length; index += 1) {
        target -= Math.max(0, weights[index] ?? 0);
        if (target < 0) return items[index];
      }
      return items[items.length - 1];
    },
    shuffle(items) {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        [copy[index], copy[swap]] = [copy[swap], copy[index]];
      }
      return copy;
    },
    fork(label) {
      // Mix the current state into the label so forks are stable but distinct.
      return makePrng(hashSeed(`${state.toString(16)}:${label}`));
    },
  };
  return prng;
}
