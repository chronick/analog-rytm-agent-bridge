import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSamples,
  decodeWav,
  fftRadix2,
  activeRange,
  extractFrameFeatures,
  sidecarTempo,
  ADJ_SIM_FLAG,
  LONGEST_RUN_FLAG,
} from "../src/bin/analyze-render.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SR = 48000;

// ---------------------------------------------------------------------------
// Deterministic synthesis helpers: build a render as a stack of per-bar drum
// "patterns". A pattern is a set of (step, kind) hits; a hit is a short
// exponentially-decayed burst (noise for a snare/hat, a low sine for a kick).
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Hit {
  step: number; // 0..15
  freq: number; // burst carrier (Hz); low = kick-ish, high = hat-ish
  noise: number; // 0..1 noise mix
  decay: number; // seconds
}

function renderBar(out: Float64Array, offset: number, barSamples: number, hits: Hit[], rng: () => number): void {
  for (const h of hits) {
    const start = offset + Math.floor((h.step / 16) * barSamples);
    const len = Math.floor(h.decay * SR);
    for (let i = 0; i < len && start + i < out.length; i += 1) {
      const env = Math.exp(-i / (h.decay * SR * 0.3));
      const tone = Math.sin((2 * Math.PI * h.freq * i) / SR);
      const noise = 2 * rng() - 1;
      out[start + i] += env * ((1 - h.noise) * tone + h.noise * noise) * 0.6;
    }
  }
}

/** Build a render: `leadSilenceSec` of silence, then `bars` bars at `bpm`. */
function synthRender(opts: {
  bpm: number;
  bars: number;
  leadSilenceSec?: number;
  patternForBar: (bar: number, rng: () => number) => Hit[];
}): Float64Array {
  const barSamples = Math.round((4 * 60 * SR) / opts.bpm);
  const lead = Math.round((opts.leadSilenceSec ?? 0) * SR);
  const out = new Float64Array(lead + barSamples * opts.bars + SR); // + tail
  for (let b = 0; b < opts.bars; b += 1) {
    // Fresh RNG per bar seeded by bar index only when the caller wants variation;
    // for verbatim loops the caller returns identical hits and we must render
    // identical noise, so seed the noise RNG by a STABLE key.
    const rng = mulberry32(1000 + b);
    renderBar(out, lead + b * barSamples, barSamples, opts.patternForBar(b, rng), rng);
  }
  return out;
}

// A fixed 4-on-the-floor + hats pattern (verbatim every bar). Noise is seeded
// identically per bar so bars are bit-for-bit repeats.
const LOOP_HITS: Hit[] = [
  { step: 0, freq: 55, noise: 0.1, decay: 0.18 },
  { step: 4, freq: 55, noise: 0.1, decay: 0.18 },
  { step: 8, freq: 55, noise: 0.1, decay: 0.18 },
  { step: 12, freq: 55, noise: 0.1, decay: 0.18 },
  { step: 2, freq: 9000, noise: 0.9, decay: 0.05 },
  { step: 6, freq: 9000, noise: 0.9, decay: 0.05 },
  { step: 10, freq: 9000, noise: 0.9, decay: 0.05 },
  { step: 14, freq: 9000, noise: 0.9, decay: 0.05 },
];
function verbatimPattern(): Hit[] {
  return LOOP_HITS;
}

