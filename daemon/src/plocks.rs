//! Parameter-lock pool decode: 72 `PlockSeq` slots -> per-trig `{parameter: value}`.
//!
//! A pattern's p-locks live in its parameter-lock pool, not on the trigs: each of
//! the 72 slots claims one `(track_nr, plock_type)` pair and holds one byte per
//! trig column (64 columns, `0xFF` = "this trig is not locked"). Compound locks
//! occupy two adjacent slots — the claimed MSB slot plus a companion LSB slot
//! marked `track_nr = 128 / plock_type = 128`, which carries no lock of its own.
//!
//! The daemon used to read locks back through rytm-rs's `Trig::plock_get_*`
//! accessors. Those need the trig's `Arc` link to the pool, and any pattern that
//! loses that link — a `Pattern` revived through serde, for instance, whose trigs
//! deserialize before the pool field exists — answers `Err(OrphanTrig)` for every
//! parameter. The old accessor-based collector swallowed that error, so
//! `pattern.inspect` reported `locks: {}` for every trig while the locks were
//! live in the pool and audible on the device. Decoding the pool directly removes
//! that whole class of failure: the bytes are read from the pattern's own
//! serialized pool, so the readback no longer depends on object wiring.
//!
//! Names and value encodings match the write path (`apply_parameter_lock_set` in
//! `hardware.rs`) so a declaration's locks compare equal on readback.
//!
//! Known limitation (unchanged by this decode): a device-*saved* pattern can fill
//! un-locked trig columns of a claimed slot with `0x00` instead of `0xFF`. An
//! in-range `0` is indistinguishable from a real `0` lock at the byte level, so
//! such columns still surface as locks. The daemon's own writes use `0xFF` fill
//! and read back clean.

use rytm_rs::object::pattern::Pattern;
use rytm_rs::prelude::{FilterType, LfoDestination, LfoMode, LfoMultiplier, LfoWaveform};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// Byte marking an unclaimed slot / an un-locked trig column.
const UNSET: u8 = 0xFF;
/// `track_nr` and `plock_type` of the companion (LSB) slot of a compound lock.
const COMPOUND_COMPANION_TRACK: u8 = 128;
const COMPOUND_COMPANION_TYPE: u8 = 128;
/// Trig columns per pool slot.
const TRIG_COLUMNS: usize = 64;
/// Signed p-lock bytes are stored around the midpoint of the `0..=127` range.
const SIGNED_MIDPOINT: i16 = 64;

/// How a slot's byte(s) decode into a JSON lock value.
#[derive(Clone, Copy)]
enum Kind {
    /// Raw `0..=127` byte.
    Unsigned,
    /// Byte offset from the `0..=127` midpoint, gated to the parameter's range.
    Signed { low: i16, high: i16 },
    /// Non-zero byte = true.
    Bool,
    /// Two-slot compound: `(msb << 8) | lsb`, scaled onto a float range. The
    /// patched rytm-rs fork writes these as single MSB bytes (`lsb == 0`), which
    /// decodes identically; a legacy pool's companion LSB is folded in here.
    Compound { raw_max: u16, low: f32, high: f32 },
    /// Byte parsed into a rytm-rs enum, reported as its serde variant string.
    Enum(EnumKind),
}

#[derive(Clone, Copy)]
enum EnumKind {
    FilterType,
    LfoMultiplier,
    LfoDestination,
    LfoWaveform,
    LfoMode,
}

