use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use rytm_rs::{
    object::{global::Global, pattern::Pattern},
    prelude::*,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

pub const DEFAULT_PORT_MATCH: &str = "Elektron Analog Rytm MKII";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(8);
const TRACK_NAMES: [&str; 12] = [
    "BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB",
];

pub type HardwareResult<T> = Result<T, String>;

pub struct RytmMidiSession {
    _input: MidiInputConnection<()>,
    output: MidiOutputConnection,
    receiver: Receiver<Vec<u8>>,
    pub input_name: String,
    pub output_name: String,
}

pub struct StateCapture {
    pub project: RytmProject,
    pub pattern_raw: Vec<u8>,
    pub kit_raw: Vec<u8>,
    pub global_raw: Vec<u8>,
    pub settings_raw: Vec<u8>,
}

impl RytmMidiSession {
    pub fn open(port_match: &str) -> HardwareResult<Self> {
        let mut input = MidiInput::new("analog-rytm-agent-input").map_err(error_string)?;
        input.ignore(Ignore::None);
        let input_port = input
            .ports()
            .into_iter()
            .find(|port| {
                input
                    .port_name(port)
                    .is_ok_and(|name| name.contains(port_match))
            })
            .ok_or_else(|| format!("no MIDI input contains {port_match:?}"))?;
        let input_name = input.port_name(&input_port).map_err(error_string)?;

        let output = MidiOutput::new("analog-rytm-agent-output").map_err(error_string)?;
        let output_port = output
            .ports()
            .into_iter()
            .find(|port| {
                output
                    .port_name(port)
                    .is_ok_and(|name| name.contains(port_match))
            })
            .ok_or_else(|| format!("no MIDI output contains {port_match:?}"))?;
        let output_name = output.port_name(&output_port).map_err(error_string)?;

        let (sender, receiver) = mpsc::channel();
        let input_connection = input
            .connect(
                &input_port,
                "analog-rytm-agent-input",
                move |_stamp, message, _| {
                    let _ = sender.send(message.to_vec());
                },
                (),
            )
            .map_err(error_string)?;
        let output_connection = output
            .connect(&output_port, "analog-rytm-agent-output")
            .map_err(error_string)?;

        Ok(Self {
            _input: input_connection,
            output: output_connection,
            receiver,
            input_name,
            output_name,
        })
    }

    pub fn send(&mut self, message: &[u8]) -> HardwareResult<()> {
        self.output.send(message).map_err(error_string)
    }

    pub fn request(&mut self, request: &[u8]) -> HardwareResult<Vec<u8>> {
        while self.receiver.try_recv().is_ok() {}
        self.send(request)?;
        self.receive_sysex(RESPONSE_TIMEOUT)
    }

    fn receive_sysex(&self, timeout: Duration) -> HardwareResult<Vec<u8>> {
        let deadline = Instant::now() + timeout;
        let mut response = Vec::new();
        let mut receiving = false;

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("timed out waiting for a complete SysEx response".to_string());
            }

            let message = match self.receiver.recv_timeout(remaining) {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => {
                    return Err("timed out waiting for a SysEx response".to_string())
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("MIDI input disconnected while waiting for SysEx".to_string())
                }
            };

            for byte in message {
                if byte >= 0xF8 {
                    continue;
                }
                if !receiving {
                    if byte != 0xF0 {
                        continue;
                    }
                    receiving = true;
                }
                response.push(byte);
                if byte == 0xF7 {
                    return Ok(response);
                }
            }
        }
    }
}

pub fn list_midi_ports() -> HardwareResult<Value> {
    let input = MidiInput::new("analog-rytm-agent-list-input").map_err(error_string)?;
    let output = MidiOutput::new("analog-rytm-agent-list-output").map_err(error_string)?;
    let inputs = input
        .ports()
        .iter()
        .map(|port| input.port_name(port).map_err(error_string))
        .collect::<HardwareResult<Vec<_>>>()?;
    let outputs = output
        .ports()
        .iter()
        .map(|port| output.port_name(port).map_err(error_string))
        .collect::<HardwareResult<Vec<_>>>()?;
    Ok(json!({ "inputs": inputs, "outputs": outputs }))
}

pub fn query_identity(session: &mut RytmMidiSession) -> HardwareResult<Value> {
    let response = session.request(&[0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7])?;
    let manufacturer = if response.len() >= 8 {
        hex_bytes(&response[5..8])
    } else {
        "unknown".to_string()
    };
    Ok(json!({
        "input": session.input_name,
        "output": session.output_name,
        "manufacturerId": manufacturer,
        "response": hex_bytes(&response),
        "responseBytes": response.len()
    }))
}

