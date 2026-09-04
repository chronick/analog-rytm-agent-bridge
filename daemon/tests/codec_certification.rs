//! Regression cover for the committed hardware-certification receipts.
//!
//! The receipts under `tests/fixtures/rytm-rs-certification/` are the bridge's
//! evidence that the maintained `rytm-rs` fork's typed Scene, Performance, and
//! Song codecs match what an Analog Rytm MKII actually stored. These tests
//! re-derive that evidence offline: the rollback dumps must still be byte-equal
//! to their baselines, and the committed dumps must still decode through the
//! currently pinned fork to the values the receipts recorded.
//!
//! Regenerate the fixtures with the `certify_macro_codecs` / `certify_song_codec`
//! examples; see `docs/CODEC_CERTIFICATION.md`.

use rytm_rs::prelude::*;
use serde_json::Value;
use std::{fs, path::PathBuf};

const FIXTURE_DIRECTORY: &str = "tests/fixtures/rytm-rs-certification/mkii-connected-2026-07-17";

#[test]
fn macro_certification_rollback_restored_the_exact_baseline() {
    assert_eq!(
        fixture("macros-restored-kit.syx"),
        fixture("macros-baseline-kit.syx"),
        "macro certification rollback did not restore the captured baseline Kit"
    );
}

#[test]
fn song_certification_rollback_restored_the_exact_baseline() {
    assert_eq!(
        fixture("song-certification-restored.syx"),
        fixture("song-certification-baseline.syx"),
        "Song certification rollback did not restore the captured baseline Song"
    );
}

#[test]
fn macro_certification_receipt_records_a_verified_run() {
    let report = receipt("macros-certification.json");
    assert_eq!(report["schema"], "rytm-rs-macro-certification.v1");
    assert_eq!(report["status"], "write-readback-rollback-verified");
    assert_eq!(report["observedFirmware"], "1.72");
    assert_eq!(report["baselineFingerprint"], report["restoredFingerprint"]);
    assert_ne!(report["baselineFingerprint"], report["definedFingerprint"]);
}

#[test]
fn song_certification_receipt_records_a_verified_run() {
    let report = receipt("song-certification.json");
    assert_eq!(report["schema"], "rytm-rs-song-certification.v1");
    assert_eq!(report["status"], "write-readback-rollback-verified");
    assert_eq!(report["observedFirmware"], "1.72");
    assert_eq!(report["baselineFingerprint"], report["restoredFingerprint"]);
    assert_ne!(report["baselineFingerprint"], report["definedFingerprint"]);
}

#[test]
fn defined_kit_decodes_to_the_scene_and_performance_locks_in_the_receipt() {
    let bytes = fixture("macros-defined-kit.syx");
    let raw = RawSysexObject::from_sysex(&bytes).unwrap();
    assert_eq!(raw.metadata().object_type().unwrap(), SysexType::Kit);

    let mut project = RytmProject::try_default().unwrap();
    project.update_from_sysex_response(&bytes).unwrap();
    let kit = project.work_buffer().kit();

    // Writing definitions must never activate a Scene: the device stayed on the
    // 0xFF inactive-Scene sentinel across the whole certification run.
    assert_eq!(kit.current_scene_id(), None);
    assert_eq!(kit.current_scene_id_raw(), 0xFF);

    let scene_zero = kit.scene_definitions().definition(0).unwrap();
    assert_eq!(scene_zero.locks().len(), 1);
    assert_eq!(
        scene_lock_tuple(scene_zero.locks()[0]),
        (MacroTrack::Voice(0), 8, 65)
    );
    let scene_one = kit.scene_definitions().definition(1).unwrap();
    assert_eq!(
        scene_one
            .locks()
            .iter()
            .copied()
            .map(scene_lock_tuple)
            .collect::<Vec<_>>(),
        [(MacroTrack::Voice(1), 20, 96), (MacroTrack::Fx, 3, 80)]
    );

    let performance_zero = kit.performance_definitions().definition(0).unwrap();
    assert_eq!(performance_zero.locks().len(), 1);
    assert_eq!(
        performance_lock_tuple(performance_zero.locks()[0]),
        (MacroTrack::Voice(0), 8, 12)
    );
    let performance_one = kit.performance_definitions().definition(1).unwrap();
    assert_eq!(
        performance_one
            .locks()
            .iter()
            .copied()
            .map(performance_lock_tuple)
            .collect::<Vec<_>>(),
        [(MacroTrack::Voice(1), 30, -32), (MacroTrack::Fx, 11, 24)]
    );

    assert_eq!(kit.as_sysex().unwrap(), bytes);

    // The receipt is a claim about this dump; hold the two to each other so a
    // codec change cannot quietly drift away from the recorded readback.
    let report = receipt("macros-certification.json");
    for (id, definition) in [(0_usize, scene_zero), (1, scene_one)] {
        let recorded = &report["scenes"][id];
        assert_eq!(recorded["id"], id);
        assert_eq!(
            recorded["locks"].as_array().unwrap().len(),
            definition.locks().len()
        );
        for (index, lock) in definition.locks().iter().enumerate() {
            let recorded = &recorded["locks"][index];
            assert_eq!(recorded["track"], lock.track().raw_id());
            assert_eq!(recorded["rawParameterId"], lock.parameter().raw_id());
            assert_eq!(recorded["value"], lock.value());
        }
    }
    for (id, definition) in [(0_usize, performance_zero), (1, performance_one)] {
        let recorded = &report["performances"][id];
        assert_eq!(recorded["id"], id);
        assert_eq!(
            recorded["locks"].as_array().unwrap().len(),
            definition.locks().len()
        );
        for (index, lock) in definition.locks().iter().enumerate() {
            let recorded = &recorded["locks"][index];
            assert_eq!(recorded["track"], lock.track().raw_id());
            assert_eq!(recorded["rawParameterId"], lock.parameter().raw_id());
            assert_eq!(recorded["depth"], lock.depth());
        }
    }
}

