# analyze-render calibration profiles

`analyze-render` (`npm run analyze:render`) reads its **repetition-smell flag bands**
from a named profile instead of hardcoding them, so the bands can be re-pinned from
a corpus of correctly-conducted takes.

- Default profile: `legacy` (this directory's `legacy.json`) — reproduces the historical
  hardcoded constants. It remains the default when no `--profile` is given.
- Select one: `--profile <name>` loads `config/analyze-profiles/<name>.json`.
  `--profile ./some/path.json` (a path or anything ending in `.json`) loads that file directly.
- Re-pin from good takes: `--calibrate "<glob>" --write-profile <path>` (see below).

## Schema (`analog-rytm-analyze-profile.v1`)

```jsonc
{
  "schema": "analog-rytm-analyze-profile.v1",
  "name": "legacy",                 // profile name; echoed into the analysis output
  "description": "…",               // optional, human-readable
  "thresholds": {
    "adjSimFlag": 0.97,             // FLAG when mean adjacent-bar similarity EXCEEDS this
    "nearIdenticalSim": 0.985,      // an adjacent bar pair this similar counts as "the same bar"
    "longestRunFlag": 8,            // FLAG when the longest near-identical run (bars) EXCEEDS this
    "noveltyStarvedBelow": 0.05,    // FLAG when mean per-bar novelty is BELOW this
    "noveltyFull": 0.2              // per-bar novelty >= this is "fully new material" (index scaling)
  },
  "provenance": { … }               // present only on --calibrate output (corpus + distributions)
}
```

Any missing threshold falls back to the corresponding `legacy` value, so a partial
profile that overrides only `adjSimFlag` is valid.

`adjSimFlag` and `longestRunFlag` are the **high-side repetition flags** — the bands the
`--calibrate` command re-pins. `nearIdenticalSim`, `noveltyStarvedBelow`, and `noveltyFull`
are sensitivities/scalings; `--calibrate` keeps them at their `legacy` values.

The silence-gap gate, anchor-offset warning, and on-grid fraction use fixed thresholds
(compiled constants), not the profile.

## Calibrating a new profile

```
npm run analyze:render -- \
  --calibrate "hardware/runs/<good-run>/score-*.wav" \
  --write-profile config/analyze-profiles/<name>.json \
  --tempo 120                 # fallback tempo; per-file sidecar tempo wins when present
```

For each matched WAV the tempo is taken from its sidecar (`*.events.json`
`schedule.finalTempo`, else `*.json` `tempo`) and only falls back to `--tempo`. Takes with
no tempo, or that read as `insufficient-audio`, are skipped. The command prints the
p50/p75/p90/max distribution of every metric and writes a profile whose flag bands sit at
the corpus **p90**, embedding the full distribution under `provenance`.
