import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// =============================================================================
// analyze-render: BOTTOM-UP, audio-domain repetitiveness analysis of a rendered
// score WAV. The GROUND-TRUTH complement to lint-arrangement.ts.
// =============================================================================
//
//   npm run analyze:render -- <render.wav> --tempo 121.43 [--json]
//
// Why this exists: lint-arrangement.ts measures the SCORE (the conducting layer)
// -- section lengths, drops, EVENT-tier gestures -- at 2-8 bar granularity. But
// a score can pass every score-level gate while the actual audio is a 1-bar
// pattern looping verbatim underneath the conducting: the ear hears "repetitive
// drum loop" that no score-level metric can see, because the repetition lives
// BELOW the conducting grid. This tool listens to the rendered audio and
// measures bar-to-bar self-similarity directly.
//
// Method (mirrors the standard MIR self-similarity-matrix approach):
//   1. Decode WAV (PCM16/24/32 + IEEE float32/64 + WAVE_FORMAT_EXTENSIBLE),
//      downmix to mono.
//   2. STFT (1024 Hann, 512 hop) -> per frame: 8 log-spaced band energies and a
//      broadband spectral-flux onset strength.
//   3. Detect the first onset (skip lead-in: renders here carry ~39 s of leading
//      silence that no fixed metadata offset would predict) and last active
//      frame (skip the ring-out tail).
//   4. Tempo-lock: the CONDUCTING tempo (score.finalTempo, e.g. 121.43) is NOT
//      necessarily the tempo the Rytm's sequencer actually played the audio at
//      (device metadata + audio autocorrelation put the perigee-v2 renders at
//      120.0). A ~1% tempo error drifts nearly a full bar across ~80 bars and
//      silently understates every repetition metric, so we refine the tempo
//      within +-3 BPM of the hint by maximizing adjacent-bar onset-pattern
//      similarity (the phase-sensitive feature). --no-tempo-lock disables this.
//   5. Slice into bars; per-bar feature = unit(log band energies, 8) ++
//      unit(onset pattern, 16 sub-steps). Build the bar x bar cosine SSM.
//   6. Report: (a) mean adjacent-bar similarity (verbatim-loop smell; >0.97
//      flags), (b) longest run of near-identical consecutive bars (>8 flags),
//      (c) novelty per 8-bar window (how much NEW material appears), and (d) a
//      0-100 repetitiveness index.
//
// Pure TypeScript, zero runtime deps (matching the repo): a self-contained
// radix-2 FFT + WAV decoder, so it needs neither a python venv nor ffmpeg and
// is importable by lint-arrangement.ts as the bottom-up ground-truth gate.

// ---------------------------------------------------------------------------
// Tunable thresholds. Calibrated on hardware/runs/perigee-v2/*.wav (verbatim
// loops -> should score BAD) vs. a human live-jam MASTER excerpt (should score
// clearly lower). Named so recalibration is a one-line change.
// ---------------------------------------------------------------------------
export const STFT_WIN = 1024;
export const STFT_HOP = 512;
export const ONSET_STEPS = 16; // sub-steps per bar for the rhythm fingerprint
export const BAND_EDGES_HZ = [0, 80, 160, 320, 640, 1280, 2560, 6000] as const; // + nyquist

export const ADJ_SIM_FLAG = 0.97; // mean adjacent-bar similarity above this = verbatim-loop smell
export const NEAR_IDENTICAL_SIM = 0.985; // an adjacent pair this similar counts as "same bar"
export const LONGEST_RUN_FLAG = 8; // a near-identical run longer than this (bars) = a static stretch
export const TEMPO_LOCK_RANGE_BPM = 3; // search +-this around the hint
export const TEMPO_LOCK_STEP_BPM = 0.05;
export const NOVELTY_WINDOW_BARS = 8;
export const NOVELTY_FULL = 0.2; // per-bar novelty >= this counts as "fully new material"
export const MIN_BARS_FOR_METRICS = 8;

// ---------------------------------------------------------------------------
// WAV decode -> mono Float64Array. Handles PCM 16/24/32-bit, IEEE float 32/64,
// and WAVE_FORMAT_EXTENSIBLE (reads the sub-format GUID's leading code).
// ---------------------------------------------------------------------------
export interface DecodedWav {
  sampleRate: number;
  channels: number;
  frames: number;
  mono: Float64Array;
}