#[test]
fn defined_song_decodes_to_the_rows_in_the_receipt() {
    let defined = fixture("song-certification-defined.syx");
    let song = Song::from_sysex(&defined).unwrap();

    assert_eq!(song.name(), "AGENT SONG");
    let rows = song.rows().unwrap();
    assert_eq!(rows.len(), 2);

    assert_eq!(rows[0].repeats(), 2);
    assert_eq!(rows[0].patterns().len(), 2);
    assert_eq!(rows[0].patterns()[0].pattern(), 0);
    assert_eq!(rows[0].patterns()[0].muted_tracks_mask(), 0);
    assert_eq!(rows[0].patterns()[1].pattern(), 1);
    assert_eq!(rows[0].patterns()[1].muted_tracks_mask(), 1);

    assert_eq!(rows[1].repeats(), 1);
    assert_eq!(rows[1].patterns().len(), 1);
    assert_eq!(rows[1].patterns()[0].pattern(), 16);
    assert_eq!(rows[1].patterns()[0].muted_tracks_mask(), 2);

    assert_eq!(song.as_sysex().unwrap(), defined);

    let report = receipt("song-certification.json");
    assert_eq!(report["name"], "AGENT SONG");
    assert_eq!(report["rows"].as_array().unwrap().len(), rows.len());
    for (index, row) in rows.iter().enumerate() {
        let recorded = &report["rows"][index];
        assert_eq!(recorded["row"], index);
        assert_eq!(recorded["repeats"], row.repeats());
        assert_eq!(
            recorded["patterns"].as_array().unwrap().len(),
            row.patterns().len()
        );
        for (pattern_index, pattern) in row.patterns().iter().enumerate() {
            let recorded = &recorded["patterns"][pattern_index];
            assert_eq!(recorded["index"], pattern.pattern());
            assert_eq!(recorded["mutedTracksMask"], pattern.muted_tracks_mask());
        }
    }
}

fn fixture(file_name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(FIXTURE_DIRECTORY)
        .join(file_name);
    fs::read(&path).unwrap_or_else(|error| panic!("missing fixture {}: {error}", path.display()))
}

fn receipt(file_name: &str) -> Value {
    serde_json::from_slice(&fixture(file_name)).unwrap()
}

fn scene_lock_tuple(lock: SceneLock) -> (MacroTrack, u8, u8) {
    (lock.track(), lock.parameter().raw_id(), lock.value())
}

fn performance_lock_tuple(lock: PerformanceLock) -> (MacroTrack, u8, i8) {
    (lock.track(), lock.parameter().raw_id(), lock.depth())
}