// A varied pattern: kick placement and a mid tonal hit shuffle every bar.
function variedPattern(bar: number): Hit[] {
  const rng = mulberry32(9 + bar * 7);
  const hits: Hit[] = [{ step: 0, freq: 55, noise: 0.1, decay: 0.18 }];
  for (let s = 1; s < 16; s += 1) {
    if (rng() < 0.4) {
      hits.push({ step: s, freq: 200 + Math.floor(rng() * 8000), noise: rng(), decay: 0.04 + rng() * 0.15 });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------
test("fftRadix2: a pure cosine concentrates energy at its bin", () => {
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bin = 5;
  for (let i = 0; i < n; i += 1) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
  fftRadix2(re, im);
  const mag = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
  let peak = 0;
  for (let k = 1; k < mag.length; k += 1) if (mag[k] > mag[peak]) peak = k;
  assert.equal(peak, bin, `energy should peak at bin ${bin}, got ${peak}`);
});

test("fftRadix2: an impulse produces a flat magnitude spectrum", () => {
  const n = 32;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re[0] = 1;
  fftRadix2(re, im);
  for (let k = 0; k < n; k += 1) {
    assert.ok(Math.abs(Math.hypot(re[k], im[k]) - 1) < 1e-9, `bin ${k} magnitude should be 1`);
  }
});

// ---------------------------------------------------------------------------
// WAV decode
// ---------------------------------------------------------------------------
function encodeWavPcm16(mono: Float64Array, sampleRate: number, channels = 1): Buffer {
  const bytesPerSample = 2;
  const dataLen = mono.length * bytesPerSample * channels;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample * channels, 28);
  buf.writeUInt16LE(bytesPerSample * channels, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  let p = 44;
  for (let i = 0; i < mono.length; i += 1) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    const s = Math.round(v * 32767);
    for (let c = 0; c < channels; c += 1) {
      buf.writeInt16LE(s, p);
      p += 2;
    }
  }
  return buf;
}

test("decodeWav: round-trips a PCM16 stereo signal and downmixes to mono", () => {
  const mono = Float64Array.from([0, 0.5, -0.5, 1, -1, 0.25]);
  const wav = encodeWavPcm16(mono, SR, 2);
  const dec = decodeWav(wav);
  assert.equal(dec.sampleRate, SR);
  assert.equal(dec.channels, 2);
  assert.equal(dec.frames, mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    assert.ok(Math.abs(dec.mono[i] - mono[i]) < 1e-3, `sample ${i}: ${dec.mono[i]} vs ${mono[i]}`);
  }
});

test("decodeWav: rejects non-RIFF input", () => {
  assert.throws(() => decodeWav(Buffer.from("not a wav file at all")), /RIFF/);
});

// ---------------------------------------------------------------------------
// Lead-in / active-range detection
// ---------------------------------------------------------------------------
test("activeRange: skips leading silence to the first onset", () => {
  const mono = synthRender({ bpm: 120, bars: 6, leadSilenceSec: 3, patternForBar: verbatimPattern });
  const feat = extractFrameFeatures(mono, SR);
  const { firstFrame } = activeRange(feat.energy);
  const leadInSec = firstFrame * feat.hopSec;
  assert.ok(leadInSec > 2.5 && leadInSec < 3.6, `lead-in ${leadInSec.toFixed(2)}s should be ~3s`);
});

// ---------------------------------------------------------------------------
// End-to-end: verbatim loop vs. varied material
// ---------------------------------------------------------------------------
test("analyzeSamples: a verbatim 1-bar loop reads as highly repetitive and flags (a) and (b)", () => {
  const mono = synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: verbatimPattern });
  const a = analyzeSamples(mono, SR, "verbatim.wav", { tempo: 120 });
  assert.ok(a.barCount >= 12, `expected ~16 bars, got ${a.barCount}`);
  assert.ok(a.metrics.meanAdjacentSimilarity > ADJ_SIM_FLAG, `adjSim ${a.metrics.meanAdjacentSimilarity} should flag`);
  assert.ok(a.metrics.adjacentSimilarityFlag);
  assert.ok(a.metrics.longestNearIdenticalRun > LONGEST_RUN_FLAG, `run ${a.metrics.longestNearIdenticalRun} should flag`);
  assert.ok(a.metrics.longestRunFlag);
  assert.ok(a.metrics.repetitivenessIndex >= 60, `index ${a.metrics.repetitivenessIndex} should be high`);
  assert.ok(["repetitive", "verbatim-loop"].includes(a.verdict), `verdict ${a.verdict}`);
});

test("analyzeSamples: bar-by-bar varied material reads as far less repetitive than a verbatim loop", () => {
  const varied = analyzeSamples(
    synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: (b) => variedPattern(b) }),
    SR,
    "varied.wav",
    { tempo: 120 },
  );
  const loop = analyzeSamples(
    synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: verbatimPattern }),
    SR,
    "loop.wav",
    { tempo: 120 },
  );
  assert.ok(
    varied.metrics.meanAdjacentSimilarity < loop.metrics.meanAdjacentSimilarity - 0.03,
    `varied adjSim ${varied.metrics.meanAdjacentSimilarity.toFixed(3)} should be well below loop ${loop.metrics.meanAdjacentSimilarity.toFixed(3)}`,
  );
  assert.ok(
    varied.metrics.longestNearIdenticalRun < loop.metrics.longestNearIdenticalRun,
    `varied run ${varied.metrics.longestNearIdenticalRun} < loop run ${loop.metrics.longestNearIdenticalRun}`,
  );
  assert.ok(
    varied.metrics.repetitivenessIndex < loop.metrics.repetitivenessIndex,
    `varied index ${varied.metrics.repetitivenessIndex} < loop index ${loop.metrics.repetitivenessIndex}`,
  );
});

// ---------------------------------------------------------------------------
// Tempo lock: recover the audio's true tempo from a wrong hint
// ---------------------------------------------------------------------------
test("analyzeSamples: tempo-lock recovers the true loop tempo from a wrong hint and flags the mismatch", () => {
  // Audio actually loops at 120; feed the wrong conducting hint 123.5.
  const mono = synthRender({ bpm: 120, bars: 20, leadSilenceSec: 1, patternForBar: verbatimPattern });
  const a = analyzeSamples(mono, SR, "loop120.wav", { tempo: 123.5 });
  assert.ok(Math.abs(a.tempoLocked - 120) < 0.6, `locked ${a.tempoLocked} should be ~120`);
  assert.ok(a.findings.some((f) => f.startsWith("tempo mismatch")), "should report a tempo mismatch");
});

test("analyzeSamples: --no-tempo-lock keeps the provided hint", () => {
  const mono = synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: verbatimPattern });
  const a = analyzeSamples(mono, SR, "loop.wav", { tempo: 123.5, tempoLock: false });
  assert.equal(a.tempoLocked, 123.5);
  assert.equal(a.tempoLockApplied, false);
});

// ---------------------------------------------------------------------------
// sidecar tempo lookup
// ---------------------------------------------------------------------------
test("sidecarTempo: reads schedule.finalTempo from a sibling .events.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "arr-analyze-"));
  try {
    writeFileSync(join(dir, "take.events.json"), JSON.stringify({ schedule: { finalTempo: 128.5 } }));
    assert.equal(sidecarTempo(join(dir, "take.wav")), 128.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sidecarTempo: falls back to .json tempo, and is undefined when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "arr-analyze-"));
  try {
    writeFileSync(join(dir, "take.json"), JSON.stringify({ tempo: 119 }));
    assert.equal(sidecarTempo(join(dir, "take.wav")), 119);
    assert.equal(sidecarTempo(join(dir, "missing.wav")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
