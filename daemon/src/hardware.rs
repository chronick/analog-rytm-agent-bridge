use crate::state::{
    operation_song_target, parse_song_inspect_request, PersistentOperation, SongPatternInput,
    SongRowInput, SongTarget,
};
use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use rytm_rs::{
    object::{
        global::Global,
        kit::Kit,
        pattern::Pattern,
        settings::Settings,
        song::Song,
        sound::{machine::MachineParameterValue, Sound},
    },
    prelude::*,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
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

// The pinned rytm-rs revision maps its Fill variant to device condition value
// 22 and FillNot to 23, but on OS 1.72 hardware value 23 is the trig that
// stays silent until FILL is held (verified by captured playback,
// 2026-07-17). Swap at the boundary in both directions so the bridge's
// public "fill"/"fillnot" strings mean what the device panel means.
fn swap_fill_condition(condition: &str) -> &str {
    match condition {
        "fill" => "fillnot",
        "fillnot" => "fill",
        other => other,
    }
}

pub struct RytmMidiSession {
    _input: MidiInputConnection<()>,
    output: MidiOutputConnection,
    response_receiver: Receiver<Vec<u8>>,
    event_receiver: Receiver<Vec<u8>>,
    pub input_name: String,
    pub output_name: String,
}

pub struct StateCapture {
    pub project: RytmProject,
    pub pattern_raw: Vec<u8>,
    pub kit_raw: Vec<u8>,
    pub global_raw: Vec<u8>,
    pub settings_raw: Vec<u8>,
    pub song_raw: BTreeMap<String, Vec<u8>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RawState {
    pub pattern_raw: Vec<u8>,
    pub kit_raw: Vec<u8>,
    pub global_raw: Vec<u8>,
    pub settings_raw: Vec<u8>,
    #[serde(default)]
    pub song_raw: BTreeMap<String, Vec<u8>>,
    pub summary: Value,
}

impl RawState {
    pub fn from_capture(capture: &StateCapture) -> HardwareResult<Self> {
        Ok(Self {
            pattern_raw: capture.pattern_raw.clone(),
            kit_raw: capture.kit_raw.clone(),
            global_raw: capture.global_raw.clone(),
            settings_raw: capture.settings_raw.clone(),
            song_raw: capture.song_raw.clone(),
            summary: capture_summary(capture)?,
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedObjects {
    pub pattern: bool,
    pub kit: bool,
    pub global: bool,
    pub settings: bool,
    pub songs: Vec<String>,
}

impl ChangedObjects {
    pub fn any(&self) -> bool {
        self.pattern || self.kit || self.global || self.settings || !self.songs.is_empty()
    }
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

        let (response_sender, response_receiver) = mpsc::channel();
        let (event_sender, event_receiver) = mpsc::channel();
        let input_connection = input
            .connect(
                &input_port,
                "analog-rytm-agent-input",
                move |_stamp, message, _| {
                    let message = message.to_vec();
                    let _ = response_sender.send(message.clone());
                    let _ = event_sender.send(message);
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
            response_receiver,
            event_receiver,
            input_name,
            output_name,
        })
    }

    pub fn send(&mut self, message: &[u8]) -> HardwareResult<()> {
        self.output.send(message).map_err(error_string)
    }

    pub fn request(&mut self, request: &[u8]) -> HardwareResult<Vec<u8>> {
        while self.response_receiver.try_recv().is_ok() {}
        self.send(request)?;
        self.receive_sysex(RESPONSE_TIMEOUT)
    }

    pub fn drain_midi_events(&self) -> Vec<Vec<u8>> {
        self.event_receiver.try_iter().collect()
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

            let message = match self.response_receiver.recv_timeout(remaining) {
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
    let song_raw = query_object(session, &SongQuery::new_targeting_work_buffer())?;
    project
        .update_from_sysex_response(&song_raw)
        .map_err(|error| firmware_decode_error("song", error))?;
    let song_raw = BTreeMap::from([(SongTarget::WorkBuffer.key(), song_raw)]);

    Ok(StateCapture {
        project,
        pattern_raw,
        kit_raw,
        global_raw,
        settings_raw,
        song_raw,
    })
}

pub fn read_operation_state(
    session: &mut RytmMidiSession,
    operations: &[PersistentOperation],
) -> HardwareResult<StateCapture> {
    let mut capture = read_work_buffer_state(session)?;
    if let Some(target) = operation_song_target(operations)? {
        populate_song_target(session, &mut capture, &target)?;
    }
    Ok(capture)
}

pub fn read_snapshot_state(session: &mut RytmMidiSession) -> HardwareResult<StateCapture> {
    let mut capture = read_work_buffer_state(session)?;
    for song in 1..=16 {
        populate_song_target(session, &mut capture, &SongTarget::Stored { song })?;
    }
    Ok(capture)
}

fn populate_song_target(
    session: &mut RytmMidiSession,
    capture: &mut StateCapture,
    target: &SongTarget,
) -> HardwareResult<()> {
    let key = target.key();
    if capture.song_raw.contains_key(&key) {
        return Ok(());
    }
    let SongTarget::Stored { song } = target else {
        return Err("work-buffer Song was missing from the base state capture".to_string());
    };
    if !(1..=16).contains(song) {
        return Err(format!("stored Song must be between 1 and 16: {song}"));
    }
    let query = SongQuery::new(usize::from(*song - 1)).map_err(error_string)?;
    let raw = query_object(session, &query)?;
    capture
        .project
        .update_from_sysex_response(&raw)
        .map_err(|error| firmware_decode_error("song", error))?;
    capture.song_raw.insert(key, raw);
    Ok(())
}

fn inspect_song_targets(session: &mut RytmMidiSession, keys: &[String]) -> HardwareResult<Value> {
    let mut capture = read_work_buffer_state(session)?;
    for key in keys {
        populate_song_target(session, &mut capture, &song_target_from_key(key)?)?;
    }
    capture_summary(&capture)
}

fn capture_summary(capture: &StateCapture) -> HardwareResult<Value> {
    let mut summary = state_summary(&capture.project);
    summary["songs"] = song_map_summary(&capture.project, capture.song_raw.keys())?;
    Ok(summary)
}

pub fn canonical_capture_summary(capture: &StateCapture) -> HardwareResult<Value> {
    let mut summary = canonical_state_summary(&capture.project)?;
    let mut songs = serde_json::Map::new();
    for key in capture.song_raw.keys() {
        let target = song_target_from_key(key)?;
        let encoded = project_song(&capture.project, &target)?
            .as_sysex()
            .map_err(error_string)?;
        let canonical = Song::from_sysex(&encoded).map_err(error_string)?;
        songs.insert(key.clone(), song_summary(&canonical, &target)?);
    }
    summary["songs"] = Value::Object(songs);
    Ok(summary)
}

fn song_map_summary<'a>(
    project: &RytmProject,
    keys: impl Iterator<Item = &'a String>,
) -> HardwareResult<Value> {
    let mut songs = serde_json::Map::new();
    for key in keys {
        let target = song_target_from_key(key)?;
        songs.insert(
            key.clone(),
            song_summary(project_song(project, &target)?, &target)?,
        );
    }
    Ok(Value::Object(songs))
}

pub fn capture_state(session: &mut RytmMidiSession, directory: &Path) -> HardwareResult<Value> {
    let capture = read_work_buffer_state(session)?;
    fs::create_dir_all(directory).map_err(error_string)?;
    write_file(directory, "work-buffer-pattern.syx", &capture.pattern_raw)?;
    write_file(directory, "work-buffer-kit.syx", &capture.kit_raw)?;
    write_file(directory, "work-buffer-global.syx", &capture.global_raw)?;
    write_file(directory, "settings.syx", &capture.settings_raw)?;
    write_file(
        directory,
        "work-buffer-song.syx",
        capture
            .song_raw
            .get("work_buffer")
            .expect("work-buffer capture includes Song bytes"),
    )?;

    let summary = state_summary(&capture.project);
    write_file(
        directory,
        "state-summary.json",
        &serde_json::to_vec_pretty(&summary).map_err(error_string)?,
    )?;
    Ok(summary)
}

pub fn inspect_work_buffer_state(session: &mut RytmMidiSession) -> HardwareResult<Value> {
    let capture = read_work_buffer_state(session)?;
    Ok(state_summary(&capture.project))
}

pub fn inspect_song_state(session: &mut RytmMidiSession, params: &Value) -> HardwareResult<Value> {
    let (targets, resolve_references) = parse_song_inspect_request(params)?;
    let mut capture = read_work_buffer_state(session)?;
    for target in &targets {
        populate_song_target(session, &mut capture, target)?;
    }
    let mut songs = targets
        .iter()
        .map(|target| song_summary(project_song(&capture.project, target)?, target))
        .collect::<HardwareResult<Vec<_>>>()?;
    if resolve_references {
        let references = resolve_song_references(session, &songs)?;
        for song in &mut songs {
            let referenced = song["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|row| row["patterns"].as_array().into_iter().flatten())
                .filter_map(|position| position["pattern"].as_str())
                .collect::<BTreeSet<_>>();
            song["references"] = json!(references
                .iter()
                .filter(|reference| reference["pattern"]
                    .as_str()
                    .is_some_and(|slot| referenced.contains(slot)))
                .cloned()
                .collect::<Vec<_>>());
        }
    }
    if songs.len() == 1 {
        return Ok(songs.into_iter().next().expect("one Song was requested"));
    }
    Ok(json!({
        "count": songs.len(),
        "songs": songs,
        "capabilities": song_summary(capture.project.work_buffer().song(), &SongTarget::WorkBuffer)?["capabilities"].clone(),
    }))
}

fn resolve_song_references(
    session: &mut RytmMidiSession,
    songs: &[Value],
) -> HardwareResult<Vec<Value>> {
    let slots = songs
        .iter()
        .flat_map(|song| song["rows"].as_array().into_iter().flatten())
        .flat_map(|row| row["patterns"].as_array().into_iter().flatten())
        .filter_map(|position| position["pattern"].as_str())
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    let mut kit_names = BTreeMap::<u64, String>::new();
    let mut references = Vec::new();
    for slot in slots {
        let index = parse_pattern_slot(&slot)?;
        let raw = query_object(session, &PatternQuery::new(index).map_err(error_string)?)?;
        let pattern = decode_stored_pattern_summary(&raw, index)?;
        let kit_number = pattern["kitNumber"].as_u64().unwrap_or(255);
        let kit_name = if kit_number < 128 {
            let name = match kit_names.entry(kit_number) {
                std::collections::btree_map::Entry::Occupied(entry) => entry.get().clone(),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    let raw = query_object(
                        session,
                        &KitQuery::new(kit_number as usize).map_err(error_string)?,
                    )?;
                    let mut project = RytmProject::try_default().map_err(error_string)?;
                    project
                        .update_from_sysex_response(&raw)
                        .map_err(|error| firmware_decode_error("kit", error))?;
                    let name = project.kits()[kit_number as usize]
                        .name()
                        .trim_end_matches('\0')
                        .to_string();
                    entry.insert(name.clone());
                    name
                }
            };
            Some(name)
        } else {
            None
        };
        references.push(json!({
            "pattern": slot,
            "available": true,
            "kitNumber": kit_number,
            "kitName": kit_name,
            "patternLength": pattern["masterLength"].clone(),
        }));
    }
    Ok(references)
}

pub fn apply_persistent_operations(
    capture: &mut StateCapture,
    operations: &[PersistentOperation],
) -> HardwareResult<ChangedObjects> {
    let before = canonical_capture_summary(capture)?;
    for operation in operations {
        apply_persistent_operation(&mut capture.project, operation)?;
    }
    let after = canonical_capture_summary(capture)?;
    let songs = capture
        .song_raw
        .keys()
        .filter(|key| before["songs"][*key] != after["songs"][*key])
        .cloned()
        .collect();
    Ok(ChangedObjects {
        pattern: before["pattern"] != after["pattern"],
        kit: before["kit"] != after["kit"],
        global: before["global"] != after["global"],
        settings: before["settings"] != after["settings"],
        songs,
    })
}

pub fn write_capture_delta(
    session: &mut RytmMidiSession,
    capture: &StateCapture,
    baseline: &RawState,
    changed: &ChangedObjects,
) -> HardwareResult<Value> {
    write_capture_delta_internal(session, capture, baseline, changed, false)
}

#[doc(hidden)]
pub fn write_capture_delta_with_test_verification_failure(
    session: &mut RytmMidiSession,
    capture: &StateCapture,
    baseline: &RawState,
    changed: &ChangedObjects,
) -> HardwareResult<Value> {
    write_capture_delta_internal(session, capture, baseline, changed, true)
}

fn write_capture_delta_internal(
    session: &mut RytmMidiSession,
    capture: &StateCapture,
    baseline: &RawState,
    changed: &ChangedObjects,
    force_verification_failure: bool,
) -> HardwareResult<Value> {
    let expected = canonical_capture_summary(capture)?;
    if !changed.any() {
        return Ok(json!({
            "status": "already-converged",
            "changed": changed,
            "state": expected,
        }));
    }

    let write_result: HardwareResult<Value> = (|| {
        send_changed_project(session, &capture.project, changed)?;
        let observed = inspect_song_targets(session, &changed.songs)?;
        if force_verification_failure {
            return Err("injected readback verification failure".to_string());
        }
        verify_changed_sections(&expected, &observed, changed)?;
        Ok(observed)
    })();

    match write_result {
        Ok(observed) => Ok(json!({
            "status": "applied-and-verified",
            "changed": changed,
            "state": observed,
        })),
        Err(write_error) => match restore_raw_state(session, baseline, changed) {
            Ok(_) => Err(format!(
                "hardware write failed and baseline was restored: {write_error}"
            )),
            Err(rollback_error) => Err(format!(
                "hardware write failed: {write_error}; automatic rollback also failed: {rollback_error}"
            )),
        },
    }
}

pub fn restore_raw_state(
    session: &mut RytmMidiSession,
    raw: &RawState,
    changed: &ChangedObjects,
) -> HardwareResult<Value> {
    if changed.pattern {
        session.send(&raw.pattern_raw)?;
        thread::sleep(Duration::from_millis(450));
    }
    if changed.kit {
        session.send(&raw.kit_raw)?;
        thread::sleep(Duration::from_millis(450));
    }
    if changed.global {
        session.send(&raw.global_raw)?;
        thread::sleep(Duration::from_millis(450));
    }
    if changed.settings {
        session.send(&raw.settings_raw)?;
        thread::sleep(Duration::from_millis(450));
    }
    for key in &changed.songs {
        let bytes = raw
            .song_raw
            .get(key)
            .ok_or_else(|| format!("rollback snapshot is missing Song target {key}"))?;
        session.send(bytes)?;
        thread::sleep(Duration::from_millis(750));
    }
    let observed = inspect_song_targets(session, &changed.songs)?;
    verify_changed_sections(&raw.summary, &observed, changed)?;
    Ok(observed)
}

fn send_changed_project(
    session: &mut RytmMidiSession,
    project: &RytmProject,
    changed: &ChangedObjects,
) -> HardwareResult<()> {
    if changed.pattern {
        session.send(
            &project
                .work_buffer()
                .pattern()
                .as_sysex()
                .map_err(error_string)?,
        )?;
        thread::sleep(Duration::from_millis(450));
    }
    if changed.kit {
        session.send(
            &project
                .work_buffer()
                .kit()
                .as_sysex()
                .map_err(error_string)?,
        )?;
        thread::sleep(Duration::from_millis(450));
    }
    if changed.global {
        session.send(
            &project
                .work_buffer()
                .global()
                .as_sysex()
                .map_err(error_string)?,
        )?;
        thread::sleep(Duration::from_millis(450));
    }
    if changed.settings {
        session.send(&project.settings().as_sysex().map_err(error_string)?)?;
        thread::sleep(Duration::from_millis(450));
    }
    for key in &changed.songs {
        session.send(
            &song_for_key(project, key)?
                .as_sysex()
                .map_err(error_string)?,
        )?;
        thread::sleep(Duration::from_millis(750));
    }
    Ok(())
}

fn verify_changed_sections(
    expected: &Value,
    observed: &Value,
    changed: &ChangedObjects,
) -> HardwareResult<()> {
    for (name, should_compare) in [
        ("pattern", changed.pattern),
        ("kit", changed.kit),
        ("global", changed.global),
        ("settings", changed.settings),
    ] {
        if should_compare && expected[name] != observed[name] {
            let mut differences = Vec::new();
            collect_value_differences(name, &expected[name], &observed[name], &mut differences, 12);
            return Err(format!(
                "{name} readback did not match the requested state: {}",
                differences.join("; ")
            ));
        }
    }
    for key in &changed.songs {
        if expected["songs"][key] != observed["songs"][key] {
            let mut differences = Vec::new();
            collect_value_differences(
                &format!("songs.{key}"),
                &expected["songs"][key],
                &observed["songs"][key],
                &mut differences,
                12,
            );
            return Err(format!(
                "Song {key} readback did not match the requested state: {}",
                differences.join("; ")
            ));
        }
    }
    Ok(())
}

fn collect_value_differences(
    path: &str,
    expected: &Value,
    observed: &Value,
    differences: &mut Vec<String>,
    limit: usize,
) {
    if differences.len() >= limit || expected == observed {
        return;
    }
    match (expected, observed) {
        (Value::Object(expected), Value::Object(observed)) => {
            let mut keys = expected.keys().chain(observed.keys()).collect::<Vec<_>>();
            keys.sort();
            keys.dedup();
            for key in keys {
                collect_value_differences(
                    &format!("{path}.{key}"),
                    expected.get(key).unwrap_or(&Value::Null),
                    observed.get(key).unwrap_or(&Value::Null),
                    differences,
                    limit,
                );
                if differences.len() >= limit {
                    break;
                }
            }
        }
        (Value::Array(expected), Value::Array(observed)) => {
            for index in 0..expected.len().max(observed.len()) {
                collect_value_differences(
                    &format!("{path}[{index}]"),
                    expected.get(index).unwrap_or(&Value::Null),
                    observed.get(index).unwrap_or(&Value::Null),
                    differences,
                    limit,
                );
                if differences.len() >= limit {
                    break;
                }
            }
        }
        _ => differences.push(format!("{path}: expected {expected}, observed {observed}")),
    }
}

fn apply_persistent_operation(
    project: &mut RytmProject,
    operation: &PersistentOperation,
) -> HardwareResult<()> {
    match operation {
        PersistentOperation::SetTrackMachine { track, machine, .. } => {
            let track_index = parse_track_index(track)?;
            let machine = MachineType::try_from(machine.as_str()).map_err(error_string)?;
            let sound = &mut project.work_buffer_mut().kit_mut().sounds_mut()[track_index];
            if sound.machine_type() == machine {
                return Ok(());
            }
            sound.set_machine_type(machine).map_err(error_string)
        }
        PersistentOperation::SetKitParameter {
            track,
            parameter,
            value,
        } => apply_kit_parameter(project.work_buffer_mut().kit_mut(), track, parameter, value),
        PersistentOperation::SetSoundParameter {
            track,
            page,
            parameter,
            value,
        } => {
            let track_index = parse_track_index(track)?;
            let sound = &mut project.work_buffer_mut().kit_mut().sounds_mut()[track_index];
            apply_sound_parameter(sound, page, parameter, value)
        }
        PersistentOperation::SetFxParameter {
            effect,
            parameter,
            value,
        } => apply_fx_parameter(
            project.work_buffer_mut().kit_mut(),
            effect,
            parameter,
            value,
        ),
        PersistentOperation::SetGlobalParameter {
            section,
            parameter,
            track,
            value,
        } => apply_global_parameter(project, section, parameter, track, value),
        PersistentOperation::SetTrig {
            pattern,
            track,
            step,
            velocity,
            micro_timing,
            condition,
            retrig,
        } => {
            let track_index = parse_track_index(track)?;
            let pattern = work_buffer_pattern_mut(project, pattern)?;
            let trig = pattern.tracks_mut()[track_index]
                .trigs_mut()
                .get_mut(usize::from(*step))
                .ok_or_else(|| format!("step {step} must be between 0 and 63"))?;
            trig.set_trig_enable(true);
            if let Some(velocity) = velocity {
                trig.set_velocity(usize::from(*velocity))
                    .map_err(error_string)?;
            }
            if let Some(micro_timing) = micro_timing {
                trig.set_micro_timing_by_value(isize::from(*micro_timing))
                    .map_err(error_string)?;
            }
            if let Some(condition) = condition {
                trig.set_trig_condition(
                    TrigCondition::try_from(swap_fill_condition(condition.as_str()))
                        .map_err(error_string)?,
                );
            }
            if let Some(retrig) = retrig {
                trig.set_retrig(*retrig);
            }
            Ok(())
        }
        PersistentOperation::ClearTrig {
            pattern,
            track,
            step,
        } => {
            let track_index = parse_track_index(track)?;
            let pattern = work_buffer_pattern_mut(project, pattern)?;
            let trig = pattern.tracks_mut()[track_index]
                .trigs_mut()
                .get_mut(usize::from(*step))
                .ok_or_else(|| format!("step {step} must be between 0 and 63"))?;
            trig.set_trig_enable(false);
            trig.set_retrig(false);
            trig.set_trig_condition(TrigCondition::Unset);
            trig.set_micro_timing_by_value(0).map_err(error_string)
        }
        PersistentOperation::SetParameterLock {
            pattern,
            track,
            step,
            parameter,
            value,
        } => {
            let track_index = parse_track_index(track)?;
            let pattern = work_buffer_pattern_mut(project, pattern)?;
            let trig = pattern.tracks_mut()[track_index]
                .trigs_mut()
                .get_mut(usize::from(*step))
                .ok_or_else(|| format!("step {step} must be between 0 and 63"))?;
            match parameter.as_str() {
                "filter_frequency" | "filter_cutoff" => {
                    trig.set_parameter_lock_env(true);
                    trig.plock_set_filter_cutoff(exact_nonnegative_usize(*value, "value")?)
                        .map_err(error_string)
                }
                _ => Err(format!(
                    "unsupported hardware parameter lock {parameter:?}; supported: filter_frequency"
                )),
            }
        }
        PersistentOperation::ClearParameterLock {
            pattern,
            track,
            step,
            parameter,
        } => {
            let track_index = parse_track_index(track)?;
            let pattern = work_buffer_pattern_mut(project, pattern)?;
            let trig = pattern.tracks_mut()[track_index]
                .trigs_mut()
                .get_mut(usize::from(*step))
                .ok_or_else(|| format!("step {step} must be between 0 and 63"))?;
            match parameter.as_str() {
                "filter_frequency" | "filter_cutoff" => {
                    trig.plock_clear_filter_cutoff().map_err(error_string)
                }
                _ => Err(format!(
                    "unsupported hardware parameter lock {parameter:?}; supported: filter_frequency"
                )),
            }
        }
        PersistentOperation::SetTrackLength {
            pattern,
            track,
            steps,
        } => {
            let track_index = parse_track_index(track)?;
            work_buffer_pattern_mut(project, pattern)?.tracks_mut()[track_index]
                .set_number_of_steps(usize::from(*steps))
                .map_err(error_string)
        }
        PersistentOperation::CopyPattern { .. } => Err(
            "copy_pattern requires a multi-slot transaction and is not available in the work-buffer mutator"
                .to_string(),
        ),
        PersistentOperation::AssignSampleSlot {
            pattern,
            track,
            slot,
            ..
        } => {
            work_buffer_pattern_mut(project, pattern)?;
            let track_index = parse_track_index(track)?;
            project.work_buffer_mut().kit_mut().sounds_mut()[track_index]
                .sample_mut()
                .set_slice_number(usize::from(*slot))
                .map_err(error_string)
        }
        PersistentOperation::SetSceneLock {
            scene,
            track,
            parameter,
            value,
        } => {
            let lock = scene_lock(track, parameter, *value)?;
            project
                .work_buffer_mut()
                .kit_mut()
                .scene_definitions_mut()
                .set_lock(macro_index(*scene, "scene")?, lock)
                .map_err(error_string)
        }
        PersistentOperation::ReplaceScene { scene, locks } => {
            let locks = locks
                .iter()
                .map(|lock| scene_lock(&lock.track, &lock.parameter, lock.value))
                .collect::<HardwareResult<Vec<_>>>()?;
            project
                .work_buffer_mut()
                .kit_mut()
                .scene_definitions_mut()
                .replace(macro_index(*scene, "scene")?, &locks)
                .map_err(error_string)
        }
        PersistentOperation::ClearScene { scene } => project
            .work_buffer_mut()
            .kit_mut()
            .scene_definitions_mut()
            .clear(macro_index(*scene, "scene")?)
            .map_err(error_string),
        PersistentOperation::CopyScene {
            source_scene,
            target_scene,
        } => project
            .work_buffer_mut()
            .kit_mut()
            .scene_definitions_mut()
            .copy(
                macro_index(*source_scene, "sourceScene")?,
                macro_index(*target_scene, "targetScene")?,
            )
            .map_err(error_string),
        PersistentOperation::SetPerformanceLock {
            performance,
            track,
            parameter,
            depth,
        } => {
            let lock = performance_lock(track, parameter, *depth)?;
            project
                .work_buffer_mut()
                .kit_mut()
                .performance_definitions_mut()
                .set_lock(macro_index(*performance, "performance")?, lock)
                .map_err(error_string)
        }
        PersistentOperation::ReplacePerformance { performance, locks } => {
            let locks = locks
                .iter()
                .map(|lock| performance_lock(&lock.track, &lock.parameter, lock.depth))
                .collect::<HardwareResult<Vec<_>>>()?;
            project
                .work_buffer_mut()
                .kit_mut()
                .performance_definitions_mut()
                .replace(macro_index(*performance, "performance")?, &locks)
                .map_err(error_string)
        }
        PersistentOperation::ClearPerformance { performance } => project
            .work_buffer_mut()
            .kit_mut()
            .performance_definitions_mut()
            .clear(macro_index(*performance, "performance")?)
            .map_err(error_string),
        PersistentOperation::CopyPerformance {
            source_performance,
            target_performance,
        } => project
            .work_buffer_mut()
            .kit_mut()
            .performance_definitions_mut()
            .copy(
                macro_index(*source_performance, "sourcePerformance")?,
                macro_index(*target_performance, "targetPerformance")?,
            )
            .map_err(error_string),
        PersistentOperation::SetSongName { target, name } => project_song_mut(project, target)?
            .set_name(name)
            .map_err(error_string),
        PersistentOperation::ReplaceSong { target, name, rows } => {
            let rows = typed_song_rows(rows)?;
            let song = project_song_mut(project, target)?;
            if let Some(name) = name {
                song.set_name(name).map_err(error_string)?;
            }
            song.replace_rows(&rows).map_err(error_string)
        }
        PersistentOperation::InsertSongRow { target, row, value } => {
            let song = project_song_mut(project, target)?;
            let mut rows = song.rows().map_err(error_string)?;
            let row = usize::from(*row);
            if row > rows.len() {
                return Err(format!(
                    "row {row} cannot be inserted into a Song with {} rows",
                    rows.len()
                ));
            }
            rows.insert(row, typed_song_row(value)?);
            song.replace_rows(&rows).map_err(error_string)
        }
        PersistentOperation::UpdateSongRow { target, row, value } => {
            let song = project_song_mut(project, target)?;
            let mut rows = song.rows().map_err(error_string)?;
            let row = usize::from(*row);
            let existing = rows
                .get_mut(row)
                .ok_or_else(|| format!("row {row} does not exist"))?;
            *existing = typed_song_row(value)?;
            song.replace_rows(&rows).map_err(error_string)
        }
        PersistentOperation::MoveSongRow {
            target,
            source_row,
            target_row,
        } => {
            let song = project_song_mut(project, target)?;
            let mut rows = song.rows().map_err(error_string)?;
            let source = usize::from(*source_row);
            let destination = usize::from(*target_row);
            if source >= rows.len() || destination >= rows.len() {
                return Err(format!(
                    "move rows must be within the current {}-row Song",
                    rows.len()
                ));
            }
            let row = rows.remove(source);
            rows.insert(destination, row);
            song.replace_rows(&rows).map_err(error_string)
        }
        PersistentOperation::CopySongRow {
            target,
            source_row,
            target_row,
        } => {
            let song = project_song_mut(project, target)?;
            let mut rows = song.rows().map_err(error_string)?;
            let source = usize::from(*source_row);
            let destination = usize::from(*target_row);
            let row = rows
                .get(source)
                .cloned()
                .ok_or_else(|| format!("row {source} does not exist"))?;
            if destination > rows.len() {
                return Err(format!(
                    "row {destination} cannot be inserted into a Song with {} rows",
                    rows.len()
                ));
            }
            rows.insert(destination, row);
            song.replace_rows(&rows).map_err(error_string)
        }
        PersistentOperation::RemoveSongRow { target, row } => {
            let song = project_song_mut(project, target)?;
            let mut rows = song.rows().map_err(error_string)?;
            let row = usize::from(*row);
            if row >= rows.len() {
                return Err(format!("row {row} does not exist"));
            }
            rows.remove(row);
            song.replace_rows(&rows).map_err(error_string)
        }
        PersistentOperation::ClearSong { target } => {
            project_song_mut(project, target)?.clear();
            Ok(())
        }
    }
}

fn work_buffer_pattern_mut<'a>(
    project: &'a mut RytmProject,
    requested_slot: &Option<String>,
) -> HardwareResult<&'a mut Pattern> {
    if let Some(requested_slot) = requested_slot {
        let requested_index = parse_pattern_slot(requested_slot)?;
        let current_index = project.work_buffer().pattern().index();
        if requested_index != current_index {
            return Err(format!(
                "operation targets pattern {}, but the work buffer contains {}",
                requested_slot.to_ascii_uppercase(),
                pattern_slot(current_index)
            ));
        }
    }
    Ok(project.work_buffer_mut().pattern_mut())
}

fn project_song<'a>(project: &'a RytmProject, target: &SongTarget) -> HardwareResult<&'a Song> {
    match target {
        SongTarget::WorkBuffer => Ok(project.work_buffer().song()),
        SongTarget::Stored { song } if (1..=16).contains(song) => {
            Ok(&project.songs()[usize::from(*song - 1)])
        }
        SongTarget::Stored { song } => Err(format!("stored Song must be between 1 and 16: {song}")),
    }
}

fn project_song_mut<'a>(
    project: &'a mut RytmProject,
    target: &SongTarget,
) -> HardwareResult<&'a mut Song> {
    match target {
        SongTarget::WorkBuffer => Ok(project.work_buffer_mut().song_mut()),
        SongTarget::Stored { song } if (1..=16).contains(song) => {
            Ok(&mut project.songs_mut()[usize::from(*song - 1)])
        }
        SongTarget::Stored { song } => Err(format!("stored Song must be between 1 and 16: {song}")),
    }
}