pub fn read_work_buffer_state(session: &mut RytmMidiSession) -> HardwareResult<StateCapture> {
    let mut project = RytmProject::try_default().map_err(error_string)?;
    let pattern_raw = query_object(session, &PatternQuery::new_targeting_work_buffer())?;
    project
        .update_from_sysex_response(&pattern_raw)
        .map_err(|error| firmware_decode_error("pattern", error))?;
    let kit_raw = query_object(session, &KitQuery::new_targeting_work_buffer())?;
    project
        .update_from_sysex_response(&kit_raw)
        .map_err(|error| firmware_decode_error("kit", error))?;
    let global_raw = query_object(session, &GlobalQuery::new_targeting_work_buffer())?;
    project
        .update_from_sysex_response(&global_raw)
        .map_err(|error| firmware_decode_error("global", error))?;
    let settings_raw = query_object(session, &SettingsQuery::new())?;
    project
        .update_from_sysex_response(&settings_raw)
        .map_err(|error| firmware_decode_error("settings", error))?;

    Ok(StateCapture {
        project,
        pattern_raw,
        kit_raw,
        global_raw,
        settings_raw,
    })
}

pub fn capture_state(session: &mut RytmMidiSession, directory: &Path) -> HardwareResult<Value> {
    let capture = read_work_buffer_state(session)?;
    fs::create_dir_all(directory).map_err(error_string)?;
    write_file(directory, "work-buffer-pattern.syx", &capture.pattern_raw)?;
    write_file(directory, "work-buffer-kit.syx", &capture.kit_raw)?;
    write_file(directory, "work-buffer-global.syx", &capture.global_raw)?;
    write_file(directory, "settings.syx", &capture.settings_raw)?;

    let summary = state_summary(&capture.project);
    write_file(
        directory,
        "state-summary.json",
        &serde_json::to_vec_pretty(&summary).map_err(error_string)?,
    )?;
    Ok(summary)
}

pub fn configure_midi(session: &mut RytmMidiSession, directory: &Path) -> HardwareResult<Value> {
    fs::create_dir_all(directory).map_err(error_string)?;
    let query = GlobalQuery::new_targeting_work_buffer();
    let baseline_raw = query_object(session, &query)?;
    write_file_if_absent(directory, "before-midi-global.syx", &baseline_raw)?;

    let mut project = RytmProject::try_default().map_err(error_string)?;
    project
        .update_from_sysex_response(&baseline_raw)
        .map_err(|error| firmware_decode_error("global", error))?;
    let before = midi_config_summary(project.work_buffer().global());
    let changed = !midi_config_is_desired(project.work_buffer().global());

    if changed {
        apply_desired_midi_config(project.work_buffer_mut().global_mut());
        let write_raw = project
            .work_buffer()
            .global()
            .as_sysex()
            .map_err(error_string)?;
        write_file(directory, "write-midi-global.syx", &write_raw)?;
        session.send(&write_raw)?;
        thread::sleep(Duration::from_millis(250));
    }

    let observed_raw = query_object(session, &query)?;
    write_file(directory, "after-midi-global.syx", &observed_raw)?;
    let observed = decode_work_buffer_global(&observed_raw)?;
    if !midi_config_is_desired(&observed) {
        return Err(format!(
            "Rytm MIDI configuration did not reconcile to the declarative bridge requirements: {}",
            midi_config_summary(&observed)
        ));
    }

    Ok(json!({
        "status": if changed { "applied" } else { "already-converged" },
        "changed": changed,
        "before": before,
        "observed": midi_config_summary(&observed),
        "rollbackBaseline": directory.join("before-midi-global.syx")
    }))
}

pub fn restore_midi_config(
    session: &mut RytmMidiSession,
    directory: &Path,
) -> HardwareResult<Value> {
    let baseline_raw = fs::read(directory.join("before-midi-global.syx")).map_err(error_string)?;
    let expected = decode_work_buffer_global(&baseline_raw)?;
    session.send(&baseline_raw)?;
    thread::sleep(Duration::from_millis(250));
    let observed_raw = query_object(session, &GlobalQuery::new_targeting_work_buffer())?;
    let observed = decode_work_buffer_global(&observed_raw)?;
    if midi_config_summary(&observed) != midi_config_summary(&expected) {
        return Err("MIDI configuration rollback failed readback verification".to_string());
    }
    Ok(json!({
        "status": "restored",
        "observed": midi_config_summary(&observed)
    }))
}

pub fn query_pattern_summary(
    session: &mut RytmMidiSession,
    pattern_index: usize,
) -> HardwareResult<Value> {
    if pattern_index > 127 {
        return Err("pattern index must be between 0 and 127".to_string());
    }
    let raw = query_object(
        session,
        &PatternQuery::new(pattern_index).map_err(error_string)?,
    )?;
    let mut project = RytmProject::try_default().map_err(error_string)?;
    project
        .update_from_sysex_response(&raw)
        .map_err(|error| firmware_decode_error("pattern", error))?;
    Ok(pattern_summary(&project.patterns()[pattern_index]))
}