/// Device p-lock type id -> the daemon's flat parameter name and its encoding.
///
/// Ids follow libanalogrytm `pattern.h` (`AR_PLOCK_TYPE_*`). The machine-page
/// types (`MP0..MP7`, 0x00-0x07) are deliberately absent: the write path has no
/// name for them (rytm-rs exposes no synth-page p-lock API), so decoding them
/// would report keys no declaration can round-trip.
const PARAMETERS: &[(u8, &str, Kind)] = &[
    // ----- sample page -----
    (0x08, "sample_tune", Kind::Signed { low: -24, high: 24 }),
    (
        0x09,
        "sample_fine_tune",
        Kind::Signed { low: -64, high: 63 },
    ),
    (0x0A, "sample_number", Kind::Unsigned),
    (0x0B, "sample_bit_reduction", Kind::Unsigned),
    (
        0x0C,
        "sample_start",
        Kind::Compound {
            raw_max: 30720,
            low: 0.0,
            high: 120.0,
        },
    ),
    (
        0x0D,
        "sample_end",
        Kind::Compound {
            raw_max: 30720,
            low: 0.0,
            high: 120.0,
        },
    ),
    (0x0E, "sample_loop", Kind::Bool),
    (0x0F, "sample_level", Kind::Unsigned),
    // ----- filter page -----
    (0x10, "filter_attack", Kind::Unsigned),
    (0x11, "filter_sustain", Kind::Unsigned),
    (0x12, "filter_decay", Kind::Unsigned),
    (0x13, "filter_release", Kind::Unsigned),
    (0x14, "filter_cutoff", Kind::Unsigned),
    (0x15, "filter_resonance", Kind::Unsigned),
    (0x16, "filter_type", Kind::Enum(EnumKind::FilterType)),
    (0x17, "filter_envelope", Kind::Signed { low: -64, high: 63 }),
    // ----- amp page -----
    (0x18, "amp_attack", Kind::Unsigned),
    (0x19, "amp_hold", Kind::Unsigned),
    (0x1A, "amp_decay", Kind::Unsigned),
    (0x1B, "amp_overdrive", Kind::Unsigned),
    (0x1C, "amp_delay_send", Kind::Unsigned),
    (0x1D, "amp_reverb_send", Kind::Unsigned),
    (0x1E, "amp_pan", Kind::Signed { low: -64, high: 63 }),
    (0x1F, "amp_volume", Kind::Unsigned),
    // ----- lfo page -----
    (0x21, "lfo_speed", Kind::Signed { low: -64, high: 63 }),
    (0x22, "lfo_multiplier", Kind::Enum(EnumKind::LfoMultiplier)),
    (0x23, "lfo_fade", Kind::Signed { low: -64, high: 63 }),
    (
        0x24,
        "lfo_destination",
        Kind::Enum(EnumKind::LfoDestination),
    ),
    (0x25, "lfo_waveform", Kind::Enum(EnumKind::LfoWaveform)),
    (0x26, "lfo_phase", Kind::Unsigned),
    (0x27, "lfo_mode", Kind::Enum(EnumKind::LfoMode)),
    (
        0x28,
        "lfo_depth",
        Kind::Compound {
            raw_max: 32767,
            low: -128.0,
            high: 127.99,
        },
    ),
];

/// Every parameter lock a pattern carries, keyed by `(track index, trig step)`.
#[derive(Debug, Default)]
pub struct PatternPlocks {
    per_trig: BTreeMap<(usize, usize), Map<String, Value>>,
}

impl PatternPlocks {
    /// Decodes a pattern's pool. The pool is read through the pattern's public
    /// `Serialize` surface (`parameter_lock_pool.inner[]`), the same path the
    /// `plock_dump` forensic bin uses.
    pub fn decode(pattern: &Pattern) -> Self {
        serde_json::to_value(pattern)
            .map(|pattern| Self::from_pool_value(&pattern["parameter_lock_pool"]))
            .unwrap_or_default()
    }

    /// Decodes a serialized `ParameterLockPool` value.
    pub fn from_pool_value(pool: &Value) -> Self {
        let slots: Vec<Slot> = pool["inner"]
            .as_array()
            .map(|slots| slots.iter().map(Slot::from_value).collect())
            .unwrap_or_default();

        let mut per_trig: BTreeMap<(usize, usize), Map<String, Value>> = BTreeMap::new();
        for (index, slot) in slots.iter().enumerate() {
            // Unclaimed slots, and the companion LSB slots of compound locks
            // (which carry no lock of their own), hold nothing to report.
            if slot.track_nr == UNSET || slot.plock_type == UNSET || slot.is_companion() {
                continue;
            }
            let Some((_, name, kind)) = PARAMETERS
                .iter()
                .find(|(plock_type, _, _)| *plock_type == slot.plock_type)
            else {
                continue;
            };
            let companion = slots
                .get(index + 1)
                .filter(|next| next.is_companion())
                .filter(|_| matches!(kind, Kind::Compound { .. }));

            for step in 0..TRIG_COLUMNS {
                let msb = slot.byte(step);
                if msb == UNSET {
                    continue;
                }
                // A companion column left at the unset sentinel contributes no
                // low byte (that is how the fork's single-byte writes look).
                let lsb = companion
                    .map(|companion| companion.byte(step))
                    .filter(|byte| *byte != UNSET)
                    .unwrap_or(0);
                if let Some(value) = decode_value(*kind, msb, lsb) {
                    per_trig
                        .entry((slot.track_nr as usize, step))
                        .or_default()
                        .insert((*name).to_string(), value);
                }
            }
        }
        Self { per_trig }
    }

