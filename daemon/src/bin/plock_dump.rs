//! Dev-only forensic pool dumper for Analog Rytm work-buffer pattern captures.
//!
//! Reads one or more captured `work-buffer-pattern.syx` files, decodes each via
//! rytm-rs (`RytmProject::try_default()` + `update_from_sysex_response`), and dumps
//! EVERY parameter-lock pool slot: pool index, `track_nr`, `plock_type` (hex + name),
//! and, per used trig column, the raw data byte (only columns differing from the unset
//! sentinel `0xFF`).
//!
//! No MIDI, no daemon, no hardware. Pure offline decode.
//!
//! Usage:
//!   cargo run --bin plock_dump -- <path/to/work-buffer-pattern.syx> [more.syx ...]
//!
//! The pool is reached through the public `Serialize` surface of `Pattern`
//! (`parameter_lock_pool` serializes inline as `{owner_pattern_index, inner:[{track_nr,
//! plock_type, data:[u8;64]}], is_owner_pattern_work_buffer}`), so no private rytm-rs
//! internals are touched.

use rytm_rs::RytmProject;

/// The 12 sound tracks in device order, plus the FX track at index 12.
const TRACK_NAMES: [&str; 13] = [
    "BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB", "FX",
];

/// Companion (LSB) slot marker rytm-rs writes for two-slot compound locks.
const COMPOUND_COMPANION_TRACK: u8 = 128;
const COMPOUND_COMPANION_TYPE: u8 = 128;

/// Human-readable name for a device plock type id (see libanalogrytm pattern.h).
fn plock_type_name(t: u8) -> &'static str {
    match t {
        0x00..=0x07 => "MP (machine param)",
        0x08 => "SMP_TUNE",
        0x09 => "SMP_FINE",
        0x0A => "SMP_NR (sample number)",
        0x0B => "SMP_BITRDC",
        0x0C => "SMP_START (basic 0..120)",
        0x0D => "SMP_END (basic 0..120)",
        0x0E => "SMP_LOOPSW",
        0x0F => "SMP_LEVEL",
        0x10 => "FLT_ATTACK",
        0x11 => "FLT_SUSTAIN",
        0x12 => "FLT_DECAY",
        0x13 => "FLT_RELEASE",
        0x14 => "FLT_FREQ (cutoff)",
        0x15 => "FLT_RESO",
        0x16 => "FLT_TYPE",
        0x17 => "FLT_ENV",
        0x18 => "AMP_ATTACK",
        0x19 => "AMP_HOLD",
        0x1A => "AMP_DECAY",
        0x1B => "AMP_DRIVE",
        0x1C => "AMP_DELAY",
        0x1D => "AMP_REVERB",
        0x1E => "AMP_PAN",
        0x1F => "AMP_VOLUME",
        0x21 => "LFO_SPEED",
        0x22 => "LFO_MULTIPLY",
        0x23 => "LFO_FADE",
        0x24 => "LFO_DEST",
        0x25 => "LFO_WAVEFORM",
        0x26 => "LFO_PHASE",
        0x27 => "LFO_TRIGMODE",
        0x28 => "LFO_DEPTH (basic 0..127)",
        128 => "<compound-companion LSB>",
        0xFF => "<unused>",
        _ => "<other>",
    }
}

fn track_name(nr: u8) -> String {
    if (nr as usize) < TRACK_NAMES.len() {
        TRACK_NAMES[nr as usize].to_string()
    } else if nr == COMPOUND_COMPANION_TRACK {
        "<companion>".to_string()
    } else {
        format!("track#{nr}")
    }
}

