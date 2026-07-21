import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";
import type {
  RytmAudioRecording,
  RytmTrackId,
} from "../domain/types.ts";

// =============================================================================
// render-score: record a full arranged song as a single-take WAV.
// =============================================================================
//
//   npm run render:score -- <score.json> [--out <dir>] [--adapter mock|hardware]
//                                        [--dry-run]
//
// The daemon CONDUCTS a song in real time while a background recording runs:
// pattern changes, strategic track muting (the compositional spine: intro =
// voices subtracted, drop = the unmute), level fades, scene holds, and
// performance-macro ramps are dispatched on a drift-corrected wall-clock
// schedule. Recording is bracketed by startRecording -> timed event loop ->
// stopRecording; we deliberately do NOT use capturePatternAudio, because that
// RPC BLOCKS the daemon's serial RPC loop for its whole duration and would
// starve every live send (a hard-won lesson). Every send here is a short RPC.
//
// -----------------------------------------------------------------------------
// SCORE SCHEMA (as implemented)
// -----------------------------------------------------------------------------
//
//   {
//     "name": "ignition-sequence",   // identifier; used to name output files
//     "tempo": 132,                  // initial BPM (30-300); 1 bar = 4 beats
//     "leadInBars": 1,               // count-in silence recorded before events
//     "tailBars": 4,                 // keep recording this long after last event
//     "events": [ <ScoreEvent>, ... ]
//   }
//
// Each ScoreEvent carries `atBar` (bar offset from the start of the music, i.e.
// after the lead-in; may be fractional) plus EXACTLY ONE action:
//
//   { atBar, pattern: "A02", immediate?: false }
//       Change pattern. immediate:true resets the daemon's transport step to 0
//       for a hard cut. immediate:false (default) sends the program change and
//       lets the DEVICE apply it on its own pattern-change boundary (see
//       "changePattern semantics" below) so the sequencer stays continuous.
//
//   { atBar, mute: ["BD","BT"] }        mute the listed tracks
//   { atBar, unmute: ["BD"] }           unmute the listed tracks
//   { atBar, soloKeep: ["BD","CH"] }    mute everything EXCEPT the listed tracks
//   { atBar, unmuteAll: true }          clear every mute
//       Mute state is tracked across the whole score, so deltas are minimal:
//       only tracks whose mute state actually changes emit a send. A muted
//       track is Track Mute value 127; unmuted is 0 (see the daemon comment on
//       set_live_parameter for the 0-63/64-127 switch semantics).
//
//   { atBar, scene: 6 }                 activate SCENE 6 (1-12)
//   { atBar, scene: null }              clear the active scene
//
//   { atBar, perf: { n: 9, ramp: [[0,0],[7.5,127],[8,0]] } }
//       Ramp performance macro `n` (1-12). Each ramp point is
//       [barOffset, amount]: barOffset is relative to this event's atBar,
//       amount is 0-127. The ramp is sampled and linearly interpolated into a
//       series of setPerformanceMacro sends.
//
//   { atBar, level: { track: "CY", to: 40 } }
//       Set Track Level of `track` to `to` (0-127) -- a fade target.
//
//   { atBar, tempo: 134 }
//       Retempo the generated clock in place (see "tempo semantics" below).
//
//   { atBar, stop: true }
//       Cut the sequencer (setTransport stop) at that bar while the RECORDING
//       CONTINUES through tailBars -- an EP ending that captures the
//       reverb/delay ring-out. At most one stop event per score, and no
//       pattern/mute/perf/tempo events may follow it (level and scene ARE
//       allowed after stop, e.g. releasing a scene during the ring-out; tempo
//       is rejected because retempo rides a MIDI "continue", which would
//       restart the transport).
//
// Events are processed in the ORDER GIVEN; atBar must be non-decreasing
// (same-bar events are allowed and fire in listed order). Unknown keys on an
// EVENT are rejected; unknown TOP-LEVEL keys (score metadata such as `ep`,
// `trackNumber`, `notes`) are ignored.
//
// -----------------------------------------------------------------------------
// DAEMON BEHAVIOUR FINDINGS (read from daemon/src/hardware_control.rs)
// -----------------------------------------------------------------------------
//
// changePattern semantics (immediate flag): change_pattern ALWAYS sends a MIDI
//   Program Change immediately (0xC0 | channel, pattern_index). The `immediate`
//   flag only controls whether the DAEMON resets its own transport step
//   counters to 0 (step/absolute_step/midi_clock). It does NOT itself queue the
//   change to a bar boundary -- WHEN the device actually switches patterns is
//   governed by the device's own pattern-change quantize (Elektron "CHANGE
//   LEN", default = end of current pattern). So immediate:false = "send the
//   program change now, let the device swap on its next boundary, and keep the
//   daemon's step count running"; immediate:true = "send it and hard-reset the
//   daemon's local step count to 0" (a cut). This renderer fires the program
//   change AT the event's scheduled bar for both; use immediate:true only for a
//   deliberate hard cut.
//
// tempo semantics (mid-play retempo): the generated clock interval is
//   recomputed from transport.tempo on EVERY tick (clock_interval() =
//   60/(tempo*24)), so changing transport.tempo retempos the clock on the next
//   tick without stopping. The only RPC that writes transport.tempo is
//   setTransport, which requires a command byte. We therefore retempo with
//   setTransport({command:"continue", tempo}): "continue" keeps playing=true,
//   does NOT reset the epoch or step counters (only "start" does), and reseeds
//   the next clock deadline at the new interval. Caveat: it also emits a MIDI
//   Continue (0xFB) to the hardware; on a running device slaved to our clock
//   this is a benign "resume at current position". Tempo events are therefore
//   SUPPORTED. After a tempo event, the bar->ms mapping is recomputed from that
//   bar forward.
// =============================================================================