fn song_for_key<'a>(project: &'a RytmProject, key: &str) -> HardwareResult<&'a Song> {
    project_song(project, &song_target_from_key(key)?)
}

fn song_target_from_key(key: &str) -> HardwareResult<SongTarget> {
    if key == "work_buffer" {
        return Ok(SongTarget::WorkBuffer);
    }
    let song = key
        .strip_prefix("stored:")
        .ok_or_else(|| format!("invalid Song target key: {key}"))?
        .parse::<u8>()
        .map_err(|_| format!("invalid Song target key: {key}"))?;
    if !(1..=16).contains(&song) {
        return Err(format!("invalid Song target key: {key}"));
    }
    Ok(SongTarget::Stored { song })
}

fn typed_song_rows(rows: &[SongRowInput]) -> HardwareResult<Vec<SongRow>> {
    rows.iter().map(typed_song_row).collect()
}

fn typed_song_row(row: &SongRowInput) -> HardwareResult<SongRow> {
    let patterns = row
        .patterns
        .iter()
        .map(typed_song_pattern)
        .collect::<HardwareResult<Vec<_>>>()?;
    SongRow::try_new(patterns, usize::from(row.repeats)).map_err(error_string)
}

fn typed_song_pattern(position: &SongPatternInput) -> HardwareResult<SongPattern> {
    let mut pattern =
        SongPattern::try_new(parse_pattern_slot(&position.pattern)?).map_err(error_string)?;
    let mut seen = BTreeSet::new();
    for track in &position.muted_tracks {
        let track_index = parse_track_index(track)?;
        if !seen.insert(track_index) {
            return Err(format!("mutedTracks contains duplicate track: {track}"));
        }
        pattern
            .set_track_muted(track_index, true)
            .map_err(error_string)?;
    }
    Ok(pattern)
}

