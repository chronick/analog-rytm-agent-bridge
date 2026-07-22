import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSamples,
  analyzeRenderFile,
  decodeWav,
  fftRadix2,
  activeRange,
  extractFrameFeatures,
  detectSilenceFrames,
  buildSilenceReport,
  detectOnsets,
  computeOnGrid,
  loadProfile,
  calibrateProfile,
  sidecarTempo,
  LEGACY_PROFILE,
  ADJ_SIM_FLAG,
  LONGEST_RUN_FLAG,
  SILENCE_ABS_DB,
  ONGRID_TOLERANCE_MS,
  type AnalyzeProfile,
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

// ---------------------------------------------------------------------------
// Continuous-energy synth for the audio-integrity gates: active bars carry a
// steady 80 Hz tone (so inter-hit gaps never dip to the noise floor, matching
// how real renders keep energy up between transients); gap bars are pure zero.
// ---------------------------------------------------------------------------
function synthContinuous(opts: { bars: number; leadSec: number; bpm?: number; gap?: [number, number]; tailSec?: number }): Float64Array {
  const bpm = opts.bpm ?? 120;
  const barSamples = Math.round((4 * 60 * SR) / bpm);
  const lead = Math.round(opts.leadSec * SR);
  const tail = Math.round((opts.tailSec ?? 1) * SR);
  const out = new Float64Array(lead + barSamples * opts.bars + tail);
  for (let b = 0; b < opts.bars; b += 1) {
    if (opts.gap && b >= opts.gap[0] && b < opts.gap[1]) continue; // silent bar
    const base = lead + b * barSamples;
    for (let i = 0; i < barSamples && base + i < out.length; i += 1) {
      out[base + i] += 0.3 * Math.sin((2 * Math.PI * 80 * (base + i)) / SR);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Silence-gap gate: detection, bar mapping (from the anchor), severity.
// ---------------------------------------------------------------------------
test("analyzeSamples: an interior silent span is detected, bar-mapped from the anchor, and errors", () => {
  // lead 2s (=1 bar @120), bars 0-7 active, bars 8-15 silent (8 bars = 16s), bars 16-23 active.
  const mono = synthContinuous({ bars: 24, leadSec: 2, gap: [8, 16] });
  const a = analyzeSamples(mono, SR, "gap.wav", { tempo: 120, tempoLock: false });
  assert.equal(a.silence.severity, "error", "an 8-bar interior silence must be ERROR");
  assert.ok(a.silence.spans.length >= 1, "the interior silence should be reported as a span");
  const sp = a.silence.spans[0];
  assert.ok(sp.startSec > 17.5 && sp.startSec < 19, `span start ${sp.startSec.toFixed(2)}s ~ 18s`);
  assert.ok(sp.endSec > 33 && sp.endSec < 35, `span end ${sp.endSec.toFixed(2)}s ~ 34s`);
  assert.ok(sp.bars > 4, `span ${sp.bars.toFixed(1)} bars should exceed the 4-bar ERROR gate`);
  // anchor ~2s, bar = (t - anchor)/2s -> silence at bars ~8..16.
  assert.ok(sp.startBar >= 7 && sp.startBar <= 9, `startBar ${sp.startBar} ~ 8`);
  assert.ok(sp.endBar >= 15 && sp.endBar <= 17, `endBar ${sp.endBar} ~ 16`);
  assert.ok(a.silence.silentFraction > 0.2, `silent fraction ${a.silence.silentFraction.toFixed(3)} should be substantial`);
});

test("analyzeSamples: continuous active audio (no interior silence) reads silence OK with no spans", () => {
  const mono = synthContinuous({ bars: 20, leadSec: 2 });
  const a = analyzeSamples(mono, SR, "clean.wav", { tempo: 120, tempoLock: false });
  assert.equal(a.silence.spans.length, 0, "no interior silent spans expected");
  assert.equal(a.silence.severity, "ok");
  assert.ok(a.silence.silentFraction < 0.05, `silent fraction ${a.silence.silentFraction.toFixed(3)} ~ 0`);
});

test("buildSilenceReport: clips spans to [anchor, lastOnset] so lead-in and tail are excluded", () => {
  const n = 200; // 200 x 50ms = 10s
  const silent = new Array<boolean>(n).fill(false);
  for (let f = 0; f < 20; f += 1) silent[f] = true; // 0-1s : lead-in
  for (let f = 100; f < 160; f += 1) silent[f] = true; // 5-8s : interior
  for (let f = 180; f < 200; f += 1) silent[f] = true; // 9-10s : tail
  const sil = { frameSec: 0.05, dbfs: new Float64Array(n), silent, floorDb: -98, thresholdDb: -70 };
  const rep = buildSilenceReport(sil, 1.0, 9.0, 1.0); // region [1s,9s], barSec 1s
  assert.equal(rep.spans.length, 1, "only the interior span survives clipping");
  const sp = rep.spans[0];
  assert.ok(Math.abs(sp.startSec - 5) < 1e-9 && Math.abs(sp.endSec - 8) < 1e-9);
  assert.equal(sp.startBar, 4); // (5 - 1)/1
  assert.equal(sp.endBar, 7); // (8 - 1)/1
  assert.ok(Math.abs(sp.bars - 3) < 1e-9);
  assert.ok(Math.abs(rep.silentSeconds - 3) < 1e-9, "lead-in and tail silence are excluded from the total");
  assert.ok(Math.abs(rep.musicalLengthSec - 8) < 1e-9);
  assert.equal(rep.severity, "error"); // fraction 3/8 = 0.375 > 0.12
});

// ---------------------------------------------------------------------------
// Adaptive noise floor vs the -70 dBFS absolute floor.
// ---------------------------------------------------------------------------
test("detectSilenceFrames: a very low noise floor falls back to the -70 dBFS absolute threshold", () => {
  // Mostly zero (device-silent), with a short loud burst.
  const mono = new Float64Array(SR * 4);
  for (let i = SR; i < SR + SR / 2; i += 1) mono[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR);
  const sil = detectSilenceFrames(mono, SR);
  assert.ok(sil.floorDb < -100, `floor ${sil.floorDb.toFixed(1)} should be near digital silence`);
  assert.equal(sil.thresholdDb, SILENCE_ABS_DB, "floor + 12 dB is below -70, so the absolute floor wins");
});

test("detectSilenceFrames: a high noise floor uses the adaptive floor + 12 dB", () => {
  const rng = mulberry32(7);
  const mono = new Float64Array(SR * 4);
  for (let i = 0; i < mono.length; i += 1) mono[i] = (2 * rng() - 1) * 0.0173; // ~ -40 dBFS RMS
  const sil = detectSilenceFrames(mono, SR);
  assert.ok(sil.floorDb > -45 && sil.floorDb < -35, `adaptive floor ${sil.floorDb.toFixed(1)} ~ -40 dBFS`);
  assert.ok(sil.thresholdDb > SILENCE_ABS_DB, `threshold ${sil.thresholdDb.toFixed(1)} should be adaptive, not -70`);
  assert.ok(Math.abs(sil.thresholdDb - (sil.floorDb + 12)) < 1e-9, "threshold == floor + 12 dB when above the absolute floor");
});

// ---------------------------------------------------------------------------
// Anchor: first-onset offset vs the expected lead-in + warn threshold.
// ---------------------------------------------------------------------------
test("analyzeSamples: anchor offset ~0 (no warn) when the lead-in matches the expected 1 bar", () => {
  const mono = synthContinuous({ bars: 12, leadSec: 2 }); // 1 bar @120 = 2s
  const a = analyzeSamples(mono, SR, "ontime.wav", { tempo: 120, tempoLock: false });
  assert.ok(Math.abs(a.anchor.anchorOffsetMs) < 300, `offset ${a.anchor.anchorOffsetMs.toFixed(0)}ms should be small`);
  assert.equal(a.anchor.warn, false);
  assert.equal(a.anchor.leadInBars, 1);
  assert.ok(Math.abs(a.anchor.expectedLeadInMs - 2000) < 1);
});

test("analyzeSamples: a late transport start yields a large positive anchor offset and warns", () => {
  const mono = synthContinuous({ bars: 12, leadSec: 3 }); // audio starts 1s after the expected 2s lead-in
  const a = analyzeSamples(mono, SR, "late.wav", { tempo: 120, tempoLock: false });
  assert.ok(a.anchor.anchorOffsetMs > 700 && a.anchor.anchorOffsetMs < 1300, `offset ${a.anchor.anchorOffsetMs.toFixed(0)}ms ~ +1000`);
  assert.equal(a.anchor.warn, true);
});

test("analyzeSamples: --lead-in-ms overrides the bar-derived expectation", () => {
  const mono = synthContinuous({ bars: 12, leadSec: 2 });
  const a = analyzeSamples(mono, SR, "leadms.wav", { tempo: 120, tempoLock: false, leadInMs: 1000 });
  assert.equal(a.anchor.leadInBars, null);
  assert.ok(Math.abs(a.anchor.expectedLeadInMs - 1000) < 1e-9);
  assert.ok(a.anchor.anchorOffsetMs > 700, `offset ${a.anchor.anchorOffsetMs.toFixed(0)}ms ~ +1000 vs the 1s expectation`);
  assert.equal(a.anchor.warn, true);
});

// ---------------------------------------------------------------------------
// On-grid fraction.
// ---------------------------------------------------------------------------
test("computeOnGrid: onsets on the grid score ~1.0; a half-grid anchor shift scores ~0", () => {
  const barSec = 2.0; // 16th grid = 0.125s
  const onsets = [0, 0.125, 0.25, 0.5, 1.0, 1.5, 1.875];
  const onGrid = computeOnGrid(onsets, 0, barSec);
  assert.equal(onGrid.onsetCount, onsets.length);
  assert.equal(onGrid.onGridFraction, 1, "all onsets sit exactly on the 1/16 grid");
  assert.equal(onGrid.gridDivision, 16);
  // Shift the grid origin by half a grid step (62.5ms > 60ms tolerance) -> nothing lands on grid.
  const shifted = computeOnGrid(onsets, 0.0625, barSec);
  assert.equal(shifted.onGridFraction, 0, "a half-step anchor shift puts every onset off-grid");
});

test("analyzeSamples: on-grid fraction is high for hits synthesised on the step grid", () => {
  const mono = synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: verbatimPattern });
  const a = analyzeSamples(mono, SR, "grid.wav", { tempo: 120, tempoLock: false });
  assert.ok(a.onGrid.onsetCount > 20, `expected many onsets, got ${a.onGrid.onsetCount}`);
  assert.ok(a.onGrid.onGridFraction > 0.8, `on-grid ${(a.onGrid.onGridFraction * 100).toFixed(0)}% should be high for on-grid hits`);
  assert.equal(a.onGrid.toleranceMs, ONGRID_TOLERANCE_MS);
});

test("detectOnsets: finds one event per hit on a sparse grid", () => {
  const buf = new Float64Array(SR * 3);
  const rng = mulberry32(3);
  // three transients at 0.5s, 1.0s, 1.5s
  for (const t of [0.5, 1.0, 1.5]) {
    const s = Math.floor(t * SR);
    for (let i = 0; i < 0.05 * SR && s + i < buf.length; i += 1) buf[s + i] = Math.exp(-i / (0.01 * SR)) * (2 * rng() - 1);
  }
  const feat = extractFrameFeatures(buf, SR);
  const onsets = detectOnsets(feat, 0, feat.flux.length - 1);
  assert.ok(onsets.length >= 3 && onsets.length <= 5, `expected ~3 onsets, got ${onsets.length}`);
});

// ---------------------------------------------------------------------------
// Calibration profiles: loading + application.
// ---------------------------------------------------------------------------
function makeProfile(over: Partial<AnalyzeProfile["thresholds"]>, name = "test"): AnalyzeProfile {
  return { schema: "analog-rytm-analyze-profile.v1", name, thresholds: { ...LEGACY_PROFILE.thresholds, ...over } };
}

test("loadProfile: reads thresholds and back-fills any missing field from the legacy profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "arr-profile-"));
  try {
    const path = join(dir, "strict.json");
    writeFileSync(path, JSON.stringify({ schema: "analog-rytm-analyze-profile.v1", name: "strict", thresholds: { adjSimFlag: 0.5, longestRunFlag: 2 } }));
    const p = loadProfile(path);
    assert.equal(p.name, "strict");
    assert.equal(p.thresholds.adjSimFlag, 0.5);
    assert.equal(p.thresholds.longestRunFlag, 2);
    // untouched fields fall back to legacy
    assert.equal(p.thresholds.nearIdenticalSim, LEGACY_PROFILE.thresholds.nearIdenticalSim);
    assert.equal(p.thresholds.noveltyFull, LEGACY_PROFILE.thresholds.noveltyFull);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeSamples: the active profile governs the adjacent-similarity flag and is echoed in the output", () => {
  const loop = synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: verbatimPattern });
  const strict = analyzeSamples(loop, SR, "x.wav", { tempo: 120, profile: makeProfile({ adjSimFlag: 0.5 }, "strict") });
  assert.equal(strict.profileName, "strict");
  assert.equal(strict.thresholds.adjSimFlag, 0.5);
  assert.equal(strict.metrics.adjacentSimilarityFlag, true, "a strict band flags the verbatim loop");
  const lenient = analyzeSamples(loop, SR, "x.wav", { tempo: 120, profile: makeProfile({ adjSimFlag: 1.0 }, "lenient") });
  assert.equal(lenient.metrics.adjacentSimilarityFlag, false, "an unreachable band clears the flag");
  // default (no profile) is legacy
  const def = analyzeSamples(loop, SR, "x.wav", { tempo: 120 });
  assert.equal(def.profileName, "legacy");
});