const TRACKS: readonly RytmTrackId[] = [
  "BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB",
];
const TRACK_SET = new Set<string>(TRACKS);
const PATTERN_SLOT = /^[A-H](0[1-9]|1[0-6])$/;
const BEATS_PER_BAR = 4;
const MUTE_VALUE = 127; // 64-127 = muted (see daemon set_live_parameter comment)
const UNMUTE_VALUE = 0; //  0-63  = audible
const TEMPO_MIN = 30;
const TEMPO_MAX = 300;
// Performance-ramp sampling resolution: one send per this many bars (plus every
// explicit ramp point). Keeps ramps smooth without flooding the RPC loop.
const PERF_STEP_BARS = 0.25;
const RECORDING_MIN_MS = 100;
const RECORDING_MAX_MS = 600_000;

export interface PerfRamp {
  n: number;
  ramp: Array<[number, number]>;
}

export interface LevelChange {
  track: RytmTrackId;
  to: number;
}

export interface ScoreEvent {
  atBar: number;
  pattern?: string;
  immediate?: boolean;
  mute?: string[];
  unmute?: string[];
  soloKeep?: string[];
  unmuteAll?: boolean;
  scene?: number | null;
  perf?: PerfRamp;
  level?: LevelChange;
  tempo?: number;
  stop?: boolean;
}

export interface Score {
  name: string;
  tempo: number;
  leadInBars?: number;
  tailBars?: number;
  events: ScoreEvent[];
}

// A single concrete RPC send, resolved onto an absolute time offset (ms from
// the start epoch) with a stable sequence index for tie-breaking.
export type ScheduledSend =
  | { seq: number; offsetMs: number; atBar: number; kind: "pattern"; pattern: string; immediate: boolean }
  | { seq: number; offsetMs: number; atBar: number; kind: "mute"; track: RytmTrackId; muted: boolean }
  | { seq: number; offsetMs: number; atBar: number; kind: "level"; track: RytmTrackId; value: number }
  | { seq: number; offsetMs: number; atBar: number; kind: "scene"; scene: number | null }
  | { seq: number; offsetMs: number; atBar: number; kind: "perf"; performance: number; amount: number }
  | { seq: number; offsetMs: number; atBar: number; kind: "tempo"; tempo: number }
  | { seq: number; offsetMs: number; atBar: number; kind: "stop" }
  | { seq: number; offsetMs: number; atBar: number; kind: "start"; tempo: number };

