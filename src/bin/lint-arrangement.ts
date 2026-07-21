import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { validateScore } from "./render-score.ts";
import type { Score } from "./render-score.ts";

// =============================================================================
// lint-arrangement: an offline, measurable arrangement-quality GATE over a
// render-score.ts score.json.
// =============================================================================
//
//   npm run lint:arrangement -- <score.json|scores-dir> [--json]
//
// Built directly off the music-production skill's autopsy of why our first
// conducted EP (PERIGEE, v1) was "dull" despite technically valid scores (see
// ~/.claude/skills/music-production/SKILL.md and
// vault/music/production/arrangement-craft.md). That autopsy names five causes;
// this tool measures each one against the score JSON alone -- no daemon, no
// audio, no pattern content (see score-danceability.ts for that layer):
//
//   1. Section-length variance: metronomic 8/16-bar grid-lock, and no
//      deliberate long-held section.
//   2. EVENT-tier emptiness: no once-only per-track gestures (Ember's CB trick
//      -- a track appears via `unmute` and is `mute`d again within 2 bars).
//   3. One-dimension drops: a drop that's just an `unmute`, not 2+ contrast
//      dimensions (mute-family/scene/perf/level/pattern) stacked at once.
//   4. Build-type monotony: every build the same gesture (usually a perf ramp).
//   5. The missing silent bar: no soloKeep:[] / all-tracks-muted stretch.
//   6. The continuous ride: a long stretch with zero events of any kind.
//
// This is a QUALITY gate, not a correctness validator -- render-score.ts's
// `validateScore` already owns schema correctness, and is reused here (a
// structurally invalid score can't be arrangement-linted; its errors are
// surfaced as this tool's only "error"-severity findings). Every arrangement
// flag below is "warning" severity, but the CLI still exits non-zero when any
// finding is present, error or warning: that is what makes this a gate rather
// than an FYI. A synthetic score with no flags exits 0.

export const TRACKS = ["BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB"] as const;
const TRACK_ORDER = new Map<string, number>(TRACKS.map((track, index) => [track, index]));