// ---------------------------------------------------------------------------
// Calibration math over a small corpus.
// ---------------------------------------------------------------------------
test("calibrateProfile: computes p50/p75/p90/max and pins flag bands at corpus p90", () => {
  const dir = mkdtempSync(join(tmpdir(), "arr-calib-"));
  try {
    const files: string[] = [];
    const renders = [
      synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: verbatimPattern }),
      synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: (b) => variedPattern(b) }),
      synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: (b) => variedPattern(b + 50) }),
    ];
    renders.forEach((mono, i) => {
      const p = join(dir, `take${i}.wav`);
      writeFileSync(p, encodeWavPcm16(mono, SR));
      files.push(p);
    });
    const result = calibrateProfile(files, { tempo: 120 });
    assert.equal(result.corpus.length, 3, "all three takes contribute");
    assert.equal(result.skipped.length, 0);
    for (const key of ["meanAdjacentSimilarity", "longestNearIdenticalRun", "meanNovelty", "repetitivenessIndex", "silentFraction", "anchorOffsetMsAbs", "onGridFraction"]) {
      const d = result.distributions[key];
      assert.ok(d && d.n === 3, `distribution ${key} should have n=3`);
      assert.ok(d.p50 <= d.p90 + 1e-9 && d.p90 <= d.max + 1e-9, `${key} percentiles should be monotone`);
    }
    // adjSimFlag is pinned to round(p90, 4) of the adjacency distribution.
    const expected = Math.round(result.distributions.meanAdjacentSimilarity.p90 * 1e4) / 1e4;
    assert.equal(result.profile.thresholds.adjSimFlag, expected);
    assert.equal(result.profile.thresholds.longestRunFlag, Math.max(1, Math.round(result.distributions.longestNearIdenticalRun.p90)));
    assert.equal(result.profile.schema, "analog-rytm-analyze-profile.v1");
    const prov = result.profile.provenance as { corpusSize: number; bandsPinnedAt: string; distributions: Record<string, unknown> };
    assert.equal(prov.corpusSize, 3);
    assert.equal(prov.bandsPinnedAt, "p90");
    assert.ok(prov.distributions.meanAdjacentSimilarity, "the raw distribution is embedded as provenance");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("calibrateProfile: uses a sidecar tempo when present and skips takes with no tempo", () => {
  const dir = mkdtempSync(join(tmpdir(), "arr-calib2-"));
  try {
    const mono = synthRender({ bpm: 120, bars: 16, leadSilenceSec: 1, patternForBar: verbatimPattern });
    const withSidecar = join(dir, "sidecar.wav");
    writeFileSync(withSidecar, encodeWavPcm16(mono, SR));
    writeFileSync(join(dir, "sidecar.json"), JSON.stringify({ tempo: 120 }));
    const okResult = calibrateProfile([withSidecar], {}); // no --tempo; must fall back to the sidecar
    assert.equal(okResult.corpus.length, 1, "sidecar tempo lets the take be analysed");

    const noTempo = join(dir, "notempo.wav");
    writeFileSync(noTempo, encodeWavPcm16(mono, SR));
    const skipResult = calibrateProfile([noTempo], {}); // no sidecar, no --tempo
    assert.equal(skipResult.corpus.length, 0);
    assert.equal(skipResult.skipped.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Additive fields are present even on the insufficient-audio path; existing
// fields are untouched (back-compat).
// ---------------------------------------------------------------------------
test("analyzeSamples: insufficient audio still reports anchor, silence, and on-grid", () => {
  const mono = synthContinuous({ bars: 3, leadSec: 2 }); // 3 bars < MIN_BARS_FOR_METRICS
  const a = analyzeSamples(mono, SR, "short.wav", { tempo: 120, tempoLock: false });
  assert.equal(a.verdict, "insufficient-audio");
  assert.ok(typeof a.anchor.anchorOffsetMs === "number");
  assert.ok(typeof a.silence.severity === "string");
  assert.ok(typeof a.onGrid.onGridFraction === "number");
  assert.equal(a.profileName, "legacy");
});

test("analyzeRenderFile: round-trips new fields through a written WAV", () => {
  const dir = mkdtempSync(join(tmpdir(), "arr-rt-"));
  try {
    const mono = synthContinuous({ bars: 20, leadSec: 2, gap: [8, 14] });
    const p = join(dir, "rt.wav");
    writeFileSync(p, encodeWavPcm16(mono, SR));
    const a = analyzeRenderFile(p, { tempo: 120, tempoLock: false });
    assert.equal(a.silence.severity, "error", "the 6-bar gap should error through the file path");
    assert.ok(a.anchor.firstOnsetMs >= 0);
    // existing fields intact
    assert.equal(a.schema, "analog-rytm-render-analysis.v1");
    assert.ok(Array.isArray(a.findings));
    assert.ok(typeof a.metrics.repetitivenessIndex === "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