export interface Schedule {
  sends: ScheduledSend[];
  leadInMs: number;
  tailMs: number;
  musicalEndBar: number;
  finalTempo: number;
  totalMs: number;
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

/** Milliseconds per bar at a given tempo (1 bar = 4 beats). */
export function barMsForTempo(tempo: number): number {
  return (BEATS_PER_BAR * 60_000) / tempo;
}

interface TempoSegment {
  bar: number;
  tempo: number;
}

/**
 * Tempo segments in bar order, always starting with the initial tempo at bar 0,
 * then one entry per tempo event (in given order, which validation guarantees
 * is non-decreasing by bar).
 */
export function tempoSegments(score: Score): TempoSegment[] {
  const segments: TempoSegment[] = [{ bar: 0, tempo: score.tempo }];
  for (const event of score.events) {
    if (typeof event.tempo === "number") {
      segments.push({ bar: event.atBar, tempo: event.tempo });
    }
  }
  return segments;
}

/**
 * Absolute milliseconds from the first musical bar (bar 0) to `bar`, honouring
 * every tempo change strictly before `bar`. A tempo change exactly at `bar`
 * does not affect the time OF that bar -- it applies to what follows.
 */
export function barToMs(bar: number, segments: TempoSegment[]): number {
  let ms = 0;
  let prevBar = segments[0].bar;
  let curTempo = segments[0].tempo;
  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.bar >= bar) break;
    ms += (seg.bar - prevBar) * barMsForTempo(curTempo);
    prevBar = seg.bar;
    curTempo = seg.tempo;
  }
  ms += (bar - prevBar) * barMsForTempo(curTempo);
  return ms;
}

// ---------------------------------------------------------------------------
// Validation (runs before ANY daemon contact)
// ---------------------------------------------------------------------------

const ACTION_KEYS = [
  "pattern", "mute", "unmute", "soloKeep", "unmuteAll", "scene", "perf", "level", "tempo", "stop",
] as const;
// Event objects are validated STRICTLY (unknown keys rejected); unknown
// TOP-LEVEL score keys (metadata: ep, trackNumber, notes, ...) are ignored.
const EVENT_KEYS = new Set<string>(["atBar", "immediate", ...ACTION_KEYS]);
// Actions still allowed after a stop event: releasing a scene or riding a
// level during the ring-out is legit; everything sequenced is not.
const RING_OUT_KEYS = new Set<string>(["level", "scene"]);