    /// The locks on one trig, as a flat `name -> value` map.
    pub fn locks_for(&self, track_index: usize, step: usize) -> Map<String, Value> {
        self.per_trig
            .get(&(track_index, step))
            .cloned()
            .unwrap_or_default()
    }
}

/// One decoded pool slot.
struct Slot {
    track_nr: u8,
    plock_type: u8,
    data: Vec<u8>,
}

impl Slot {
    fn from_value(slot: &Value) -> Self {
        Self {
            track_nr: byte_at(&slot["track_nr"]),
            plock_type: byte_at(&slot["plock_type"]),
            data: slot["data"]
                .as_array()
                .map(|data| data.iter().map(byte_at).collect())
                .unwrap_or_default(),
        }
    }

    fn is_companion(&self) -> bool {
        self.track_nr == COMPOUND_COMPANION_TRACK && self.plock_type == COMPOUND_COMPANION_TYPE
    }

    fn byte(&self, step: usize) -> u8 {
        self.data.get(step).copied().unwrap_or(UNSET)
    }
}

fn byte_at(value: &Value) -> u8 {
    u8::try_from(value.as_u64().unwrap_or(u64::from(UNSET))).unwrap_or(UNSET)
}

/// Decodes one trig column's byte(s). `None` means "not a value this parameter
/// can hold" — stale or out-of-range bytes are dropped rather than reported.
fn decode_value(kind: Kind, msb: u8, lsb: u8) -> Option<Value> {
    match kind {
        Kind::Unsigned => (msb <= 127).then(|| json!(msb)),
        Kind::Signed { low, high } => {
            let value = i16::from(msb) - SIGNED_MIDPOINT;
            (low..=high).contains(&value).then(|| json!(value))
        }
        Kind::Bool => Some(json!(msb != 0)),
        Kind::Compound { raw_max, low, high } => {
            let raw = (u16::from(msb) << 8) | u16::from(lsb);
            let value = scale_raw_to_f32(raw, raw_max, low, high);
            (value >= low && value <= high).then(|| json!(value))
        }
        Kind::Enum(kind) => decode_enum(kind, msb),
    }
}

/// Mirrors rytm-rs's `scale_u16_to_f32` (input minimum 0) so decoded floats match
/// the values the write path round-trips.
fn scale_raw_to_f32(raw: u16, raw_max: u16, low: f32, high: f32) -> f32 {
    let scale_factor = (high - low) / f32::from(raw_max);
    f32::from(raw).mul_add(scale_factor, low)
}