// ---------------------------------------------------------------------------
// Tunable thresholds. Named + documented so recalibration is a one-line change.
// ---------------------------------------------------------------------------
const LOW_DENSITY_MUTED_THRESHOLD = 6; // >=half of 12 tracks muted = "low density"
const GRID_LOCK_FRACTION = 0.7; // >70% of sections sharing one length = grid-locked
const GRID_LOCK_LENGTHS = new Set([8, 16]); // ...or every section drawn from this set
const LONG_HOLD_RATIO = 1.5; // a "long hold" section is >=1.5x the median
const MIN_SECTIONS_FOR_LENGTH_FLAGS = 3; // need >=3 sections before judging shape
const EVENT_TIER_EMPTY_MAX = 1; // 0-1 once-only gestures per track = empty
const ONCE_ONLY_MAX_GAP_BARS = 2; // unmute->mute within this window = once-only
const SCENE_FLASH_MAX_GAP_BARS = 2; // scene:N -> scene:null within this window = a flash
const PERF_SPIKE_MAX_SPAN_BARS = 2; // a ramp spanning this much (or less), returning to 0
const DROP_DIMENSION_WINDOW_BARS = 0.5; // co-firing window around a drop's bar
const MIN_DROP_DIMENSIONS = 2; // fewer distinct kinds than this = a weak/one-dim drop
const BUILD_LOOKBACK_BARS = 8; // pre-drop window classified for build-type diversity
const SILENCE_MIN_DURATION_BARS = 0.5; // an all-muted span shorter than this doesn't count
const UNATTENDED_FLAG_BARS = 24; // a gap this long or longer = "continuous ride"
const EP_BUILD_DOMINANCE_FRACTION = 0.7; // one build type owning this share of drops = monotony

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
export interface ArrangementFinding {
  severity: "error" | "warning";
  section: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Metric 1: section lengths
// ---------------------------------------------------------------------------
export interface SectionLengthReport {
  patternChangeCount: number;
  lengths: number[];
  median: number;
  mean: number;
  variance: number;
  longestSection: number;
  longestRatioToMedian: number;
  modalLength: number;
  modalFraction: number;
  gridLocked: boolean;
  missingLongHold: boolean;
}

function endBar(score: Score): number {
  let max = 0;
  let stopBar: number | undefined;
  for (const event of score.events) {
    if (event.atBar > max) max = event.atBar;
    if (event.stop === true) stopBar = event.atBar;
  }
  return stopBar ?? max;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function analyzeSectionLengths(score: Score): SectionLengthReport {
  const patternBars = score.events.filter((event) => event.pattern !== undefined).map((event) => event.atBar);
  const end = endBar(score);
  const lengths: number[] = [];
  for (let i = 0; i < patternBars.length; i += 1) {
    const next = i + 1 < patternBars.length ? patternBars[i + 1] : end;
    lengths.push(next - patternBars[i]);
  }

  const mean = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const variance = lengths.length > 0 ? lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length : 0;
  const med = median(lengths);
  const longestSection = lengths.length > 0 ? Math.max(...lengths) : 0;
  const longestRatioToMedian = med > 0 ? longestSection / med : 0;

  const counts = new Map<number, number>();
  for (const length of lengths) counts.set(length, (counts.get(length) ?? 0) + 1);
  let modalLength = 0;
  let modalCount = 0;
  for (const [length, count] of counts) {
    if (count > modalCount) {
      modalCount = count;
      modalLength = length;
    }
  }
  const modalFraction = lengths.length > 0 ? modalCount / lengths.length : 0;

  const enoughSections = lengths.length >= MIN_SECTIONS_FOR_LENGTH_FLAGS;
  const gridLocked =
    enoughSections && (modalFraction > GRID_LOCK_FRACTION || lengths.every((length) => GRID_LOCK_LENGTHS.has(length)));
  const missingLongHold = enoughSections && med > 0 && longestRatioToMedian < LONG_HOLD_RATIO;

  return {
    patternChangeCount: patternBars.length,
    lengths,
    median: med,
    mean,
    variance,
    longestSection,
    longestRatioToMedian,
    modalLength,
    modalFraction,
    gridLocked,
    missingLongHold,
  };
}

// ---------------------------------------------------------------------------
// Mute-state simulation, shared by metrics 2 (scene/perf don't need it), 3
// (drops) and 5 (silence). Mirrors render-score.ts's own delta-tracked mute
// simulation: every track starts unmuted (the daemon resets state at record
// start), soloKeep mutes every track NOT listed, unmuteAll clears every mute.
// ---------------------------------------------------------------------------
interface BarGroup {
  atBar: number;
  mutedBefore: Set<string>;
  mutedAfter: Set<string>;
  kinds: Set<string>;
  hasUnmuteAll: boolean;
  maxUnmuteLen: number;
}

function groupEventsByBar(score: Score): BarGroup[] {
  const groups: BarGroup[] = [];
  let muted = new Set<string>();
  const events = score.events;
  let i = 0;
  while (i < events.length) {
    const atBar = events[i].atBar;
    const mutedBefore = new Set(muted);
    const kinds = new Set<string>();
    let hasUnmuteAll = false;
    let maxUnmuteLen = 0;
    while (i < events.length && events[i].atBar === atBar) {
      const event = events[i];
      if (event.pattern !== undefined) kinds.add("pattern");
      if (event.mute !== undefined) {
        kinds.add("mute-family");
        for (const track of event.mute) muted.add(track);
      }
      if (event.unmute !== undefined) {
        kinds.add("mute-family");
        maxUnmuteLen = Math.max(maxUnmuteLen, event.unmute.length);
        for (const track of event.unmute) muted.delete(track);
      }
      if (event.soloKeep !== undefined) {
        kinds.add("mute-family");
        const keep = new Set(event.soloKeep);
        muted = new Set(TRACKS.filter((track) => !keep.has(track)));
      }
      if (event.unmuteAll === true) {
        kinds.add("mute-family");
        hasUnmuteAll = true;
        muted = new Set();
      }
      if (event.scene !== undefined) kinds.add("scene");
      if (event.perf !== undefined) kinds.add("perf");
      if (event.level !== undefined) kinds.add("level");
      i += 1;
    }
    groups.push({ atBar, mutedBefore, mutedAfter: new Set(muted), kinds, hasUnmuteAll, maxUnmuteLen });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Metric 2: EVENT-tier count
// ---------------------------------------------------------------------------
export interface TrackEventTier {
  track: string;
  onceOnlyCount: number;
  empty: boolean;
}

export interface EventTierReport {
  tracks: TrackEventTier[];
  sceneFlashCount: number;
  perfSpikeCount: number;
  perfSpikeDisqualifiedByRepeat: number;
}

function activeTracks(score: Score): string[] {
  const seen = new Set<string>();
  for (const event of score.events) {
    for (const track of event.mute ?? []) seen.add(track);
    for (const track of event.unmute ?? []) seen.add(track);
    for (const track of event.soloKeep ?? []) seen.add(track);
    if (event.level) seen.add(event.level.track);
  }
  return [...seen].sort((a, b) => (TRACK_ORDER.get(a) ?? 99) - (TRACK_ORDER.get(b) ?? 99));
}

// Once-only per-track gesture (Ember's CB trick): an explicit `unmute` for a
// track followed by an explicit `mute` of the SAME track within
// ONCE_ONLY_MAX_GAP_BARS. Deliberately literal about the mute/unmute ARRAYS
// (not soloKeep/unmuteAll deltas): a track dropping out and returning
// (mute-then-unmute) is a COLOR-tier call-and-response, not the "appears once
// and leaves" EVENT gesture the skill describes.
function computeEventTiers(score: Score): EventTierReport {
  const tracks = activeTracks(score);
  const counts = new Map<string, number>(tracks.map((track) => [track, 0]));
  const pendingUnmuteBar = new Map<string, number>();

  for (const event of score.events) {
    if (event.unmute !== undefined) {
      for (const track of event.unmute) pendingUnmuteBar.set(track, event.atBar);
    }
    if (event.mute !== undefined) {
      for (const track of event.mute) {
        const pending = pendingUnmuteBar.get(track);
        if (pending !== undefined && event.atBar - pending <= ONCE_ONLY_MAX_GAP_BARS) {
          counts.set(track, (counts.get(track) ?? 0) + 1);
          pendingUnmuteBar.delete(track);
        }
      }
    }
  }

  const trackReports = tracks.map((track) => {
    const onceOnlyCount = counts.get(track) ?? 0;
    return { track, onceOnlyCount, empty: onceOnlyCount <= EVENT_TIER_EMPTY_MAX };
  });

  // Scene flashes: scene:N -> scene:null within SCENE_FLASH_MAX_GAP_BARS. A
  // longer hold is a COLOR-tier "scene-hold" build (see metric 4), not a flash.
  let sceneFlashCount = 0;
  let pendingSceneBar: number | undefined;
  for (const event of score.events) {
    if (event.scene === undefined) continue;
    if (event.scene === null) {
      if (pendingSceneBar !== undefined && event.atBar - pendingSceneBar <= SCENE_FLASH_MAX_GAP_BARS) sceneFlashCount += 1;
      pendingSceneBar = undefined;
    } else {
      pendingSceneBar = event.atBar;
    }
  }

  // Perf spikes: a ramp spanning <= PERF_SPIKE_MAX_SPAN_BARS that returns to 0.
  // "not repeated" -- if the same macro number produces more than one spike
  // candidate across the score, it's a recurring COLOR-tier gesture, not a
  // once-only EVENT, and none of its occurrences count.
  const candidatesByMacro = new Map<number, number>();
  for (const event of score.events) {
    if (event.perf === undefined) continue;
    const ramp = event.perf.ramp;
    const span = ramp[ramp.length - 1][0] - ramp[0][0];
    const endsAtZero = ramp[ramp.length - 1][1] === 0;
    if (span <= PERF_SPIKE_MAX_SPAN_BARS && endsAtZero) {
      candidatesByMacro.set(event.perf.n, (candidatesByMacro.get(event.perf.n) ?? 0) + 1);
    }
  }
  let perfSpikeCount = 0;
  let perfSpikeDisqualifiedByRepeat = 0;
  for (const occurrences of candidatesByMacro.values()) {
    if (occurrences === 1) perfSpikeCount += 1;
    else perfSpikeDisqualifiedByRepeat += occurrences;
  }

  return { tracks: trackReports, sceneFlashCount, perfSpikeCount, perfSpikeDisqualifiedByRepeat };
}

// ---------------------------------------------------------------------------
// Metric 3: drops + contrast dimensions
// ---------------------------------------------------------------------------
export interface DropRecord {
  atBar: number;
  mutedBefore: number;
  mutedAfter: number;
  dimensions: string[];
  weak: boolean;
}

// A drop is: unmuteAll, OR an explicit unmute of >=2 tracks at once (density
// returning after a muted stretch), OR a pattern change out of a low-density
// stretch that does not simultaneously mute further (the techno anti-drop --
// "the kick returning after a break, or ONE new element re-lensing the
// groove"). soloKeep is deliberately excluded as a trigger: it MUTES most
// tracks (a breakdown/strip-back), the opposite motion of a drop.
function computeDrops(score: Score): DropRecord[] {
  const groups = groupEventsByBar(score);
  const drops: DropRecord[] = [];
  for (const group of groups) {
    const hasPattern = group.kinds.has("pattern");
    // unmuteAll/bigUnmute only count as a drop if something was actually
    // muted beforehand -- a "return" needs a stretch to return FROM; an
    // unmuteAll fired while everything is already audible is a no-op, not a
    // contrast move.
    const wasMuted = group.mutedBefore.size > 0;
    const isDrop =
      (group.hasUnmuteAll && wasMuted) ||
      (group.maxUnmuteLen >= 2 && wasMuted) ||
      (hasPattern && group.mutedBefore.size >= LOW_DENSITY_MUTED_THRESHOLD && group.mutedAfter.size <= group.mutedBefore.size);
    if (!isDrop) continue;

    const dims = new Set<string>(group.kinds);
    for (const other of groups) {
      if (other === group) continue;
      if (Math.abs(other.atBar - group.atBar) <= DROP_DIMENSION_WINDOW_BARS) {
        for (const kind of other.kinds) dims.add(kind);
      }
    }
    drops.push({
      atBar: group.atBar,
      mutedBefore: group.mutedBefore.size,
      mutedAfter: group.mutedAfter.size,
      dimensions: [...dims].sort(),
      weak: dims.size < MIN_DROP_DIMENSIONS,
    });
  }
  return drops;
}

// ---------------------------------------------------------------------------
// Metric 4: build diversity
// ---------------------------------------------------------------------------
export type BuildType = "silence" | "progressive-mutes" | "level-fade" | "scene-hold" | "perf-ramp" | "none";

export interface BuildRecord {
  dropAtBar: number;
  types: BuildType[];
  primary: BuildType;
}

// Classifies the gesture(s) found in the BUILD_LOOKBACK_BARS window BEFORE a
// drop (events AT the drop's own bar are the drop's contrast dimensions, not
// its build). Priority when multiple gestures co-occur -- silence first (the
// rarest, strongest signal) down to perf-ramp last (the most generic/default
// gesture, and the one the autopsy calls out as overused): if a perf ramp
// shows up alongside something more deliberate, the something-else is credited
// as the build's identity.
const BUILD_PRIORITY: BuildType[] = ["silence", "progressive-mutes", "level-fade", "scene-hold", "perf-ramp"];

function classifyBuilds(score: Score, drops: DropRecord[], silenceSpans: SilenceSpan[]): BuildRecord[] {
  const groups = groupEventsByBar(score);
  return drops.map((drop) => {
    const windowStart = drop.atBar - BUILD_LOOKBACK_BARS;
    const windowGroups = groups.filter((group) => group.atBar >= windowStart && group.atBar < drop.atBar);
    const types = new Set<BuildType>();

    if (silenceSpans.some((span) => span.atBar >= windowStart && span.atBar < drop.atBar)) types.add("silence");
    if (windowGroups.some((group) => group.kinds.has("perf"))) types.add("perf-ramp");
    if (windowGroups.some((group) => group.kinds.has("level"))) types.add("level-fade");
    if (windowGroups.some((group) => group.kinds.has("scene"))) types.add("scene-hold");
    const thinningGroups = windowGroups.filter((group) => group.mutedAfter.size > group.mutedBefore.size);
    if (thinningGroups.length >= 2) types.add("progressive-mutes");

    const typeList = [...types];
    const primary = BUILD_PRIORITY.find((candidate) => types.has(candidate)) ?? "none";
    return { dropAtBar: drop.atBar, types: typeList, primary };
  });
}

// ---------------------------------------------------------------------------
// Metric 5: silence
// ---------------------------------------------------------------------------
export interface SilenceSpan {
  atBar: number;
  durationBars: number;
}

function computeSilenceSpans(score: Score): SilenceSpan[] {
  const groups = groupEventsByBar(score);
  const end = endBar(score);
  const spans: SilenceSpan[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i].mutedAfter.size !== TRACKS.length) continue;
    const start = groups[i].atBar;
    const next = i + 1 < groups.length ? groups[i + 1].atBar : end;
    const duration = next - start;
    if (duration >= SILENCE_MIN_DURATION_BARS) spans.push({ atBar: start, durationBars: duration });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Metric 6: unattended span
// ---------------------------------------------------------------------------
export interface UnattendedSpan {
  longestGapBars: number;
  atBar: number;
}

function computeUnattendedSpan(score: Score): UnattendedSpan {
  const bars = [...new Set(score.events.map((event) => event.atBar))].sort((a, b) => a - b);
  let longestGapBars = 0;
  let atBar = 0;
  for (let i = 0; i < bars.length - 1; i += 1) {
    const gap = bars[i + 1] - bars[i];
    if (gap > longestGapBars) {
      longestGapBars = gap;
      atBar = bars[i];
    }
  }
  return { longestGapBars, atBar };
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------
export interface ArrangementMetrics {
  sectionLengths: SectionLengthReport;
  eventTiers: EventTierReport;
  drops: DropRecord[];
  builds: BuildRecord[];
  silence: SilenceSpan[];
  unattended: UnattendedSpan;
}

export interface ArrangementReport {
  name: string;
  findings: ArrangementFinding[];
  metrics?: ArrangementMetrics;
}

function buildFindings(metrics: ArrangementMetrics): ArrangementFinding[] {
  const findings: ArrangementFinding[] = [];
  const { sectionLengths, eventTiers, drops, builds, silence, unattended } = metrics;

  if (sectionLengths.gridLocked) {
    findings.push({
      severity: "warning",
      section: "sections",
      message:
        `grid-locked: ${(sectionLengths.modalFraction * 100).toFixed(0)}% of ${sectionLengths.lengths.length} sections ` +
        `are ${sectionLengths.modalLength} bars, or every section is drawn from {8,16} (lengths: ${sectionLengths.lengths.join(",")})`,
    });
  }
  if (sectionLengths.missingLongHold) {
    findings.push({
      severity: "warning",
      section: "sections",
      message:
        `missing one long-held section: longest is ${sectionLengths.longestSection} bars, only ` +
        `${sectionLengths.longestRatioToMedian.toFixed(2)}x the median (${sectionLengths.median}); need >= ${LONG_HOLD_RATIO}x`,
    });
  }

  // The 2-4 target is SCORE-wide (per the skill's "budget 2-4 once-only EVENT
  // moments per track[-of-the-EP]"), not per instrument-track — a per-track
  // gate can never pass on a 12-voice machine. Per-track counts stay in the
  // report data for detail; only the aggregate flags.
  const scoreWideEvents =
    eventTiers.tracks.reduce((sum, track) => sum + track.onceOnlyCount, 0) +
    eventTiers.sceneFlashCount + eventTiers.perfSpikeCount;
  if (scoreWideEvents <= EVENT_TIER_EMPTY_MAX) {
    findings.push({
      severity: "warning",
      section: "EVENT tier",
      message: `EVENT tier empty: ${scoreWideEvents} once-only gesture(s) score-wide (target 2-4)`,
    });
  }

  for (const drop of drops) {
    if (drop.weak) {
      findings.push({
        severity: "warning",
        section: `drop @bar${drop.atBar}`,
        message: `weak drop: only ${drop.dimensions.length} contrast dimension(s) [${drop.dimensions.join(",")}] (need >= ${MIN_DROP_DIMENSIONS})`,
      });
    }
  }

  if (builds.length >= 2) {
    const primaries = new Set(builds.map((build) => build.primary));
    if (primaries.size === 1) {
      findings.push({
        severity: "warning",
        section: "builds",
        message: `build-type monotony: all ${builds.length} pre-drop builds classify as "${[...primaries][0]}"`,
      });
    }
  }

  if (silence.length === 0) {
    findings.push({
      severity: "warning",
      section: "silence",
      message: "no silent bar detected (soloKeep:[] or an all-tracks-muted span >=0.5 bar); the skill wants >=1 per track at the EP level",
    });
  }

  if (unattended.longestGapBars > UNATTENDED_FLAG_BARS) {
    findings.push({
      severity: "warning",
      section: "unattended span",
      message: `continuous ride: ${unattended.longestGapBars} bars with no events starting at bar ${unattended.atBar} (flag threshold ${UNATTENDED_FLAG_BARS})`,
    });
  }

  return findings;
}

export function lintArrangement(input: unknown): ArrangementReport {
  const name = typeof input === "object" && input !== null && typeof (input as { name?: unknown }).name === "string"
    ? (input as { name: string }).name
    : "(unnamed)";
  const errors = validateScore(input);
  if (errors.length > 0) {
    return {
      name,
      findings: errors.map((message) => ({ severity: "error" as const, section: "schema", message })),
    };
  }
  const score = input as Score;
  const sectionLengths = analyzeSectionLengths(score);
  const eventTiers = computeEventTiers(score);
  const drops = computeDrops(score);
  const silence = computeSilenceSpans(score);
  const builds = classifyBuilds(score, drops, silence);
  const unattended = computeUnattendedSpan(score);
  const metrics: ArrangementMetrics = { sectionLengths, eventTiers, drops, builds, silence, unattended };
  return { name: score.name, findings: buildFindings(metrics), metrics };
}

// ---------------------------------------------------------------------------
// EP-level summary (directory mode)
// ---------------------------------------------------------------------------
export interface EpSummary {
  scoreCount: number;
  silentScoreCount: number;
  silentCoverageFraction: number;
  buildTypeCounts: Record<string, number>;
  dominantBuildType?: string;
  dominantBuildFraction: number;
  buildDiversityFlag: boolean;
}

export function buildEpSummary(reports: ArrangementReport[]): EpSummary {
  const withMetrics = reports.filter((report): report is ArrangementReport & { metrics: ArrangementMetrics } => report.metrics !== undefined);
  const silentScoreCount = withMetrics.filter((report) => report.metrics.silence.length > 0).length;
  const buildTypeCounts: Record<string, number> = {};
  let totalBuilds = 0;
  for (const report of withMetrics) {
    for (const build of report.metrics.builds) {
      buildTypeCounts[build.primary] = (buildTypeCounts[build.primary] ?? 0) + 1;
      totalBuilds += 1;
    }
  }
  let dominantBuildType: string | undefined;
  let dominantCount = 0;
  for (const [type, count] of Object.entries(buildTypeCounts)) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantBuildType = type;
    }
  }
  const dominantBuildFraction = totalBuilds > 0 ? dominantCount / totalBuilds : 0;
  return {
    scoreCount: withMetrics.length,
    silentScoreCount,
    silentCoverageFraction: withMetrics.length > 0 ? silentScoreCount / withMetrics.length : 0,
    buildTypeCounts,
    dominantBuildType,
    dominantBuildFraction,
    buildDiversityFlag: totalBuilds >= 2 && dominantBuildFraction > EP_BUILD_DOMINANCE_FRACTION,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function formatReport(report: ArrangementReport): string {
  const lines: string[] = [report.name];
  if (!report.metrics) {
    lines.push("  INVALID SCORE");
    for (const finding of report.findings) lines.push(`    ERROR ${finding.message}`);
    return lines.join("\n");
  }
  const { sectionLengths, eventTiers, drops, builds, silence, unattended } = report.metrics;

  lines.push(
    `  sections: ${sectionLengths.patternChangeCount} pattern changes, lengths [${sectionLengths.lengths.join(",")}], ` +
      `median ${sectionLengths.median}, variance ${sectionLengths.variance.toFixed(1)}, longest ${sectionLengths.longestSection}` +
      ` (${sectionLengths.longestRatioToMedian.toFixed(2)}x median)`,
  );
  lines.push(
    `  EVENT tier: ${eventTiers.tracks.map((t) => `${t.track}:${t.onceOnlyCount}`).join(" ")}` +
      ` | scene flashes ${eventTiers.sceneFlashCount} | perf spikes ${eventTiers.perfSpikeCount}` +
      (eventTiers.perfSpikeDisqualifiedByRepeat > 0 ? ` (${eventTiers.perfSpikeDisqualifiedByRepeat} repeated, disqualified)` : ""),
  );
  lines.push(
    `  drops: ${drops.length} detected` +
      (drops.length > 0 ? ` -- ${drops.map((d) => `bar${d.atBar}[${d.dimensions.join("+")}]${d.weak ? " WEAK" : ""}`).join(", ")}` : ""),
  );
  lines.push(
    `  builds: ${builds.length} pre-drop` +
      (builds.length > 0 ? ` -- ${builds.map((b) => `bar${b.dropAtBar}:${b.primary}`).join(", ")}` : ""),
  );
  lines.push(
    `  silence: ${silence.length} span(s)` +
      (silence.length > 0 ? ` -- ${silence.map((s) => `bar${s.atBar}(${s.durationBars})`).join(", ")}` : " (none)"),
  );
  lines.push(`  unattended: longest gap ${unattended.longestGapBars} bars (from bar ${unattended.atBar})`);

  if (report.findings.length === 0) {
    lines.push("  clean: no findings");
  } else {
    lines.push(`  ${report.findings.length} finding(s):`);
    for (const finding of report.findings) {
      lines.push(`    ${finding.severity === "error" ? "ERROR" : "WARN "} [${finding.section}] ${finding.message}`);
    }
  }
  return lines.join("\n");
}

function formatEpSummary(summary: EpSummary): string {
  const lines = ["EP summary"];
  lines.push(`  silent-bar coverage: ${summary.silentScoreCount}/${summary.scoreCount} scores (${(summary.silentCoverageFraction * 100).toFixed(0)}%)`);
  const buildTypeLine = Object.entries(summary.buildTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}:${count}`)
    .join(" ");
  lines.push(`  build types across EP: ${buildTypeLine || "(no drops detected)"}`);
  if (summary.buildDiversityFlag) {
    lines.push(
      `  FLAG build-type monotony: "${summary.dominantBuildType}" is ${(summary.dominantBuildFraction * 100).toFixed(0)}% of all builds`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function lintPath(path: string): ArrangementReport {
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  return lintArrangement(input);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function runLint(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const path = args.find((arg) => !arg.startsWith("--"));
  if (!path) {
    process.stderr.write("usage: lint-arrangement.ts <score.json|scores-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }

  const files = isDirectory(path)
    ? readdirSync(path)
        .filter((entry) => extname(entry) === ".json")
        .sort()
        .map((entry) => join(path, entry))
    : [path];

  const reports = files.map(lintPath);
  const anyFindings = reports.some((report) => report.findings.length > 0);

  if (json) {
    const output: { scores: ArrangementReport[]; epSummary?: EpSummary } = { scores: reports };
    if (files.length > 1) output.epSummary = buildEpSummary(reports);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`${reports.map(formatReport).join("\n\n")}\n`);
    if (files.length > 1) {
      process.stdout.write(`\n${formatEpSummary(buildEpSummary(reports))}\n`);
    }
  }
  if (anyFindings) process.exitCode = 1;
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) runLint();