fn exact_nonnegative_usize(value: f64, label: &str) -> HardwareResult<usize> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > usize::MAX as f64 {
        return Err(format!("{label} must be a non-negative integer"));
    }
    Ok(value as usize)
}

fn macro_index(value: u8, label: &str) -> HardwareResult<usize> {
    if !(1..=12).contains(&value) {
        return Err(format!("{label} must be between 1 and 12"));
    }
    Ok(usize::from(value - 1))
}

fn macro_track(value: &str) -> HardwareResult<MacroTrack> {
    if value == "FX" {
        return Ok(MacroTrack::Fx);
    }
    MacroTrack::try_voice(parse_track_index(value)?).map_err(error_string)
}

fn macro_parameter(track: MacroTrack, name: &str) -> HardwareResult<MacroParameter> {
    let raw_id = match track {
        MacroTrack::Voice(_) => voice_macro_parameter_id(name),
        MacroTrack::Fx => fx_macro_parameter_id(name),
    }
    .ok_or_else(|| format!("unsupported macro parameter {name:?} for {track:?}"))?;
    MacroParameter::try_from_raw(track, raw_id).map_err(error_string)
}

fn scene_lock(track: &str, parameter: &str, value: u8) -> HardwareResult<SceneLock> {
    let track = macro_track(track)?;
    SceneLock::try_new(
        track,
        macro_parameter(track, parameter)?,
        usize::from(value),
    )
    .map_err(error_string)
}