fn decode_enum(kind: EnumKind, byte: u8) -> Option<Value> {
    let value = match kind {
        EnumKind::FilterType => serde_json::to_value(FilterType::try_from(byte).ok()?),
        EnumKind::LfoMultiplier => serde_json::to_value(LfoMultiplier::try_from(byte).ok()?),
        EnumKind::LfoDestination => serde_json::to_value(LfoDestination::try_from(byte).ok()?),
        EnumKind::LfoWaveform => serde_json::to_value(LfoWaveform::try_from(byte).ok()?),
        EnumKind::LfoMode => serde_json::to_value(LfoMode::try_from(byte).ok()?),
    };
    value.ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One pool slot description: `track_nr`, `plock_type`, and the `(step, byte)`
    /// trig columns to set (every other column stays at the unset sentinel).
    type SlotSpec<'a> = (u8, u8, &'a [(usize, u8)]);

    /// Builds a serialized pool value from slot descriptions, padding the rest of
    /// the 72 slots as unclaimed.
    fn pool(slots: &[SlotSpec]) -> Value {
        let mut inner: Vec<Value> = slots
            .iter()
            .map(|(track_nr, plock_type, columns)| {
                let mut data = [UNSET; TRIG_COLUMNS];
                for (step, byte) in *columns {
                    data[*step] = *byte;
                }
                json!({
                    "track_nr": track_nr,
                    "plock_type": plock_type,
                    "data": data.to_vec(),
                })
            })
            .collect();
        let unset_columns = vec![UNSET; TRIG_COLUMNS];
        while inner.len() < 72 {
            inner.push(json!({
                "track_nr": UNSET,
                "plock_type": UNSET,
                "data": unset_columns,
            }));
        }
        json!({
            "owner_pattern_index": 0,
            "inner": inner,
            "is_owner_pattern_work_buffer": true,
        })
    }

    #[test]
    fn basic_slots_decode_per_trig_and_skip_unset_columns() {
        // LT (track 5) sample_tune on steps 0 and 4, sample_number on step 4,
        // an amp_pan lock on CH (track 8), and one unreadable machine-page slot.
        let plocks = PatternPlocks::from_pool_value(&pool(&[
            (5, 0x08, &[(0, 52), (4, 76)]),
            (5, 0x0A, &[(4, 7)]),
            (8, 0x1E, &[(2, 44)]),
            (0, 0x00, &[(0, 64)]),
        ]));

        assert_eq!(
            plocks.locks_for(5, 0),
            json!({ "sample_tune": -12 }).as_object().cloned().unwrap()
        );
        assert_eq!(
            plocks.locks_for(5, 4),
            json!({ "sample_tune": 12, "sample_number": 7 })
                .as_object()
                .cloned()
                .unwrap()
        );
        assert_eq!(
            plocks.locks_for(8, 2),
            json!({ "amp_pan": -20 }).as_object().cloned().unwrap()
        );
        // Unset columns, untouched tracks, and machine-page slots report nothing.
        assert!(plocks.locks_for(5, 1).is_empty());
        assert!(plocks.locks_for(6, 4).is_empty());
        assert!(plocks.locks_for(0, 0).is_empty());
    }

    #[test]
    fn compound_slots_fold_in_the_companion_lsb_and_report_no_companion_lock() {
        // A legacy two-slot compound lfo_depth (0x28) on BD step 3: MSB slot plus
        // the track_nr=128/plock_type=128 companion carrying the low byte.
        let plocks = PatternPlocks::from_pool_value(&pool(&[
            (0, 0x28, &[(3, 79)]),
            (
                COMPOUND_COMPANION_TRACK,
                COMPOUND_COMPANION_TYPE,
                &[(3, 0x40)],
            ),
        ]));

        let locks = plocks.locks_for(0, 3);
        let depth = locks["lfo_depth"].as_f64().unwrap();
        let expected = f64::from(scale_raw_to_f32((79 << 8) | 0x40, 32767, -128.0, 127.99));
        assert!(
            (depth - expected).abs() < 1e-6,
            "compound depth decoded as {depth}, expected {expected}"
        );
        assert_eq!(locks.len(), 1, "only the MSB slot names a parameter");
        // The companion slot is not a track: it contributes no locks of its own.
        assert!(plocks
            .locks_for(COMPOUND_COMPANION_TRACK as usize, 3)
            .is_empty());
    }

    #[test]
    fn single_byte_compound_slots_decode_without_a_companion() {
        // The patched fork writes 0x0C/0x0D/0x28 as BASIC single bytes (no
        // companion slot); the low byte is then simply zero.
        let plocks = PatternPlocks::from_pool_value(&pool(&[(2, 0x0C, &[(1, 32)])]));
        let start = plocks.locks_for(2, 1)["sample_start"].as_f64().unwrap();
        let expected = f64::from(scale_raw_to_f32(32 << 8, 30720, 0.0, 120.0));
        assert!((start - expected).abs() < 1e-6, "sample_start {start}");
    }

    #[test]
    fn enum_bool_and_out_of_range_bytes_decode_like_the_write_path() {
        let plocks = PatternPlocks::from_pool_value(&pool(&[
            (1, 0x16, &[(0, 1)]),   // filter_type
            (1, 0x27, &[(0, 0)]),   // lfo_mode
            (1, 0x0E, &[(0, 1)]),   // sample_loop
            (1, 0x1F, &[(0, 200)]), // amp_volume, out of the 0..=127 range
            (1, 0x08, &[(0, 0)]),   // sample_tune byte 0 -> -64, out of -24..=24
        ]));

        let locks = plocks.locks_for(1, 0);
        assert_eq!(locks["filter_type"], json!("Lp1"));
        assert_eq!(locks["lfo_mode"], json!("Free"));
        assert_eq!(locks["sample_loop"], json!(true));
        assert!(
            !locks.contains_key("amp_volume"),
            "out-of-range byte dropped"
        );
        assert!(
            !locks.contains_key("sample_tune"),
            "out-of-range byte dropped"
        );
    }
}