pub fn validate_realtime_controls(
    session: &mut RytmMidiSession,
    directory: &Path,
) -> HardwareResult<Value> {
    fs::create_dir_all(directory).map_err(error_string)?;
    let capture = read_work_buffer_state(session)?;
    let channels = capture
        .project
        .work_buffer()
        .global()
        .midi_config()
        .channels();
    let track_channels = *channels.track_channels();

    session.send(&[0xFC])?;
    session.send(&[0xFA])?;
    send_clock_ticks(session, 24, capture.project.settings().bpm())?;
    session.send(&[0xFC])?;

    let mut triggered = Vec::new();
    for (track_index, channel) in track_channels.iter().enumerate() {
        let channel = concrete_channel(*channel, &format!("track {}", track_index + 1))?;
        let note = track_index as u8;
        session.send(&[0x90 | channel, note, 32])?;
        thread::sleep(Duration::from_millis(55));
        session.send(&[0x80 | channel, note, 0])?;
        triggered.push(json!({
            "track": TRACK_NAMES[track_index],
            "channel": channel + 1,
            "note": note,
            "velocity": 32
        }));
    }

    let kit_query = KitQuery::new_targeting_work_buffer();
    let baseline_kit_raw = query_object(session, &kit_query)?;
    write_file(directory, "realtime-kit-baseline.syx", &baseline_kit_raw)?;
    let baseline_level = decode_work_buffer_kit_track_level(&baseline_kit_raw, 0)?;
    let test_level = if baseline_level >= 32 {
        baseline_level - 16
    } else {
        baseline_level + 16
    };
    let track_channel = concrete_channel(track_channels[0], "track 1")?;

    send_cc(session, track_channel, 95, test_level as u8)?;
    thread::sleep(Duration::from_millis(250));
    let cc_raw = query_object(session, &kit_query)?;
    let cc_level = decode_work_buffer_kit_track_level(&cc_raw, 0)?;
    if cc_level != test_level {
        restore_kit(session, &kit_query, &baseline_kit_raw, baseline_level)?;
        return Err(format!(
            "CC 95 readback mismatch: expected {test_level}, observed {cc_level}"
        ));
    }
    restore_kit(session, &kit_query, &baseline_kit_raw, baseline_level)?;

    send_nrpn(session, track_channel, 1, 100, test_level as u8)?;
    thread::sleep(Duration::from_millis(250));
    let nrpn_raw = query_object(session, &kit_query)?;
    let nrpn_level = decode_work_buffer_kit_track_level(&nrpn_raw, 0)?;
    if nrpn_level != test_level {
        restore_kit(session, &kit_query, &baseline_kit_raw, baseline_level)?;
        return Err(format!(
            "NRPN 1:100 readback mismatch: expected {test_level}, observed {nrpn_level}"
        ));
    }
    restore_kit(session, &kit_query, &baseline_kit_raw, baseline_level)?;
    let restored_tempo = restore_settings(session, &capture.settings_raw)?;

    Ok(json!({
        "transport": {
            "startSent": true,
            "stopSent": true,
            "clockPpqn": 24,
            "settingsTempoRestored": restored_tempo
        },
        "trackTriggers": triggered,
        "cc": { "parameter": "track_level", "controller": 95, "sent": test_level, "observed": cc_level, "restored": baseline_level },
        "nrpn": { "parameter": "track_level", "number": "1:100", "sent": test_level, "observed": nrpn_level, "restored": baseline_level }
    }))
}