export function decodeWav(buf: Buffer): DecodedWav {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      audioFormat = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
      if (audioFormat === 0xfffe && chunkSize >= 40) {
        // WAVE_FORMAT_EXTENSIBLE: real format is the sub-format GUID's first 2 bytes.
        audioFormat = buf.readUInt16LE(body + 24);
      }
    } else if (chunkId === "data") {
      dataOffset = body;
      dataLength = Math.min(chunkSize, buf.length - body);
    }
    offset = body + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }

  if (dataOffset < 0 || channels === 0 || sampleRate === 0) throw new Error("malformed WAV: missing fmt/data");

  const bytesPerSample = bitsPerSample >> 3;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataLength / frameBytes);
  const mono = new Float64Array(frames);

  const isFloat = audioFormat === 3;
  const isPcm = audioFormat === 1;
  if (!isFloat && !isPcm) throw new Error(`unsupported WAV audioFormat ${audioFormat}`);

  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    const base = dataOffset + f * frameBytes;
    for (let c = 0; c < channels; c += 1) {
      const p = base + c * bytesPerSample;
      let v: number;
      if (isFloat) {
        v = bitsPerSample === 64 ? buf.readDoubleLE(p) : buf.readFloatLE(p);
      } else if (bitsPerSample === 16) {
        v = buf.readInt16LE(p) / 32768;
      } else if (bitsPerSample === 24) {
        const u = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
        v = (u & 0x800000 ? u - 0x1000000 : u) / 8388608;
      } else if (bitsPerSample === 32) {
        v = buf.readInt32LE(p) / 2147483648;
      } else {
        throw new Error(`unsupported PCM bit depth ${bitsPerSample}`);
      }
      sum += v;
    }
    mono[f] = sum / channels;
  }
  return { sampleRate, channels, frames, mono };
}