fn performance_lock(track: &str, parameter: &str, depth: i8) -> HardwareResult<PerformanceLock> {
    let track = macro_track(track)?;
    PerformanceLock::try_new(track, macro_parameter(track, parameter)?, depth).map_err(error_string)
}

fn voice_macro_parameter_id(name: &str) -> Option<u8> {
    match name {
        "machine_parameter_1" => Some(0),
        "machine_parameter_2" => Some(1),
        "machine_parameter_3" => Some(2),
        "machine_parameter_4" => Some(3),
        "machine_parameter_5" => Some(4),
        "machine_parameter_6" => Some(5),
        "machine_parameter_7" => Some(6),
        "machine_parameter_8" => Some(7),
        "sample_tune" => Some(8),
        "sample_fine_tune" => Some(9),
        "sample_number" => Some(10),
        "sample_bit_reduction" => Some(11),
        "sample_start" => Some(12),
        "sample_end" => Some(13),
        "sample_loop" => Some(14),
        "sample_level" => Some(15),
        "filter_attack" => Some(16),
        "filter_sustain" => Some(17),
        "filter_decay" => Some(18),
        "filter_release" => Some(19),
        "filter_frequency" | "filter_cutoff" => Some(20),
        "filter_resonance" => Some(21),
        "filter_type" => Some(22),
        "filter_envelope" => Some(23),
        "amp_attack" => Some(24),
        "amp_hold" => Some(25),
        "amp_decay" => Some(26),
        "amp_overdrive" => Some(27),
        "amp_delay_send" => Some(28),
        "amp_reverb_send" => Some(29),
        "amp_pan" => Some(30),
        "amp_volume" => Some(31),
        "lfo_speed" => Some(33),
        "lfo_multiplier" => Some(34),
        "lfo_fade" => Some(35),
        "lfo_destination" => Some(36),
        "lfo_waveform" => Some(37),
        "lfo_phase" => Some(38),
        "lfo_mode" => Some(39),
        "lfo_depth" => Some(40),
        _ => None,
    }
}

fn fx_macro_parameter_id(name: &str) -> Option<u8> {
    match name {
        "delay_time" => Some(0),
        "delay_ping_pong" => Some(1),
        "delay_stereo_width" => Some(2),
        "delay_feedback" => Some(3),
        "delay_hpf" => Some(4),
        "delay_lpf" => Some(5),
        "delay_reverb_send" => Some(6),
        "delay_volume" => Some(7),
        "distortion_delay_overdrive" => Some(8),
        "distortion_delay_post" => Some(9),
        "reverb_pre_delay" => Some(10),
        "reverb_decay" => Some(11),
        "reverb_shelving_frequency" => Some(12),
        "reverb_shelving_gain" => Some(13),
        "reverb_hpf" => Some(14),
        "reverb_lpf" => Some(15),
        "reverb_volume" => Some(16),
        "distortion_reverb_post" => Some(17),
        "distortion_amount" => Some(18),
        "distortion_symmetry" => Some(19),
        "compressor_threshold" => Some(21),
        "compressor_attack" => Some(22),
        "compressor_release" => Some(23),
        "compressor_ratio" => Some(24),
        "compressor_sidechain_eq" => Some(25),
        "compressor_makeup_gain" => Some(26),
        "compressor_mix" => Some(27),
        "compressor_volume" => Some(28),
        "fx_lfo_speed" => Some(29),
        "fx_lfo_multiplier" => Some(30),
        "fx_lfo_fade" => Some(31),
        "fx_lfo_destination" => Some(32),
        "fx_lfo_waveform" => Some(33),
        "fx_lfo_phase" => Some(34),
        "fx_lfo_mode" => Some(35),
        "fx_lfo_depth" => Some(36),
        _ => None,
    }
}

fn apply_kit_parameter(
    kit: &mut Kit,
    track: &Option<String>,
    parameter: &str,
    value: &Value,
) -> HardwareResult<()> {
    match parameter {
        "name" => kit
            .set_name(control_string(value, "value")?)
            .map_err(error_string),
        "track_level" => {
            let track_index = required_track_index(track, parameter)?;
            kit.set_track_level(track_index, control_usize(value, "value")?)
                .map_err(error_string)
        }
        "fx_track_level" => kit
            .set_track_level(12, control_usize(value, "value")?)
            .map_err(error_string),
        "retrig.rate" => {
            let track_index = required_track_index(track, parameter)?;
            let parsed = parse_enum(value, "value")?;
            kit.track_retrig_settings_mut(track_index)
                .map_err(error_string)?
                .set_rate(parsed);
            Ok(())
        }
        "retrig.length" => {
            let track_index = required_track_index(track, parameter)?;
            let parsed = parse_enum(value, "value")?;
            kit.track_retrig_settings_mut(track_index)
                .map_err(error_string)?
                .set_length(parsed);
            Ok(())
        }
        "retrig.velocity_curve" => {
            let track_index = required_track_index(track, parameter)?;
            kit.track_retrig_settings_mut(track_index)
                .map_err(error_string)?
                .set_velocity_curve(control_isize(value, "value")?)
                .map_err(error_string)
        }
        "retrig.always_on" => {
            let track_index = required_track_index(track, parameter)?;
            kit.track_retrig_settings_mut(track_index)
                .map_err(error_string)?
                .set_always_on(control_bool(value, "value")?);
            Ok(())
        }
        _ => Err(format!("unsupported Kit parameter {parameter:?}")),
    }
}

fn apply_sound_parameter(
    sound: &mut Sound,
    page: &str,
    parameter: &str,
    value: &Value,
) -> HardwareResult<()> {
    match page {
        "machine" => match parameter {
            "type" => sound
                .set_machine_type(
                    MachineType::try_from(control_string(value, "value")?).map_err(error_string)?,
                )
                .map_err(error_string),
            _ => {
                let value = match value {
                    Value::Number(number) => MachineParameterValue::Number(
                        number
                            .as_f64()
                            .ok_or_else(|| "value must be a finite number".to_string())?,
                    ),
                    Value::String(symbol) => MachineParameterValue::Symbol(symbol),
                    _ => return Err("value must be a number or symbolic string".to_string()),
                };
                sound
                    .machine_parameters_mut()
                    .set_parameter(parameter, value)
                    .map_err(error_string)
            }
        },
        "sample" => {
            let page = sound.sample_mut();
            match parameter {
                "tune" => page
                    .set_tune(control_isize(value, "value")?)
                    .map_err(error_string),
                "fine_tune" => page
                    .set_fine_tune(control_isize(value, "value")?)
                    .map_err(error_string),
                "number" => Err("sample.number is controlled by assign_sample_slot".to_string()),
                "bit_reduction" => page
                    .set_bit_reduction(control_usize(value, "value")?)
                    .map_err(error_string),
                "start" => page
                    .set_start(control_f32(value, "value")?)
                    .map_err(error_string),
                "end" => page
                    .set_end(control_f32(value, "value")?)
                    .map_err(error_string),
                "loop_flag" => {
                    page.set_loop_flag(control_bool(value, "value")?);
                    Ok(())
                }
                "volume" => page
                    .set_volume(control_usize(value, "value")?)
                    .map_err(error_string),
                _ => Err(format!("unsupported sample parameter {parameter:?}")),
            }
        }
        "filter" => {
            let page = sound.filter_mut();
            match parameter {
                "attack" => page
                    .set_attack(control_usize(value, "value")?)
                    .map_err(error_string),
                "sustain" => page
                    .set_sustain(control_usize(value, "value")?)
                    .map_err(error_string),
                "decay" => page
                    .set_decay(control_usize(value, "value")?)
                    .map_err(error_string),
                "release" => page
                    .set_release(control_usize(value, "value")?)
                    .map_err(error_string),
                "cutoff" => page
                    .set_cutoff(control_usize(value, "value")?)
                    .map_err(error_string),
                "resonance" => page
                    .set_resonance(control_usize(value, "value")?)
                    .map_err(error_string),
                "filter_type" => {
                    page.set_filter_type(parse_enum(value, "value")?);
                    Ok(())
                }
                "envelope_amount" => page
                    .set_envelope_amount(control_isize(value, "value")?)
                    .map_err(error_string),
                _ => Err(format!("unsupported filter parameter {parameter:?}")),
            }
        }
        "amp" => {
            let page = sound.amplitude_mut();
            match parameter {
                "attack" => page
                    .set_attack(control_usize(value, "value")?)
                    .map_err(error_string),
                "hold" => page
                    .set_hold(control_usize(value, "value")?)
                    .map_err(error_string),
                "decay" => page
                    .set_decay(control_usize(value, "value")?)
                    .map_err(error_string),
                "overdrive" => page
                    .set_overdrive(control_usize(value, "value")?)
                    .map_err(error_string),
                "delay_send" => page
                    .set_delay_send(control_usize(value, "value")?)
                    .map_err(error_string),
                "reverb_send" => page
                    .set_reverb_send(control_usize(value, "value")?)
                    .map_err(error_string),
                "pan" => page
                    .set_pan(control_isize(value, "value")?)
                    .map_err(error_string),
                "volume" => page
                    .set_volume(control_usize(value, "value")?)
                    .map_err(error_string),
                _ => Err(format!("unsupported amp parameter {parameter:?}")),
            }
        }
        "lfo" => apply_sound_lfo_parameter(sound, parameter, value),
        "settings" => apply_sound_settings_parameter(sound, parameter, value),
        _ => Err(format!("unsupported Sound page {page:?}")),
    }
}

fn apply_sound_lfo_parameter(
    sound: &mut Sound,
    parameter: &str,
    value: &Value,
) -> HardwareResult<()> {
    let page = sound.lfo_mut();
    match parameter {
        "speed" => page
            .set_speed(control_isize(value, "value")?)
            .map_err(error_string),
        "multiplier" => {
            page.set_multiplier(parse_enum(value, "value")?);
            Ok(())
        }
        "fade" => page
            .set_fade(control_isize(value, "value")?)
            .map_err(error_string),
        "destination" => {
            page.set_destination(parse_enum(value, "value")?);
            Ok(())
        }
        "waveform" => {
            page.set_waveform(parse_enum(value, "value")?);
            Ok(())
        }
        "depth" => page
            .set_depth(control_f32(value, "value")?)
            .map_err(error_string),
        "start_phase_or_slew" => page
            .set_start_phase(control_usize(value, "value")?)
            .map_err(error_string),
        "mode" => {
            page.set_mode(parse_enum(value, "value")?);
            Ok(())
        }
        _ => Err(format!("unsupported LFO parameter {parameter:?}")),
    }
}