pub fn create_demo_patterns(
    session: &mut RytmMidiSession,
    directory: &Path,
) -> HardwareResult<Value> {
    fs::create_dir_all(directory).map_err(error_string)?;
    let mut results = Vec::new();

    for pattern_index in 0..3 {
        let slot = pattern_slot(pattern_index);
        let query = PatternQuery::new(pattern_index).map_err(error_string)?;
        let baseline_raw = query_object(session, &query)?;
        write_file_if_absent(directory, &format!("before-{slot}.syx"), &baseline_raw)?;

        let mut project = RytmProject::try_default().map_err(error_string)?;
        project
            .update_from_sysex_response(&baseline_raw)
            .map_err(|error| firmware_decode_error("pattern", error))?;
        let pattern = &mut project.patterns_mut()[pattern_index];
        let before = pattern_summary(pattern);
        configure_demo_pattern(pattern, pattern_index)?;
        let expected = pattern_summary(pattern);
        let changed = before != expected;
        let write_raw = pattern.as_sysex().map_err(error_string)?;
        write_file(directory, &format!("write-{slot}.syx"), &write_raw)?;

        if changed {
            session.send(&write_raw)?;
            thread::sleep(Duration::from_millis(450));
        }
        let observed_raw = query_object(session, &query)?;
        write_file(directory, &format!("after-{slot}.syx"), &observed_raw)?;
        let mut observed_project = RytmProject::try_default().map_err(error_string)?;
        observed_project
            .update_from_sysex_response(&observed_raw)
            .map_err(|error| firmware_decode_error("pattern", error))?;
        let observed = pattern_summary(&observed_project.patterns()[pattern_index]);
        if observed != expected {
            return Err(format!(
                "{slot} did not match after write; baselines remain in {}",
                directory.display()
            ));
        }

        results.push(json!({
            "slot": slot,
            "status": if changed { "applied-and-verified" } else { "already-converged" },
            "changed": changed,
            "fingerprint": fingerprint(&observed_raw),
            "summary": observed
        }));
    }

    let summary = json!({
        "captureDirectory": directory,
        "patterns": results,
        "rollbackCommand": format!(
            "cargo run -- restore-patterns --execute {}",
            directory.display()
        )
    });
    write_file(
        directory,
        "pattern-suite-summary.json",
        &serde_json::to_vec_pretty(&summary).map_err(error_string)?,
    )?;
    Ok(summary)
}

pub fn restore_demo_patterns(
    session: &mut RytmMidiSession,
    directory: &Path,
) -> HardwareResult<Value> {
    let mut restored = Vec::new();
    for pattern_index in 0..3 {
        let slot = pattern_slot(pattern_index);
        let baseline_path = directory.join(format!("before-{slot}.syx"));
        let baseline_raw = fs::read(&baseline_path).map_err(error_string)?;
        let baseline_summary = decode_stored_pattern_summary(&baseline_raw, pattern_index)?;
        session.send(&baseline_raw)?;
        thread::sleep(Duration::from_millis(450));
        let observed_raw = query_object(
            session,
            &PatternQuery::new(pattern_index).map_err(error_string)?,
        )?;
        let observed_summary = decode_stored_pattern_summary(&observed_raw, pattern_index)?;
        if observed_summary != baseline_summary {
            return Err(format!("rollback verification failed for {slot}"));
        }
        restored.push(json!({ "slot": slot, "status": "restored" }));
    }
    Ok(json!({ "patterns": restored }))
}

pub fn play_demo_patterns(
    session: &mut RytmMidiSession,
    baseline_directory: &Path,
) -> HardwareResult<Value> {
    let capture = read_work_buffer_state(session)?;
    let baseline_settings_raw =
        fs::read(baseline_directory.join("settings.syx")).map_err(error_string)?;
    let baseline_tempo = decode_settings_tempo(&baseline_settings_raw)?;
    let global = capture.project.work_buffer().global();
    if !global.midi_config().sync().program_change_receive() {
        return Err("PROGRAM CHANGE RECEIVE is disabled in the active Global slot".to_string());
    }
    let channels = global.midi_config().channels();
    let program_channel = match channels.program_change_in_channel() {
        MidiChannel::Channel(channel) => channel as u8,
        MidiChannel::Auto => concrete_channel(channels.auto_channel(), "auto channel")?,
        MidiChannel::Off => return Err("program change input channel is off".to_string()),
    };

    let tempo = baseline_tempo;
    session.send(&[0xFC])?;
    let result = (|| {
        session.send(&[0xC0 | program_channel, 0])?;
        thread::sleep(Duration::from_millis(200));
        session.send(&[0xFA])?;
        let mut observed = Vec::new();
        for pattern_index in 0..3 {
            session.send(&[0xC0 | program_channel, pattern_index as u8])?;
            send_clock_ticks(session, 96, tempo)?;
            let work_buffer_raw =
                query_object(session, &PatternQuery::new_targeting_work_buffer())?;
            let summary = decode_work_buffer_pattern_summary(&work_buffer_raw)?;
            observed.push(json!({
                "requested": pattern_slot(pattern_index),
                "observed": summary["slot"],
            }));
        }
        Ok(json!({
            "programChangeChannel": program_channel + 1,
            "patterns": observed,
            "clock": { "tempo": tempo, "ppqn": 24 },
            "leftStoppedOn": "A01"
        }))
    })();
    let _ = session.send(&[0xFC]);
    let _ = session.send(&[0xC0 | program_channel, 0]);
    let restore_result = restore_settings(session, &baseline_settings_raw);
    match (result, restore_result) {
        (Ok(mut summary), Ok(restored_tempo)) => {
            summary["settingsTempoRestored"] = json!(restored_tempo);
            Ok(summary)
        }
        (Err(error), Ok(_)) => Err(error),
        (Ok(_), Err(restore_error)) => Err(restore_error),
        (Err(error), Err(restore_error)) => Err(format!(
            "{error}; additionally failed to restore Settings: {restore_error}"
        )),
    }
}

