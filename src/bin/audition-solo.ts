import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";
import type { RytmTrackId } from "../domain/types.ts";

// Per-track isolation audition: activate a pattern, then for each requested
// track mute the other eleven, capture a bounded window, and report what that
// track alone contributes (rms/peak from the capture sidecar). The standard
// feedback tool for "which voice is doing that" questions and relative-level
// audits — born from the basilica 808 Hz stripe hunt, where the offender
// (kick-sample drone bleed) was only findable by soloing.
//
//   npm run audition:solo -- B01                     all 12 tracks
//   npm run audition:solo -- B01 BD CH OH            just these
//   npm run audition:solo -- B01 --duration-ms 4000 --tempo 137
//
// Output: an aligned table on stderr, one JSON line on stdout
// ({ pattern, results: [{ track, rmsDb, peakDb, silence, audioPath }] }).

const TRACKS: RytmTrackId[] = ["BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB"];

interface SoloCapture {
  status: string;
  audioPath?: string;
  analysis?: { silence?: boolean; peak?: number; rms?: number };
  audio?: { silence?: boolean; peak?: number; rms?: number };
}

function db(linear: number | undefined): number | null {
  if (linear === undefined || linear <= 0) return null;
  return Math.round(20 * Math.log10(linear) * 10) / 10;
}

export async function runSoloAudition(): Promise<void> {
  const args = process.argv.slice(2);
  const pattern = args.find((a) => /^[A-H](0[1-9]|1[0-6])$/.test(a));
  assert.ok(pattern, "usage: audition-solo.ts <pattern> [TRACK ...] [--duration-ms N] [--tempo N]");
  const requested = args.filter((a): a is RytmTrackId => (TRACKS as string[]).includes(a));
  const solos = requested.length > 0 ? requested : TRACKS;
  const durationMs = Number(args[args.indexOf("--duration-ms") + 1] || NaN) || 3000;
  const tempo = Number(args[args.indexOf("--tempo") + 1] || NaN) || 130;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const directory = `${repository}hardware/runs/solo-${stamp}`;
  mkdirSync(directory, { recursive: true });

  const client = new RustDaemonClient({
    command: "cargo",
    args: [
      "run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve",
      "--adapter", "hardware", "--clock-source", "generated", "--audio-dir", directory,
    ],
    cwd: repository,
    requestTimeoutMs: 120_000,
  });
  const results: Array<Record<string, unknown>> = [];
  try {
    const health = await client.start();
    assert.equal(health.adapter, "hardware");

    await client.changePattern({ pattern, immediate: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = (await client.inspectDeviceState()) as { activePattern?: string | { pattern?: string } };
      const active = typeof state.activePattern === "object" ? state.activePattern?.pattern : state.activePattern;
      if (active === pattern) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await client.setTransport({ command: "start", tempo });

    for (const solo of solos) {
      for (const track of TRACKS) {
        await client.setLiveParameter({ track, parameter: "track_mute", value: track === solo ? 0 : 1 });
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      const capture = (await client.capturePatternAudio({
        recordingId: `solo-${stamp}-${solo}`,
        durationMs,
      })) as SoloCapture;
      const metrics = capture.analysis ?? capture.audio ?? {};
      results.push({
        track: solo,
        rmsDb: db(metrics.rms),
        peakDb: db(metrics.peak),
        silence: metrics.silence ?? null,
        status: capture.status,
        audioPath: capture.audioPath ?? null,
      });
      process.stderr.write(
        `${solo.padEnd(3)} rms ${String(results.at(-1)!.rmsDb ?? "-").padStart(7)} dBFS  peak ${String(results.at(-1)!.peakDb ?? "-").padStart(7)} dBFS  ${capture.status}\n`,
      );
    }
  } finally {
    await client.setTransport({ command: "stop" }).catch(() => {});
    for (const track of TRACKS) {
      await client.setLiveParameter({ track, parameter: "track_mute", value: 0 }).catch(() => {});
    }
    await client.close();
  }
  process.stdout.write(`${JSON.stringify({ pattern, durationMs, tempo, results })}\n`);
}

await runSoloAudition();