fn apply_sound_settings_parameter(
    sound: &mut Sound,
    parameter: &str,
    value: &Value,
) -> HardwareResult<()> {
    match parameter {
        "name" => sound
            .set_name(control_string(value, "value")?)
            .map_err(error_string),
        "accent_level" => sound
            .set_accent_level(control_usize(value, "value")?)
            .map_err(error_string),
        _ => {
            let settings = sound.settings_mut();
            match parameter {
                "chromatic_mode" => {
                    settings.set_chromatic_mode(parse_enum(value, "value")?);
                    Ok(())
                }
                "env_reset_filter" => {
                    settings.set_env_reset_filter(control_bool(value, "value")?);
                    Ok(())
                }
                "velocity_to_volume" => {
                    settings.set_velocity_to_volume(control_bool(value, "value")?);
                    Ok(())
                }
                "legacy_fx_send" => {
                    settings.set_legacy_fx_send(control_bool(value, "value")?);
                    Ok(())
                }
                "velocity_modulation_amt_1" => settings
                    .set_velocity_modulation_amt_1(control_isize(value, "value")?)
                    .map_err(error_string),
                "velocity_modulation_amt_2" => settings
                    .set_velocity_modulation_amt_2(control_isize(value, "value")?)
                    .map_err(error_string),
                "velocity_modulation_amt_3" => settings
                    .set_velocity_modulation_amt_3(control_isize(value, "value")?)
                    .map_err(error_string),
                "velocity_modulation_amt_4" => settings
                    .set_velocity_modulation_amt_4(control_isize(value, "value")?)
                    .map_err(error_string),
                "velocity_modulation_target_1" => {
                    settings.set_velocity_modulation_target_1(parse_enum(value, "value")?);
                    Ok(())
                }
                "velocity_modulation_target_2" => {
                    settings.set_velocity_modulation_target_2(parse_enum(value, "value")?);
                    Ok(())
                }
                "velocity_modulation_target_3" => {
                    settings.set_velocity_modulation_target_3(parse_enum(value, "value")?);
                    Ok(())
                }
                "velocity_modulation_target_4" => {
                    settings.set_velocity_modulation_target_4(parse_enum(value, "value")?);
                    Ok(())
                }
                "after_touch_modulation_amt_1" => settings
                    .set_after_touch_modulation_amt_1(control_isize(value, "value")?)
                    .map_err(error_string),
                "after_touch_modulation_amt_2" => settings
                    .set_after_touch_modulation_amt_2(control_isize(value, "value")?)
                    .map_err(error_string),
                "after_touch_modulation_amt_3" => settings
                    .set_after_touch_modulation_amt_3(control_isize(value, "value")?)
                    .map_err(error_string),
                "after_touch_modulation_amt_4" => settings
                    .set_after_touch_modulation_amt_4(control_isize(value, "value")?)
                    .map_err(error_string),
                "after_touch_modulation_target_1" => {
                    settings.set_after_touch_modulation_target_1(parse_enum(value, "value")?);
                    Ok(())
                }
                "after_touch_modulation_target_2" => {
                    settings.set_after_touch_modulation_target_2(parse_enum(value, "value")?);
                    Ok(())
                }
                "after_touch_modulation_target_3" => {
                    settings.set_after_touch_modulation_target_3(parse_enum(value, "value")?);
                    Ok(())
                }
                "after_touch_modulation_target_4" => {
                    settings.set_after_touch_modulation_target_4(parse_enum(value, "value")?);
                    Ok(())
                }
                _ => Err(format!(
                    "unsupported Sound settings parameter {parameter:?}"
                )),
            }
        }
    }
}

fn apply_fx_parameter(
    kit: &mut Kit,
    effect: &str,
    parameter: &str,
    value: &Value,
) -> HardwareResult<()> {
    match effect {
        "delay" => {
            let fx = kit.fx_delay_mut();
            match parameter {
                "time" => fx
                    .set_time(control_usize(value, "value")?)
                    .map_err(error_string),
                "time_on_grid" => {
                    fx.set_time_on_grid(parse_enum(value, "value")?);
                    Ok(())
                }
                "ping_pong" => {
                    fx.set_ping_pong(control_bool(value, "value")?);
                    Ok(())
                }
                "stereo_width" => fx
                    .set_stereo_width(control_isize(value, "value")?)
                    .map_err(error_string),
                "feedback" => fx
                    .set_feedback(control_usize(value, "value")?)
                    .map_err(error_string),
                "hpf" => fx
                    .set_hpf(control_usize(value, "value")?)
                    .map_err(error_string),
                "lpf" => fx
                    .set_lpf(control_usize(value, "value")?)
                    .map_err(error_string),
                "reverb_send" => fx
                    .set_reverb_send(control_usize(value, "value")?)
                    .map_err(error_string),
                "volume" => fx
                    .set_volume(control_usize(value, "value")?)
                    .map_err(error_string),
                _ => Err(format!("unsupported delay parameter {parameter:?}")),
            }
        }
        "reverb" => {
            let fx = kit.fx_reverb_mut();
            match parameter {
                "pre_delay" => fx
                    .set_pre_delay(control_usize(value, "value")?)
                    .map_err(error_string),
                "decay" => fx
                    .set_decay(control_usize(value, "value")?)
                    .map_err(error_string),
                "freq" => fx
                    .set_freq(control_usize(value, "value")?)
                    .map_err(error_string),
                "gain" => fx
                    .set_gain(control_usize(value, "value")?)
                    .map_err(error_string),
                "hpf" => fx
                    .set_hpf(control_usize(value, "value")?)
                    .map_err(error_string),
                "lpf" => fx
                    .set_lpf(control_usize(value, "value")?)
                    .map_err(error_string),
                "volume" => fx
                    .set_volume(control_usize(value, "value")?)
                    .map_err(error_string),
                _ => Err(format!("unsupported reverb parameter {parameter:?}")),
            }
        }
        "distortion" => {
            let fx = kit.fx_distortion_mut();
            match parameter {
                "delay_overdrive" => fx
                    .set_delay_overdrive(control_usize(value, "value")?)
                    .map_err(error_string),
                "reverb_post" => {
                    fx.set_reverb_post(control_bool(value, "value")?);
                    Ok(())
                }
                "delay_post" => {
                    fx.set_delay_post(control_bool(value, "value")?);
                    Ok(())
                }
                "amount" => fx
                    .set_amount(control_usize(value, "value")?)
                    .map_err(error_string),
                "symmetry" => fx
                    .set_symmetry(control_isize(value, "value")?)
                    .map_err(error_string),
                _ => Err(format!("unsupported distortion parameter {parameter:?}")),
            }
        }
        "compressor" => {
            let fx = kit.fx_compressor_mut();
            match parameter {
                "threshold" => fx
                    .set_threshold(control_usize(value, "value")?)
                    .map_err(error_string),
                "attack" => {
                    fx.set_attack(parse_enum(value, "value")?);
                    Ok(())
                }
                "release" => {
                    fx.set_release(parse_enum(value, "value")?);
                    Ok(())
                }
                "ratio" => {
                    fx.set_ratio(parse_enum(value, "value")?);
                    Ok(())
                }
                "side_chain_eq" | "seq" => {
                    fx.set_side_chain_eq(parse_enum(value, "value")?);
                    Ok(())
                }
                "gain" => fx
                    .set_gain(control_usize(value, "value")?)
                    .map_err(error_string),
                "mix" => fx
                    .set_mix(control_usize(value, "value")?)
                    .map_err(error_string),
                "volume" => fx
                    .set_volume(control_usize(value, "value")?)
                    .map_err(error_string),
                _ => Err(format!("unsupported compressor parameter {parameter:?}")),
            }
        }
        "lfo" => {
            let fx = kit.fx_lfo_mut();
            match parameter {
                "speed" => fx
                    .set_speed(control_isize(value, "value")?)
                    .map_err(error_string),
                "multiplier" => {
                    fx.set_multiplier(parse_enum(value, "value")?);
                    Ok(())
                }
                "fade" => fx
                    .set_fade(control_isize(value, "value")?)
                    .map_err(error_string),
                "destination" => {
                    fx.set_destination(parse_enum(value, "value")?);
                    Ok(())
                }
                "waveform" => {
                    fx.set_waveform(parse_enum(value, "value")?);
                    Ok(())
                }
                "start_phase_or_slew" => fx
                    .set_start_phase(control_usize(value, "value")?)
                    .map_err(error_string),
                "depth" => fx
                    .set_depth(control_f32(value, "value")?)
                    .map_err(error_string),
                "mode" => {
                    fx.set_mode(parse_enum(value, "value")?);
                    Ok(())
                }
                _ => Err(format!("unsupported FX LFO parameter {parameter:?}")),
            }
        }
        _ => Err(format!("unsupported Kit FX effect {effect:?}")),
    }
}