pub fn parse_pattern_slot(slot: &str) -> HardwareResult<usize> {
    let normalized = slot.trim().to_ascii_uppercase();
    let bytes = normalized.as_bytes();
    if bytes.len() != 3 || !(b'A'..=b'H').contains(&bytes[0]) {
        return Err("pattern slot must be A01 through H16".to_string());
    }
    let number = normalized[1..]
        .parse::<usize>()
        .map_err(|_| "pattern slot must be A01 through H16".to_string())?;
    if !(1..=16).contains(&number) {
        return Err("pattern slot must be A01 through H16".to_string());
    }
    Ok(((bytes[0] - b'A') as usize * 16) + number - 1)
}

fn query_object(
    session: &mut RytmMidiSession,
    query: &impl SysexCompatible,
) -> HardwareResult<Vec<u8>> {
    session.request(&query.as_sysex().map_err(error_string)?)
}

fn state_summary(project: &RytmProject) -> Value {
    let global = project.work_buffer().global();
    let midi = global.midi_config();
    let channels = midi.channels();
    let track_channels = channels
        .track_channels()
        .iter()
        .map(|channel| format_midi_channel(*channel))
        .collect::<Vec<_>>();
    json!({
        "compatibility": {
            "adapter": "rytm-rs 0.1.3",
            "adapterTargetFirmware": "1.70",
            "observedFirmware": null,
            "status": "decoded-unverified",
            "notes": ["All queried work-buffer object sizes decoded successfully; the device did not expose its OS version through Universal Device Inquiry."]
        },
        "pattern": pattern_summary(project.work_buffer().pattern()),
        "kit": {
            "index": project.work_buffer().kit().index(),
            "name": project.work_buffer().kit().name().trim_end_matches('\0'),
            "structureVersion": project.work_buffer().kit().structure_version(),
            "trackLevels": project.work_buffer().kit().track_levels()
        },
        "settings": {
            "structureVersion": project.settings().structure_version(),
            "tempo": project.settings().bpm(),
            "selectedTrack": TRACK_NAMES[project.settings().selected_track()],
            "mutedTracks": project.settings().muted_sound_indexes()
                .into_iter()
                .filter_map(|index| TRACK_NAMES.get(index).copied())
                .collect::<Vec<_>>()
        },
        "midi": {
            "clockReceive": midi.sync().clock_receive(),
            "clockSend": midi.sync().clock_send(),
            "transportReceive": midi.sync().transport_receive(),
            "transportSend": midi.sync().transport_send(),
            "programChangeReceive": midi.sync().program_change_receive(),
            "programChangeSend": midi.sync().program_change_send(),
            "receiveNotes": midi.port_config().receive_notes(),
            "receiveCcNrpn": midi.port_config().receive_cc_nrpn(),
            "inputTransport": format!("{:?}", midi.port_config().input_transport()),
            "outputTransport": format!("{:?}", midi.port_config().output_transport()),
            "autoChannel": format_midi_channel(channels.auto_channel()),
            "programChangeInChannel": format_midi_channel(channels.program_change_in_channel()),
            "trackChannels": track_channels
        }
    })
}

