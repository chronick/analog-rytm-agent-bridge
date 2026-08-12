# Upstream PR review packet — `alisomay/rytm-rs`

**Status: nothing has been submitted.** Eight branches exist locally in
`~/git/rytm-rs`, each built on `upstream/main` and verified standalone. Review
these, then decide what to open and in what order.

Prepared 2026-08-11 against `upstream/main` = `5638457` (2024-12-07).

Branches were rebuilt after the `rytm/proj.json` purge; every one is verified to
sit on the genuine upstream tip `5638457` (0 commits behind), not on a rewritten
copy of upstream history.

## Context worth knowing before you submit

- Upstream's last commit is **2024-12-07** — roughly twenty months of silence.
  There are no open PRs and no CI workflows in the repo.
- Two open upstream issues, both filed **2026-01-28 by `kmorrill`** (not us) and
  both **still unanswered by the maintainer**, ask for exactly two of these
  features:
  - [#2](https://github.com/alisomay/rytm-rs/issues/2) — Song data structure and
    SysEx parsing → **`pr/song-codec`**
  - [#3](https://github.com/alisomay/rytm-rs/issues/3) — Scene and Performance
    macro APIs → **`pr/scene-performance-codecs`**
  A third party asking for the same thing is the strongest argument these PRs
  are wanted rather than imposed.
- **Upstream has zero unit tests.** `cargo test --lib` on `upstream/main` runs 0
  tests. The only test file, `tests/reverse_engineering.rs`, requires a
  physically connected device and says in its own header that it "is not
  expected to pass". Every test count below is coverage this work adds.
- Clippy: `upstream/main` has **79** pre-existing lints and **0** hard errors.
  Every branch below matches that exactly — no new findings.
- `cargo fmt --check` is clean on every branch. (Upstream's `rustfmt.toml` sets
  two nightly-only options that stable ignores with a warning.)

## The branches

Verified individually: built, `cargo test --lib`, `cargo test --test
firmware_fixtures` where applicable, `cargo clippy --all-targets`, `cargo fmt
--check`.

| # | Branch | Commits | Files | Tests added | Closes |
|---|---|---|---|---|---|
| 1 | `pr/kit-retrig-decode` | 1 | 1 | 1 lib | — |
| 2 | `pr/global-routing-active-low` | 1 | 1 | 1 lib | — |
| 3 | `pr/firmware-object-round-trips` | 1 | 7 | 1 lib | — |
| 4 | `pr/dynamic-machine-parameters` | 1 | 6 | 3 lib | — |
| 5 | `pr/plock-pool-sentinel-fill` | 2 | 3 | 7 lib | — |
| 6 | `pr/firmware-fixtures` | 3 † | 18 | 2 lib + 5 fixture | — |
| 7 | `pr/scene-performance-codecs` | 4 † | 24 | 7 lib + 7 fixture | **#3** |
| 8 | `pr/song-codec` | 4 † | 31 | 7 lib + 6 fixture | **#2** |

† includes prerequisite commits — see the stack below.

### Suggested submission order

Open 1–5 first. They are small, independent, and each fixes a real encoding bug
— the cheapest way to find out whether the maintainer is responsive at all
before asking for review on 900-line features.

```
upstream/main
├── 1  kit-retrig-decode              independent
├── 2  global-routing-active-low      independent
├── 3  firmware-object-round-trips    independent
├── 4  dynamic-machine-parameters     independent
├── 5  plock-pool-sentinel-fill       independent
└── 6  firmware-fixtures              NEEDS 1 + 3
    ├── 7  scene-performance-codecs   NEEDS 6
    └── 8  song-codec                 NEEDS 6
```

The dependencies in 6 are not stylistic — they were found by the tests failing:

- Without **3**, `firmware_fixtures.rs` does not compile: `RawSysexObject` does
  not exist.
- Without **1**, the kit round-trip test fails with 12 differing bytes at a
  stride of 4, each losing bit `0x20` — one dropped retrig flag per track.

7 and 8 both branch from 6 and are independent of each other, so the maintainer
can take either alone. If **both** merge, the second needs a trivial rebase:
they each append to `tests/firmware_fixtures.rs` and to the fixture README.

---

## 1. `pr/kit-retrig-decode` — Preserve kit retrig settings when decoding SysEx

**What's wrong:** decoding a Kit drops the per-track retrig settings, so a
decode/encode round trip is not byte-exact.

**Evidence:** with this fix reverted, the kit fixture round trip fails on 12
bytes at stride 4, each `0x2E → 0x0E` — bit `0x20` cleared once per track.

**Risk:** low. One file, additive.

## 2. `pr/global-routing-active-low` — Fix active-low global routing flags

**What's wrong:** the global routing flags are active-**low** on the device, and
were being read as active-high, so routing state decoded inverted.

**Risk:** low, but it is a **behavior change** — anyone who compensated for the
old inversion in their own code will see routing flip. Worth calling out
explicitly in the PR body.

## 3. `pr/firmware-object-round-trips` — Preserve firmware object round trips

**What it adds:** `RawSysexObject`, so any object can be carried byte-exactly
through decode/encode even where the typed model does not cover every field.
Also fixes delay, pattern, and track encoding paths that lost bytes.

**Why it matters upstream:** this is the foundation for trusting the codecs at
all, and it is what makes the fixture suite (6) possible.

**Risk:** medium — touches `sysex.rs` and `prelude.rs`. Widest blast radius of
the five small PRs.

## 4. `pr/dynamic-machine-parameters` — Validated dynamic machine parameter control

**What it adds:** set machine parameters by name with validation, via an
extension to the `machine_parameters` macro, plus the missing `hh_lab` machine
parameters.

**Risk:** low-medium. Touches the proc-macro crate, so review attention belongs
on `rytm-macro/src/machine_parameters.rs`.

## 5. `pr/plock-pool-sentinel-fill` — P-lock pool correctness

**What's wrong:** two distinct bugs in the parameter-lock pool.

1. Claiming a pool slot left it zero-filled rather than sentinel-filled, so
   unset steps read back as a real value of 0 instead of "no lock". Fixed by
   sentinel-filling on claim.
2. `lfo_depth`, `sample_start`, and `sample_end` were written as compound
   two-byte locks. Per `libanalogrytm`'s `pattern.h` they are basic single-byte
   locks; the compound form produced an orphan companion slot.

The second commit proves `Pattern::clear_all_plocks` retires both the zero-fill
ghosts and the orphan companions.

**Note:** the original commit accidentally included a **63 MB `rytm/proj.json`**
device dump. It has been purged from this branch and from the fork's
`agent-control` history; the bridge is repinned to the purged revision.

**Risk:** medium. This is protocol-level behavior; the claim rests on
`libanalogrytm`'s header, which the PR body should cite directly.

## 6. `pr/firmware-fixtures` — Connected firmware compatibility fixtures

**What it adds:** real SysEx captured from a connected Analog Rytm MKII on
OS 1.72, a manifest, and a test suite that validates every fixture byte, proves
typed decode/re-encode loses nothing, and rejects checksum corruption. Also
`examples/capture_firmware_fixtures.rs` so anyone can regenerate them from their
own device.

**Why it matters upstream:** it converts "the codecs seem right" into a
regression suite, on a project that currently has none.

**Ask the maintainer first?** Possibly. It commits ~25 KB of binary `.syx`
fixtures. Some maintainers dislike binary test data. The PR body should say
plainly that the fixtures are disposable protocol evidence from a scratch
project, contain no sample audio, and are regenerable from the shipped example.

**Stripped for upstream:** `docs/MAINTAINED_FORK.md` and the fork-branding
banner the original commit added to `README.md`. Neither belongs upstream.

## 7. `pr/scene-performance-codecs` — Typed Scene and Performance codecs → closes #3

**What it adds:** typed models for all 12 Scene and 12 Performance definitions
with semantic voice/FX lock targets, plus set/replace/copy/clear through the
Kit. `examples/certify_macro_codecs.rs` certifies the round trip against
hardware.

**Hardware evidence:** controlled one-lock and multi-track/multi-page
definitions were written to the work-buffer Kit, read back through the typed
codec, and rolled back to an exact baseline. The write preserved the device's
`0xFF` inactive-Scene state.

**Risk:** medium-high by size (886 new lines in `kit/macros.rs`), low by blast
radius — almost entirely new surface rather than changed behavior.

## 8. `pr/song-codec` — Lossless typed Song codec → closes #2

**What it adds:** a typed Song model — names, rows, pattern chains, repeats,
per-position track mutes — plus `SongQuery` wired into the prelude and
`RytmProject`. Unidentified bytes are preserved, and unsupported arranger
fields (tempo/length overrides, jumps, loops, labels, end markers) stay explicit
capability gaps rather than silent data loss.

**Hardware evidence:** controlled name, rows, chain, repeats, and 12-track mute
masks written to the work buffer, read back typed, rolled back to an exact
baseline. Certified by `examples/certify_song_codec.rs`.

**Note on this branch's construction:** commit `f2e8143` was originally authored
on top of the Scene/Performance work, so its diff carried scene context. This
branch was rebuilt on `pr/firmware-fixtures` with the Scene/Performance tests
and helpers removed — verified by asserting no `Scene`/`Performance`/`Macro`
identifier survives in the test file. Worth a skim of
`rytm/tests/firmware_fixtures.rs` to confirm the seam reads cleanly.

**Keeps the README change** describing Song query support, since that documents
a real upstream-facing feature (unlike the fork banner, which was stripped).

**Risk:** medium-high by size. Same shape as 7 — mostly new surface.

---

## Loose ends for you to decide

1. **Author identity.** Commits carry `Co-Authored-By: Claude Opus 5`. Many
   maintainers are wary of machine-submitted PRs. Options: leave it as
   disclosure, rewrite the trailers, or keep them and state plainly in the PR
   body that the work was agent-assisted and hardware-verified. Your call — I
   have not changed any authorship.

2. **How much to open at once.** Eight PRs landing simultaneously on a
   twenty-month-dormant repo reads as a dump. Opening 1–3 first and waiting is
   the friendlier move.

3. **If upstream stays silent.** The fork is already the real dependency. The
   honest alternative is to say so publicly — a note in the fork's README
   describing it as a maintained fork with changes offered upstream, so others
   hitting issues #2 and #3 can find it.

## Reproducing this

The stack is rebuilt deterministically by
`scratchpad/build-pr-stack.sh` (this session), which strips fork-only artifacts
and resolves the two known conflicts. To re-verify any branch:

```bash
cd ~/git/rytm-rs && git checkout pr/<branch>
cargo test --manifest-path rytm/Cargo.toml --lib
cargo test --manifest-path rytm/Cargo.toml --test firmware_fixtures
cargo clippy --manifest-path rytm/Cargo.toml --all-targets
cargo fmt --manifest-path rytm/Cargo.toml --check
```

Ignore `tests/reverse_engineering.rs` — it needs a connected device and fails on
`upstream/main` too.
