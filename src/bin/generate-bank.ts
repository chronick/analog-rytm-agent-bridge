import { readFileSync, writeFileSync } from "node:fs";
import { generateBank } from "../gen/index.ts";
import type { GenConfig } from "../gen/index.ts";
import { STYLES } from "../gen/types.ts";

// CLI for the rytm-gen v0 pattern generator. Reads a high-level config, emits a
// deterministic, self-gated bank of PatternDecls that the existing gates
// (lint:declaration, score:danceability, build:project) verify and apply.
//
//   npm run gen:bank -- <config.json> [--seed N] [--out file] [--json] [--report]
//
// The config is the taste surface (see src/gen/types.ts GenConfig):
//   { "bank": "D", "style": "driving",
//     "kit": 2, "tempoFeel": 130, "density": "medium",
//     "harmonicFrame": { "root": "Am", "pivot": "Dm" },
//     "samplePalette": [ { "slot": 26, "role": "tonal", "root": "D4" }, ... ],
//     "eventBudget": { "signature": 1.5 }, "patterns": 12 }
//
// Default stdout is the declaration ({ project, patterns }) ready to pipe into
// build:project / lint:declaration / score:danceability. --report prints a
// human summary to stderr; --out writes the declaration to a file.

interface CliArgs {
  configPath?: string;
  seed: string;
  out?: string;
  json: boolean;
  report: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { seed: "0", json: false, report: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--seed") args.seed = argv[(index += 1)] ?? "0";
    else if (arg === "--out") args.out = argv[(index += 1)];
    else if (arg === "--json") args.json = true;
    else if (arg === "--report") args.report = true;
    else if (!arg.startsWith("--") && !args.configPath) args.configPath = arg;
  }
  return args;
}

function formatReport(bank: ReturnType<typeof generateBank>): string {
  const { summary: s, config } = bank;
  const lines: string[] = [
    `bank ${config.bank} — ${config.style} (seed ${bank.seed})`,
    `band ${s.band[0]}-${s.band[1]}  mean ${s.meanScore}  min ${s.minScore}  max ${s.maxScore}`,
    `gates: inBand ${s.allInBand}  lint-clean ${s.allLintClean}  choke-clean ${s.allChokeClean}  budget-clean ${s.allBudgetClean}`,
    "slot  name             score  int   flags",
    "-".repeat(56),
  ];
  for (const pattern of bank.patterns) {
    const g = pattern.gate;
    const flags: string[] = [];
    if (!g.inBand) flags.push("OUT-OF-BAND");
    if (g.lintErrors.length) flags.push(`${g.lintErrors.length} lint-err`);
    if (g.chokeCollisions.length) flags.push(`choke:${g.chokeCollisions.map((c) => c.pair).join(",")}`);
    if (g.budgetViolations.length) flags.push(`budget:${g.budgetViolations.map((v) => v.track).join(",")}`);
    lines.push(
      `${pattern.decl.slot.padEnd(4)}  ${(pattern.decl.name ?? "").padEnd(15)}  ${String(g.score).padStart(4)}  ${pattern.intensity.toFixed(2)}  ${flags.join("; ")}`,
    );
  }
  return lines.join("\n");
}

export function runGenerateBank(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  if (!args.configPath) {
    process.stderr.write("usage: generate-bank.ts <config.json> [--seed N] [--out file] [--json] [--report]\n");
    process.exitCode = 2;
    return;
  }
  const config = JSON.parse(readFileSync(args.configPath, "utf8")) as GenConfig;
  if (!config.bank || !/^[A-H]$/.test(config.bank)) {
    process.stderr.write(`config.bank must be a single letter A-H, got ${JSON.stringify(config.bank)}\n`);
    process.exitCode = 2;
    return;
  }
  if (!STYLES.includes(config.style)) {
    process.stderr.write(`config.style must be one of ${STYLES.join(", ")}, got ${JSON.stringify(config.style)}\n`);
    process.exitCode = 2;
    return;
  }

  const bank = generateBank(config, args.seed);
  const payload = args.json ? bank : bank.declaration;
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;

  if (args.out) {
    writeFileSync(args.out, serialized);
    process.stderr.write(`wrote ${bank.summary.count} patterns -> ${args.out}\n`);
  } else {
    process.stdout.write(serialized);
  }
  if (args.report) process.stderr.write(`${formatReport(bank)}\n`);

  // Non-zero exit if any gate failed, so this can gate a pipeline.
  const { summary } = bank;
  if (!(summary.allInBand && summary.allLintClean && summary.allChokeClean && summary.allBudgetClean)) {
    process.exitCode = 1;
  }
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) runGenerateBank();