// ---------------------------------------------------------------------------
// Radix-2 iterative FFT (in-place). re/im are Float64Array of length n (pow2).
// ---------------------------------------------------------------------------
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len >> 1; k += 1) {
        const a = i + k;
        const b = a + (len >> 1);
        const xr = re[b] * cwr - im[b] * cwi;
        const xi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = ncwr;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// STFT feature extraction: per frame -> 8 band RMS energies + broadband
// spectral flux (half-wave-rectified magnitude increase, summed over bins).
// ---------------------------------------------------------------------------
export interface FrameFeatures {
  hopSec: number;
  bandEnergy: Float64Array[]; // per frame: Float64Array(8)
  flux: Float64Array; // per frame onset strength
  energy: Float64Array; // per frame broadband magnitude sum (for onset gating)
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export function extractFrameFeatures(mono: Float64Array, sampleRate: number): FrameFeatures {
  const win = STFT_WIN;
  const hop = STFT_HOP;
  const w = hann(win);
  const nBins = win / 2 + 1;
  const bandBins: Array<[number, number]> = [];
  const edges = [...BAND_EDGES_HZ, sampleRate / 2];
  for (let b = 0; b < 8; b += 1) {
    const lo = Math.max(0, Math.floor((edges[b] * win) / sampleRate));
    const hi = Math.min(nBins - 1, Math.ceil((edges[b + 1] * win) / sampleRate));
    bandBins.push([lo, hi]);
  }

  const nFrames = mono.length >= win ? Math.floor((mono.length - win) / hop) + 1 : 0;
  const bandEnergy: Float64Array[] = new Array(nFrames);
  const flux = new Float64Array(nFrames);
  const energy = new Float64Array(nFrames);
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(nBins);
  let prevMag: Float64Array | null = null;

  for (let fr = 0; fr < nFrames; fr += 1) {
    const start = fr * hop;
    for (let i = 0; i < win; i += 1) {
      re[i] = mono[start + i] * w[i];
      im[i] = 0;
    }
    fftRadix2(re, im);
    let eSum = 0;
    for (let k = 0; k < nBins; k += 1) {
      const m = Math.hypot(re[k], im[k]);
      mag[k] = m;
      eSum += m;
    }
    energy[fr] = eSum;

    const bands = new Float64Array(8);
    for (let b = 0; b < 8; b += 1) {
      const [lo, hi] = bandBins[b];
      let acc = 0;
      let cnt = 0;
      for (let k = lo; k <= hi; k += 1) {
        acc += mag[k] * mag[k];
        cnt += 1;
      }
      bands[b] = cnt > 0 ? Math.sqrt(acc / cnt) : 0;
    }
    bandEnergy[fr] = bands;

    if (prevMag) {
      let fx = 0;
      for (let k = 0; k < nBins; k += 1) {
        const d = mag[k] - prevMag[k];
        if (d > 0) fx += d;
      }
      flux[fr] = fx;
    }
    prevMag = mag.slice();
  }
  return { hopSec: hop / sampleRate, bandEnergy, flux, energy };
}

// ---------------------------------------------------------------------------
// Onset gating: first active frame (skip lead-in) + last active frame (skip
// ring-out tail). Threshold = floor(10th pct) + 10% of the (p90-floor) span.
// ---------------------------------------------------------------------------
function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

export function activeRange(energy: Float64Array): { firstFrame: number; lastFrame: number } {
  if (energy.length === 0) return { firstFrame: 0, lastFrame: 0 };
  const sorted = Float64Array.from(energy).sort();
  const floor = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);
  const thr = floor + 0.1 * (p90 - floor);
  let firstFrame = 0;
  while (firstFrame < energy.length && energy[firstFrame] <= thr) firstFrame += 1;
  let lastFrame = energy.length - 1;
  while (lastFrame > firstFrame && energy[lastFrame] <= thr) lastFrame -= 1;
  if (firstFrame >= energy.length) firstFrame = 0;
  return { firstFrame, lastFrame };
}

// ---------------------------------------------------------------------------
// Bar slicing + per-bar features.
// ---------------------------------------------------------------------------
function unitNorm(v: Float64Array): Float64Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n;
  return out;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

interface BarFeatures {
  combined: Float64Array; // unit(band,8) ++ unit(onset,16)
  onset: Float64Array; // unit onset fingerprint alone (for tempo lock)
}

function sliceBars(feat: FrameFeatures, firstFrame: number, lastFrame: number, barFrames: number): BarFeatures[] {
  const bars: BarFeatures[] = [];
  let b = 0;
  while (true) {
    const s = firstFrame + b * barFrames;
    const e = firstFrame + (b + 1) * barFrames;
    if (Math.floor(e) > lastFrame) break;
    const s0 = Math.floor(s);
    const e0 = Math.floor(e);
    // band feature: mean energy per band across the bar's frames
    const band = new Float64Array(8);
    let n = 0;
    for (let fr = s0; fr < e0; fr += 1) {
      const be = feat.bandEnergy[fr];
      if (!be) continue;
      for (let k = 0; k < 8; k += 1) band[k] += be[k];
      n += 1;
    }
    if (n > 0) for (let k = 0; k < 8; k += 1) band[k] = Math.log1p(band[k] / n);
    // onset fingerprint: flux summed into ONSET_STEPS sub-bins
    const onset = new Float64Array(ONSET_STEPS);
    for (let step = 0; step < ONSET_STEPS; step += 1) {
      const ss = Math.floor(s + ((e - s) * step) / ONSET_STEPS);
      const se = Math.floor(s + ((e - s) * (step + 1)) / ONSET_STEPS);
      let acc = 0;
      for (let fr = ss; fr < se; fr += 1) acc += feat.flux[fr] ?? 0;
      onset[step] = acc;
    }
    const ub = unitNorm(band);
    const uo = unitNorm(onset);
    const combined = new Float64Array(24);
    combined.set(ub, 0);
    combined.set(uo, 8);
    bars.push({ combined, onset: uo });
    b += 1;
  }
  return bars;
}

// Mean adjacent-bar onset-fingerprint similarity at a candidate tempo -- the
// phase-sensitive objective the tempo lock maximizes.
function adjacentOnsetSim(feat: FrameFeatures, firstFrame: number, lastFrame: number, barFrames: number): number {
  const bars = sliceBars(feat, firstFrame, lastFrame, barFrames);
  if (bars.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < bars.length; i += 1) sum += cosine(bars[i].onset, bars[i + 1].onset);
  return sum / (bars.length - 1);
}

// ---------------------------------------------------------------------------
// Full analysis.
// ---------------------------------------------------------------------------
export interface RenderAnalysisMetrics {
  meanAdjacentSimilarity: number; // (a)
  adjacentSimilarityFlag: boolean; // > ADJ_SIM_FLAG
  longestNearIdenticalRun: number; // (b) bars
  longestRunFlag: boolean; // > LONGEST_RUN_FLAG
  noveltyPer8Bar: number[]; // (c)
  meanNovelty: number;
  repetitivenessIndex: number; // (d) 0-100
}

export interface RenderAnalysis {
  schema: "analog-rytm-render-analysis.v1";
  path: string;
  name: string;
  sampleRate: number;
  durationSec: number;
  tempoHint: number;
  tempoLocked: number;
  tempoLockApplied: boolean;
  leadInSec: number;
  activeSec: number;
  barSec: number;
  barCount: number;
  metrics: RenderAnalysisMetrics;
  verdict: "verbatim-loop" | "repetitive" | "evolving" | "varied" | "insufficient-audio";
  findings: string[];
}

export interface AnalyzeOptions {
  tempo: number;
  tempoLock?: boolean; // default true
  name?: string;
}

export function analyzeSamples(mono: Float64Array, sampleRate: number, path: string, opts: AnalyzeOptions): RenderAnalysis {
  const name = opts.name ?? basename(path);
  const durationSec = mono.length / sampleRate;
  const feat = extractFrameFeatures(mono, sampleRate);
  const { firstFrame, lastFrame } = activeRange(feat.energy);
  const leadInSec = firstFrame * feat.hopSec;
  const activeSec = (lastFrame - firstFrame) * feat.hopSec;

  const hintBarFrames = ((4 * 60) / opts.tempo) * (sampleRate / STFT_HOP);
  const tempoLock = opts.tempoLock !== false;

  let lockedTempo = opts.tempo;
  let lockedBarFrames = hintBarFrames;
  if (tempoLock) {
    let best = -1;
    for (let bpm = opts.tempo - TEMPO_LOCK_RANGE_BPM; bpm <= opts.tempo + TEMPO_LOCK_RANGE_BPM + 1e-9; bpm += TEMPO_LOCK_STEP_BPM) {
      if (bpm <= 0) continue;
      const bf = ((4 * 60) / bpm) * (sampleRate / STFT_HOP);
      const sim = adjacentOnsetSim(feat, firstFrame, lastFrame, bf);
      if (sim > best) {
        best = sim;
        lockedTempo = Math.round(bpm * 100) / 100;
        lockedBarFrames = bf;
      }
    }
  }

  const bars = sliceBars(feat, firstFrame, lastFrame, lockedBarFrames);
  const barCount = bars.length;
  const barSec = (lockedBarFrames * STFT_HOP) / sampleRate;

  if (barCount < MIN_BARS_FOR_METRICS) {
    return {
      schema: "analog-rytm-render-analysis.v1",
      path,
      name,
      sampleRate,
      durationSec,
      tempoHint: opts.tempo,
      tempoLocked: lockedTempo,
      tempoLockApplied: tempoLock,
      leadInSec,
      activeSec,
      barSec,
      barCount,
      metrics: {
        meanAdjacentSimilarity: 0,
        adjacentSimilarityFlag: false,
        longestNearIdenticalRun: 0,
        longestRunFlag: false,
        noveltyPer8Bar: [],
        meanNovelty: 0,
        repetitivenessIndex: 0,
      },
      verdict: "insufficient-audio",
      findings: [`only ${barCount} bar(s) of active audio detected (need >= ${MIN_BARS_FOR_METRICS}); cannot judge`],
    };
  }

  // Self-similarity matrix (cosine on combined features).
  const ssm: number[][] = [];
  for (let i = 0; i < barCount; i += 1) {
    ssm[i] = [];
    for (let j = 0; j < barCount; j += 1) {
      ssm[i][j] = i === j ? 1 : j < i ? ssm[j][i] : cosine(bars[i].combined, bars[j].combined);
    }
  }

  // (a) mean adjacent-bar similarity
  let adjSum = 0;
  for (let i = 0; i + 1 < barCount; i += 1) adjSum += ssm[i][i + 1];
  const meanAdjacentSimilarity = adjSum / (barCount - 1);

  // (b) longest run of near-identical consecutive bars
  let longestRun = 1;
  let cur = 1;
  for (let i = 0; i + 1 < barCount; i += 1) {
    if (ssm[i][i + 1] >= NEAR_IDENTICAL_SIM) {
      cur += 1;
      if (cur > longestRun) longestRun = cur;
    } else {
      cur = 1;
    }
  }

  // (c) novelty per bar = 1 - max similarity to any EARLIER bar; then per 8-bar window
  const noveltyBar = new Float64Array(barCount);
  noveltyBar[0] = 1;
  for (let i = 1; i < barCount; i += 1) {
    let maxPrior = 0;
    for (let j = 0; j < i; j += 1) if (ssm[i][j] > maxPrior) maxPrior = ssm[i][j];
    noveltyBar[i] = 1 - maxPrior;
  }
  const noveltyPer8Bar: number[] = [];
  for (let w = 0; w < barCount; w += NOVELTY_WINDOW_BARS) {
    let s = 0;
    let c = 0;
    for (let i = w; i < Math.min(barCount, w + NOVELTY_WINDOW_BARS); i += 1) {
      s += noveltyBar[i];
      c += 1;
    }
    noveltyPer8Bar.push(c > 0 ? Math.round((s / c) * 1000) / 1000 : 0);
  }
  // meanNovelty excludes bar 0 (which is trivially novel) so an intro doesn't inflate it.
  let novSum = 0;
  for (let i = 1; i < barCount; i += 1) novSum += noveltyBar[i];
  const meanNovelty = barCount > 1 ? novSum / (barCount - 1) : 1;

  // (d) repetitiveness index 0-100
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const A = clamp01((meanAdjacentSimilarity - 0.9) / (0.99 - 0.9)); // adjacent-similarity component
  const R = clamp01(longestRun / barCount); // static-stretch component
  const N = clamp01(meanNovelty / NOVELTY_FULL); // novelty component
  const repetitivenessIndex = Math.round(100 * (0.45 * A + 0.35 * R + 0.2 * (1 - N)));

  const adjacentSimilarityFlag = meanAdjacentSimilarity > ADJ_SIM_FLAG;
  const longestRunFlag = longestRun > LONGEST_RUN_FLAG;

  const findings: string[] = [];
  if (adjacentSimilarityFlag) {
    findings.push(
      `verbatim-loop smell: mean adjacent-bar similarity ${meanAdjacentSimilarity.toFixed(3)} > ${ADJ_SIM_FLAG} ` +
        `(bars are near-identical to their neighbours)`,
    );
  }
  if (longestRunFlag) {
    findings.push(
      `static stretch: ${longestRun} consecutive near-identical bars (>= ${NEAR_IDENTICAL_SIM} sim) > ${LONGEST_RUN_FLAG}`,
    );
  }
  if (meanNovelty < 0.05) {
    findings.push(`starved of new material: mean per-bar novelty ${meanNovelty.toFixed(3)} (< 0.05)`);
  }
  if (opts.tempo - lockedTempo > 0.3 || lockedTempo - opts.tempo > 0.3) {
    findings.push(
      `tempo mismatch: conducting hint ${opts.tempo} BPM but audio loops at ~${lockedTempo} BPM ` +
        `(device/sequencer tempo differs from the score's finalTempo)`,
    );
  }

  let verdict: RenderAnalysis["verdict"];
  if (repetitivenessIndex >= 75) verdict = "verbatim-loop";
  else if (repetitivenessIndex >= 55) verdict = "repetitive";
  else if (repetitivenessIndex >= 35) verdict = "evolving";
  else verdict = "varied";

  return {
    schema: "analog-rytm-render-analysis.v1",
    path,
    name,
    sampleRate,
    durationSec,
    tempoHint: opts.tempo,
    tempoLocked: lockedTempo,
    tempoLockApplied: tempoLock,
    leadInSec,
    activeSec,
    barSec,
    barCount,
    metrics: {
      meanAdjacentSimilarity,
      adjacentSimilarityFlag,
      longestNearIdenticalRun: longestRun,
      longestRunFlag,
      noveltyPer8Bar,
      meanNovelty,
      repetitivenessIndex,
    },
    verdict,
    findings,
  };
}

// Read the conducting tempo from a sidecar <recordingId>.events.json
// (schedule.finalTempo) or <recordingId>.json (tempo), if present.
export function sidecarTempo(wavPath: string): number | undefined {
  const dir = dirname(wavPath);
  const stem = basename(wavPath).replace(/\.wav$/i, "");
  const eventsPath = join(dir, `${stem}.events.json`);
  const metaPath = join(dir, `${stem}.json`);
  try {
    if (existsSync(eventsPath)) {
      const j = JSON.parse(readFileSync(eventsPath, "utf8")) as { schedule?: { finalTempo?: number } };
      if (typeof j.schedule?.finalTempo === "number") return j.schedule.finalTempo;
    }
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(metaPath)) {
      const j = JSON.parse(readFileSync(metaPath, "utf8")) as { tempo?: number };
      if (typeof j.tempo === "number") return j.tempo;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function analyzeRenderFile(path: string, opts: AnalyzeOptions): RenderAnalysis {
  const buf = readFileSync(path);
  const { mono, sampleRate } = decodeWav(buf);
  return analyzeSamples(mono, sampleRate, path, opts);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function formatAnalysis(a: RenderAnalysis): string {
  const lines: string[] = [a.name];
  lines.push(
    `  tempo: hint ${a.tempoHint} -> ${a.tempoLockApplied ? `locked ${a.tempoLocked}` : "lock off"} BPM` +
      ` | bar ${a.barSec.toFixed(3)}s | ${a.barCount} bars | lead-in ${a.leadInSec.toFixed(1)}s | active ${a.activeSec.toFixed(1)}s`,
  );
  if (a.verdict === "insufficient-audio") {
    lines.push(`  INSUFFICIENT AUDIO`);
    for (const f of a.findings) lines.push(`    ${f}`);
    return lines.join("\n");
  }
  const m = a.metrics;
  lines.push(
    `  (a) mean adjacent-bar similarity: ${m.meanAdjacentSimilarity.toFixed(3)}` +
      `${m.adjacentSimilarityFlag ? ` FLAG (> ${ADJ_SIM_FLAG})` : ""}`,
  );
  lines.push(
    `  (b) longest near-identical run: ${m.longestNearIdenticalRun} bars` +
      `${m.longestRunFlag ? ` FLAG (> ${LONGEST_RUN_FLAG})` : ""}`,
  );
  lines.push(`  (c) novelty / 8-bar window: [${m.noveltyPer8Bar.join(", ")}] (mean ${m.meanNovelty.toFixed(3)})`);
  lines.push(`  (d) repetitiveness index: ${m.repetitivenessIndex}/100  ->  ${a.verdict.toUpperCase()}`);
  if (a.findings.length > 0) {
    lines.push(`  ${a.findings.length} finding(s):`);
    for (const f of a.findings) lines.push(`    ${f}`);
  } else {
    lines.push("  clean: no repetition findings");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): { path?: string; tempo?: number; json: boolean; tempoLock: boolean } {
  const json = argv.includes("--json");
  const tempoLock = !argv.includes("--no-tempo-lock");
  let tempo: number | undefined;
  const tIdx = argv.indexOf("--tempo");
  if (tIdx >= 0 && argv[tIdx + 1]) tempo = Number(argv[tIdx + 1]);
  const path = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--tempo");
  return { path, tempo, json, tempoLock };
}

function runCli(): void {
  const argv = process.argv.slice(2);
  const { path, tempo: tempoArg, json, tempoLock } = parseArgs(argv);
  if (!path) {
    process.stderr.write("usage: analyze-render.ts <render.wav> --tempo <bpm> [--json] [--no-tempo-lock]\n");
    process.exitCode = 2;
    return;
  }
  const tempo = tempoArg ?? sidecarTempo(path);
  if (tempo === undefined || !Number.isFinite(tempo) || tempo <= 0) {
    process.stderr.write("error: --tempo <bpm> required (no usable sidecar .events.json/.json tempo found)\n");
    process.exitCode = 2;
    return;
  }
  const analysis = analyzeRenderFile(path, { tempo, tempoLock });
  if (json) {
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatAnalysis(analysis)}\n`);
  }
  // Gate: any repetition finding exits non-zero (matches lint-arrangement's gate semantics).
  if (analysis.findings.some((f) => f.startsWith("verbatim-loop") || f.startsWith("static stretch") || f.startsWith("starved"))) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runCli();