function isTrackList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Returns a list of human-readable errors; empty means valid. */
export function validateScore(score: unknown): string[] {
  const errors: string[] = [];
  if (typeof score !== "object" || score === null) {
    return ["score must be a JSON object"];
  }
  const s = score as Record<string, unknown>;

  if (typeof s.name !== "string" || s.name.trim() === "") {
    errors.push("name must be a non-empty string");
  }
  if (typeof s.tempo !== "number" || !Number.isFinite(s.tempo) || s.tempo < TEMPO_MIN || s.tempo > TEMPO_MAX) {
    errors.push(`tempo must be a number between ${TEMPO_MIN} and ${TEMPO_MAX}`);
  }
  for (const key of ["leadInBars", "tailBars"] as const) {
    if (s[key] !== undefined && (typeof s[key] !== "number" || !Number.isFinite(s[key]) || (s[key] as number) < 0)) {
      errors.push(`${key} must be a number >= 0`);
    }
  }
  if (!Array.isArray(s.events)) {
    errors.push("events must be an array");
    return errors;
  }

  let previousBar = -Infinity;
  let stopSeen = false;
  s.events.forEach((raw, index) => {
    const where = `events[${index}]`;
    if (typeof raw !== "object" || raw === null) {
      errors.push(`${where} must be an object`);
      return;
    }
    const event = raw as Record<string, unknown>;

    for (const key of Object.keys(event)) {
      if (!EVENT_KEYS.has(key)) {
        errors.push(`${where} has unknown key "${key}" (allowed: ${[...EVENT_KEYS].join(", ")})`);
      }
    }

    if (typeof event.atBar !== "number" || !Number.isFinite(event.atBar) || event.atBar < 0) {
      errors.push(`${where}.atBar must be a number >= 0`);
    } else {
      if (event.atBar < previousBar) {
        errors.push(`${where}.atBar (${event.atBar}) is before the previous event's bar (${previousBar}); events must be non-decreasing by bar`);
      }
      previousBar = event.atBar;
    }

    // `immediate` is a modifier (not in ACTION_KEYS), so exactly one action key
    // is expected; pattern+immediate is the only allowed pairing.
    const present = ACTION_KEYS.filter((key) => event[key] !== undefined);
    if (present.length === 0) {
      errors.push(`${where} has no action (one of ${ACTION_KEYS.join(", ")})`);
    } else if (present.length > 1) {
      errors.push(`${where} has multiple actions (${present.join(", ")}); use one action per event`);
    }

    // EP-ending rules: after the sequencer is cut, only ring-out actions
    // (level/scene) make sense -- everything sequenced is silenced anyway, and
    // tempo would RESTART the transport (retempo rides a MIDI "continue").
    if (stopSeen) {
      for (const key of present) {
        if (key === "stop") {
          errors.push(`${where}: at most one stop event per score`);
        } else if (!RING_OUT_KEYS.has(key)) {
          errors.push(
            key === "tempo"
              ? `${where}: tempo after stop would restart the transport; move it before the stop`
              : `${where}: ${key} after stop has no effect (sequencer is cut); only level/scene are allowed during the ring-out`,
          );
        }
      }
    }
    if (event.stop !== undefined) {
      if (event.stop !== true) {
        errors.push(`${where}.stop must be true when present`);
      }
      stopSeen = true;
    }

    if (event.pattern !== undefined) {
      if (typeof event.pattern !== "string" || !PATTERN_SLOT.test(event.pattern)) {
        errors.push(`${where}.pattern must be a slot A01-H16`);
      }
      if (event.immediate !== undefined && typeof event.immediate !== "boolean") {
        errors.push(`${where}.immediate must be a boolean`);
      }
    } else if (event.immediate !== undefined) {
      errors.push(`${where}.immediate is only valid alongside pattern`);
    }

    for (const key of ["mute", "unmute", "soloKeep"] as const) {
      if (event[key] !== undefined) {
        if (!isTrackList(event[key])) {
          errors.push(`${where}.${key} must be an array of track ids`);
        } else {
          for (const track of event[key] as string[]) {
            if (!TRACK_SET.has(track)) errors.push(`${where}.${key} has invalid track "${track}"`);
          }
        }
      }
    }

    if (event.unmuteAll !== undefined && event.unmuteAll !== true) {
      errors.push(`${where}.unmuteAll must be true when present`);
    }

    if (event.scene !== undefined && event.scene !== null) {
      if (typeof event.scene !== "number" || !Number.isInteger(event.scene) || event.scene < 1 || event.scene > 12) {
        errors.push(`${where}.scene must be an integer 1-12 or null`);
      }
    }

    if (event.perf !== undefined) {
      const perf = event.perf as Record<string, unknown>;
      if (typeof perf.n !== "number" || !Number.isInteger(perf.n) || perf.n < 1 || perf.n > 12) {
        errors.push(`${where}.perf.n must be an integer 1-12`);
      }
      if (!Array.isArray(perf.ramp) || perf.ramp.length < 1) {
        errors.push(`${where}.perf.ramp must be a non-empty array of [barOffset, amount] pairs`);
      } else {
        let lastOffset = -Infinity;
        perf.ramp.forEach((point, pointIndex) => {
          if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== "number" || typeof point[1] !== "number") {
            errors.push(`${where}.perf.ramp[${pointIndex}] must be [barOffset, amount]`);
            return;
          }
          const [offset, amount] = point;
          if (offset < 0) errors.push(`${where}.perf.ramp[${pointIndex}] barOffset must be >= 0`);
          if (offset < lastOffset) errors.push(`${where}.perf.ramp[${pointIndex}] barOffset must be non-decreasing`);
          lastOffset = offset;
          if (amount < 0 || amount > 127) errors.push(`${where}.perf.ramp[${pointIndex}] amount must be 0-127`);
        });
      }
    }

    if (event.level !== undefined) {
      const level = event.level as Record<string, unknown>;
      if (typeof level.track !== "string" || !TRACK_SET.has(level.track)) {
        errors.push(`${where}.level.track must be a valid track id`);
      }
      if (typeof level.to !== "number" || !Number.isInteger(level.to) || level.to < 0 || level.to > 127) {
        errors.push(`${where}.level.to must be an integer 0-127`);
      }
    }

    if (event.tempo !== undefined) {
      if (typeof event.tempo !== "number" || !Number.isFinite(event.tempo) || event.tempo < TEMPO_MIN || event.tempo > TEMPO_MAX) {
        errors.push(`${where}.tempo must be a number between ${TEMPO_MIN} and ${TEMPO_MAX}`);
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Schedule construction
// ---------------------------------------------------------------------------

/**
 * Expand a validated score into a flat, time-ordered list of concrete sends.
 * Mute-type events are resolved into per-track track_mute deltas against a
 * simulated mute set, and performance ramps are sampled into discrete sends.
 * Every send carries an absolute offset (ms from the start epoch); ties break
 * on `seq` (build order) so same-bar events keep their listed order.
 */
export function buildSchedule(score: Score): Schedule {
  const segments = tempoSegments(score);
  const leadInBars = score.leadInBars ?? 0;
  const tailBars = score.tailBars ?? 0;
  const leadInMs = leadInBars * barMsForTempo(score.tempo);

  const sends: ScheduledSend[] = [];
  const muted = new Set<string>();
  let seq = 0;
  const offsetFor = (atBar: number): number => leadInMs + barToMs(atBar, segments);

  // The device's sequencer mutes persist across takes (hardware state, not
  // per-pattern), so a previous render's ending mutes silently leak into the
  // next one. Reset every track to unmuted at recording start — before the
  // lead-in ends and any bar-0 events fire.
  for (const track of TRACKS) {
    sends.push({ seq: seq++, offsetMs: 0, atBar: -leadInBars, kind: "mute", track, muted: false });
  }

  const emitMute = (atBar: number, track: RytmTrackId, shouldMute: boolean): void => {
    const currentlyMuted = muted.has(track);
    if (shouldMute === currentlyMuted) return; // delta only
    if (shouldMute) muted.add(track);
    else muted.delete(track);
    sends.push({ seq: seq++, offsetMs: offsetFor(atBar), atBar, kind: "mute", track, muted: shouldMute });
  };

  let musicalEndBar = 0;
  for (const event of score.events) {
    musicalEndBar = Math.max(musicalEndBar, event.atBar);

    if (event.pattern !== undefined) {
      sends.push({
        seq: seq++, offsetMs: offsetFor(event.atBar), atBar: event.atBar,
        kind: "pattern", pattern: event.pattern, immediate: event.immediate ?? false,
      });
    } else if (event.mute !== undefined) {
      for (const track of event.mute) emitMute(event.atBar, track as RytmTrackId, true);
    } else if (event.unmute !== undefined) {
      for (const track of event.unmute) emitMute(event.atBar, track as RytmTrackId, false);
    } else if (event.soloKeep !== undefined) {
      const keep = new Set(event.soloKeep);
      for (const track of TRACKS) emitMute(event.atBar, track, !keep.has(track));
    } else if (event.unmuteAll === true) {
      for (const track of TRACKS) emitMute(event.atBar, track, false);
    } else if (event.scene !== undefined) {
      sends.push({ seq: seq++, offsetMs: offsetFor(event.atBar), atBar: event.atBar, kind: "scene", scene: event.scene });
    } else if (event.level !== undefined) {
      sends.push({
        seq: seq++, offsetMs: offsetFor(event.atBar), atBar: event.atBar,
        kind: "level", track: event.level.track, value: event.level.to,
      });
    } else if (event.tempo !== undefined) {
      sends.push({ seq: seq++, offsetMs: offsetFor(event.atBar), atBar: event.atBar, kind: "tempo", tempo: event.tempo });
    } else if (event.stop === true) {
      sends.push({ seq: seq++, offsetMs: offsetFor(event.atBar), atBar: event.atBar, kind: "stop" });
    } else if (event.perf !== undefined) {
      const { n, ramp } = event.perf;
      // Sample every consecutive segment of the ramp, interpolating linearly.
      let lastEmitted: { offset: number; amount: number } | undefined;
      const pushPerf = (barOffset: number, amount: number): void => {
        if (lastEmitted && lastEmitted.offset === barOffset && lastEmitted.amount === amount) return;
        lastEmitted = { offset: barOffset, amount };
        const bar = event.atBar + barOffset;
        musicalEndBar = Math.max(musicalEndBar, bar);
        sends.push({ seq: seq++, offsetMs: offsetFor(bar), atBar: bar, kind: "perf", performance: n, amount });
      };
      pushPerf(ramp[0][0], Math.round(ramp[0][1]));
      for (let i = 1; i < ramp.length; i += 1) {
        const [o0, a0] = ramp[i - 1];
        const [o1, a1] = ramp[i];
        const span = o1 - o0;
        const steps = Math.max(1, Math.ceil(span / PERF_STEP_BARS));
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          pushPerf(o0 + span * t, Math.round(a0 + (a1 - a0) * t));
        }
      }
    }
  }

  const finalTempo = segments[segments.length - 1].tempo;
  const tailMs = tailBars * barMsForTempo(finalTempo);
  const totalMs = leadInMs + barToMs(musicalEndBar, segments) + tailMs;

  // Transport start is itself a scheduled send at the end of the lead-in,
  // AFTER every bar-0 send (huge seq wins the tie-break): the bar-0 pattern
  // and mutes must be in place before the sequencer runs, or whatever the
  // device played last blasts through the lead-in and the downbeat.
  sends.push({ seq: Number.MAX_SAFE_INTEGER, offsetMs: leadInMs, atBar: 0, kind: "start", tempo: score.tempo });

  // Stable sort by absolute time, tie-break on build order.
  sends.sort((a, b) => (a.offsetMs - b.offsetMs) || (a.seq - b.seq));

  return { sends, leadInMs, tailMs, musicalEndBar, finalTempo, totalMs };
}

// ---------------------------------------------------------------------------
// Rendering (daemon lifecycle + drift-corrected event loop)
// ---------------------------------------------------------------------------

export interface RenderOptions {
  score: Score;
  outDir: string;
  adapter?: "mock" | "hardware";
  repository?: string;
  requestTimeoutMs?: number;
}

export interface SentEntry {
  seq: number;
  kind: ScheduledSend["kind"];
  atBar: number;
  plannedOffsetMs: number;
  actualOffsetMs: number;
  payload: Record<string, unknown>;
}

export interface RenderSummary {
  name: string;
  adapter: string;
  outDir: string;
  wavPath?: string;
  eventsLogPath: string;
  schedule: { totalMs: number; leadInMs: number; tailMs: number; musicalEndBar: number; finalTempo: number; sendCount: number };
  recording: { recordingId: string; status: string; startedAt?: string; stoppedAt?: string };
  sent: SentEntry[];
  daemonEvents: Array<{ cursor: number; receivedAt: string; type: string }>;
}

function repositoryRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/** Resolve after `targetMs` wall-clock ms have elapsed since `epoch`. */
function sleepUntil(epoch: number, targetMs: number): Promise<void> {
  const remaining = epoch + targetMs - Date.now();
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, remaining));
}

function payloadFor(send: ScheduledSend): Record<string, unknown> {
  switch (send.kind) {
    case "pattern": return { pattern: send.pattern, immediate: send.immediate };
    case "mute": return { track: send.track, parameter: "track_mute", value: send.muted ? MUTE_VALUE : UNMUTE_VALUE };
    case "level": return { track: send.track, parameter: "track_level", value: send.value };
    case "scene": return { scene: send.scene };
    case "perf": return { performance: send.performance, amount: send.amount };
    case "tempo": return { command: "continue", tempo: send.tempo };
    case "stop": return { command: "stop" };
    case "start": return { command: "start", tempo: send.tempo };
  }
}

async function dispatch(client: RustDaemonClient, send: ScheduledSend): Promise<void> {
  switch (send.kind) {
    case "pattern":
      await client.changePattern({ pattern: send.pattern, immediate: send.immediate });
      return;
    case "mute":
      await client.setLiveParameter({ track: send.track, parameter: "track_mute", value: send.muted ? MUTE_VALUE : UNMUTE_VALUE });
      return;
    case "level":
      await client.setLiveParameter({ track: send.track, parameter: "track_level", value: send.value });
      return;
    case "scene":
      await client.setActiveScene({ scene: send.scene });
      return;
    case "perf":
      await client.setPerformanceMacro({ performance: send.performance, amount: send.amount });
      return;
    case "tempo":
      await client.setTransport({ command: "continue", tempo: send.tempo });
      return;
    case "stop":
      await client.setTransport({ command: "stop" });
      return;
    case "start":
      await client.setTransport({ command: "start", tempo: send.tempo });
      return;
  }
}

export async function renderScore(options: RenderOptions): Promise<RenderSummary> {
  const errors = validateScore(options.score);
  if (errors.length > 0) {
    throw new Error(`invalid score:\n  - ${errors.join("\n  - ")}`);
  }
  const score = options.score;
  const adapter = options.adapter ?? "hardware";
  const repository = options.repository ?? repositoryRoot();
  const schedule = buildSchedule(score);
  mkdirSync(options.outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const recordingId = `score-${score.name}-${stamp}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);

  const args = [
    "run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve",
    "--adapter", adapter, "--audio-dir", options.outDir,
  ];
  // The hardware adapter needs the daemon to generate the MIDI clock so the
  // sequencer actually plays; the mock adapter does not drive a real clock.
  if (adapter === "hardware") args.push("--clock-source", "generated");

  const client = new RustDaemonClient({
    command: "cargo",
    args,
    cwd: repository,
    requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
  });

  const sent: SentEntry[] = [];
  let recording: RytmAudioRecording | undefined;
  let stopped: RytmAudioRecording | undefined;

  try {
    const health = await client.start();
    if (health.adapter !== adapter) {
      throw new Error(`daemon started with adapter ${health.adapter}, expected ${adapter}`);
    }

    // 1. Start recording FIRST so the count-in and every send are captured.
    const startInput: { recordingId: string; expectedDurationMs?: number } = { recordingId };
    const expected = Math.round(schedule.totalMs);
    if (expected >= RECORDING_MIN_MS && expected <= RECORDING_MAX_MS) {
      startInput.expectedDurationMs = expected;
    }
    recording = await client.startRecording(startInput);

    // 2. The epoch anchors all scheduling at recording start; transport start
    //    is a scheduled send inside the sequence (end of lead-in, after the
    //    bar-0 state), so the lead-in records silence, not the last pattern.
    const epoch = Date.now();

    // 3. Drift-corrected event loop: each send is timed against the FIXED epoch,
    //    so per-send sleep jitter never accumulates.
    for (const send of schedule.sends) {
      await sleepUntil(epoch, send.offsetMs);
      const actualOffsetMs = Date.now() - epoch;
      await dispatch(client, send);
      sent.push({
        seq: send.seq, kind: send.kind, atBar: send.atBar,
        plannedOffsetMs: Math.round(send.offsetMs), actualOffsetMs,
        payload: payloadFor(send),
      });
    }

    // 4. Hold for the tail, then stop transport and recording. A score with a
    //    stop event already cut the sequencer (EP ending: the tail records the
    //    ring-out), so don't append a second transport stop to the journal.
    await sleepUntil(epoch, schedule.totalMs);
    if (!schedule.sends.some((send) => send.kind === "stop")) {
      await client.setTransport({ command: "stop" });
    }
    stopped = await client.stopRecording({ recordingId });

    // 5. Read the daemon's event journal for verification/retakes BEFORE close.
    const journal = await client.getEvents(0, 1000);
    const daemonEvents = journal.map((entry) => ({
      cursor: entry.cursor,
      receivedAt: entry.receivedAt,
      type: (entry.event as { type?: string }).type ?? "unknown",
    }));

    const wavPath = stopped.audio?.path;
    const eventsLogPath = join(options.outDir, `${recordingId}.events.json`);
    const log = {
      schema: "analog-rytm-score-render.v1",
      name: score.name,
      adapter,
      renderedAt: new Date().toISOString(),
      schedule: {
        totalMs: schedule.totalMs, leadInMs: schedule.leadInMs, tailMs: schedule.tailMs,
        musicalEndBar: schedule.musicalEndBar, finalTempo: schedule.finalTempo, sendCount: schedule.sends.length,
      },
      wavPath,
      recording: {
        recordingId,
        status: stopped.status,
        startedAt: recording.timestamps?.startedAt ?? recording.startedAt,
        stoppedAt: stopped.timestamps?.stoppedAt,
      },
      sent,
      daemonEvents,
    };
    writeFileSync(eventsLogPath, `${JSON.stringify(log, null, 2)}\n`);

    return {
      name: score.name,
      adapter,
      outDir: options.outDir,
      wavPath,
      eventsLogPath,
      schedule: log.schedule,
      recording: log.recording,
      sent,
      daemonEvents,
    };
  } finally {
    // Best-effort: never leave the transport running or a recording open.
    try {
      await client.setTransport({ command: "stop" });
    } catch {
      // transport already stopped or daemon gone
    }
    if (recording && !stopped) {
      try {
        await client.stopRecording({ recordingId });
      } catch {
        // recording already stopped or daemon gone
      }
    }
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  scorePath?: string;
  out?: string;
  adapter: "mock" | "hardware";
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { adapter: "hardware", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") { parsed.out = argv[++i]; }
    else if (arg === "--adapter") {
      const value = argv[++i];
      if (value !== "mock" && value !== "hardware") throw new Error("--adapter must be mock or hardware");
      parsed.adapter = value;
    } else if (arg === "--dry-run") { parsed.dryRun = true; }
    else if (!arg.startsWith("--") && parsed.scorePath === undefined) { parsed.scorePath = arg; }
    else { throw new Error(`unexpected argument: ${arg}`); }
  }
  return parsed;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.scorePath === undefined) {
    process.stderr.write("usage: render:score -- <score.json> [--out <dir>] [--adapter mock|hardware] [--dry-run]\n");
    process.exitCode = 2;
    return;
  }

  const raw = JSON.parse(readFileSync(args.scorePath, "utf8")) as unknown;
  const errors = validateScore(raw);
  if (errors.length > 0) {
    process.stderr.write(`invalid score:\n  - ${errors.join("\n  - ")}\n`);
    process.exitCode = 1;
    return;
  }
  const score = raw as Score;

  if (args.dryRun) {
    const schedule = buildSchedule(score);
    process.stdout.write(`${JSON.stringify({
      name: score.name,
      dryRun: true,
      schedule: {
        totalMs: schedule.totalMs, leadInMs: schedule.leadInMs, tailMs: schedule.tailMs,
        musicalEndBar: schedule.musicalEndBar, finalTempo: schedule.finalTempo, sendCount: schedule.sends.length,
      },
      sends: schedule.sends.map((send) => ({ atBar: send.atBar, offsetMs: Math.round(send.offsetMs), ...payloadFor(send), kind: send.kind })),
    }, null, 2)}\n`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.out ?? join(repositoryRoot(), "hardware", "runs", `score-${score.name}-${stamp}`);

  const summary = await renderScore({ score, outDir, adapter: args.adapter });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