fn pattern_summary(pattern: &Pattern) -> Value {
    let tracks = pattern
        .tracks()
        .iter()
        .enumerate()
        .map(|(track_index, track)| {
            let trigs = track
                .trigs()
                .iter()
                .filter(|trig| trig.enabled_trig())
                .map(|trig| {
                    let condition: &str = trig.trig_condition().into();
                    let filter_cutoff_lock = if trig.enabled_parameter_lock_env() {
                        trig.plock_get_filter_cutoff().ok().flatten()
                    } else {
                        None
                    };
                    json!({
                        "step": trig.index(),
                        "velocity": trig.velocity(),
                        "microTiming": normalized_micro_timing(trig),
                        "condition": condition,
                        "filterCutoffLock": filter_cutoff_lock
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "track": TRACK_NAMES[track_index],
                "length": track.number_of_steps(),
                "trigs": trigs
            })
        })
        .collect::<Vec<_>>();
    json!({
        "index": pattern.index(),
        "slot": pattern_slot(pattern.index()),
        "structureVersion": pattern.structure_version(),
        "kitNumber": pattern.kit_number(),
        "timeMode": format!("{:?}", pattern.time_mode()),
        "masterLength": pattern.master_length(),
        "masterChange": pattern.master_change(),
        "swing": pattern.swing_amount(),
        "tempo": pattern.bpm(),
        "tracks": tracks
    })
}

fn configure_demo_pattern(pattern: &mut Pattern, variant: usize) -> HardwareResult<()> {
    pattern
        .set_swing_amount(match variant {
            0 => 54,
            1 => 58,
            _ => 52,
        })
        .map_err(error_string)?;
    pattern.set_time_mode(if variant == 2 {
        TimeMode::Advanced
    } else {
        TimeMode::Normal
    });
    pattern
        .set_master_length(if variant == 2 { 64 } else { 16 })
        .map_err(error_string)?;

    for (track_index, track) in pattern.tracks_mut().iter_mut().enumerate() {
        track.clear_all_plocks();
        let length = if variant == 2 && track_index == 8 {
            15
        } else if variant == 2 && track_index == 10 {
            12
        } else {
            16
        };
        track.set_number_of_steps(length).map_err(error_string)?;
        for trig in track.trigs_mut() {
            trig.set_trig_enable(false);
            trig.set_retrig(false);
            trig.set_mute(false);
            trig.set_accent(false);
            trig.set_slide(false);
            trig.set_parameter_lock_lfo_switch(false);
            trig.set_parameter_lock_lfo(false);
            trig.set_parameter_lock_synth_switch(false);
            trig.set_parameter_lock_synth(false);
            trig.set_parameter_lock_sample_switch(false);
            trig.set_parameter_lock_sample(false);
            trig.set_parameter_lock_env_switch(false);
            trig.set_parameter_lock_env(false);
            trig.set_trig_condition(TrigCondition::Unset);
            trig.set_micro_timing_by_value(0).map_err(error_string)?;
        }
    }

    match variant {
        0 => {
            set_steps(pattern, 0, &[(0, 108), (4, 100), (8, 112), (12, 104)])?;
            set_steps(pattern, 1, &[(4, 104), (12, 110)])?;
            set_steps(
                pattern,
                8,
                &[
                    (0, 74),
                    (2, 62),
                    (4, 72),
                    (6, 64),
                    (8, 76),
                    (10, 62),
                    (12, 72),
                    (14, 66),
                ],
            )?;
            set_steps(pattern, 9, &[(6, 72), (14, 80)])?;
            set_filter_cutoff_lock(pattern, 0, 12, 92)?;
        }
        1 => {
            set_steps(
                pattern,
                0,
                &[(0, 108), (3, 84), (7, 98), (10, 88), (14, 102)],
            )?;
            set_steps(pattern, 1, &[(4, 106), (12, 112)])?;
            set_steps(pattern, 3, &[(11, 76)])?;
            set_steps(
                pattern,
                8,
                &[
                    (0, 68),
                    (2, 60),
                    (4, 72),
                    (6, 58),
                    (8, 70),
                    (10, 62),
                    (12, 76),
                    (14, 64),
                ],
            )?;
            set_steps(pattern, 9, &[(6, 68), (14, 76)])?;
            for step in [2, 6, 10, 14] {
                pattern.tracks_mut()[8].trigs_mut()[step]
                    .set_micro_timing_by_value(2)
                    .map_err(error_string)?;
            }
            pattern.tracks_mut()[9].trigs_mut()[14].set_trig_condition(TrigCondition::P50);
            set_filter_cutoff_lock(pattern, 0, 7, 72)?;
        }
        2 => {
            set_steps(pattern, 0, &[(0, 108), (5, 86), (9, 98), (12, 104)])?;
            set_steps(pattern, 1, &[(4, 106), (12, 112)])?;
            set_steps(pattern, 5, &[(2, 74), (10, 82)])?;
            set_steps(pattern, 8, &[(0, 68), (3, 64), (6, 72), (9, 62), (12, 76)])?;
            set_steps(pattern, 10, &[(0, 70), (7, 66)])?;
            pattern.tracks_mut()[1].trigs_mut()[12]
                .set_micro_timing_by_value(-2)
                .map_err(error_string)?;
            pattern.tracks_mut()[10].trigs_mut()[7].set_trig_condition(TrigCondition::_1B2);
            for (step, cutoff) in [(0, 110), (5, 84), (9, 68), (12, 96)] {
                set_filter_cutoff_lock(pattern, 0, step, cutoff)?;
            }
        }
        _ => return Err("unknown demo pattern variant".to_string()),
    }
    Ok(())
}

fn set_filter_cutoff_lock(
    pattern: &mut Pattern,
    track_index: usize,
    step: usize,
    cutoff: usize,
) -> HardwareResult<()> {
    let trig = &mut pattern.tracks_mut()[track_index].trigs_mut()[step];
    trig.set_parameter_lock_env(true);
    trig.plock_set_filter_cutoff(cutoff).map_err(error_string)
}

fn normalized_micro_timing(trig: &rytm_rs::object::pattern::Trig) -> isize {
    trig.micro_timing() as isize - MicroTime::OnGrid as isize
}

fn apply_desired_midi_config(global: &mut Global) {
    let midi = global.midi_config_mut();
    midi.sync_mut().set_transport_receive(true);
    midi.sync_mut().set_program_change_receive(true);
    midi.port_config_mut().set_receive_notes(true);
    midi.port_config_mut().set_receive_cc_nrpn(true);
}

fn midi_config_is_desired(global: &Global) -> bool {
    let midi = global.midi_config();
    midi.sync().transport_receive()
        && midi.sync().program_change_receive()
        && midi.port_config().receive_notes()
        && midi.port_config().receive_cc_nrpn()
}

fn midi_config_summary(global: &Global) -> Value {
    let midi = global.midi_config();
    json!({
        "transportReceive": midi.sync().transport_receive(),
        "programChangeReceive": midi.sync().program_change_receive(),
        "receiveNotes": midi.port_config().receive_notes(),
        "receiveCcNrpn": midi.port_config().receive_cc_nrpn(),
        "inputTransport": format!("{:?}", midi.port_config().input_transport())
    })
}

fn set_steps(
    pattern: &mut Pattern,
    track_index: usize,
    steps: &[(usize, usize)],
) -> HardwareResult<()> {
    for (step, velocity) in steps {
        let trig = &mut pattern.tracks_mut()[track_index].trigs_mut()[*step];
        trig.set_trig_enable(true);
        trig.set_velocity(*velocity).map_err(error_string)?;
    }
    Ok(())
}

fn restore_kit(
    session: &mut RytmMidiSession,
    query: &KitQuery,
    baseline_raw: &[u8],
    baseline_level: usize,
) -> HardwareResult<()> {
    session.send(baseline_raw)?;
    thread::sleep(Duration::from_millis(250));
    let restored_raw = query_object(session, query)?;
    let restored_level = decode_work_buffer_kit_track_level(&restored_raw, 0)?;
    if restored_level != baseline_level {
        return Err(format!(
            "failed to restore track level: expected {baseline_level}, observed {restored_level}"
        ));
    }
    Ok(())
}

fn send_cc(
    session: &mut RytmMidiSession,
    channel: u8,
    controller: u8,
    value: u8,
) -> HardwareResult<()> {
    session.send(&[0xB0 | channel, controller, value])
}

fn send_nrpn(
    session: &mut RytmMidiSession,
    channel: u8,
    parameter_msb: u8,
    parameter_lsb: u8,
    value: u8,
) -> HardwareResult<()> {
    send_cc(session, channel, 99, parameter_msb)?;
    send_cc(session, channel, 98, parameter_lsb)?;
    send_cc(session, channel, 6, value)?;
    send_cc(session, channel, 38, 0)?;
    send_cc(session, channel, 99, 127)?;
    send_cc(session, channel, 98, 127)
}

fn decode_work_buffer_kit_track_level(raw: &[u8], track_index: usize) -> HardwareResult<usize> {
    let mut project = RytmProject::try_default().map_err(error_string)?;
    project
        .update_from_sysex_response(raw)
        .map_err(|error| firmware_decode_error("kit", error))?;
    project
        .work_buffer()
        .kit()
        .track_level(track_index)
        .map_err(error_string)
}

fn decode_stored_pattern_summary(raw: &[u8], pattern_index: usize) -> HardwareResult<Value> {
    let mut project = RytmProject::try_default().map_err(error_string)?;
    project
        .update_from_sysex_response(raw)
        .map_err(|error| firmware_decode_error("pattern", error))?;
    Ok(pattern_summary(&project.patterns()[pattern_index]))
}

fn decode_work_buffer_pattern_summary(raw: &[u8]) -> HardwareResult<Value> {
    let mut project = RytmProject::try_default().map_err(error_string)?;
    project
        .update_from_sysex_response(raw)
        .map_err(|error| firmware_decode_error("pattern", error))?;
    Ok(pattern_summary(project.work_buffer().pattern()))
}

fn decode_work_buffer_global(raw: &[u8]) -> HardwareResult<Global> {
    let mut project = RytmProject::try_default().map_err(error_string)?;
    project
        .update_from_sysex_response(raw)
        .map_err(|error| firmware_decode_error("global", error))?;
    Ok(*project.work_buffer().global())
}

fn decode_settings_tempo(raw: &[u8]) -> HardwareResult<f32> {
    let mut project = RytmProject::try_default().map_err(error_string)?;
    project
        .update_from_sysex_response(raw)
        .map_err(|error| firmware_decode_error("settings", error))?;
    Ok(project.settings().bpm())
}

fn restore_settings(session: &mut RytmMidiSession, baseline_raw: &[u8]) -> HardwareResult<f32> {
    let expected_tempo = decode_settings_tempo(baseline_raw)?;
    session.send(baseline_raw)?;
    thread::sleep(Duration::from_millis(250));
    let observed_raw = query_object(session, &SettingsQuery::new())?;
    let observed_tempo = decode_settings_tempo(&observed_raw)?;
    if (observed_tempo - expected_tempo).abs() > 0.01 {
        return Err(format!(
            "failed to restore Settings tempo: expected {expected_tempo}, observed {observed_tempo}"
        ));
    }
    Ok(observed_tempo)
}

fn send_clock_ticks(
    session: &mut RytmMidiSession,
    tick_count: usize,
    tempo: f32,
) -> HardwareResult<()> {
    if !(30.0..=300.0).contains(&tempo) {
        return Err(format!("refusing invalid clock tempo {tempo}"));
    }
    let interval = Duration::from_secs_f64(60.0 / (f64::from(tempo) * 24.0));
    let started_at = Instant::now();
    for tick in 0..tick_count {
        session.send(&[0xF8])?;
        let deadline =
            started_at + Duration::from_secs_f64(interval.as_secs_f64() * (tick + 1) as f64);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            thread::sleep(remaining);
        }
    }
    Ok(())
}

fn concrete_channel(channel: MidiChannel, label: &str) -> HardwareResult<u8> {
    match channel {
        MidiChannel::Channel(channel) if channel <= 15 => Ok(channel as u8),
        MidiChannel::Channel(channel) => {
            Err(format!("{label} uses invalid MIDI channel {channel}"))
        }
        MidiChannel::Auto => Err(format!("{label} unexpectedly resolves to AUTO")),
        MidiChannel::Off => Err(format!("{label} MIDI channel is off")),
    }
}

fn format_midi_channel(channel: MidiChannel) -> Value {
    match channel {
        MidiChannel::Channel(channel) => json!(channel + 1),
        MidiChannel::Auto => json!("auto"),
        MidiChannel::Off => json!("off"),
    }
}

fn pattern_slot(index: usize) -> String {
    let bank = char::from(b'A' + (index / 16) as u8);
    format!("{bank}{:02}", (index % 16) + 1)
}

fn fingerprint(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    format!("fnv1a64:{hash:016x}")
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn write_file(directory: &Path, name: &str, bytes: &[u8]) -> HardwareResult<()> {
    fs::write(directory.join(name), bytes).map_err(error_string)
}

fn write_file_if_absent(directory: &Path, name: &str, bytes: &[u8]) -> HardwareResult<()> {
    let path = directory.join(name);
    if path.exists() {
        return Ok(());
    }
    fs::write(path, bytes).map_err(error_string)
}

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn firmware_decode_error(object: &str, error: impl std::fmt::Display) -> String {
    format!(
        "failed to decode {object} SysEx with the firmware 1.70 adapter; current hardware compatibility remains unverified: {error}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pattern_slots() {
        assert_eq!(parse_pattern_slot("A01").unwrap(), 0);
        assert_eq!(parse_pattern_slot("h16").unwrap(), 127);
        assert!(parse_pattern_slot("A00").is_err());
        assert!(parse_pattern_slot("I01").is_err());
    }

    #[test]
    fn demo_patterns_cover_delta_features() {
        let mut project = RytmProject::try_default().unwrap();
        for variant in 0..3 {
            let pattern = &mut project.patterns_mut()[variant];
            configure_demo_pattern(pattern, variant).unwrap();
            let summary = pattern_summary(pattern);
            assert!(summary["tracks"].as_array().unwrap().iter().any(|track| {
                track["trigs"]
                    .as_array()
                    .is_some_and(|trigs| !trigs.is_empty())
            }));
        }
        assert_eq!(project.patterns()[2].tracks()[8].number_of_steps(), 15);
        assert_eq!(
            project.patterns()[1].tracks()[9].trigs()[14].trig_condition(),
            TrigCondition::P50
        );
        assert_eq!(
            project.patterns()[2].tracks()[0].trigs()[5]
                .plock_get_filter_cutoff()
                .unwrap(),
            Some(84)
        );
    }

    #[test]
    fn declarative_midi_config_converges_idempotently() {
        let mut project = RytmProject::try_default().unwrap();
        let global = project.work_buffer_mut().global_mut();
        global
            .midi_config_mut()
            .sync_mut()
            .set_program_change_receive(false);
        assert!(!midi_config_is_desired(global));
        apply_desired_midi_config(global);
        assert!(midi_config_is_desired(global));
        let first = midi_config_summary(global);
        apply_desired_midi_config(global);
        assert_eq!(midi_config_summary(global), first);
    }
}
