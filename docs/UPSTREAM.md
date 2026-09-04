# Upstream `rytm-rs`

The daemon's SysEx codecs come from [`rytm-rs`](https://github.com/alisomay/rytm-rs)
by alisomay — safe Rust abstractions over `rytm-sys`, MIT licensed. The bridge
does not vendor or re-implement those codecs; it depends on them.

## Why the dependency is a fork

`daemon/Cargo.toml` pins `algonormative/rytm-rs` at an immutable revision rather than
the crates.io release. Building the bridge required object families and fixes
that upstream did not have:

| Area | Change |
|---|---|
| Song | A lossless typed Song codec — upstream had no Song data structure or SysEx parsing. |
| Scenes / Performance | Typed Scene and Performance codecs with semantic lock targets. |
| Machines | Validated dynamic machine parameter control. |
| Round trips | Firmware objects preserved byte-exactly across decode/encode. |
| Kit | Retrig settings preserved when decoding SysEx. |
| Global | Active-low routing flags corrected. |
| P-locks | Sentinel-fill on pool-slot claim; `lfo_depth`/`sample_start`/`sample_end` routed as basic single-byte locks per `libanalogrytm` `pattern.h`. |
| Fixtures | Compatibility fixtures captured from a connected OS 1.72 device. |

The pin is a revision, never a branch, so the codecs a build resolves are
exactly the ones that were certified against hardware.

## Contribution status

These changes are meant to go upstream, not to live in a fork indefinitely.
Two of them answer open upstream feature requests:

- [alisomay/rytm-rs#2](https://github.com/alisomay/rytm-rs/issues/2) — Song data
  structure and SysEx parsing.
- [alisomay/rytm-rs#3](https://github.com/alisomay/rytm-rs/issues/3) — Scene and
  Performance macro APIs.

The work was submitted as one pull request with one logical change per commit:
[alisomay/rytm-rs#4](https://github.com/alisomay/rytm-rs/pull/4) (opened 2026-09-04, from the fork branch `upstream-codecs`). Upstream's
last commit is from December 2024, so a response may take a while; the fork
carries the same commits on `agent-control` in the meantime, and the bridge pins
that branch by revision.

The fork's branch layout is documented in its `docs/MAINTAINED_FORK.md`:
`upstream-codecs` is exactly what was offered upstream, and `agent-control` is
`upstream-codecs` plus that document. Everything that is agent workflow rather
than codec — the certification examples and receipts — lives in this repository
(see below), not in the fork.

## Certification tooling

The hardware certification examples and their receipts live in this repo, not in
the fork — see [CODEC_CERTIFICATION.md](CODEC_CERTIFICATION.md).

## Staying current

Upstream's last release was December 2024. The fork tracks it as follows:

```bash
git -C rytm-rs fetch upstream
git -C rytm-rs log --oneline upstream-codecs..upstream/main   # anything to pick up?
```

If upstream moves, rebase `upstream-codecs` onto it, then `agent-control` onto
that, re-run the fork's test suite, and repin `daemon/Cargo.toml` to the new
revision. The pin is the
contract: the bridge is never silently upgraded underneath its hardware
certificates.
