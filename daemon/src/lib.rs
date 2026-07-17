pub mod audio;
pub mod hardware;
pub mod hardware_control;
pub mod hardware_scheduler;
pub mod overbridge;
pub mod rpc;
pub mod samples;
pub mod state;

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum AdapterMode {
    #[serde(rename = "mock")]
    Mock,
    #[serde(rename = "coremidi")]
    CoreMidi,
    #[serde(rename = "rytm-rs")]
    RytmRs,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Compatibility {
    Mock,
    Verified,
    Unverified,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareCompatibility {
    pub adapter: AdapterMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_target_firmware: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_firmware: Option<String>,
    pub compatibility: Compatibility,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFlags {
    pub realtime_midi: bool,
    pub sysex_state: bool,
    pub pattern_edit: bool,
    pub kit_edit: bool,
    pub machine_edit: bool,
    pub sample_slot_assignment: bool,
    pub sample_transfer: bool,
    pub scene_macros: bool,
    pub performance_macros: bool,
    pub songs: bool,
    pub class_compliant_audio: bool,
    pub overbridge_audio: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFirmwareEvidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_target_firmware: Option<&'static str>,
    pub hardware_verified_firmware: Vec<&'static str>,
    pub certifications: Vec<&'static str>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRisk {
    pub level: &'static str,
    pub rollback: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityEvidence {
    pub status: &'static str,
    pub readable: bool,
    pub writable: bool,
    pub verified: bool,
    pub transport: Vec<&'static str>,
    pub firmware_evidence: CapabilityFirmwareEvidence,
    pub risk: CapabilityRisk,
    pub notes: Vec<&'static str>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonDescription {
    pub schema: &'static str,
    pub model: &'static str,
    pub firmware: FirmwareCompatibility,
    pub capabilities: CapabilityFlags,
    pub capability_evidence: BTreeMap<&'static str, CapabilityEvidence>,
}

pub fn mock_description() -> DaemonDescription {
    DaemonDescription {
        schema: "analog-rytm-daemon.v1",
        model: "Analog Rytm MKII",
        firmware: FirmwareCompatibility {
            adapter: AdapterMode::Mock,
            adapter_target_firmware: None,
            observed_firmware: None,
            compatibility: Compatibility::Mock,
            notes: vec!["Mock daemon. No MIDI or SysEx transport is open.".to_string()],
        },
        capabilities: CapabilityFlags {
            realtime_midi: true,
            sysex_state: true,
            pattern_edit: true,
            kit_edit: true,
            machine_edit: true,
            sample_slot_assignment: true,
            sample_transfer: true,
            scene_macros: true,
            performance_macros: true,
            songs: true,
            class_compliant_audio: true,
            overbridge_audio: false,
        },
        capability_evidence: mock_capability_evidence(),
    }
}

pub fn hardware_description() -> DaemonDescription {
    DaemonDescription {
        schema: "analog-rytm-daemon.v1",
        model: "Analog Rytm MKII",
        firmware: FirmwareCompatibility {
            adapter: AdapterMode::RytmRs,
            adapter_target_firmware: Some("1.70".to_string()),
            observed_firmware: None,
            compatibility: Compatibility::Unverified,
            notes: vec![
                "rytm-rs 0.1.3 targets firmware 1.70; connected-device decoding must be verified independently.".to_string(),
            ],
        },
        capabilities: CapabilityFlags {
            realtime_midi: true,
            sysex_state: true,
            pattern_edit: true,
            kit_edit: true,
            machine_edit: true,
            sample_slot_assignment: true,
            sample_transfer: true,
            scene_macros: true,
            performance_macros: true,
            songs: true,
            class_compliant_audio: true,
            overbridge_audio: false,
        },
        capability_evidence: hardware_capability_evidence(false),
    }
}

fn mock_capability_evidence() -> BTreeMap<&'static str, CapabilityEvidence> {
    let mut evidence = hardware_capability_evidence(false);
    for item in evidence.values_mut() {
        item.verified = false;
        item.firmware_evidence.adapter_target_firmware = None;
        item.firmware_evidence.hardware_verified_firmware.clear();
        item.firmware_evidence.certifications = vec!["test/rust-daemon-client.test.ts"];
        item.notes
            .push("Mock behavior only; no connected hardware was exercised.");
    }
    evidence
}

fn hardware_capability_evidence(
    overbridge_verified: bool,
) -> BTreeMap<&'static str, CapabilityEvidence> {
    let mut evidence = BTreeMap::new();
    evidence.insert(
        "realtimeTransportAndPattern",
        capability(
            "supported",
            true,
            true,
            true,
            &["CoreMIDI transport, clock, and program change"],
            &["docs/HARDWARE_VALIDATION_2026-07-16.md"],
            "low",
            "Transient commands; shutdown sends Stop and All Notes Off.",
            &["Pattern selection is readable through the work-buffer Pattern."],
        ),
    );
    evidence.insert(
        "realtimeVoiceControl",
        capability(
            "partial",
            false,
            true,
            true,
            &["CoreMIDI notes, CC, and NRPN"],
            &["docs/HARDWARE_VALIDATION_2026-07-16.md"],
            "low",
            "Transient sends do not mutate the persistent revision.",
            &[
                "Track triggering and track level are certified.",
                "Arbitrary live parameters are send-only unless their owning SysEx object exposes readback.",
            ],
        ),
    );
    evidence.insert(
        "persistentPatternCore",
        capability(
            "supported",
            true,
            true,
            true,
            &["rytm-rs Pattern SysEx"],
            &["docs/HARDWARE_VALIDATION_2026-07-16.md"],
            "medium",
            "Raw Pattern snapshot, semantic readback, and automatic rollback.",
            &[
                "Covers trigs, velocity, microtiming, conditions, retrig enable, parameter locks, track lengths, and Pattern copy.",
            ],
        ),
    );
    evidence.insert(
        "advancedPatternSequencer",
        capability(
            "partial",
            true,
            true,
            true,
            &["rytm-rs Pattern SysEx"],
            &["docs/HARDWARE_VALIDATION_2026-07-16.md"],
            "medium",
            "Owned Pattern fields use raw snapshot rollback.",
            &[
                "Swing, master length, time mode, conditional locks, and polymetric track lengths are certified through demo declarations.",
                "Per-trig note length/rate/velocity curve, sound locks, accent/mute/swing/slide flags, Euclidean fields, pad scales, and per-track speed are not exposed as agent operations.",
            ],
        ),
    );
    evidence.insert(
        "soundAndMachine",
        capability(
            "supported",
            true,
            true,
            true,
            &["rytm-rs Kit and Sound SysEx"],
            &["docs/HARDWARE_VALIDATION_2026-07-16.md"],
            "medium",
            "Raw Kit snapshot, semantic readback, and automatic rollback.",
            &[
                "Covers compatible machines and machine, sample, filter, amp, LFO, and Sound settings pages.",
            ],
        ),
    );
    evidence.insert(
        "soundLibraryAndPool",
        capability(
            "unsupported",
            false,
            false,
            false,
            &["none"],
            &[],
            "low",
            "No command is dispatched.",
            &[
                "+Drive Sound browser/manager, tags, Sound Pool management, and Sound locks are not exposed.",
            ],
        ),
    );
    evidence.insert(
        "kitMixAndFx",
        capability(
            "supported",
            true,
            true,
            true,
            &["rytm-rs Kit SysEx"],
            &["docs/HARDWARE_VALIDATION_2026-07-16.md"],
            "medium",
            "Raw Kit snapshot, semantic readback, and automatic rollback.",
            &[
                "Covers names, track/FX levels, retrig settings, Delay, Reverb, Distortion, Compressor, and FX LFO.",
            ],
        ),
    );
    evidence.insert(
        "kitControlInputs",
        capability(
            "partial",
            true,
            false,
            false,
            &["rytm-rs Kit SysEx inspection"],
            &[],
            "low",
            "No write operation is exposed.",
            &["CONTROL IN 1/2 modulation targets and amounts are decoded but currently inspect-only."],
        ),
    );
    evidence.insert(
        "sceneMacros",
        capability(
            "supported",
            true,
            true,
            true,
            &["rytm-rs Kit SysEx", "CoreMIDI CC/NRPN activation"],
            &["docs/HARDWARE_VALIDATION_2026-07-17_MACROS.md"],
            "medium",
            "Definitions use raw Kit rollback; active Scene is restored explicitly.",
            &["All 12 definitions and voice/FX locks are exposed."],
        ),
    );
    evidence.insert(
        "performanceMacros",
        capability(
            "supported",
            true,
            true,
            true,
            &["rytm-rs Kit SysEx", "CoreMIDI CC/NRPN amount"],
            &["docs/HARDWARE_VALIDATION_2026-07-17_MACROS.md"],
            "medium",
            "Definitions use raw Kit rollback; transient amounts are reset explicitly.",
            &[
                "All 12 definitions are readable and writable.",
                "Live Performance amounts are send-cache state because the Kit dump does not report them.",
            ],
        ),
    );
    evidence.insert(
        "songDefinitions",
        capability(
            "partial",
            true,
            true,
            true,
            &["maintained-fork Song SysEx"],
            &["docs/HARDWARE_VALIDATION_2026-07-17_SONGS.md"],
            "medium",
            "All 17 Song objects are covered by raw snapshot rollback.",
            &[
                "Names, rows, Pattern chains, repeats, and per-position track mutes are supported.",
                "Tempo/length overrides, jumps, loops, labels, explicit end markers, and Song activation are not exposed.",
            ],
        ),
    );
    evidence.insert(
        "songAndChainPlayback",
        capability(
            "unsupported",
            false,
            false,
            false,
            &["none"],
            &[],
            "low",
            "No command is dispatched.",
            &["Song/Chain mode activation, playback cursor, scratch rows, and loop/jump control remain device-UI workflows."],
        ),
    );
    evidence.insert(
        "sampleFilesAndAssignment",
        capability(
            "supported",
            true,
            true,
            true,
            &["pinned Elektroid CLI", "rytm-rs Kit SysEx"],
            &["docs/HARDWARE_VALIDATION_2026-07-17_SAMPLES.md"],
            "high",
            "Sound assignment uses raw Kit rollback; +Drive uploads are retained and RAM cleanup is identity-gated.",
            &["Inspect, upload, canonical download verification, RAM resolve/clear, and track assignment are exposed."],
        ),
    );
    evidence.insert(
        "onDeviceSampling",
        capability(
            "partial",
            true,
            true,
            false,
            &["rytm-rs Settings SysEx"],
            &[],
            "medium",
            "Recorder settings are snapshot-backed; recording actions are not dispatched.",
            &[
                "Recorder source, threshold, monitor, and length settings are exposed.",
                "Arm, record, trim, normalize, save, and direct-sampling actions remain device-UI workflows.",
            ],
        ),
    );
    evidence.insert(
        "globalConfiguration",
        capability(
            "supported",
            true,
            true,
            true,
            &["rytm-rs Global and Settings SysEx"],
            &["docs/HARDWARE_VALIDATION_2026-07-16.md"],
            "medium",
            "Raw Global/Settings snapshot, semantic readback, and automatic rollback.",
            &[
                "Covers routing, USB levels, metronome, MIDI sync/ports/channels, control destinations, sequencer configuration, tempo, mutes, fixed velocity, UI selection, and recorder settings.",
            ],
        ),
    );
    evidence.insert(
        "projectLifecycle",
        capability(
            "unsupported",
            false,
            false,
            false,
            &["none"],
            &[],
            "high",
            "No command is dispatched.",
            &["Project load/save/manage, Kit/Sound library save/load, and whole-project regeneration are not routine agent operations."],
        ),
    );
    evidence.insert(
        "objectSnapshotsAndBackup",
        capability(
            "partial",
            true,
            true,
            true,
            &["CoreMIDI SysEx queries and dumps"],
            &[
                "docs/HARDWARE_VALIDATION_2026-07-16.md",
                "docs/HARDWARE_VALIDATION_2026-07-17_SONGS.md",
            ],
            "medium",
            "Raw baseline objects are restored and re-queried.",
            &["Bridge snapshots cover owned Pattern, Kit, Global, Settings, and Song objects, not a Transfer-compatible full Project archive."],
        ),
    );
    evidence.insert(
        "classCompliantAudio",
        capability(
            "supported",
            true,
            false,
            true,
            &["CoreAudio class-compliant stereo"],
            &["docs/HARDWARE_VALIDATION_2026-07-17_AUDIO.md"],
            "low",
            "Capture is read-only and finalizes files atomically.",
            &["Bounded and start/stop Main stereo WAV capture include state and signal evidence."],
        ),
    );
    evidence.insert(
        "overbridgeMultitrackAudio",
        capability(
            if overbridge_verified { "supported" } else { "implemented-unverified" },
            true,
            false,
            overbridge_verified,
            &["Elektron Overbridge CoreAudio HAL"],
            if overbridge_verified {
                &["docs/HARDWARE_VALIDATION_2026-07-17_OVERBRIDGE.md"]
            } else {
                &[]
            },
            "low",
            "Capture is read-only and finalizes synchronized stems atomically.",
            &[
                "Provider discovery is always available; capture requires manual OVERBRIDGE USB mode and exclusive audio ownership.",
            ],
        ),
    );
    evidence.insert(
        "overbridgePluginAutomation",
        capability(
            "unsupported",
            false,
            false,
            false,
            &["none"],
            &[],
            "low",
            "No plugin host or automation command is dispatched.",
            &["Overbridge is an optional audio provider, not the bridge control API."],
        ),
    );
    evidence.insert(
        "physicalUiModes",
        capability(
            "unsupported",
            false,
            false,
            false,
            &["none"],
            &[],
            "low",
            "No panel-key emulation is attempted.",
            &["Browser, copy/paste gestures, recording modes, mute/chromatic modes, and menu navigation remain human workflows unless represented by a semantic operation above."],
        ),
    );
    evidence.insert(
        "destructiveMaintenance",
        capability(
            "excluded",
            false,
            false,
            false,
            &["none"],
            &[],
            "excluded",
            "No command exists by design.",
            &["OS upgrade, +Drive format, calibration, test mode, empty reset, and factory reset are excluded from agent tools."],
        ),
    );
    evidence
}

#[allow(clippy::too_many_arguments)]
fn capability(
    status: &'static str,
    readable: bool,
    writable: bool,
    verified: bool,
    transport: &[&'static str],
    certifications: &[&'static str],
    risk_level: &'static str,
    rollback: &'static str,
    notes: &[&'static str],
) -> CapabilityEvidence {
    CapabilityEvidence {
        status,
        readable,
        writable,
        verified,
        transport: transport.to_vec(),
        firmware_evidence: CapabilityFirmwareEvidence {
            adapter_target_firmware: Some("1.70"),
            hardware_verified_firmware: if verified { vec!["1.72"] } else { Vec::new() },
            certifications: certifications.to_vec(),
        },
        risk: CapabilityRisk {
            level: risk_level,
            rollback,
        },
        notes: notes.to_vec(),
    }
}

pub fn describe_as_json(description: &DaemonDescription) -> String {
    serde_json::to_string(description).expect("daemon description is serializable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_description_advertises_verified_sample_workflows() {
        let description = mock_description();
        assert!(description.capabilities.realtime_midi);
        assert!(description.capabilities.pattern_edit);
        assert!(description.capabilities.sample_transfer);
        assert!(description.capabilities.performance_macros);
        assert_eq!(description.firmware.compatibility, Compatibility::Mock);
    }

    #[test]
    fn json_description_contains_schema_and_flags() {
        let json = describe_as_json(&mock_description());
        assert!(json.contains("\"schema\":\"analog-rytm-daemon.v1\""));
        assert!(json.contains("\"sampleTransfer\":true"));
        assert!(json.contains("\"adapter\":\"mock\""));
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value["capabilityEvidence"]["persistentPatternCore"]["verified"],
            false
        );
        assert_eq!(
            value["capabilityEvidence"]["destructiveMaintenance"]["status"],
            "excluded"
        );
    }

    #[test]
    fn hardware_description_advertises_certified_macro_and_song_workflows() {
        let description = hardware_description();
        assert!(description.capabilities.scene_macros);
        assert!(description.capabilities.performance_macros);
        assert!(description.capabilities.songs);
        assert!(description.capability_evidence["songDefinitions"].verified);
        assert!(!description.capability_evidence["overbridgeMultitrackAudio"].verified);
        assert_eq!(
            description.firmware.compatibility,
            Compatibility::Unverified
        );
    }
}