fn apply_global_parameter(
    project: &mut RytmProject,
    section: &str,
    parameter: &str,
    track: &Option<String>,
    value: &Value,
) -> HardwareResult<()> {
    if section == "settings" {
        return apply_settings_parameter(project.settings_mut(), parameter, track, value);
    }
    let global = project.work_buffer_mut().global_mut();
    match section {
        "routing" => {
            let routing = global.routing_mut();
            match parameter {
                "route_to_main" => {
                    let track_index = required_track_index(track, parameter)?;
                    let flags = set_track_flag(
                        routing.raw_route_to_main_flags(),
                        track_index,
                        control_bool(value, "value")?,
                    );
                    routing.set_route_to_main_flags(flags).map_err(error_string)
                }
                "send_to_fx" => {
                    let track_index = required_track_index(track, parameter)?;
                    let flags = set_track_flag(
                        routing.raw_send_to_fx_flags(),
                        track_index,
                        control_bool(value, "value")?,
                    );
                    routing.set_send_to_fx_flags(flags).map_err(error_string)
                }
                "route_to_main_flags" => routing
                    .set_route_to_main_flags(control_u16(value, "value")?)
                    .map_err(error_string),
                "send_to_fx_flags" => routing
                    .set_send_to_fx_flags(control_u16(value, "value")?)
                    .map_err(error_string),
                "usb_in" => {
                    routing.set_usb_in(parse_enum(value, "value")?);
                    Ok(())
                }
                "usb_out" => {
                    routing.set_usb_out(parse_enum(value, "value")?);
                    Ok(())
                }
                "usb_to_main_db" => {
                    routing.set_usb_to_main_db(parse_enum(value, "value")?);
                    Ok(())
                }
                _ => Err(format!("unsupported routing parameter {parameter:?}")),
            }
        }
        "metronome" => {
            let metronome = global.metronome_settings_mut();
            match parameter {
                "active" => {
                    metronome.set_active(control_bool(value, "value")?);
                    Ok(())
                }
                "time_signature" => {
                    metronome.set_time_signature(parse_enum(value, "value")?);
                    Ok(())
                }
                "pre_roll_bars" => metronome
                    .set_pre_roll_bars(control_usize(value, "value")?)
                    .map_err(error_string),
                "volume" => metronome
                    .set_volume(control_usize(value, "value")?)
                    .map_err(error_string),
                _ => Err(format!("unsupported metronome parameter {parameter:?}")),
            }
        }
        "midi_sync" => {
            let sync = global.midi_config_mut().sync_mut();
            let enabled = control_bool(value, "value")?;
            match parameter {
                "clock_receive" => sync.set_clock_receive(enabled),
                "clock_send" => sync.set_clock_send(enabled),
                "transport_receive" => sync.set_transport_receive(enabled),
                "transport_send" => sync.set_transport_send(enabled),
                "program_change_receive" => sync.set_program_change_receive(enabled),
                "program_change_send" => sync.set_program_change_send(enabled),
                _ => return Err(format!("unsupported MIDI sync parameter {parameter:?}")),
            }
            Ok(())
        }
        "midi_port" => {
            let port = global.midi_config_mut().port_config_mut();
            match parameter {
                "output_port_function" => {
                    port.set_output_port_function(parse_enum(value, "value")?)
                }
                "thru_port_function" => port.set_thru_port_function(parse_enum(value, "value")?),
                "input_transport" => port.set_input_transport(parse_enum(value, "value")?),
                "output_transport" => port.set_output_transport(parse_enum(value, "value")?),
                "parameter_output_type" => {
                    port.set_parameter_output_type(parse_enum(value, "value")?)
                }
                "receive_notes" => port.set_receive_notes(control_bool(value, "value")?),
                "receive_cc_nrpn" => port.set_receive_cc_nrpn(control_bool(value, "value")?),
                "pad_parameter_destination" => {
                    port.set_pad_parameter_destination(parse_enum(value, "value")?)
                }
                "pressure_parameter_destination" => {
                    port.set_pressure_parameter_destination(parse_enum(value, "value")?)
                }
                "encoder_parameter_destination" => {
                    port.set_encoder_parameter_destination(parse_enum(value, "value")?)
                }
                "mute_parameter_destination" => {
                    port.set_mute_parameter_destination(parse_enum(value, "value")?)
                }
                "ports_output_channel" => {
                    port.set_ports_output_channel(parse_enum(value, "value")?)
                }
                _ => return Err(format!("unsupported MIDI port parameter {parameter:?}")),
            }
            Ok(())
        }
        "midi_channels" => {
            let channels = global.midi_config_mut().channels_mut();
            let channel = parse_midi_channel(value)?;
            match parameter {
                "auto_channel" => channels.set_auto_channel(channel).map_err(error_string),
                "track_channel" => channels
                    .set_track_channel(required_track_index(track, parameter)?, channel)
                    .map_err(error_string),
                "track_fx_channel" => channels.set_track_fx_channel(channel).map_err(error_string),
                "program_change_in_channel" => channels
                    .set_program_change_in_channel(channel)
                    .map_err(error_string),
                "program_change_out_channel" => channels
                    .set_program_change_out_channel(channel)
                    .map_err(error_string),
                "performance_channel" => channels
                    .set_performance_channel(channel)
                    .map_err(error_string),
                _ => Err(format!("unsupported MIDI channel parameter {parameter:?}")),
            }
        }
        "sequencer" => {
            let sequencer = global.sequencer_config_mut();
            let enabled = control_bool(value, "value")?;
            match parameter {
                "kit_reload_on_chg" => sequencer.set_kit_reload_on_chg(enabled),
                "quantize_live_rec" => sequencer.set_quantize_live_rec(enabled),
                "auto_trk_switch" => sequencer.set_auto_trk_switch(enabled),
                _ => return Err(format!("unsupported sequencer parameter {parameter:?}")),
            }
            Ok(())
        }
        _ => Err(format!("unsupported Global section {section:?}")),
    }
}

fn apply_settings_parameter(
    settings: &mut Settings,
    parameter: &str,
    track: &Option<String>,
    value: &Value,
) -> HardwareResult<()> {
    match parameter {
        "tempo" => settings
            .set_bpm(control_f32(value, "value")?)
            .map_err(error_string),
        "selected_track" => {
            let index = track
                .as_ref()
                .map(|track| parse_track_index(track))
                .transpose()?
                .unwrap_or(parse_track_index(control_string(value, "value")?)?);
            settings.set_selected_track(index).map_err(error_string)
        }
        "selected_parameter_menu_item" => {
            settings.set_selected_parameter_menu_item(parse_enum(value, "value")?);
            Ok(())
        }
        "selected_fx_menu_item" => {
            settings.set_selected_fx_menu_item(parse_enum(value, "value")?);
            Ok(())
        }
        "selected_page" => settings
            .set_selected_page(control_usize(value, "value")?)
            .map_err(error_string),
        "selected_mode" => {
            settings.set_selected_mode(parse_enum(value, "value")?);
            Ok(())
        }
        "selected_pattern_mode" => {
            settings.set_selected_pattern_mode(parse_enum(value, "value")?);
            Ok(())
        }
        "mute_flags" => settings
            .set_mute_flags(control_u16(value, "value")?)
            .map_err(error_string),
        "muted" => {
            let track_index = required_track_index(track, parameter)?;
            if control_bool(value, "value")? {
                settings.mute_sound(track_index).map_err(error_string)
            } else {
                settings.unmute_sound(track_index).map_err(error_string)
            }
        }
        "fixed_velocity_enabled" => {
            settings.set_fixed_velocity_enable(control_bool(value, "value")?);
            Ok(())
        }
        "fixed_velocity_amount" => settings
            .set_fixed_velocity_amount(control_usize(value, "value")?)
            .map_err(error_string),
        "sample_recorder_source" => {
            settings.set_sample_recorder_source(parse_enum(value, "value")?);
            Ok(())
        }
        "sample_recorder_threshold" => settings
            .set_sample_recorder_threshold(control_usize(value, "value")?)
            .map_err(error_string),
        "sample_recorder_monitor_enabled" => {
            settings.set_sample_recorder_monitor_enable(control_bool(value, "value")?);
            Ok(())
        }
        "sample_recorder_recording_length" => {
            settings.set_sample_recorder_recording_length(parse_enum(value, "value")?);
            Ok(())
        }
        _ => Err(format!("unsupported Settings parameter {parameter:?}")),
    }
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

pub fn state_summary(project: &RytmProject) -> Value {
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
        // Device Song bytes that decode but fail row access (firmware
        // variance) must not panic the daemon inside every inspect/poll.
        "song": song_summary(project.work_buffer().song(), &SongTarget::WorkBuffer)
            .unwrap_or_else(|error| json!({
                "target": "work_buffer",
                "status": "decode_failed",
                "error": error,
            })),
        "kit": kit_summary(project.work_buffer().kit()),
        "settings": settings_summary(project.settings()),
        "global": global_summary(global),
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
            "performanceChannel": format_midi_channel(channels.performance_channel()),
            "trackFxChannel": format_midi_channel(channels.track_fx_channel()),
            "programChangeInChannel": format_midi_channel(channels.program_change_in_channel()),
            "trackChannels": track_channels
        }
    })
}