fn dump_capture(path: &str) {
    println!("\n================================================================");
    println!("CAPTURE: {path}");
    println!("================================================================");

    let raw = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) => {
            println!("  ERROR reading file: {e}");
            return;
        }
    };

    let mut project = match RytmProject::try_default() {
        Ok(p) => p,
        Err(e) => {
            println!("  ERROR RytmProject::try_default: {e}");
            return;
        }
    };
    if let Err(e) = project.update_from_sysex_response(&raw) {
        println!("  ERROR decoding sysex: {e}");
        return;
    }

    let pattern = project.work_buffer().pattern();
    let value = match serde_json::to_value(pattern) {
        Ok(v) => v,
        Err(e) => {
            println!("  ERROR serializing pattern: {e}");
            return;
        }
    };

    let pool = &value["parameter_lock_pool"];
    let inner = match pool["inner"].as_array() {
        Some(a) => a,
        None => {
            println!("  ERROR: parameter_lock_pool.inner missing");
            return;
        }
    };

    println!(
        "  pool owner_pattern_index={} is_work_buffer={} slot_count={}",
        pool["owner_pattern_index"],
        pool["is_owner_pattern_work_buffer"],
        inner.len()
    );

    let mut used = 0usize;
    let mut companions = 0usize;
    for (i, slot) in inner.iter().enumerate() {
        let track_nr = slot["track_nr"].as_u64().unwrap_or(0xFF) as u8;
        let plock_type = slot["plock_type"].as_u64().unwrap_or(0xFF) as u8;
        if track_nr == 0xFF && plock_type == 0xFF {
            continue; // unused slot
        }
        used += 1;
        let is_companion =
            track_nr == COMPOUND_COMPANION_TRACK && plock_type == COMPOUND_COMPANION_TYPE;
        if is_companion {
            companions += 1;
        }

        let data = slot["data"].as_array().cloned().unwrap_or_default();
        // Columns (trigs) whose byte differs from the 0xFF unset sentinel.
        let mut cols: Vec<String> = Vec::new();
        for (step, byte) in data.iter().enumerate() {
            let b = byte.as_u64().unwrap_or(0xFF) as u8;
            if b != 0xFF {
                cols.push(format!("s{step}=0x{b:02X}({b})"));
            }
        }

        println!(
            "  [slot {i:2}] track_nr={:>3} ({:<11}) type=0x{:02X} {:<28} | set_cols={} ",
            track_nr,
            track_name(track_nr),
            plock_type,
            plock_type_name(plock_type),
            cols.len()
        );
        if !cols.is_empty() {
            // Wrap the per-column list for readability.
            for chunk in cols.chunks(8) {
                println!("             {}", chunk.join("  "));
            }
        }
    }

    println!(
        "  --- {used} used slots ({companions} compound-companion LSB slots, track_nr=128/type=128) ---"
    );

    // Layout report for the historically-compound types (0x28 LFO_DEPTH,
    // 0x0C SMP_START, 0x0D SMP_END). pattern.h defines all three as BASIC
    // single-byte locks; the patched rytm-rs fork writes them that way (no
    // companion). A trailing track_nr=128/type=128 companion at i+1 marks a
    // slot written by the legacy two-slot compound path.
    for (i, slot) in inner.iter().enumerate() {
        let track_nr = slot["track_nr"].as_u64().unwrap_or(0xFF) as u8;
        let plock_type = slot["plock_type"].as_u64().unwrap_or(0xFF) as u8;
        if track_nr <= 12 && matches!(plock_type, 0x0C | 0x0D | 0x28) {
            let next_is_companion = inner
                .get(i + 1)
                .map(|n| {
                    n["track_nr"].as_u64() == Some(COMPOUND_COMPANION_TRACK as u64)
                        && n["plock_type"].as_u64() == Some(COMPOUND_COMPANION_TYPE as u64)
                })
                .unwrap_or(false);
            let layout = if next_is_companion {
                "LEGACY compound (companion LSB at i+1)"
            } else {
                "basic single-byte (per pattern.h)"
            };
            println!(
                "  layout: slot {i} (track {} type 0x{plock_type:02X} {}) -> {layout}",
                track_name(track_nr),
                plock_type_name(plock_type)
            );
        }
    }

    // Orphan companions: a companion whose preceding slot is NOT a compound-typed slot.
    let mut orphan_companions = Vec::new();
    for (i, slot) in inner.iter().enumerate() {
        let track_nr = slot["track_nr"].as_u64().unwrap_or(0xFF) as u8;
        let plock_type = slot["plock_type"].as_u64().unwrap_or(0xFF) as u8;
        if track_nr == COMPOUND_COMPANION_TRACK && plock_type == COMPOUND_COMPANION_TYPE {
            let prev = if i == 0 { None } else { inner.get(i - 1) };
            let prev_is_compound = prev
                .map(|p| {
                    let pt = p["plock_type"].as_u64().unwrap_or(0xFF) as u8;
                    let tn = p["track_nr"].as_u64().unwrap_or(0xFF) as u8;
                    tn <= 12 && matches!(pt, 0x0C | 0x0D | 0x28)
                })
                .unwrap_or(false);
            if !prev_is_compound {
                orphan_companions.push(i);
            }
        }
    }
    if !orphan_companions.is_empty() {
        println!(
            "  ORPHAN companions (LSB slot not preceded by a compound MSB slot) at pool indices: {orphan_companions:?}"
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: plock_dump <work-buffer-pattern.syx> [more.syx ...]");
        std::process::exit(2);
    }
    for path in &args {
        dump_capture(path);
    }
}
