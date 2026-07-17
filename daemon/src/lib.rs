pub mod audio;
pub mod hardware;
pub mod hardware_control;
pub mod hardware_scheduler;
pub mod rpc;
pub mod state;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterMode {
    Mock,
    CoreMidi,
    RytmRs,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Compatibility {
    Mock,
    Verified,
    Unverified,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FirmwareCompatibility {
    pub adapter: AdapterMode,
    pub adapter_target_firmware: Option<String>,
    pub observed_firmware: Option<String>,
    pub compatibility: Compatibility,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaemonDescription {
    pub schema: &'static str,
    pub model: &'static str,
    pub firmware: FirmwareCompatibility,
    pub capabilities: CapabilityFlags,
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
            sample_slot_assignment: false,
            sample_transfer: false,
            scene_macros: false,
            performance_macros: false,
            songs: false,
            class_compliant_audio: true,
            overbridge_audio: false,
        },
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
            sample_slot_assignment: false,
            sample_transfer: false,
            scene_macros: false,
            performance_macros: false,
            songs: false,
            class_compliant_audio: true,
            overbridge_audio: false,
        },
    }
}

pub fn describe_as_json(description: &DaemonDescription) -> String {
    format!(
        concat!(
            "{{",
            "\"schema\":\"{}\",",
            "\"model\":\"{}\",",
            "\"firmware\":{{\"adapter\":\"{}\",\"compatibility\":\"{}\",\"notes\":[{}]}},",
            "\"capabilities\":{{",
            "\"realtimeMidi\":{},",
            "\"sysExState\":{},",
            "\"patternEdit\":{},",
            "\"kitEdit\":{},",
            "\"machineEdit\":{},",
            "\"sampleSlotAssignment\":{},",
            "\"sampleTransfer\":{},",
            "\"sceneMacros\":{},",
            "\"performanceMacros\":{},",
            "\"songs\":{},",
            "\"classCompliantAudio\":{},",
            "\"overbridgeAudio\":{}",
            "}}",
            "}}"
        ),
        description.schema,
        description.model,
        adapter_mode_name(&description.firmware.adapter),
        compatibility_name(&description.firmware.compatibility),
        description
            .firmware
            .notes
            .iter()
            .map(|note| format!("\"{}\"", escape_json(note)))
            .collect::<Vec<_>>()
            .join(","),
        description.capabilities.realtime_midi,
        description.capabilities.sysex_state,
        description.capabilities.pattern_edit,
        description.capabilities.kit_edit,
        description.capabilities.machine_edit,
        description.capabilities.sample_slot_assignment,
        description.capabilities.sample_transfer,
        description.capabilities.scene_macros,
        description.capabilities.performance_macros,
        description.capabilities.songs,
        description.capabilities.class_compliant_audio,
        description.capabilities.overbridge_audio,
    )
}

fn adapter_mode_name(mode: &AdapterMode) -> &'static str {
    match mode {
        AdapterMode::Mock => "mock",
        AdapterMode::CoreMidi => "coremidi",
        AdapterMode::RytmRs => "rytm-rs",
    }
}

fn compatibility_name(compatibility: &Compatibility) -> &'static str {
    match compatibility {
        Compatibility::Mock => "mock",
        Compatibility::Verified => "verified",
        Compatibility::Unverified => "unverified",
        Compatibility::Unsupported => "unsupported",
    }
}

fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_description_keeps_incomplete_features_disabled() {
        let description = mock_description();
        assert!(description.capabilities.realtime_midi);
        assert!(description.capabilities.pattern_edit);
        assert!(!description.capabilities.sample_transfer);
        assert!(!description.capabilities.performance_macros);
        assert_eq!(description.firmware.compatibility, Compatibility::Mock);
    }

    #[test]
    fn json_description_contains_schema_and_flags() {
        let json = describe_as_json(&mock_description());
        assert!(json.contains("\"schema\":\"analog-rytm-daemon.v1\""));
        assert!(json.contains("\"sampleTransfer\":false"));
        assert!(json.contains("\"adapter\":\"mock\""));
    }
}