fn song_summary(song: &Song, target: &SongTarget) -> HardwareResult<Value> {
    let rows = song
        .rows()
        .map_err(error_string)?
        .into_iter()
        .enumerate()
        .map(|(row_index, row)| {
            let patterns = row
                .patterns()
                .iter()
                .map(|position| {
                    let mask = position.muted_tracks_mask();
                    let muted_tracks = TRACK_NAMES
                        .iter()
                        .enumerate()
                        .filter_map(|(track_index, track)| {
                            (mask & (1 << track_index) != 0).then_some(*track)
                        })
                        .collect::<Vec<_>>();
                    json!({
                        "pattern": pattern_slot(position.pattern()),
                        "mutedTracks": muted_tracks,
                        "mutedTracksMask": mask,
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "row": row_index,
                "repeats": row.repeats(),
                "patterns": patterns,
            })
        })
        .collect::<Vec<_>>();
    let capabilities = song.capabilities();
    Ok(json!({
        "target": target,
        "name": song.name(),
        "rowCount": rows.len(),
        "patternPositionCount": rows.iter().map(|row| row["patterns"].as_array().map_or(0, Vec::len)).sum::<usize>(),
        "rows": rows,
        "capabilities": {
            "name": capabilities.name,
            "rows": capabilities.rows,
            "patternChains": capabilities.pattern_chains,
            "repeats": capabilities.repeats,
            "trackMutes": capabilities.track_mutes,
            "tempoOverrides": capabilities.tempo_overrides,
            "patternLengthOverrides": capabilities.pattern_length_overrides,
            "jumps": capabilities.jumps,
            "loops": capabilities.loops,
            "rowLabels": capabilities.row_labels,
            "explicitEnd": capabilities.explicit_end,
        },
    }))
}

pub fn canonical_state_summary(project: &RytmProject) -> HardwareResult<Value> {
    let mut canonical = RytmProject::try_default().map_err(error_string)?;
    for (name, bytes) in [
        (
            "pattern",
            project
                .work_buffer()
                .pattern()
                .as_sysex()
                .map_err(error_string)?,
        ),
        (
            "kit",
            project
                .work_buffer()
                .kit()
                .as_sysex()
                .map_err(error_string)?,
        ),
        (
            "global",
            project
                .work_buffer()
                .global()
                .as_sysex()
                .map_err(error_string)?,
        ),
        (
            "settings",
            project.settings().as_sysex().map_err(error_string)?,
        ),
        (
            "song",
            project
                .work_buffer()
                .song()
                .as_sysex()
                .map_err(error_string)?,
        ),
    ] {
        canonical
            .update_from_sysex_response(&bytes)
            .map_err(|error| firmware_decode_error(name, error))?;
    }
    Ok(state_summary(&canonical))
}

fn kit_summary(kit: &Kit) -> Value {
    let retrig = (0..12)
        .filter_map(|track_index| {
            kit.track_retrig_settings(track_index).ok().map(|settings| {
                json!({
                    "track": TRACK_NAMES[track_index],
                    "parameters": serialize_value(settings),
                })
            })
        })
        .collect::<Vec<_>>();
    let sounds = kit
        .sounds()
        .iter()
        .enumerate()
        .map(|(track_index, sound)| sound_summary(sound, track_index))
        .collect::<Vec<_>>();
    json!({
        "index": kit.index(),
        "name": kit.name().trim_end_matches('\0'),
        "structureVersion": kit.structure_version(),
        "trackLevels": kit.track_levels(),
        "retrig": retrig,
        "sounds": sounds,
        "fx": {
            "delay": serialize_value(kit.fx_delay()),
            "reverb": serialize_value(kit.fx_reverb()),
            "distortion": serialize_value(kit.fx_distortion()),
            "compressor": serialize_value(kit.fx_compressor()),
            "lfo": serialize_value(kit.fx_lfo()),
        },
        "controlInputs": {
            "input1": [
                control_input_slot(kit.control_in_1_mod_target_1(), kit.control_in_1_mod_amt_1()),
                control_input_slot(kit.control_in_1_mod_target_2(), kit.control_in_1_mod_amt_2()),
                control_input_slot(kit.control_in_1_mod_target_3(), kit.control_in_1_mod_amt_3()),
                control_input_slot(kit.control_in_1_mod_target_4(), kit.control_in_1_mod_amt_4()),
            ],
            "input2": [
                control_input_slot(kit.control_in_2_mod_target_1(), kit.control_in_2_mod_amt_1()),
                control_input_slot(kit.control_in_2_mod_target_2(), kit.control_in_2_mod_amt_2()),
                control_input_slot(kit.control_in_2_mod_target_3(), kit.control_in_2_mod_amt_3()),
                control_input_slot(kit.control_in_2_mod_target_4(), kit.control_in_2_mod_amt_4()),
            ],
        },
        "macros": macro_summary(kit),
    })
}

fn macro_summary(kit: &Kit) -> Value {
    let scenes = kit
        .scene_definitions()
        .definitions()
        .into_iter()
        .map(|definition| {
            let locks = definition
                .locks()
                .iter()
                .map(|lock| {
                    json!({
                        "track": macro_track_name(lock.track()),
                        "page": format!("{:?}", lock.parameter().page()).to_ascii_lowercase(),
                        "parameter": lock.parameter().name(),
                        "rawParameterId": lock.parameter().raw_id(),
                        "value": lock.value(),
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "id": definition.id() + 1,
                "lockCount": definition.lock_count(),
                "unknownLockCount": definition.unknown_locks().len(),
                "locks": locks,
            })
        })
        .collect::<Vec<_>>();
    let performances = kit
        .performance_definitions()
        .definitions()
        .into_iter()
        .map(|definition| {
            let locks = definition
                .locks()
                .iter()
                .map(|lock| {
                    json!({
                        "track": macro_track_name(lock.track()),
                        "page": format!("{:?}", lock.parameter().page()).to_ascii_lowercase(),
                        "parameter": lock.parameter().name(),
                        "rawParameterId": lock.parameter().raw_id(),
                        "depth": lock.depth(),
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "id": definition.id() + 1,
                "lockCount": definition.lock_count(),
                "unknownLockCount": definition.unknown_locks().len(),
                "locks": locks,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "activeScene": kit.current_scene_id().map(|id| id + 1),
        "activeSceneRaw": kit.current_scene_id_raw(),
        "scenes": scenes,
        "performances": performances,
        "sceneLockCount": kit.scene_definitions().lock_count(),
        "performanceLockCount": kit.performance_definitions().lock_count(),
    })
}

fn macro_track_name(track: MacroTrack) -> &'static str {
    match track {
        MacroTrack::Voice(index) => TRACK_NAMES[usize::from(index)],
        MacroTrack::Fx => "FX",
    }
}

fn sound_summary(sound: &Sound, track_index: usize) -> Value {
    let machine: &str = sound.machine_type().into();
    json!({
        "track": TRACK_NAMES[track_index],
        "name": sound.name().trim_end_matches('\0'),
        "structureVersion": sound.structure_version(),
        "machine": machine,
        "machineParameters": serialize_value(sound.machine_parameters()),
        "accentLevel": sound.accent_level(),
        "sample": serialize_value(sound.sample()),
        "filter": serialize_value(sound.filter()),
        "amp": serialize_value(sound.amplitude()),
        "lfo": serialize_value(sound.lfo()),
        "settings": serialize_value(sound.settings()),
    })
}

fn settings_summary(settings: &Settings) -> Value {
    json!({
        "structureVersion": settings.structure_version(),
        "tempo": settings.bpm(),
        // The selected-track index is decoded from device SysEx and can name
        // the FX track (12) or an unexpected value; never index unchecked.
        "selectedTrack": match settings.selected_track() {
            12 => "FX",
            index => TRACK_NAMES.get(index).copied().unwrap_or("unknown"),
        },
        "selectedParameterMenuItem": serialize_value(&settings.selected_parameter_menu_item()),
        "selectedFxMenuItem": serialize_value(&settings.selected_fx_menu_item()),
        "selectedPage": settings.selected_page(),
        "selectedMode": serialize_value(&settings.selected_mode()),
        "selectedPatternMode": serialize_value(&settings.selected_pattern_mode()),
        "muteFlags": settings.raw_mute_flags(),
        "mutedTracks": settings.muted_sound_indexes()
            .into_iter()
            .filter_map(|index| TRACK_NAMES.get(index).copied())
            .collect::<Vec<_>>(),
        "fixedVelocity": {
            "enabled": settings.fixed_velocity_enabled(),
            "amount": settings.fixed_velocity_amount(),
        },
        "sampleRecorder": {
            "source": serialize_value(&settings.sample_recorder_source()),
            "threshold": settings.sample_recorder_threshold(),
            "monitorEnabled": settings.sample_recorder_monitor_enabled(),
            "recordingLength": serialize_value(&settings.sample_recorder_recording_length()),
        },
    })
}

fn global_summary(global: &Global) -> Value {
    json!({
        "index": global.index(),
        "structureVersion": global.structure_version(),
        "metronome": serialize_value(global.metronome_settings()),
        "midi": serialize_value(global.midi_config()),
        "sequencer": serialize_value(global.sequencer_config()),
        "routing": {
            "routeToMainFlags": global.routing().raw_route_to_main_flags(),
            "tracksRoutedToMain": global.routing().track_indexes_routed_to_main()
                .into_iter().filter_map(|index| TRACK_NAMES.get(index).copied()).collect::<Vec<_>>(),
            "sendToFxFlags": global.routing().raw_send_to_fx_flags(),
            "tracksSentToFx": global.routing().track_indexes_sent_to_fx()
                .into_iter().filter_map(|index| TRACK_NAMES.get(index).copied()).collect::<Vec<_>>(),
            "usbIn": serialize_value(&global.routing().usb_in()),
            "usbOut": serialize_value(&global.routing().usb_out()),
            "usbToMainDb": serialize_value(&global.routing().usb_to_main_db()),
        },
    })
}

fn control_input_slot(target: impl Serialize, amount: isize) -> Value {
    json!({ "target": serialize_value(&target), "amount": amount })
}

fn serialize_value(value: &impl Serialize) -> Value {
    serde_json::to_value(value)
        .unwrap_or_else(|error| json!({ "serializationError": error.to_string() }))
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
                    let condition: &str = swap_fill_condition(trig.trig_condition().into());
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

pub fn send_cc(
    session: &mut RytmMidiSession,
    channel: u8,
    controller: u8,
    value: u8,
) -> HardwareResult<()> {
    session.send(&[0xB0 | channel, controller, value])
}

pub fn send_nrpn(
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

fn parse_track_index(track: &str) -> HardwareResult<usize> {
    TRACK_NAMES
        .iter()
        .position(|candidate| candidate.eq_ignore_ascii_case(track))
        .ok_or_else(|| format!("track must be one of {}", TRACK_NAMES.join(", ")))
}

fn required_track_index(track: &Option<String>, parameter: &str) -> HardwareResult<usize> {
    track
        .as_deref()
        .ok_or_else(|| format!("track is required for {parameter:?}"))
        .and_then(parse_track_index)
}

fn control_string<'a>(value: &'a Value, label: &str) -> HardwareResult<&'a str> {
    value
        .as_str()
        .ok_or_else(|| format!("{label} must be a string"))
}

fn control_bool(value: &Value, label: &str) -> HardwareResult<bool> {
    value
        .as_bool()
        .ok_or_else(|| format!("{label} must be a boolean"))
}

fn control_usize(value: &Value, label: &str) -> HardwareResult<usize> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("{label} must be a non-negative integer"))
}

fn control_u16(value: &Value, label: &str) -> HardwareResult<u16> {
    value
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| format!("{label} must be an integer between 0 and 65535"))
}

fn control_isize(value: &Value, label: &str) -> HardwareResult<isize> {
    value
        .as_i64()
        .and_then(|value| isize::try_from(value).ok())
        .ok_or_else(|| format!("{label} must be an integer"))
}

fn control_f32(value: &Value, label: &str) -> HardwareResult<f32> {
    let value = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| format!("{label} must be a finite number"))?;
    if value < f64::from(f32::MIN) || value > f64::from(f32::MAX) {
        return Err(format!("{label} is outside the supported numeric range"));
    }
    Ok(value as f32)
}

fn parse_enum<T: DeserializeOwned>(value: &Value, label: &str) -> HardwareResult<T> {
    serde_json::from_value(value.clone())
        .map_err(|error| format!("{label} is not a supported enum value: {error}"))
}

fn parse_midi_channel(value: &Value) -> HardwareResult<MidiChannel> {
    if let Some(value) = value.as_str() {
        return match value.to_ascii_lowercase().as_str() {
            "auto" => Ok(MidiChannel::Auto),
            "off" => Ok(MidiChannel::Off),
            _ => Err("MIDI channel must be auto, off, or an integer from 1 through 16".to_string()),
        };
    }
    let channel = control_usize(value, "value")?;
    if !(1..=16).contains(&channel) {
        return Err("MIDI channel must be auto, off, or an integer from 1 through 16".to_string());
    }
    Ok(MidiChannel::Channel(channel - 1))
}

fn set_track_flag(flags: u16, track_index: usize, enabled: bool) -> u16 {
    if enabled {
        flags | (1 << track_index)
    } else {
        flags & !(1 << track_index)
    }
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

    #[test]
    fn declarative_object_operations_cover_every_supported_page_family() {
        let operations: Vec<PersistentOperation> = serde_json::from_value(json!([
            { "type": "set_track_machine", "track": "BD", "machine": "bdclassic" },
            { "type": "set_sound_parameter", "track": "BD", "page": "machine", "parameter": "lev", "value": 91 },
            { "type": "set_kit_parameter", "track": "BD", "parameter": "track_level", "value": 90 },
            { "type": "set_kit_parameter", "track": "BD", "parameter": "retrig.velocity_curve", "value": 5 },
            { "type": "set_kit_parameter", "track": "BD", "parameter": "retrig.always_on", "value": true },
            { "type": "set_sound_parameter", "track": "BD", "page": "sample", "parameter": "tune", "value": -12 },
            { "type": "set_sound_parameter", "track": "BD", "page": "filter", "parameter": "cutoff", "value": 90 },
            { "type": "set_sound_parameter", "track": "BD", "page": "amp", "parameter": "pan", "value": -10 },
            { "type": "set_sound_parameter", "track": "BD", "page": "lfo", "parameter": "speed", "value": 12 },
            { "type": "set_sound_parameter", "track": "BD", "page": "settings", "parameter": "env_reset_filter", "value": false },
            { "type": "set_fx_parameter", "effect": "delay", "parameter": "feedback", "value": 33 },
            { "type": "set_fx_parameter", "effect": "reverb", "parameter": "decay", "value": 44 },
            { "type": "set_fx_parameter", "effect": "distortion", "parameter": "amount", "value": 11 },
            { "type": "set_fx_parameter", "effect": "compressor", "parameter": "threshold", "value": 80 },
            { "type": "set_fx_parameter", "effect": "lfo", "parameter": "speed", "value": -5 },
            { "type": "set_global_parameter", "section": "routing", "parameter": "route_to_main", "track": "BD", "value": false },
            { "type": "set_global_parameter", "section": "metronome", "parameter": "active", "value": true },
            { "type": "set_global_parameter", "section": "midi_sync", "parameter": "clock_send", "value": true },
            { "type": "set_global_parameter", "section": "midi_port", "parameter": "receive_notes", "value": false },
            { "type": "set_global_parameter", "section": "midi_channels", "parameter": "auto_channel", "value": 16 },
            { "type": "set_global_parameter", "section": "sequencer", "parameter": "quantize_live_rec", "value": true },
            { "type": "set_global_parameter", "section": "settings", "parameter": "tempo", "value": 131.0 }
        ]))
        .unwrap();
        let mut capture = StateCapture {
            project: RytmProject::try_default().unwrap(),
            pattern_raw: Vec::new(),
            kit_raw: Vec::new(),
            global_raw: Vec::new(),
            settings_raw: Vec::new(),
            song_raw: BTreeMap::from([("work_buffer".to_string(), Vec::new())]),
        };

        let changed = apply_persistent_operations(&mut capture, &operations).unwrap();
        assert!(changed.kit);
        assert!(changed.global);
        assert!(changed.settings);
        let summary = state_summary(&capture.project);
        assert_eq!(summary["kit"]["trackLevels"][0], 90);
        assert_eq!(
            summary["kit"]["retrig"][0]["parameters"]["velocity_curve"],
            5
        );
        assert_eq!(summary["kit"]["sounds"][0]["machine"], "bdclassic");
        assert_eq!(
            summary["kit"]["sounds"][0]["machineParameters"]["BdClassic"]["lev"],
            91
        );
        assert_eq!(summary["kit"]["sounds"][0]["sample"]["tune"], -12);
        assert_eq!(summary["kit"]["sounds"][0]["filter"]["cutoff"], 90);
        assert_eq!(summary["kit"]["sounds"][0]["amp"]["pan"], -10);
        assert_eq!(summary["kit"]["sounds"][0]["lfo"]["speed"], 12);
        assert_eq!(summary["kit"]["fx"]["delay"]["feedback"], 33);
        assert_eq!(summary["global"]["routing"]["routeToMainFlags"], 4094);
        assert_eq!(summary["global"]["metronome"]["active"], true);
        assert_eq!(summary["settings"]["tempo"], 131.0);

        let second = apply_persistent_operations(&mut capture, &operations).unwrap();
        assert!(!second.any());
    }

    #[test]
    fn pattern_delta_operations_mutate_idempotently_and_validate_work_buffer_slot() {
        let operations: Vec<PersistentOperation> = serde_json::from_value(json!([
            { "type": "set_track_length", "pattern": "A01", "track": "BD", "steps": 16 },
            {
                "type": "set_trig",
                "pattern": "A01",
                "track": "BD",
                "step": 4,
                "velocity": 111,
                "microTiming": 2,
                "condition": "1:2",
                "retrig": true
            },
            {
                "type": "set_parameter_lock",
                "pattern": "A01",
                "track": "BD",
                "step": 4,
                "parameter": "filter_frequency",
                "value": 92
            }
        ]))
        .unwrap();
        let mut capture = StateCapture {
            project: RytmProject::try_default().unwrap(),
            pattern_raw: Vec::new(),
            kit_raw: Vec::new(),
            global_raw: Vec::new(),
            settings_raw: Vec::new(),
            song_raw: BTreeMap::from([("work_buffer".to_string(), Vec::new())]),
        };

        let changed = apply_persistent_operations(&mut capture, &operations).unwrap();
        assert!(changed.pattern);
        let summary = state_summary(&capture.project);
        let trig = &summary["pattern"]["tracks"][0]["trigs"][0];
        assert_eq!(trig["step"], 4);
        assert_eq!(trig["velocity"], 111);
        assert_eq!(trig["microTiming"], 2);
        assert_eq!(trig["condition"], "1:2");
        assert_eq!(trig["filterCutoffLock"], 92);

        let second = apply_persistent_operations(&mut capture, &operations).unwrap();
        assert!(!second.any());

        let wrong_slot: PersistentOperation = serde_json::from_value(json!({
            "type": "set_trig",
            "pattern": "B01",
            "track": "BD",
            "step": 0
        }))
        .unwrap();
        assert!(
            apply_persistent_operation(&mut capture.project, &wrong_slot)
                .unwrap_err()
                .contains("work buffer contains A01")
        );
    }

    #[test]
    fn sample_identity_cannot_be_bypassed_through_sound_page_mutation() {
        let operation: PersistentOperation = serde_json::from_value(json!({
            "type": "set_sound_parameter",
            "track": "BD",
            "page": "sample",
            "parameter": "number",
            "value": 12
        }))
        .unwrap();
        let mut project = RytmProject::try_default().unwrap();
        assert!(apply_persistent_operation(&mut project, &operation)
            .unwrap_err()
            .contains("assign_sample_slot"));
    }

    #[test]
    fn typed_macro_operations_cover_voice_and_fx_targets_idempotently() {
        let operations: Vec<PersistentOperation> = serde_json::from_value(json!([
            {
                "type": "replace_scene",
                "scene": 1,
                "locks": [
                    { "track": "BD", "parameter": "sample_tune", "value": 65 },
                    { "track": "FX", "parameter": "delay_feedback", "value": 80 }
                ]
            },
            { "type": "copy_scene", "sourceScene": 1, "targetScene": 2 },
            { "type": "clear_scene", "scene": 1 },
            {
                "type": "replace_performance",
                "performance": 1,
                "locks": [
                    { "track": "SD", "parameter": "amp_pan", "depth": -32 },
                    { "track": "FX", "parameter": "reverb_decay", "depth": 24 }
                ]
            },
            { "type": "copy_performance", "sourcePerformance": 1, "targetPerformance": 2 },
            { "type": "clear_performance", "performance": 1 }
        ]))
        .unwrap();
        let mut capture = StateCapture {
            project: RytmProject::try_default().unwrap(),
            pattern_raw: Vec::new(),
            kit_raw: Vec::new(),
            global_raw: Vec::new(),
            settings_raw: Vec::new(),
            song_raw: BTreeMap::from([("work_buffer".to_string(), Vec::new())]),
        };

        let changed = apply_persistent_operations(&mut capture, &operations).unwrap();
        assert!(changed.kit);
        let macros = &state_summary(&capture.project)["kit"]["macros"];
        assert_eq!(macros["scenes"][0]["lockCount"], 0);
        assert_eq!(macros["scenes"][1]["lockCount"], 2);
        assert_eq!(macros["scenes"][1]["locks"][0]["track"], "BD");
        assert_eq!(macros["scenes"][1]["locks"][0]["parameter"], "sample_tune");
        assert_eq!(macros["scenes"][1]["locks"][0]["value"], 65);
        assert_eq!(macros["scenes"][1]["locks"][1]["track"], "FX");
        assert_eq!(macros["performances"][0]["lockCount"], 0);
        assert_eq!(macros["performances"][1]["lockCount"], 2);
        assert_eq!(macros["performances"][1]["locks"][0]["track"], "SD");
        assert_eq!(macros["performances"][1]["locks"][0]["depth"], -32);
        assert_eq!(macros["performances"][1]["locks"][1]["track"], "FX");

        let second = apply_persistent_operations(&mut capture, &operations).unwrap();
        assert!(!second.any());

        let invalid: PersistentOperation = serde_json::from_value(json!({
            "type": "set_scene_lock",
            "scene": 1,
            "track": "FX",
            "parameter": "sample_tune",
            "value": 65
        }))
        .unwrap();
        assert!(apply_persistent_operation(&mut capture.project, &invalid)
            .unwrap_err()
            .contains("unsupported macro parameter"));
    }

    #[test]
    fn typed_song_operations_cover_row_lifecycle_idempotently() {
        let operations: Vec<PersistentOperation> = serde_json::from_value(json!([
            {
                "type": "replace_song",
                "name": "AGENT SONG",
                "rows": [
                    { "repeats": 2, "patterns": [{ "pattern": "A01" }, { "pattern": "A02", "mutedTracks": ["BD"] }] },
                    { "repeats": 1, "patterns": [{ "pattern": "B01" }] }
                ]
            },
            {
                "type": "insert_song_row",
                "row": 1,
                "value": { "repeats": 4, "patterns": [{ "pattern": "C01", "mutedTracks": ["SD"] }] }
            },
            {
                "type": "update_song_row",
                "row": 0,
                "value": { "repeats": 3, "patterns": [{ "pattern": "A03" }] }
            },
            { "type": "copy_song_row", "sourceRow": 0, "targetRow": 3 },
            { "type": "move_song_row", "sourceRow": 3, "targetRow": 0 },
            { "type": "remove_song_row", "row": 1 }
        ]))
        .unwrap();
        let mut capture = StateCapture {
            project: RytmProject::try_default().unwrap(),
            pattern_raw: Vec::new(),
            kit_raw: Vec::new(),
            global_raw: Vec::new(),
            settings_raw: Vec::new(),
            song_raw: BTreeMap::from([("work_buffer".to_string(), Vec::new())]),
        };

        let changed = apply_persistent_operations(&mut capture, &operations).unwrap();
        assert_eq!(changed.songs, ["work_buffer"]);
        assert!(!changed.pattern);
        let summary = capture_summary(&capture).unwrap();
        assert_eq!(summary["song"]["name"], "AGENT SONG");
        assert_eq!(summary["song"]["rowCount"], 3);
        assert_eq!(summary["song"]["rows"][0]["patterns"][0]["pattern"], "A03");
        assert_eq!(summary["song"]["rows"][1]["patterns"][0]["pattern"], "C01");
        assert_eq!(
            summary["song"]["rows"][1]["patterns"][0]["mutedTracksMask"],
            2
        );

        let second = apply_persistent_operations(&mut capture, &operations).unwrap();
        assert!(!second.any());
    }

    #[test]
    fn canonical_capture_summary_preserves_stored_song_targets() {
        let mut project = RytmProject::try_default().expect("default project");
        let target = SongTarget::Stored { song: 1 };
        project_song_mut(&mut project, &target)
            .expect("stored Song")
            .set_name("STORED SONG")
            .expect("valid name");
        let capture = StateCapture {
            project,
            pattern_raw: Vec::new(),
            kit_raw: Vec::new(),
            global_raw: Vec::new(),
            settings_raw: Vec::new(),
            song_raw: BTreeMap::from([
                (SongTarget::WorkBuffer.key(), Vec::new()),
                (target.key(), Vec::new()),
            ]),
        };

        let summary = canonical_capture_summary(&capture).expect("canonical capture summary");
        assert_eq!(summary["songs"]["stored:01"]["name"], "STORED SONG");
        assert_eq!(summary["songs"]["stored:01"]["target"]["scope"], "stored");
        assert_eq!(
            summary["songs"]["work_buffer"]["target"]["scope"],
            "work_buffer"
        );
    }
}
