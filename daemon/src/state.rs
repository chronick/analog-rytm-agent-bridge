use crate::samples::SampleService;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    time::{SystemTime, UNIX_EPOCH},
};

const TRACK_NAMES: [&str; 12] = [
    "BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SceneLockInput {
    pub track: String,
    pub parameter: String,
    pub value: u8,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceLockInput {
    pub track: String,
    pub parameter: String,
    pub depth: i8,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "scope", rename_all = "snake_case", deny_unknown_fields)]
pub enum SongTarget {
    #[default]
    WorkBuffer,
    Stored {
        song: u8,
    },
}

impl SongTarget {
    pub fn key(&self) -> String {
        match self {
            Self::WorkBuffer => "work_buffer".to_string(),
            Self::Stored { song } => format!("stored:{song:02}"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SongPatternInput {
    pub pattern: String,
    #[serde(default)]
    pub muted_tracks: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SongRowInput {
    pub patterns: Vec<SongPatternInput>,
    pub repeats: u16,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PersistentOperation {
    SetTrig {
        #[serde(default)]
        pattern: Option<String>,
        track: String,
        step: u8,
        #[serde(default)]
        velocity: Option<u8>,
        #[serde(default, rename = "microTiming")]
        micro_timing: Option<i8>,
        #[serde(default)]
        condition: Option<String>,
        #[serde(default)]
        retrig: Option<bool>,
    },
    ClearTrig {
        #[serde(default)]
        pattern: Option<String>,
        track: String,
        step: u8,
    },
    SetParameterLock {
        #[serde(default)]
        pattern: Option<String>,
        track: String,
        step: u8,
        parameter: String,
        value: Value,
    },
    ClearParameterLock {
        #[serde(default)]
        pattern: Option<String>,
        track: String,
        step: u8,
        parameter: String,
    },
    /// Full parameter-lock pool purge for one pattern (all tracks, all steps).
    ///
    /// Pool-rebuild primitive: resets every pool slot to the unset sentinel,
    /// which also retires slot debris no per-step clear can reach (v1 zero-fill
    /// ghosts baked into claimed slots, orphaned legacy compound companions).
    /// Declarative rebuilds emit this first, then re-author the intended locks.
    ClearPatternPlocks {
        #[serde(default)]
        pattern: Option<String>,
    },
    SetTrackLength {
        #[serde(default)]
        pattern: Option<String>,
        track: String,
        steps: u8,
    },
    SetTrackMachine {
        #[serde(default)]
        pattern: Option<String>,
        track: String,
        machine: String,
    },
    CopyPattern {
        #[serde(rename = "sourcePattern")]
        source_pattern: String,
        #[serde(rename = "targetPattern")]
        target_pattern: String,
    },
    SetKitParameter {
        #[serde(default)]
        track: Option<String>,
        parameter: String,
        value: Value,
    },
    SetSoundParameter {
        track: String,
        page: String,
        parameter: String,
        value: Value,
    },
    SetFxParameter {
        effect: String,
        parameter: String,
        value: Value,
    },
    SetGlobalParameter {
        section: String,
        parameter: String,
        #[serde(default)]
        track: Option<String>,
        value: Value,
    },
    AssignSampleSlot {
        #[serde(default)]
        pattern: Option<String>,
        track: String,
        slot: u8,
        #[serde(rename = "sampleId")]
        sample_id: String,
    },
    SetSceneLock {
        scene: u8,
        track: String,
        parameter: String,
        value: u8,
    },
    ReplaceScene {
        scene: u8,
        locks: Vec<SceneLockInput>,
    },
    ClearScene {
        scene: u8,
    },
    CopyScene {
        #[serde(rename = "sourceScene")]
        source_scene: u8,
        #[serde(rename = "targetScene")]
        target_scene: u8,
    },
    SetPerformanceLock {
        performance: u8,
        track: String,
        parameter: String,
        depth: i8,
    },
    ReplacePerformance {
        performance: u8,
        locks: Vec<PerformanceLockInput>,
    },
    ClearPerformance {
        performance: u8,
    },
    CopyPerformance {
        #[serde(rename = "sourcePerformance")]
        source_performance: u8,
        #[serde(rename = "targetPerformance")]
        target_performance: u8,
    },
    SetSongName {
        #[serde(default)]
        target: SongTarget,
        name: String,
    },
    ReplaceSong {
        #[serde(default)]
        target: SongTarget,
        #[serde(default)]
        name: Option<String>,
        rows: Vec<SongRowInput>,
    },
    InsertSongRow {
        #[serde(default)]
        target: SongTarget,
        row: u8,
        value: SongRowInput,
    },
    UpdateSongRow {
        #[serde(default)]
        target: SongTarget,
        row: u8,
        value: SongRowInput,
    },
    MoveSongRow {
        #[serde(default)]
        target: SongTarget,
        #[serde(rename = "sourceRow")]
        source_row: u8,
        #[serde(rename = "targetRow")]
        target_row: u8,
    },
    CopySongRow {
        #[serde(default)]
        target: SongTarget,
        #[serde(rename = "sourceRow")]
        source_row: u8,
        #[serde(rename = "targetRow")]
        target_row: u8,
    },
    RemoveSongRow {
        #[serde(default)]
        target: SongTarget,
        row: u8,
    },
    ClearSong {
        #[serde(default)]
        target: SongTarget,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApplyAt {
    NextStep {
        #[serde(
            default,
            rename = "transportEpoch",
            skip_serializing_if = "Option::is_none"
        )]
        transport_epoch: Option<String>,
    },
    NextBeat {
        #[serde(
            default,
            rename = "transportEpoch",
            skip_serializing_if = "Option::is_none"
        )]
        transport_epoch: Option<String>,
    },
    NextMeasure {
        #[serde(
            default,
            rename = "transportEpoch",
            skip_serializing_if = "Option::is_none"
        )]
        transport_epoch: Option<String>,
    },
    NextPattern {
        #[serde(
            default,
            rename = "transportEpoch",
            skip_serializing_if = "Option::is_none"
        )]
        transport_epoch: Option<String>,
    },
    PatternStep {
        #[serde(rename = "transportEpoch")]
        transport_epoch: String,
        pattern: String,
        step: u8,
    },
}

impl ApplyAt {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::NextStep { .. } => "next_step",
            Self::NextBeat { .. } => "next_beat",
            Self::NextMeasure { .. } => "next_measure",
            Self::NextPattern { .. } => "next_pattern",
            Self::PatternStep { .. } => "pattern_step",
        }
    }

    pub fn transport_epoch(&self) -> Option<&str> {
        match self {
            Self::NextStep { transport_epoch }
            | Self::NextBeat { transport_epoch }
            | Self::NextMeasure { transport_epoch }
            | Self::NextPattern { transport_epoch } => transport_epoch.as_deref(),
            Self::PatternStep {
                transport_epoch, ..
            } => Some(transport_epoch),
        }
    }

    pub fn with_transport_epoch(&self, epoch: String) -> Self {
        match self {
            Self::NextStep { .. } => Self::NextStep {
                transport_epoch: Some(epoch),
            },
            Self::NextBeat { .. } => Self::NextBeat {
                transport_epoch: Some(epoch),
            },
            Self::NextMeasure { .. } => Self::NextMeasure {
                transport_epoch: Some(epoch),
            },
            Self::NextPattern { .. } => Self::NextPattern {
                transport_epoch: Some(epoch),
            },
            Self::PatternStep { pattern, step, .. } => Self::PatternStep {
                transport_epoch: epoch,
                pattern: pattern.clone(),
                step: *step,
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LatePolicy {
    RollForward,
    Reject,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationSetInput {
    #[serde(default)]
    pub operation_set_id: Option<String>,
    pub expected_revision: u64,
    pub apply_at: ApplyAt,
    pub late_policy: LatePolicy,
    pub operations: Vec<PersistentOperation>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationSetRecord {
    operation_set_id: String,
    expected_revision: u64,
    apply_at: ApplyAt,
    late_policy: LatePolicy,
    operations: Vec<PersistentOperation>,
    status: &'static str,
    submitted_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    queued_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    applied_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    applied_at_boundary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resulting_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rejection_reason: Option<String>,
}

impl OperationSetRecord {
    fn matches(&self, input: &OperationSetInput) -> bool {
        self.expected_revision == input.expected_revision
            && self.apply_at == input.apply_at
            && self.late_policy == input.late_policy
            && self.operations == input.operations
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportState {
    epoch: String,
    playing: bool,
    pattern: String,
    step: u8,
    beat: u64,
    measure: u64,
    steps_per_beat: u8,
    beats_per_measure: u8,
    tempo: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotSummary {
    snapshot_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    revision: u64,
    created_at: String,
    active_pattern: String,
    pattern_count: usize,
}

#[derive(Clone)]
struct SnapshotRecord {
    summary: SnapshotSummary,
    active_pattern: String,
    transport: TransportState,
    patterns: BTreeMap<String, Pattern>,
    songs: BTreeMap<String, MockSong>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEntry {
    pub cursor: u64,
    pub received_at: String,
    pub event: Value,
}

#[derive(Clone, Default, PartialEq)]
struct Pattern {
    slot: String,
    length: u8,
    track_lengths: BTreeMap<String, u8>,
    machines: BTreeMap<String, String>,
    sample_slots: BTreeMap<String, SampleSlot>,
    kit_parameters: BTreeMap<String, Value>,
    trigs: HashMap<String, Trig>,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleSlot {
    slot: u8,
    sample_id: String,
}

#[derive(Clone, PartialEq)]
struct Trig {
    track: String,
    step: u8,
    velocity: u8,
    micro_timing: Option<i8>,
    condition: Option<String>,
    retrig: Option<bool>,
    locks: BTreeMap<String, Value>,
}

#[derive(Clone, Default, PartialEq)]
struct MockSong {
    target: SongTarget,
    name: String,
    rows: Vec<SongRowInput>,
}

pub struct MockBridgeState {
    revision: u64,
    id_counter: u64,
    active_pattern: String,
    transport: TransportState,
    patterns: BTreeMap<String, Pattern>,
    songs: BTreeMap<String, MockSong>,
    operation_sets: Vec<OperationSetRecord>,
    snapshots: Vec<SnapshotRecord>,
    events: Vec<EventEntry>,
    active_scene: Option<u8>,
    performance_amounts: BTreeMap<String, u8>,
    samples: SampleService,
}

impl Default for MockBridgeState {
    fn default() -> Self {
        let active_pattern = "A01".to_string();
        let mut patterns = BTreeMap::new();
        patterns.insert(active_pattern.clone(), empty_pattern(&active_pattern));
        let songs = default_mock_songs();
        Self {
            revision: 0,
            id_counter: 1,
            active_pattern: active_pattern.clone(),
            transport: TransportState {
                epoch: "mock-epoch-1".to_string(),
                playing: false,
                pattern: active_pattern,
                step: 0,
                beat: 0,
                measure: 0,
                steps_per_beat: 4,
                beats_per_measure: 4,
                tempo: 120.0,
            },
            patterns,
            songs,
            operation_sets: Vec::new(),
            snapshots: Vec::new(),
            events: Vec::new(),
            active_scene: None,
            performance_amounts: BTreeMap::new(),
            samples: SampleService::mock(),
        }
    }
}

impl MockBridgeState {
    pub fn inspect_state(&self) -> Value {
        json!({
            "revision": self.revision,
            "device": {
                "model": "Analog Rytm MKII",
                "connected": true,
                "firmware": {
                    "adapter": "mock",
                    "compatibility": "mock",
                    "notes": ["Mock daemon. No MIDI or SysEx transport is open."],
                },
                "activePattern": self.active_pattern,
                "capabilities": capabilities(),
            },
            "transport": self.transport,
            "liveMacros": {
                "activeScene": self.active_scene,
                "activeSceneSource": "mock",
                "performanceAmounts": self.performance_amounts,
                "performanceAmountsSource": "mock",
            },
            "activePattern": self.inspect_pattern(&self.active_pattern).expect("active pattern is valid"),
            "workBufferSong": self.song_summary(&SongTarget::WorkBuffer, false).expect("mock work-buffer Song exists"),
            "operationSets": self.operation_sets,
            "snapshots": self.snapshots.iter().map(|record| &record.summary).collect::<Vec<_>>(),
        })
    }

    pub fn inspect_pattern(&self, slot: &str) -> Result<Value, String> {
        validate_pattern(slot, "pattern")?;
        Ok(pattern_summary(
            self.patterns
                .get(slot)
                .cloned()
                .unwrap_or_else(|| empty_pattern(slot)),
        ))
    }

    pub fn inspect_song(&self, params: &Value) -> Result<Value, String> {
        let (targets, resolve_references) = parse_song_inspect_request(params)?;
        let songs = targets
            .iter()
            .map(|target| self.song_summary(target, resolve_references))
            .collect::<Result<Vec<_>, _>>()?;
        if songs.len() == 1 {
            return Ok(songs.into_iter().next().expect("one Song was requested"));
        }
        Ok(json!({
            "songs": songs,
            "count": songs.len(),
            "capabilities": song_capabilities(),
        }))
    }

    fn song_summary(&self, target: &SongTarget, resolve_references: bool) -> Result<Value, String> {
        let song = self
            .songs
            .get(&target.key())
            .ok_or_else(|| format!("unknown Song target: {}", target.key()))?;
        let mut summary = mock_song_summary(song);
        if resolve_references {
            let references = song_pattern_slots(&song.rows)
                .into_iter()
                .map(|slot| {
                    let pattern = self
                        .patterns
                        .get(&slot)
                        .cloned()
                        .unwrap_or_else(|| empty_pattern(&slot));
                    json!({
                        "pattern": slot,
                        "available": true,
                        "kitNumber": 0,
                        "kitName": "MOCK KIT",
                        "patternLength": pattern.length,
                    })
                })
                .collect::<Vec<_>>();
            summary["references"] = json!(references);
        }
        Ok(summary)
    }

    pub fn inspect_kit(&self) -> Value {
        json!({
            "index": 0,
            "name": "MOCK KIT",
            "structureVersion": 5,
            "trackLevels": vec![100; 12],
            "retrig": TRACK_NAMES.iter().map(|track| json!({
                "track": track,
                "parameters": { "rate": "R1_16", "length": 0, "velocityCurve": 0, "alwaysOn": false },
            })).collect::<Vec<_>>(),
            "sounds": TRACK_NAMES.iter().enumerate().map(|(index, _)| self.inspect_sound(index)).collect::<Vec<_>>(),
            "fx": {
                "delay": {}, "reverb": {}, "distortion": {}, "compressor": {}, "lfo": {},
            },
            "controlInputs": { "input1": [], "input2": [] },
            "macros": mock_macro_summary(
                self.patterns.get(&self.active_pattern).expect("active pattern exists"),
                self.active_scene,
            ),
        })
    }

    pub fn inspect_sound(&self, track_index: usize) -> Value {
        json!({
            "track": TRACK_NAMES[track_index],
            "name": format!("MOCK {}", TRACK_NAMES[track_index]),
            "structureVersion": 5,
            "machine": if track_index == 0 { "bdhard" } else { "unset" },
            "machineParameters": {},
            "accentLevel": 32,
            "sample": {},
            "filter": {},
            "amp": {},
            "lfo": {},
            "settings": {},
        })
    }

    pub fn inspect_global(&self) -> Value {
        json!({
            "global": {
                "index": 0,
                "structureVersion": 5,
                "metronome": {},
                "midi": {},
                "sequencer": {},
                "routing": {
                    "routeToMainFlags": 4095,
                    "tracksRoutedToMain": TRACK_NAMES,
                    "sendToFxFlags": 4095,
                    "tracksSentToFx": TRACK_NAMES,
                    "usbIn": "Stereo",
                    "usbOut": "Stereo",
                    "usbToMainDb": "Zero",
                },
            },
            "settings": {
                "structureVersion": 5,
                "tempo": self.transport.tempo,
                "selectedTrack": TRACK_NAMES[0],
                "fixedVelocity": { "enabled": false, "amount": 100 },
            },
        })
    }

    pub fn validate(&mut self, params: &Value) -> Result<Value, String> {
        let raw = required_field(params, "operations")?;
        let generic = validation_result(raw);
        if generic["valid"] != Value::Bool(true) {
            return Ok(generic);
        }
        let operations = parse_operations(raw)?;
        match self.samples.validate_assignments(&operations) {
            Ok(()) => Ok(generic),
            Err(error) => Ok(json!({ "valid": false, "errors": [error], "warnings": [] })),
        }
    }

    pub fn propose(&mut self, params: &Value) -> Result<Value, String> {
        let pattern = optional_field_string(params, "pattern")?
            .unwrap_or(&self.active_pattern)
            .to_string();
        validate_pattern(&pattern, "pattern")?;
        let raw = required_field(params, "operations")?;
        let validation = self.validate(params)?;
        let base = self.inspect_pattern(&pattern)?;
        if validation["valid"] != Value::Bool(true) {
            return Ok(json!({ "validation": validation, "basePattern": base }));
        }
        let operations = parse_operations(raw)?;
        let mut projected_patterns = self.patterns.clone();
        let mut projected_songs = self.songs.clone();
        apply_operations(
            &mut projected_patterns,
            &mut projected_songs,
            &operations,
            &pattern,
        )?;
        let song_target = operation_song_target(&operations)?;
        let mut result = json!({
            "validation": validation,
            "basePattern": base,
            "projectedPattern": pattern_summary(projected_patterns.remove(&pattern).unwrap_or_else(|| empty_pattern(&pattern))),
        });
        if let Some(target) = song_target {
            result["baseSong"] = self.song_summary(&target, false)?;
            result["projectedSong"] = mock_song_summary(
                projected_songs
                    .get(&target.key())
                    .ok_or_else(|| format!("unknown Song target: {}", target.key()))?,
            );
        }
        Ok(result)
    }

    pub fn queue(&mut self, params: &Value) -> Result<Value, String> {
        let input = parse_operation_set(params)?;
        self.samples.validate_assignments(&input.operations)?;
        if let Some(id) = &input.operation_set_id {
            if let Some(existing) = self
                .operation_sets
                .iter()
                .find(|record| record.operation_set_id == *id)
            {
                if !existing.matches(&input) {
                    return Err(format!(
                        "operationSetId already exists with a different payload: {id}"
                    ));
                }
                return serde_json::to_value(existing).map_err(error_string);
            }
        }
        self.ensure_current_revision(input.expected_revision)?;
        if input.dry_run {
            return self.dry_run(&input);
        }

        let id = input
            .operation_set_id
            .clone()
            .unwrap_or_else(|| self.next_id("ops"));
        let now = timestamp();
        let record = OperationSetRecord {
            operation_set_id: id.clone(),
            expected_revision: input.expected_revision,
            apply_at: input.apply_at.clone(),
            late_policy: input.late_policy.clone(),
            operations: input.operations.clone(),
            status: "queued",
            submitted_at: now.clone(),
            queued_at: Some(now.clone()),
            applied_at: None,
            applied_at_boundary: None,
            resulting_revision: None,
            rejection_reason: None,
        };
        self.operation_sets.push(record);
        self.append_event(json!({
            "type": "operation_set.queued",
            "operationSetId": id,
            "applyAt": input.apply_at,
            "queuedAt": now,
        }));
        serde_json::to_value(self.operation_sets.last().expect("record was inserted"))
            .map_err(error_string)
    }

    pub fn apply_now(&mut self, params: &Value) -> Result<Value, String> {
        let mut normalized = params
            .as_object()
            .cloned()
            .ok_or_else(|| "params must be a JSON object".to_string())?;
        normalized
            .entry("applyAt".to_string())
            .or_insert_with(|| json!({ "kind": "next_step" }));
        normalized
            .entry("latePolicy".to_string())
            .or_insert_with(|| json!("reject"));
        let input = parse_operation_set(&Value::Object(normalized))?;
        self.samples.validate_assignments(&input.operations)?;
        if let Some(id) = &input.operation_set_id {
            if let Some(existing) = self
                .operation_sets
                .iter()
                .find(|record| record.operation_set_id == *id)
            {
                if !existing.matches(&input) {
                    return Err(format!(
                        "operationSetId already exists with a different payload: {id}"
                    ));
                }
                return serde_json::to_value(existing).map_err(error_string);
            }
        }
        self.ensure_current_revision(input.expected_revision)?;
        if input.dry_run {
            return self.dry_run(&input);
        }

        let id = input
            .operation_set_id
            .clone()
            .unwrap_or_else(|| self.next_id("ops"));
        let now = timestamp();
        self.operation_sets.push(OperationSetRecord {
            operation_set_id: id,
            expected_revision: input.expected_revision,
            apply_at: input.apply_at,
            late_policy: input.late_policy,
            operations: input.operations,
            status: "queued",
            submitted_at: now.clone(),
            queued_at: Some(now),
            applied_at: None,
            applied_at_boundary: None,
            resulting_revision: None,
            rejection_reason: None,
        });
        let index = self.operation_sets.len() - 1;
        self.apply_record(index, "immediate")?;
        serde_json::to_value(&self.operation_sets[index]).map_err(error_string)
    }

    pub fn advance_transport(&mut self, params: &Value) -> Result<Value, String> {
        let steps = optional_u64(params, "steps")?.unwrap_or(1);
        if !(1..=4096).contains(&steps) {
            return Err("steps must be an integer between 1 and 4096".to_string());
        }
        for _ in 0..steps {
            let previous_step = self.transport.step;
            let pattern_length = self
                .patterns
                .get(&self.active_pattern)
                .map_or(64, |pattern| pattern.length);
            let next_step = (previous_step + 1) % pattern_length;
            let mut boundaries = vec!["next_step"];
            if next_step.is_multiple_of(self.transport.steps_per_beat) {
                boundaries.push("next_beat");
            }
            if next_step
                .is_multiple_of(self.transport.steps_per_beat * self.transport.beats_per_measure)
            {
                boundaries.push("next_measure");
            }
            if next_step == 0 {
                boundaries.push("next_pattern");
            }

            let absolute_step = self.transport.measure
                * u64::from(self.transport.steps_per_beat)
                * u64::from(self.transport.beats_per_measure)
                + u64::from(previous_step)
                + 1;
            self.transport.step = next_step;
            self.transport.beat = u64::from(
                (next_step % (self.transport.steps_per_beat * self.transport.beats_per_measure))
                    / self.transport.steps_per_beat,
            );
            self.transport.measure = absolute_step
                / (u64::from(self.transport.steps_per_beat)
                    * u64::from(self.transport.beats_per_measure));
            self.apply_due(&boundaries)?;
        }
        self.append_event(json!({ "type": "transport.changed", "transport": self.transport }));
        serde_json::to_value(&self.transport).map_err(error_string)
    }

    pub fn set_live_parameter(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        if let Some(track) = object.get("track") {
            validate_track(value_string(track, "track")?)?;
        }
        validate_safe_id(required_string(object, "parameter")?, "parameter")?;
        validate_finite_range(required_f64(object, "value")?, "value", 0.0, 127.0)?;
        if let Some(lane) = object.get("lane") {
            let lane = value_string(lane, "lane")?;
            if lane != "cc" && lane != "nrpn" {
                return Err("lane must be cc or nrpn".to_string());
            }
        }
        self.append_event(json!({ "type": "live.parameter_sent", "input": params }));
        Ok(params.clone())
    }

    pub fn set_active_scene(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let scene = match object.get("scene") {
            Some(Value::Null) => None,
            Some(value) => {
                let scene = value_u64(value, "scene")?;
                validate_u64_range(scene, "scene", 1, 12)?;
                Some(scene as u8)
            }
            None => return Err("params.scene is required".to_string()),
        };
        validate_optional_lane(object)?;
        self.active_scene = scene;
        let result = json!({
            "scene": scene,
            "lane": object.get("lane").cloned().unwrap_or_else(|| json!("cc")),
            "status": "sent",
        });
        self.append_event(json!({ "type": "live.scene_sent", "input": result }));
        Ok(result)
    }

    pub fn set_performance_macro(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let performance = value_u64(
            object
                .get("performance")
                .ok_or_else(|| "params.performance is required".to_string())?,
            "performance",
        )?;
        validate_u64_range(performance, "performance", 1, 12)?;
        let amount = value_u64(
            object
                .get("amount")
                .ok_or_else(|| "params.amount is required".to_string())?,
            "amount",
        )?;
        validate_u64_range(amount, "amount", 0, 127)?;
        validate_optional_lane(object)?;
        self.performance_amounts
            .insert(performance.to_string(), amount as u8);
        let result = json!({
            "performance": performance,
            "amount": amount,
            "lane": object.get("lane").cloned().unwrap_or_else(|| json!("cc")),
            "status": "sent",
        });
        self.append_event(json!({ "type": "live.performance_sent", "input": result }));
        Ok(result)
    }

    pub fn trigger_track(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        validate_track(required_string(object, "track")?)?;
        if let Some(velocity) = object.get("velocity") {
            validate_u64_range(value_u64(velocity, "velocity")?, "velocity", 1, 127)?;
        }
        if let Some(duration) = object.get("durationMs") {
            validate_u64_range(value_u64(duration, "durationMs")?, "durationMs", 1, 60_000)?;
        }
        self.append_event(json!({ "type": "track.triggered", "input": params }));
        Ok(params.clone())
    }

    pub fn set_transport(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let command = required_string(object, "command")?;
        if !["start", "stop", "continue"].contains(&command) {
            return Err("command must be start, stop, or continue".to_string());
        }
        if let Some(tempo) = object.get("tempo") {
            self.transport.tempo =
                validate_finite_range(value_f64(tempo, "tempo")?, "tempo", 30.0, 300.0)?;
        }
        self.transport.playing = command != "stop";
        if command == "start" {
            self.transport.epoch = self.next_id("epoch");
        }
        self.append_event(json!({ "type": "transport.changed", "transport": self.transport }));
        serde_json::to_value(&self.transport).map_err(error_string)
    }

    pub fn change_pattern(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let pattern = required_string(object, "pattern")?;
        validate_pattern(pattern, "pattern")?;
        let immediate = object
            .get("immediate")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| "immediate must be a boolean".to_string())
            })
            .transpose()?
            .unwrap_or(false);
        self.patterns
            .entry(pattern.to_string())
            .or_insert_with(|| empty_pattern(pattern));
        self.active_pattern = pattern.to_string();
        self.transport.pattern = pattern.to_string();
        if immediate {
            self.transport.step = 0;
        }
        self.append_event(json!({
            "type": "pattern.changed",
            "pattern": pattern,
            "transport": self.transport,
        }));
        serde_json::to_value(&self.transport).map_err(error_string)
    }

    pub fn create_snapshot(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let requested_id = object
            .get("snapshotId")
            .map(|value| value_string(value, "snapshotId"))
            .transpose()?;
        if let Some(id) = requested_id {
            validate_safe_id(id, "snapshotId")?;
            if let Some(existing) = self
                .snapshots
                .iter()
                .find(|record| record.summary.snapshot_id == id)
            {
                return serde_json::to_value(&existing.summary).map_err(error_string);
            }
        }
        let label = object
            .get("label")
            .map(|value| value_string(value, "label"))
            .transpose()?;
        if label.is_some_and(|value| value.chars().count() > 80) {
            return Err("label must be 80 characters or fewer".to_string());
        }
        let snapshot_id = requested_id
            .map(str::to_string)
            .unwrap_or_else(|| self.next_id("snapshot"));
        let summary = SnapshotSummary {
            snapshot_id,
            label: label.map(str::to_string),
            revision: self.revision,
            created_at: timestamp(),
            active_pattern: self.active_pattern.clone(),
            pattern_count: self.patterns.len(),
        };
        self.snapshots.push(SnapshotRecord {
            summary: summary.clone(),
            active_pattern: self.active_pattern.clone(),
            transport: self.transport.clone(),
            patterns: self.patterns.clone(),
            songs: self.songs.clone(),
        });
        self.append_event(json!({ "type": "snapshot.created", "snapshot": summary }));
        serde_json::to_value(summary).map_err(error_string)
    }

    pub fn rollback_snapshot(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let snapshot_id = required_string(object, "snapshotId")?;
        if let Some(expected) = object.get("expectedRevision") {
            self.ensure_current_revision(value_u64(expected, "expectedRevision")?)?;
        }
        let snapshot = self
            .snapshots
            .iter()
            .find(|record| record.summary.snapshot_id == snapshot_id)
            .cloned()
            .ok_or_else(|| format!("unknown snapshot: {snapshot_id}"))?;
        self.patterns = snapshot.patterns;
        self.songs = snapshot.songs;
        self.active_pattern = snapshot.active_pattern.clone();
        self.transport = snapshot.transport;
        self.transport.pattern = snapshot.active_pattern;
        self.revision += 1;
        self.append_event(json!({
            "type": "snapshot.rolled_back",
            "snapshotId": snapshot_id,
            "revision": self.revision,
            "pattern": self.active_pattern,
        }));
        Ok(self.inspect_state())
    }

    pub fn read_events(&self, params: &Value) -> Result<Value, String> {
        let after = optional_u64(params, "afterCursor")?.unwrap_or(0);
        let limit = optional_u64(params, "limit")?.unwrap_or(100);
        if !(1..=1000).contains(&limit) {
            return Err("limit must be an integer between 1 and 1000".to_string());
        }
        Ok(json!(self
            .events
            .iter()
            .filter(|entry| entry.cursor > after)
            .take(limit as usize)
            .collect::<Vec<_>>()))
    }

    pub fn reconcile(&self) -> Value {
        json!({
            "status": "converged",
            "changed": false,
            "revision": self.revision,
            "activePattern": self.active_pattern,
            "pendingOperationSets": self.operation_sets.iter().filter(|record| record.status == "queued").count(),
        })
    }

    pub fn inspect_samples(&mut self, params: &Value) -> Result<Value, String> {
        self.samples.inspect(params)
    }

    pub fn upload_sample(&mut self, params: &Value) -> Result<Value, String> {
        let result = self.samples.upload(params)?;
        self.append_event(json!({ "type": "sample.uploaded", "sample": result }));
        Ok(result)
    }

    pub fn resolve_sample_ram(&mut self, params: &Value) -> Result<Value, String> {
        let result = self.samples.resolve_ram(params)?;
        self.append_event(json!({ "type": "sample.ram_resolved", "sample": result }));
        Ok(result)
    }

    pub fn clear_sample_ram(&mut self, params: &Value) -> Result<Value, String> {
        let result = self.samples.clear_ram(params)?;
        self.append_event(json!({ "type": "sample.ram_cleared", "sample": result }));
        Ok(result)
    }

    pub fn events_after(&self, cursor: u64) -> Vec<EventEntry> {
        self.events
            .iter()
            .filter(|entry| entry.cursor > cursor)
            .cloned()
            .collect()
    }

    fn dry_run(&self, input: &OperationSetInput) -> Result<Value, String> {
        let mut projected_patterns = self.patterns.clone();
        let mut projected_songs = self.songs.clone();
        apply_operations(
            &mut projected_patterns,
            &mut projected_songs,
            &input.operations,
            &self.active_pattern,
        )?;
        let changed = projected_patterns != self.patterns || projected_songs != self.songs;
        let mut result = json!({
            "operationSetId": input.operation_set_id,
            "expectedRevision": input.expected_revision,
            "applyAt": input.apply_at,
            "latePolicy": input.late_policy,
            "operations": input.operations,
            "status": "dry_run",
            "validation": { "valid": true, "errors": [], "warnings": [] },
            "projectedRevision": self.revision + u64::from(changed),
            "projectedPattern": pattern_summary(projected_patterns.remove(&self.active_pattern).unwrap_or_else(|| empty_pattern(&self.active_pattern))),
        });
        if let Some(target) = operation_song_target(&input.operations)? {
            result["projectedSong"] = mock_song_summary(
                projected_songs
                    .get(&target.key())
                    .ok_or_else(|| format!("unknown Song target: {}", target.key()))?,
            );
        }
        Ok(result)
    }

    fn ensure_current_revision(&self, expected: u64) -> Result<(), String> {
        if expected != self.revision {
            return Err(format!(
                "expected revision {expected}, current revision is {}",
                self.revision
            ));
        }
        Ok(())
    }

    fn apply_due(&mut self, boundaries: &[&str]) -> Result<(), String> {
        for index in 0..self.operation_sets.len() {
            if self.operation_sets[index].status != "queued" {
                continue;
            }
            let boundary = match &self.operation_sets[index].apply_at {
                ApplyAt::PatternStep {
                    transport_epoch,
                    pattern,
                    step,
                } if transport_epoch == &self.transport.epoch
                    && pattern == &self.transport.pattern
                    && step == &self.transport.step =>
                {
                    Some("next_step")
                }
                apply_at if boundaries.contains(&apply_at.kind()) => Some(apply_at.kind()),
                _ => None,
            };
            let Some(boundary) = boundary else {
                continue;
            };
            if self.operation_sets[index].expected_revision != self.revision {
                let reason = format!(
                    "expected revision {}, current revision is {}",
                    self.operation_sets[index].expected_revision, self.revision
                );
                self.operation_sets[index].status = "rejected";
                self.operation_sets[index].rejection_reason = Some(reason.clone());
                let id = self.operation_sets[index].operation_set_id.clone();
                self.append_event(json!({
                    "type": "operation_set.rejected",
                    "operationSetId": id,
                    "reason": reason,
                }));
                continue;
            }
            self.apply_record(index, boundary)?;
        }
        Ok(())
    }

    fn apply_record(&mut self, index: usize, boundary: &str) -> Result<(), String> {
        let operations = self.operation_sets[index].operations.clone();
        self.samples.validate_assignments(&operations)?;
        let before_patterns = self.patterns.clone();
        let before_songs = self.songs.clone();
        apply_operations(
            &mut self.patterns,
            &mut self.songs,
            &operations,
            &self.active_pattern,
        )?;
        let changed = self.patterns != before_patterns || self.songs != before_songs;
        self.revision += u64::from(changed);
        let now = timestamp();
        let id = self.operation_sets[index].operation_set_id.clone();
        self.operation_sets[index].status = "applied";
        self.operation_sets[index].applied_at = Some(now.clone());
        self.operation_sets[index].applied_at_boundary = Some(boundary.to_string());
        self.operation_sets[index].resulting_revision = Some(self.revision);
        self.append_event(json!({
            "type": "operation_set.applied",
            "operationSetId": id,
            "boundary": boundary,
            "revision": self.revision,
            "changed": changed,
            "appliedAt": now,
            "pattern": self.active_pattern,
        }));
        Ok(())
    }

    fn append_event(&mut self, event: Value) {
        self.events.push(EventEntry {
            cursor: self.events.len() as u64 + 1,
            received_at: timestamp(),
            event,
        });
    }

    fn next_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}-{}", self.id_counter);
        self.id_counter += 1;
        id
    }
}

pub fn validation_result(raw: &Value) -> Value {
    let Some(values) = raw.as_array() else {
        return json!({ "valid": false, "errors": ["operations must be an array"], "warnings": [] });
    };
    let mut errors = Vec::new();
    let mut parsed = Vec::new();
    for value in values {
        match serde_json::from_value::<PersistentOperation>(value.clone()) {
            Ok(operation) => {
                if let Err(error) = validate_operation(&operation) {
                    errors.push(error);
                }
                parsed.push(operation);
            }
            Err(error) => errors.push(format!("invalid operation: {error}")),
        }
    }
    if let Err(error) = operation_song_target(&parsed) {
        errors.push(error);
    }
    json!({ "valid": errors.is_empty(), "errors": errors, "warnings": [] })
}

pub fn parse_operation_set(params: &Value) -> Result<OperationSetInput, String> {
    let input: OperationSetInput = serde_json::from_value(params.clone())
        .map_err(|error| format!("invalid operation set: {error}"))?;
    if input.operations.is_empty() {
        return Err("operation set must contain at least one operation".to_string());
    }
    if let Some(id) = &input.operation_set_id {
        validate_safe_id(id, "operationSetId")?;
    }
    validate_apply_at(&input.apply_at)?;
    for operation in &input.operations {
        validate_operation(operation)?;
    }
    operation_song_target(&input.operations)?;
    Ok(input)
}

pub fn parse_operations(raw: &Value) -> Result<Vec<PersistentOperation>, String> {
    let validation = validation_result(raw);
    if validation["valid"] != Value::Bool(true) {
        return Err(validation["errors"]
            .as_array()
            .and_then(|errors| errors.first())
            .and_then(Value::as_str)
            .unwrap_or("operations failed validation")
            .to_string());
    }
    serde_json::from_value(raw.clone()).map_err(error_string)
}

fn validate_apply_at(apply_at: &ApplyAt) -> Result<(), String> {
    if let Some(transport_epoch) = apply_at.transport_epoch() {
        validate_safe_id(transport_epoch, "applyAt.transportEpoch")?;
    }
    if let ApplyAt::PatternStep { pattern, step, .. } = apply_at {
        validate_pattern(pattern, "applyAt.pattern")?;
        validate_u64_range(u64::from(*step), "applyAt.step", 0, 63)?;
    }
    Ok(())
}

fn validate_operation(operation: &PersistentOperation) -> Result<(), String> {
    match operation {
        PersistentOperation::SetTrig {
            pattern,
            track,
            step,
            velocity,
            micro_timing,
            condition,
            ..
        } => {
            validate_optional_pattern(pattern)?;
            validate_track_step(track, *step)?;
            if let Some(value) = velocity {
                validate_u64_range(u64::from(*value), "velocity", 1, 127)?;
            }
            if let Some(value) = micro_timing {
                if !(-24..=24).contains(value) {
                    return Err("microTiming must be an integer between -24 and 24".to_string());
                }
            }
            if let Some(value) = condition {
                validate_safe_atom(value, "condition")?;
            }
        }
        PersistentOperation::ClearTrig {
            pattern,
            track,
            step,
        } => {
            validate_optional_pattern(pattern)?;
            validate_track_step(track, *step)?;
        }
        PersistentOperation::SetParameterLock {
            pattern,
            track,
            step,
            parameter,
            value,
        } => {
            validate_optional_pattern(pattern)?;
            validate_track_step(track, *step)?;
            validate_safe_id(parameter, "parameter")?;
            validate_parameter_lock_value(parameter, value)?;
        }
        PersistentOperation::ClearParameterLock {
            pattern,
            track,
            step,
            parameter,
        } => {
            validate_optional_pattern(pattern)?;
            validate_track_step(track, *step)?;
            validate_safe_id(parameter, "parameter")?;
        }
        PersistentOperation::ClearPatternPlocks { pattern } => {
            validate_optional_pattern(pattern)?;
        }
        PersistentOperation::SetTrackLength {
            pattern,
            track,
            steps,
        } => {
            validate_optional_pattern(pattern)?;
            validate_track(track)?;
            validate_u64_range(u64::from(*steps), "steps", 1, 64)?;
        }
        PersistentOperation::SetTrackMachine {
            pattern,
            track,
            machine,
        } => {
            validate_optional_pattern(pattern)?;
            validate_track(track)?;
            validate_safe_id(machine, "machine")?;
        }
        PersistentOperation::CopyPattern {
            source_pattern,
            target_pattern,
        } => {
            validate_pattern(source_pattern, "sourcePattern")?;
            validate_pattern(target_pattern, "targetPattern")?;
            if source_pattern == target_pattern {
                return Err("copy_pattern source and target must differ".to_string());
            }
        }
        PersistentOperation::SetKitParameter {
            track,
            parameter,
            value,
        } => {
            if let Some(track) = track {
                validate_track(track)?;
            }
            validate_safe_id(parameter, "parameter")?;
            validate_control_value(value, "value")?;
        }
        PersistentOperation::SetSoundParameter {
            track,
            page,
            parameter,
            value,
        } => {
            validate_track(track)?;
            if !["machine", "sample", "filter", "amp", "lfo", "settings"].contains(&page.as_str()) {
                return Err("unsupported Sound page".to_string());
            }
            validate_safe_id(parameter, "parameter")?;
            validate_control_value(value, "value")?;
        }
        PersistentOperation::SetFxParameter {
            effect,
            parameter,
            value,
        } => {
            if !["delay", "reverb", "distortion", "compressor", "lfo"].contains(&effect.as_str()) {
                return Err("unsupported Kit FX effect".to_string());
            }
            validate_safe_id(parameter, "parameter")?;
            validate_control_value(value, "value")?;
        }
        PersistentOperation::SetGlobalParameter {
            section,
            parameter,
            track,
            value,
        } => {
            if ![
                "routing",
                "metronome",
                "midi_sync",
                "midi_port",
                "midi_channels",
                "sequencer",
                "settings",
            ]
            .contains(&section.as_str())
            {
                return Err("unsupported Global section".to_string());
            }
            if let Some(track) = track {
                validate_track(track)?;
            }
            validate_safe_id(parameter, "parameter")?;
            validate_control_value(value, "value")?;
        }
        PersistentOperation::AssignSampleSlot {
            pattern,
            track,
            slot,
            sample_id,
        } => {
            validate_optional_pattern(pattern)?;
            validate_track(track)?;
            validate_u64_range(u64::from(*slot), "slot", 1, 127)?;
            validate_safe_id(sample_id, "sampleId")?;
        }
        PersistentOperation::SetSceneLock {
            scene,
            track,
            parameter,
            value,
        } => {
            validate_macro_id(*scene, "scene")?;
            validate_macro_target(track, parameter)?;
            validate_u64_range(u64::from(*value), "value", 0, 127)?;
        }
        PersistentOperation::ReplaceScene { scene, locks } => {
            validate_macro_id(*scene, "scene")?;
            validate_scene_locks(locks)?;
        }
        PersistentOperation::ClearScene { scene } => validate_macro_id(*scene, "scene")?,
        PersistentOperation::CopyScene {
            source_scene,
            target_scene,
        } => {
            validate_macro_id(*source_scene, "sourceScene")?;
            validate_macro_id(*target_scene, "targetScene")?;
            if source_scene == target_scene {
                return Err("copy_scene source and target must differ".to_string());
            }
        }
        PersistentOperation::SetPerformanceLock {
            performance,
            track,
            parameter,
            ..
        } => {
            validate_macro_id(*performance, "performance")?;
            validate_macro_target(track, parameter)?;
        }
        PersistentOperation::ReplacePerformance { performance, locks } => {
            validate_macro_id(*performance, "performance")?;
            validate_performance_locks(locks)?;
        }
        PersistentOperation::ClearPerformance { performance } => {
            validate_macro_id(*performance, "performance")?;
        }
        PersistentOperation::CopyPerformance {
            source_performance,
            target_performance,
        } => {
            validate_macro_id(*source_performance, "sourcePerformance")?;
            validate_macro_id(*target_performance, "targetPerformance")?;
            if source_performance == target_performance {
                return Err("copy_performance source and target must differ".to_string());
            }
        }
        PersistentOperation::SetSongName { target, name } => {
            validate_song_target(target)?;
            validate_song_name(name)?;
        }
        PersistentOperation::ReplaceSong { target, name, rows } => {
            validate_song_target(target)?;
            if let Some(name) = name {
                validate_song_name(name)?;
            }
            validate_song_rows(rows)?;
        }
        PersistentOperation::InsertSongRow { target, row, value } => {
            validate_song_target(target)?;
            validate_u64_range(u64::from(*row), "row", 0, 64)?;
            validate_song_row(value)?;
        }
        PersistentOperation::UpdateSongRow { target, row, value } => {
            validate_song_target(target)?;
            validate_u64_range(u64::from(*row), "row", 0, 63)?;
            validate_song_row(value)?;
        }
        PersistentOperation::MoveSongRow {
            target,
            source_row,
            target_row,
        } => {
            validate_song_target(target)?;
            validate_u64_range(u64::from(*source_row), "sourceRow", 0, 63)?;
            validate_u64_range(u64::from(*target_row), "targetRow", 0, 63)?;
            if source_row == target_row {
                return Err("move_song_row source and target must differ".to_string());
            }
        }
        PersistentOperation::CopySongRow {
            target,
            source_row,
            target_row,
        } => {
            validate_song_target(target)?;
            validate_u64_range(u64::from(*source_row), "sourceRow", 0, 63)?;
            validate_u64_range(u64::from(*target_row), "targetRow", 0, 64)?;
        }
        PersistentOperation::RemoveSongRow { target, row } => {
            validate_song_target(target)?;
            validate_u64_range(u64::from(*row), "row", 0, 63)?;
        }
        PersistentOperation::ClearSong { target } => validate_song_target(target)?,
    }
    Ok(())
}

fn apply_operations(
    patterns: &mut BTreeMap<String, Pattern>,
    songs: &mut BTreeMap<String, MockSong>,
    operations: &[PersistentOperation],
    active_pattern: &str,
) -> Result<(), String> {
    for operation in operations {
        match operation {
            PersistentOperation::SetTrig {
                pattern,
                track,
                step,
                velocity,
                micro_timing,
                condition,
                retrig,
            } => {
                let pattern =
                    ensure_pattern(patterns, pattern.as_deref().unwrap_or(active_pattern));
                let key = trig_key(track, *step);
                let existing = pattern.trigs.get(&key).cloned();
                pattern.trigs.insert(
                    key,
                    Trig {
                        track: track.clone(),
                        step: *step,
                        velocity: velocity
                            .or(existing.as_ref().map(|trig| trig.velocity))
                            .unwrap_or(100),
                        micro_timing: micro_timing
                            .or(existing.as_ref().and_then(|trig| trig.micro_timing)),
                        condition: condition
                            .clone()
                            .or_else(|| existing.as_ref().and_then(|trig| trig.condition.clone())),
                        retrig: retrig.or(existing.as_ref().and_then(|trig| trig.retrig)),
                        locks: existing.map_or_else(BTreeMap::new, |trig| trig.locks),
                    },
                );
            }
            PersistentOperation::ClearTrig {
                pattern,
                track,
                step,
            } => {
                ensure_pattern(patterns, pattern.as_deref().unwrap_or(active_pattern))
                    .trigs
                    .remove(&trig_key(track, *step));
            }
            PersistentOperation::SetParameterLock {
                pattern,
                track,
                step,
                parameter,
                value,
            } => {
                let pattern =
                    ensure_pattern(patterns, pattern.as_deref().unwrap_or(active_pattern));
                let trig = pattern
                    .trigs
                    .entry(trig_key(track, *step))
                    .or_insert_with(|| Trig {
                        track: track.clone(),
                        step: *step,
                        velocity: 100,
                        micro_timing: None,
                        condition: None,
                        retrig: None,
                        locks: BTreeMap::new(),
                    });
                trig.locks.insert(parameter.clone(), value.clone());
            }
            PersistentOperation::ClearParameterLock {
                pattern,
                track,
                step,
                parameter,
            } => {
                if let Some(trig) =
                    ensure_pattern(patterns, pattern.as_deref().unwrap_or(active_pattern))
                        .trigs
                        .get_mut(&trig_key(track, *step))
                {
                    trig.locks.remove(parameter);
                }
            }
            PersistentOperation::ClearPatternPlocks { pattern } => {
                // The pool holds only lock values; trigs themselves survive a
                // pool purge (mirrors the hardware pattern.clear_all_plocks()).
                for trig in ensure_pattern(patterns, pattern.as_deref().unwrap_or(active_pattern))
                    .trigs
                    .values_mut()
                {
                    trig.locks.clear();
                }
            }
            PersistentOperation::SetTrackLength {
                pattern,
                track,
                steps,
            } => {
                ensure_pattern(patterns, pattern.as_deref().unwrap_or(active_pattern))
                    .track_lengths
                    .insert(track.clone(), *steps);
            }
            PersistentOperation::SetTrackMachine {
                pattern,
                track,
                machine,
            } => {
                ensure_pattern(patterns, pattern.as_deref().unwrap_or(active_pattern))
                    .machines
                    .insert(track.clone(), machine.clone());
            }
            PersistentOperation::CopyPattern {
                source_pattern,
                target_pattern,
            } => {
                let mut copy = ensure_pattern(patterns, source_pattern).clone();
                copy.slot = target_pattern.clone();
                patterns.insert(target_pattern.clone(), copy);
            }
            PersistentOperation::SetKitParameter {
                track,
                parameter,
                value,
            } => {
                let key = track
                    .as_ref()
                    .map_or_else(|| parameter.clone(), |track| format!("{track}.{parameter}"));
                ensure_pattern(patterns, active_pattern)
                    .kit_parameters
                    .insert(key, value.clone());
            }
            PersistentOperation::SetSoundParameter {
                track,
                page,
                parameter,
                value,
            } => {
                ensure_pattern(patterns, active_pattern)
                    .kit_parameters
                    .insert(format!("sound.{track}.{page}.{parameter}"), value.clone());
            }
            PersistentOperation::SetFxParameter {
                effect,
                parameter,
                value,
            } => {
                ensure_pattern(patterns, active_pattern)
                    .kit_parameters
                    .insert(format!("fx.{effect}.{parameter}"), value.clone());
            }
            PersistentOperation::SetGlobalParameter {
                section,
                parameter,
                track,
                value,
            } => {
                let track = track
                    .as_deref()
                    .map_or(String::new(), |track| format!(".{track}"));
                ensure_pattern(patterns, active_pattern)
                    .kit_parameters
                    .insert(
                        format!("global.{section}{track}.{parameter}"),
                        value.clone(),
                    );
            }
            PersistentOperation::AssignSampleSlot {
                pattern,
                track,
                slot,
                sample_id,
            } => {
                ensure_pattern(patterns, pattern.as_deref().unwrap_or(active_pattern))
                    .sample_slots
                    .insert(
                        track.clone(),
                        SampleSlot {
                            slot: *slot,
                            sample_id: sample_id.clone(),
                        },
                    );
            }
            PersistentOperation::SetSceneLock {
                scene,
                track,
                parameter,
                value,
            } => upsert_mock_macro_lock(
                ensure_pattern(patterns, active_pattern),
                "scene",
                *scene,
                json!({ "track": track, "parameter": parameter, "value": value }),
            ),
            PersistentOperation::ReplaceScene { scene, locks } => set_mock_macro_locks(
                ensure_pattern(patterns, active_pattern),
                "scene",
                *scene,
                locks
                    .iter()
                    .map(|lock| serde_json::to_value(lock).map_err(error_string))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            PersistentOperation::ClearScene { scene } => set_mock_macro_locks(
                ensure_pattern(patterns, active_pattern),
                "scene",
                *scene,
                Vec::new(),
            ),
            PersistentOperation::CopyScene {
                source_scene,
                target_scene,
            } => {
                let pattern = ensure_pattern(patterns, active_pattern);
                let locks = mock_macro_locks(pattern, "scene", *source_scene);
                set_mock_macro_locks(pattern, "scene", *target_scene, locks);
            }
            PersistentOperation::SetPerformanceLock {
                performance,
                track,
                parameter,
                depth,
            } => upsert_mock_macro_lock(
                ensure_pattern(patterns, active_pattern),
                "performance",
                *performance,
                json!({ "track": track, "parameter": parameter, "depth": depth }),
            ),
            PersistentOperation::ReplacePerformance { performance, locks } => {
                set_mock_macro_locks(
                    ensure_pattern(patterns, active_pattern),
                    "performance",
                    *performance,
                    locks
                        .iter()
                        .map(|lock| serde_json::to_value(lock).map_err(error_string))
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            PersistentOperation::ClearPerformance { performance } => set_mock_macro_locks(
                ensure_pattern(patterns, active_pattern),
                "performance",
                *performance,
                Vec::new(),
            ),
            PersistentOperation::CopyPerformance {
                source_performance,
                target_performance,
            } => {
                let pattern = ensure_pattern(patterns, active_pattern);
                let locks = mock_macro_locks(pattern, "performance", *source_performance);
                set_mock_macro_locks(pattern, "performance", *target_performance, locks);
            }
            PersistentOperation::SetSongName { target, name } => {
                mock_song_mut(songs, target)?.name.clone_from(name);
            }
            PersistentOperation::ReplaceSong { target, name, rows } => {
                let song = mock_song_mut(songs, target)?;
                if let Some(name) = name {
                    song.name.clone_from(name);
                }
                song.rows.clone_from(rows);
            }
            PersistentOperation::InsertSongRow { target, row, value } => {
                let song = mock_song_mut(songs, target)?;
                let row = usize::from(*row);
                if row > song.rows.len() {
                    return Err(format!(
                        "row {row} cannot be inserted into a Song with {} rows",
                        song.rows.len()
                    ));
                }
                song.rows.insert(row, value.clone());
            }
            PersistentOperation::UpdateSongRow { target, row, value } => {
                let song = mock_song_mut(songs, target)?;
                let row = usize::from(*row);
                let existing = song
                    .rows
                    .get_mut(row)
                    .ok_or_else(|| format!("row {row} does not exist"))?;
                existing.clone_from(value);
            }
            PersistentOperation::MoveSongRow {
                target,
                source_row,
                target_row,
            } => {
                let song = mock_song_mut(songs, target)?;
                let source = usize::from(*source_row);
                let destination = usize::from(*target_row);
                if source >= song.rows.len() || destination >= song.rows.len() {
                    return Err(format!(
                        "move rows must be within the current {}-row Song",
                        song.rows.len()
                    ));
                }
                let row = song.rows.remove(source);
                song.rows.insert(destination, row);
            }
            PersistentOperation::CopySongRow {
                target,
                source_row,
                target_row,
            } => {
                let song = mock_song_mut(songs, target)?;
                let source = usize::from(*source_row);
                let destination = usize::from(*target_row);
                let row = song
                    .rows
                    .get(source)
                    .cloned()
                    .ok_or_else(|| format!("row {source} does not exist"))?;
                if destination > song.rows.len() {
                    return Err(format!(
                        "row {destination} cannot be inserted into a Song with {} rows",
                        song.rows.len()
                    ));
                }
                song.rows.insert(destination, row);
            }
            PersistentOperation::RemoveSongRow { target, row } => {
                let song = mock_song_mut(songs, target)?;
                let row = usize::from(*row);
                if row >= song.rows.len() {
                    return Err(format!("row {row} does not exist"));
                }
                song.rows.remove(row);
            }
            PersistentOperation::ClearSong { target } => mock_song_mut(songs, target)?.rows.clear(),
        }
        if let Some(target) = persistent_operation_song_target(operation) {
            validate_mock_song(mock_song_mut(songs, target)?)?;
        }
    }
    Ok(())
}

fn default_mock_songs() -> BTreeMap<String, MockSong> {
    let mut songs = BTreeMap::new();
    let work_buffer = SongTarget::WorkBuffer;
    songs.insert(
        work_buffer.key(),
        MockSong {
            target: work_buffer,
            name: String::new(),
            rows: Vec::new(),
        },
    );
    for song in 1..=16 {
        let target = SongTarget::Stored { song };
        songs.insert(
            target.key(),
            MockSong {
                target,
                name: String::new(),
                rows: Vec::new(),
            },
        );
    }
    songs
}

fn mock_song_mut<'a>(
    songs: &'a mut BTreeMap<String, MockSong>,
    target: &SongTarget,
) -> Result<&'a mut MockSong, String> {
    songs
        .get_mut(&target.key())
        .ok_or_else(|| format!("unknown Song target: {}", target.key()))
}

fn validate_mock_song(song: &MockSong) -> Result<(), String> {
    if song.rows.len() > 64 {
        return Err("a Song has at most 64 rows".to_string());
    }
    let positions = song
        .rows
        .iter()
        .map(|row| row.patterns.len())
        .sum::<usize>();
    if positions > 256 {
        return Err("a Song has at most 256 pattern positions".to_string());
    }
    Ok(())
}

fn mock_song_summary(song: &MockSong) -> Value {
    let rows = song
        .rows
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            let patterns = row
                .patterns
                .iter()
                .map(|position| {
                    json!({
                        "pattern": position.pattern,
                        "mutedTracksMask": mock_mute_mask(&position.muted_tracks),
                        "mutedTracks": position.muted_tracks,
                    })
                })
                .collect::<Vec<_>>();
            json!({ "row": row_index, "repeats": row.repeats, "patterns": patterns })
        })
        .collect::<Vec<_>>();
    json!({
        "target": song.target,
        "name": song.name,
        "rowCount": song.rows.len(),
        "patternPositionCount": song.rows.iter().map(|row| row.patterns.len()).sum::<usize>(),
        "rows": rows,
        "capabilities": song_capabilities(),
    })
}

fn mock_mute_mask(tracks: &[String]) -> u16 {
    tracks.iter().fold(0_u16, |mask, track| {
        TRACK_NAMES
            .iter()
            .position(|candidate| candidate == track)
            .map_or(mask, |index| mask | (1 << index))
    })
}

fn song_capabilities() -> Value {
    json!({
        "name": true,
        "rows": true,
        "patternChains": true,
        "repeats": true,
        "trackMutes": true,
        "tempoOverrides": false,
        "patternLengthOverrides": false,
        "jumps": false,
        "loops": false,
        "rowLabels": false,
        "explicitEnd": false,
    })
}

fn song_pattern_slots(rows: &[SongRowInput]) -> BTreeSet<String> {
    rows.iter()
        .flat_map(|row| row.patterns.iter())
        .map(|position| position.pattern.clone())
        .collect()
}

pub fn parse_song_inspect_request(params: &Value) -> Result<(Vec<SongTarget>, bool), String> {
    let object = require_object(params)?;
    let resolve_references = object
        .get("resolveReferences")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "resolveReferences must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let scope = object
        .get("scope")
        .map(|value| value_string(value, "scope"))
        .transpose()?
        .unwrap_or("work_buffer");
    let targets = match scope {
        "work_buffer" => vec![SongTarget::WorkBuffer],
        "stored" => {
            let song = object
                .get("song")
                .ok_or_else(|| "song is required when scope is stored".to_string())
                .and_then(|value| value_u64(value, "song"))?;
            validate_u64_range(song, "song", 1, 16)?;
            vec![SongTarget::Stored { song: song as u8 }]
        }
        "all" => std::iter::once(SongTarget::WorkBuffer)
            .chain((1..=16).map(|song| SongTarget::Stored { song }))
            .collect(),
        _ => return Err("scope must be work_buffer, stored, or all".to_string()),
    };
    Ok((targets, resolve_references))
}

pub fn operation_song_target(
    operations: &[PersistentOperation],
) -> Result<Option<SongTarget>, String> {
    let mut target: Option<SongTarget> = None;
    for operation in operations {
        let Some(candidate) = persistent_operation_song_target(operation) else {
            continue;
        };
        if target.as_ref().is_some_and(|target| target != candidate) {
            return Err("one operation set may edit only one Song target".to_string());
        }
        target = Some(candidate.clone());
    }
    Ok(target)
}

fn persistent_operation_song_target(operation: &PersistentOperation) -> Option<&SongTarget> {
    match operation {
        PersistentOperation::SetSongName { target, .. }
        | PersistentOperation::ReplaceSong { target, .. }
        | PersistentOperation::InsertSongRow { target, .. }
        | PersistentOperation::UpdateSongRow { target, .. }
        | PersistentOperation::MoveSongRow { target, .. }
        | PersistentOperation::CopySongRow { target, .. }
        | PersistentOperation::RemoveSongRow { target, .. }
        | PersistentOperation::ClearSong { target } => Some(target),
        _ => None,
    }
}

fn pattern_summary(pattern: Pattern) -> Value {
    let mut trigs = pattern.trigs.into_values().collect::<Vec<_>>();
    trigs.sort_by(|left, right| {
        left.step
            .cmp(&right.step)
            .then(left.track.cmp(&right.track))
    });
    let trigs = trigs
        .into_iter()
        .map(|trig| {
            let mut value = json!({
                "track": trig.track,
                "step": trig.step,
                "velocity": trig.velocity,
                "locks": trig.locks,
            });
            if let Some(micro_timing) = trig.micro_timing {
                value["microTiming"] = json!(micro_timing);
            }
            if let Some(condition) = trig.condition {
                value["condition"] = json!(condition);
            }
            if let Some(retrig) = trig.retrig {
                value["retrig"] = json!(retrig);
            }
            value
        })
        .collect::<Vec<_>>();
    json!({
        "pattern": pattern.slot,
        "length": pattern.length,
        "trackLengths": pattern.track_lengths,
        "machines": pattern.machines,
        "sampleSlots": pattern.sample_slots,
        "kitParameters": pattern.kit_parameters,
        "trigCount": trigs.len(),
        "trigs": trigs,
    })
}

fn empty_pattern(slot: &str) -> Pattern {
    Pattern {
        slot: slot.to_string(),
        length: 64,
        ..Pattern::default()
    }
}

fn ensure_pattern<'a>(patterns: &'a mut BTreeMap<String, Pattern>, slot: &str) -> &'a mut Pattern {
    patterns
        .entry(slot.to_string())
        .or_insert_with(|| empty_pattern(slot))
}

fn mock_macro_key(family: &str, id: u8) -> String {
    format!("macros.{family}.{id}")
}

fn mock_macro_locks(pattern: &Pattern, family: &str, id: u8) -> Vec<Value> {
    pattern
        .kit_parameters
        .get(&mock_macro_key(family, id))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn set_mock_macro_locks(pattern: &mut Pattern, family: &str, id: u8, locks: Vec<Value>) {
    pattern
        .kit_parameters
        .insert(mock_macro_key(family, id), Value::Array(locks));
}

fn upsert_mock_macro_lock(pattern: &mut Pattern, family: &str, id: u8, lock: Value) {
    let track = lock["track"].clone();
    let parameter = lock["parameter"].clone();
    let mut locks = mock_macro_locks(pattern, family, id);
    if let Some(existing) = locks
        .iter_mut()
        .find(|existing| existing["track"] == track && existing["parameter"] == parameter)
    {
        *existing = lock;
    } else {
        locks.push(lock);
    }
    set_mock_macro_locks(pattern, family, id, locks);
}

fn mock_macro_summary(pattern: &Pattern, active_scene: Option<u8>) -> Value {
    let definitions = |family: &str| {
        (1..=12)
            .map(|id| {
                let locks = mock_macro_locks(pattern, family, id);
                json!({ "id": id, "lockCount": locks.len(), "locks": locks })
            })
            .collect::<Vec<_>>()
    };
    json!({
        "activeScene": active_scene,
        "activeSceneRaw": active_scene.map_or(255, |scene| scene - 1),
        "scenes": definitions("scene"),
        "performances": definitions("performance"),
    })
}

fn capabilities() -> Value {
    json!({
        "realtimeMidi": true,
        "sysExState": true,
        "patternEdit": true,
        "kitEdit": true,
        "machineEdit": true,
        "sampleSlotAssignment": true,
        "sampleTransfer": true,
        "sceneMacros": true,
        "performanceMacros": true,
        "songs": true,
    })
}

fn validate_optional_pattern(pattern: &Option<String>) -> Result<(), String> {
    if let Some(pattern) = pattern {
        validate_pattern(pattern, "pattern")?;
    }
    Ok(())
}

fn validate_track_step(track: &str, step: u8) -> Result<(), String> {
    validate_track(track)?;
    validate_u64_range(u64::from(step), "step", 0, 63)?;
    Ok(())
}

fn validate_track(track: &str) -> Result<(), String> {
    if !TRACK_NAMES.contains(&track) {
        return Err("track must be a Rytm track id".to_string());
    }
    Ok(())
}

fn validate_song_target(target: &SongTarget) -> Result<(), String> {
    if let SongTarget::Stored { song } = target {
        validate_u64_range(u64::from(*song), "target.song", 1, 16)?;
    }
    Ok(())
}

fn validate_song_name(name: &str) -> Result<(), String> {
    if name.len() > 15 || !name.bytes().all(|byte| (0x20..=0x7E).contains(&byte)) {
        return Err("Song name must be at most 15 printable ASCII characters".to_string());
    }
    Ok(())
}

fn validate_song_rows(rows: &[SongRowInput]) -> Result<(), String> {
    if rows.len() > 64 {
        return Err("a Song has at most 64 rows".to_string());
    }
    for row in rows {
        validate_song_row(row)?;
    }
    if rows.iter().map(|row| row.patterns.len()).sum::<usize>() > 256 {
        return Err("a Song has at most 256 pattern positions".to_string());
    }
    Ok(())
}

fn validate_song_row(row: &SongRowInput) -> Result<(), String> {
    if !(1..=255).contains(&row.patterns.len()) {
        return Err("a Song row must contain between 1 and 255 pattern positions".to_string());
    }
    validate_u64_range(u64::from(row.repeats), "repeats", 1, 256)?;
    for position in &row.patterns {
        validate_pattern(&position.pattern, "Song pattern")?;
        let mut tracks = BTreeSet::new();
        for track in &position.muted_tracks {
            validate_track(track)?;
            if !tracks.insert(track) {
                return Err(format!("mutedTracks contains duplicate track: {track}"));
            }
        }
    }
    Ok(())
}

fn validate_macro_id(value: u8, label: &str) -> Result<(), String> {
    validate_u64_range(u64::from(value), label, 1, 12).map(|_| ())
}

fn validate_macro_target(track: &str, parameter: &str) -> Result<(), String> {
    if track != "FX" {
        validate_track(track)?;
    }
    validate_safe_id(parameter, "parameter")
}

fn validate_scene_locks(locks: &[SceneLockInput]) -> Result<(), String> {
    if locks.len() > 48 {
        return Err("a Kit has at most 48 Scene locks".to_string());
    }
    let mut targets = Vec::with_capacity(locks.len());
    for lock in locks {
        validate_macro_target(&lock.track, &lock.parameter)?;
        validate_u64_range(u64::from(lock.value), "value", 0, 127)?;
        let target = (&lock.track, &lock.parameter);
        if targets.contains(&target) {
            return Err(format!(
                "Scene locks contain duplicate target: {}.{}",
                lock.track, lock.parameter
            ));
        }
        targets.push(target);
    }
    Ok(())
}

fn validate_performance_locks(locks: &[PerformanceLockInput]) -> Result<(), String> {
    if locks.len() > 48 {
        return Err("a Kit has at most 48 Performance locks".to_string());
    }
    let mut targets = Vec::with_capacity(locks.len());
    for lock in locks {
        validate_macro_target(&lock.track, &lock.parameter)?;
        let target = (&lock.track, &lock.parameter);
        if targets.contains(&target) {
            return Err(format!(
                "Performance locks contain duplicate target: {}.{}",
                lock.track, lock.parameter
            ));
        }
        targets.push(target);
    }
    Ok(())
}

fn validate_pattern(value: &str, label: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 3
        && (b'A'..=b'H').contains(&bytes[0])
        && value[1..]
            .parse::<u8>()
            .is_ok_and(|number| (1..=16).contains(&number));
    if !valid {
        return Err(format!("{label} must be A01-H16: {value}"));
    }
    Ok(())
}

fn validate_safe_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character))
    {
        return Err(format!(
            "{label} must contain only letters, numbers, underscore, dash, and dot: {value}"
        ));
    }
    Ok(())
}

fn validate_safe_atom(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.chars().any(char::is_whitespace) || value.contains(';') {
        return Err(format!("{label} cannot contain whitespace or semicolons"));
    }
    Ok(())
}

fn validate_control_value(value: &Value, label: &str) -> Result<(), String> {
    match value {
        Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => Ok(()),
        Value::String(value) => validate_safe_atom(value, label),
        Value::Bool(_) => Ok(()),
        _ => Err(format!(
            "{label} must be a finite number, boolean, or enum string"
        )),
    }
}

/// The value shape a given per-trig parameter lock expects.
///
/// Ranges mirror the `#[parameter_range]` attributes on the matching
/// `Trig::plock_set_*` methods in rytm-rs (`f2e8143`), so the daemon rejects
/// out-of-range locks before they reach the hardware routing in `hardware.rs`.
enum ParameterLockValueSpec {
    /// A `usize` control (`plock_set_*` takes `usize`).
    Unsigned { minimum: u64, maximum: u64 },
    /// A signed `isize` control (e.g. pan, tune, lfo speed/fade).
    Signed { minimum: i64, maximum: i64 },
    /// An `f32` control (sample start/end, lfo depth).
    Float { minimum: f64, maximum: f64 },
    /// A boolean control (sample loop switch).
    Boolean,
    /// An enum control parsed from a symbolic string (filter type, lfo enums).
    Enum,
}

/// Maps a flat p-lock `parameter` name to its expected value shape.
///
/// Names are the same flat identifiers used by `voice_macro_parameter_id`
/// in `hardware.rs` so scene/performance macros and p-locks stay aligned.
/// Returns `None` for names rytm-rs cannot route as a p-lock (synth/machine
/// page parameters) or names that are not p-lock targets at all.
fn parameter_lock_value_spec(parameter: &str) -> Option<ParameterLockValueSpec> {
    use ParameterLockValueSpec::{Boolean, Enum, Float, Signed, Unsigned};
    Some(match parameter {
        // ----- filter page (ENV p-lock family) -----
        "filter_attack" | "filter_sustain" | "filter_decay" | "filter_release"
        | "filter_frequency" | "filter_cutoff" | "filter_resonance" => Unsigned {
            minimum: 0,
            maximum: 127,
        },
        "filter_envelope" => Signed {
            minimum: -64,
            maximum: 63,
        },
        "filter_type" => Enum,
        // ----- amp page (ENV p-lock family) -----
        "amp_attack" | "amp_hold" | "amp_decay" | "amp_overdrive" | "amp_delay_send"
        | "amp_reverb_send" | "amp_volume" => Unsigned {
            minimum: 0,
            maximum: 127,
        },
        "amp_pan" => Signed {
            minimum: -64,
            maximum: 63,
        },
        // ----- lfo page (LFO p-lock family) -----
        "lfo_speed" | "lfo_fade" => Signed {
            minimum: -64,
            maximum: 63,
        },
        "lfo_phase" => Unsigned {
            minimum: 0,
            maximum: 127,
        },
        "lfo_depth" => Float {
            minimum: -128.0,
            maximum: 127.99,
        },
        "lfo_multiplier" | "lfo_waveform" | "lfo_mode" | "lfo_destination" => Enum,
        // ----- sample page (SMP p-lock family) -----
        "sample_tune" => Signed {
            minimum: -24,
            maximum: 24,
        },
        "sample_fine_tune" => Signed {
            minimum: -64,
            maximum: 63,
        },
        "sample_number" | "sample_bit_reduction" | "sample_level" => Unsigned {
            minimum: 0,
            maximum: 127,
        },
        "sample_start" | "sample_end" => Float {
            minimum: 0.0,
            maximum: 120.0,
        },
        "sample_loop" => Boolean,
        _ => return None,
    })
}

/// Error text for a p-lock `parameter` name the bridge cannot route, with a
/// pointer at the rytm-rs gap for synth/machine-page parameters.
pub fn unsupported_parameter_lock_message(parameter: &str) -> String {
    if parameter.starts_with("machine_parameter_") {
        format!(
            "parameter lock {parameter:?} targets a synth/machine-page parameter, which rytm-rs \
             (f2e8143) does not expose as a p-lock; wiring it needs a rytm-rs fork change"
        )
    } else {
        format!(
            "unsupported parameter lock {parameter:?}; supported: filter_*, amp_*, lfo_*, sample_* \
             sound-page parameters"
        )
    }
}

/// Validates a p-lock value against the range and sign of its parameter.
fn validate_parameter_lock_value(parameter: &str, value: &Value) -> Result<(), String> {
    let Some(spec) = parameter_lock_value_spec(parameter) else {
        return Err(unsupported_parameter_lock_message(parameter));
    };
    match spec {
        ParameterLockValueSpec::Unsigned { minimum, maximum } => {
            validate_u64_range(value_u64(value, "value")?, "value", minimum, maximum)?;
        }
        ParameterLockValueSpec::Signed { minimum, maximum } => {
            let number = value
                .as_i64()
                .ok_or_else(|| "value must be an integer".to_string())?;
            if !(minimum..=maximum).contains(&number) {
                return Err(format!(
                    "value must be an integer between {minimum} and {maximum}"
                ));
            }
        }
        ParameterLockValueSpec::Float { minimum, maximum } => {
            validate_finite_range(value_f64(value, "value")?, "value", minimum, maximum)?;
        }
        ParameterLockValueSpec::Boolean => {
            if !value.is_boolean() {
                return Err("value must be a boolean".to_string());
            }
        }
        ParameterLockValueSpec::Enum => {
            validate_safe_atom(value_string(value, "value")?, "value")?;
        }
    }
    Ok(())
}

fn validate_u64_range(value: u64, label: &str, minimum: u64, maximum: u64) -> Result<u64, String> {
    if !(minimum..=maximum).contains(&value) {
        return Err(format!(
            "{label} must be an integer between {minimum} and {maximum}"
        ));
    }
    Ok(value)
}

fn validate_finite_range(
    value: f64,
    label: &str,
    minimum: f64,
    maximum: f64,
) -> Result<f64, String> {
    if !value.is_finite() || value < minimum || value > maximum {
        return Err(format!(
            "{label} must be a finite number between {minimum} and {maximum}"
        ));
    }
    Ok(value)
}

fn validate_optional_lane(object: &Map<String, Value>) -> Result<(), String> {
    if let Some(lane) = object.get("lane") {
        let lane = value_string(lane, "lane")?;
        if lane != "cc" && lane != "nrpn" {
            return Err("lane must be cc or nrpn".to_string());
        }
    }
    Ok(())
}

fn require_object(value: &Value) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "params must be a JSON object".to_string())
}

fn required_field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    require_object(value)?
        .get(key)
        .ok_or_else(|| format!("params.{key} is required"))
}

fn optional_field_string<'a>(value: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    require_object(value)?
        .get(key)
        .map(|value| value_string(value, key))
        .transpose()
}

fn required_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    object
        .get(key)
        .ok_or_else(|| format!("params.{key} is required"))
        .and_then(|value| value_string(value, key))
}

fn required_f64(object: &Map<String, Value>, key: &str) -> Result<f64, String> {
    object
        .get(key)
        .ok_or_else(|| format!("params.{key} is required"))
        .and_then(|value| value_f64(value, key))
}

fn optional_u64(value: &Value, key: &str) -> Result<Option<u64>, String> {
    require_object(value)?
        .get(key)
        .map(|value| value_u64(value, key))
        .transpose()
}

fn value_string<'a>(value: &'a Value, label: &str) -> Result<&'a str, String> {
    value
        .as_str()
        .ok_or_else(|| format!("{label} must be a string"))
}

fn value_u64(value: &Value, label: &str) -> Result<u64, String> {
    value
        .as_u64()
        .ok_or_else(|| format!("{label} must be a non-negative integer"))
}

fn value_f64(value: &Value, label: &str) -> Result<f64, String> {
    value
        .as_f64()
        .ok_or_else(|| format!("{label} must be a number"))
}

fn trig_key(track: &str, step: u8) -> String {
    format!("{track}:{step}")
}

fn timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "unix:{}.{:03}",
        duration.as_secs(),
        duration.subsec_millis()
    )
}

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_at_measure_boundary_and_emits_acknowledgement() {
        let mut state = MockBridgeState::default();
        let queued = state
            .queue(&json!({
                "operationSetId": "ops-kick",
                "expectedRevision": 0,
                "applyAt": { "kind": "next_measure" },
                "latePolicy": "roll-forward",
                "operations": [
                    { "type": "set_trig", "track": "BD", "step": 0, "velocity": 116 },
                    { "type": "set_parameter_lock", "track": "BD", "step": 0, "parameter": "filter_frequency", "value": 92 },
                ],
            }))
            .unwrap();
        assert_eq!(queued["status"], "queued");

        state.advance_transport(&json!({ "steps": 15 })).unwrap();
        assert_eq!(state.inspect_state()["revision"], 0);
        state.advance_transport(&json!({ "steps": 1 })).unwrap();
        let current = state.inspect_state();
        assert_eq!(current["revision"], 1);
        assert_eq!(current["activePattern"]["trigCount"], 1);
        assert_eq!(
            current["operationSets"][0]["appliedAtBoundary"],
            "next_measure"
        );
        assert!(state
            .events
            .iter()
            .any(|entry| entry.event["type"] == "operation_set.applied"));
    }

    #[test]
    fn dry_run_snapshot_and_rollback_preserve_monotonic_revision() {
        let mut state = MockBridgeState::default();
        let dry_run = state
            .queue(&json!({
                "operationSetId": "ops-dry",
                "expectedRevision": 0,
                "applyAt": { "kind": "next_step" },
                "latePolicy": "reject",
                "dryRun": true,
                "operations": [{ "type": "set_trig", "track": "CH", "step": 12 }],
            }))
            .unwrap();
        assert_eq!(dry_run["status"], "dry_run");
        assert_eq!(state.inspect_state()["revision"], 0);

        state
            .create_snapshot(&json!({ "snapshotId": "empty" }))
            .unwrap();
        state
            .apply_now(&json!({
                "expectedRevision": 0,
                "operations": [{ "type": "set_trig", "track": "OH", "step": 8 }],
            }))
            .unwrap();
        let rolled_back = state
            .rollback_snapshot(&json!({ "snapshotId": "empty", "expectedRevision": 1 }))
            .unwrap();
        assert_eq!(rolled_back["revision"], 2);
        assert_eq!(rolled_back["activePattern"]["trigCount"], 0);
    }

    #[test]
    fn validation_collects_capability_and_range_errors() {
        let validation = validation_result(&json!([
            { "type": "set_trig", "track": "BD", "step": 99 },
            { "type": "assign_sample_slot", "track": "BD", "slot": 1, "sampleId": "sample" },
        ]));
        assert_eq!(validation["valid"], false);
        assert_eq!(validation["errors"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn parameter_lock_validation_accepts_full_value_surface() {
        assert!(validate_parameter_lock_value("filter_cutoff", &json!(84)).is_ok());
        assert!(validate_parameter_lock_value("amp_pan", &json!(-30)).is_ok());
        assert!(validate_parameter_lock_value("lfo_speed", &json!(-64)).is_ok());
        assert!(validate_parameter_lock_value("sample_start", &json!(60.0)).is_ok());
        assert!(validate_parameter_lock_value("sample_loop", &json!(true)).is_ok());
        assert!(validate_parameter_lock_value("filter_type", &json!("Hp1")).is_ok());
        assert!(validate_parameter_lock_value("lfo_mode", &json!("Trig")).is_ok());
    }

    #[test]
    fn parameter_lock_validation_rejects_out_of_range_and_wrong_kind() {
        // pan is signed -64..=63, so 100 is out of range
        assert!(validate_parameter_lock_value("amp_pan", &json!(100)).is_err());
        // unsigned params reject over-range and negatives
        assert!(validate_parameter_lock_value("filter_cutoff", &json!(200)).is_err());
        assert!(validate_parameter_lock_value("filter_cutoff", &json!(-1)).is_err());
        // float out of 0..=120
        assert!(validate_parameter_lock_value("sample_start", &json!(200.0)).is_err());
        // wrong value kinds
        assert!(validate_parameter_lock_value("sample_loop", &json!(1)).is_err());
        assert!(validate_parameter_lock_value("filter_type", &json!(3)).is_err());
    }

    #[test]
    fn parameter_lock_validation_reports_unknown_and_synth_gap() {
        let synth = validate_parameter_lock_value("machine_parameter_1", &json!(64)).unwrap_err();
        assert!(synth.contains("synth/machine-page"), "message: {synth}");
        assert!(synth.contains("rytm-rs"), "message: {synth}");
        let unknown = validate_parameter_lock_value("not_a_param", &json!(1)).unwrap_err();
        assert!(
            unknown.contains("unsupported parameter lock"),
            "message: {unknown}"
        );
    }

    #[test]
    fn set_parameter_lock_operation_accepts_signed_value() {
        // Regression: the previous blanket 0..=127 check rejected negative locks.
        let operation: PersistentOperation = serde_json::from_value(json!({
            "type": "set_parameter_lock", "track": "BD", "step": 0,
            "parameter": "amp_pan", "value": -40
        }))
        .unwrap();
        assert!(validate_operation(&operation).is_ok());
    }

    #[test]
    fn mock_backend_stores_full_parameter_lock_value_surface() {
        let mut state = MockBridgeState::default();
        state
            .apply_now(&json!({
                "expectedRevision": 0,
                "operations": [
                    { "type": "set_parameter_lock", "track": "BD", "step": 0, "parameter": "amp_pan", "value": -40 },
                    { "type": "set_parameter_lock", "track": "BD", "step": 0, "parameter": "sample_loop", "value": true },
                    { "type": "set_parameter_lock", "track": "BD", "step": 0, "parameter": "filter_type", "value": "Hp1" },
                ],
            }))
            .unwrap();
        let state_json = state.inspect_state();
        let locks = &state_json["activePattern"]["trigs"][0]["locks"];
        assert_eq!(locks["amp_pan"], json!(-40));
        assert_eq!(locks["sample_loop"], json!(true));
        assert_eq!(locks["filter_type"], json!("Hp1"));
    }

    #[test]
    fn clear_pattern_plocks_validates_and_purges_all_locks_but_keeps_trigs() {
        // validate/apply parity for the pool-rebuild op: the mock mirrors the
        // hardware semantics (pool purge clears every lock in the pattern while
        // the trigs themselves survive).
        let mut state = MockBridgeState::default();
        state
            .apply_now(&json!({
                "expectedRevision": 0,
                "operations": [
                    { "type": "set_trig", "track": "BD", "step": 0 },
                    { "type": "set_trig", "track": "CH", "step": 1 },
                    { "type": "set_parameter_lock", "track": "BD", "step": 0, "parameter": "filter_cutoff", "value": 84 },
                    { "type": "set_parameter_lock", "track": "CH", "step": 1, "parameter": "amp_pan", "value": -20 },
                ],
            }))
            .unwrap();
        state
            .apply_now(&json!({
                "expectedRevision": 1,
                "operations": [
                    { "type": "clear_pattern_plocks" },
                ],
            }))
            .unwrap();
        let state_json = state.inspect_state();
        let trigs = state_json["activePattern"]["trigs"].as_array().unwrap();
        assert_eq!(trigs.len(), 2, "trigs must survive the pool purge");
        for trig in trigs {
            assert_eq!(
                trig["locks"],
                json!({}),
                "all locks must be purged for trig {trig}"
            );
        }

        // Explicit pattern slots validate too; junk slots are rejected.
        let accepted: PersistentOperation =
            serde_json::from_value(json!({ "type": "clear_pattern_plocks", "pattern": "A01" }))
                .unwrap();
        validate_operation(&accepted).unwrap();
        let rejected: PersistentOperation =
            serde_json::from_value(json!({ "type": "clear_pattern_plocks", "pattern": "nope" }))
                .unwrap();
        validate_operation(&rejected).unwrap_err();
    }

    #[test]
    fn operation_set_ids_are_idempotent_only_for_matching_payloads() {
        let mut state = MockBridgeState::default();
        let input = json!({
            "operationSetId": "same-set",
            "expectedRevision": 0,
            "applyAt": { "kind": "next_step" },
            "latePolicy": "reject",
            "operations": [{ "type": "set_trig", "track": "SD", "step": 4 }],
        });
        let first = state.queue(&input).unwrap();
        let second = state.queue(&input).unwrap();
        assert_eq!(first, second);
        assert_eq!(state.events.len(), 1);

        let mut conflicting = input;
        conflicting["operations"][0]["step"] = json!(5);
        assert!(state
            .queue(&conflicting)
            .unwrap_err()
            .contains("different payload"));
    }

    #[test]
    fn song_rows_are_declarative_idempotent_snapshot_backed_and_transport_independent() {
        let mut state = MockBridgeState::default();
        let baseline_transport = state.inspect_state()["transport"].clone();
        state
            .create_snapshot(&json!({ "snapshotId": "before-song" }))
            .unwrap();
        let create = json!({
            "operationSetId": "song-create",
            "expectedRevision": 0,
            "operations": [{
                "type": "replace_song",
                "target": { "scope": "stored", "song": 1 },
                "name": "AGENT SONG",
                "rows": [{
                    "repeats": 2,
                    "patterns": [
                        { "pattern": "A01" },
                        { "pattern": "A02", "mutedTracks": ["BD"] }
                    ]
                }]
            }]
        });
        let applied = state.apply_now(&create).unwrap();
        assert_eq!(applied["resultingRevision"], 1);
        assert_eq!(state.apply_now(&create).unwrap(), applied);

        let created = state
            .inspect_song(&json!({
                "scope": "stored",
                "song": 1,
                "resolveReferences": true
            }))
            .unwrap();
        assert_eq!(created["name"], "AGENT SONG");
        assert_eq!(created["rowCount"], 1);
        assert_eq!(created["rows"][0]["patterns"][1]["mutedTracksMask"], 1);
        assert_eq!(created["references"].as_array().unwrap().len(), 2);
        assert_eq!(state.inspect_state()["transport"], baseline_transport);

        let edits = json!({
            "operationSetId": "song-row-edits",
            "expectedRevision": 1,
            "operations": [
                {
                    "type": "insert_song_row",
                    "target": { "scope": "stored", "song": 1 },
                    "row": 1,
                    "value": { "repeats": 1, "patterns": [{ "pattern": "B01" }] }
                },
                {
                    "type": "update_song_row",
                    "target": { "scope": "stored", "song": 1 },
                    "row": 0,
                    "value": { "repeats": 3, "patterns": [{ "pattern": "A03", "mutedTracks": ["SD"] }] }
                },
                {
                    "type": "copy_song_row",
                    "target": { "scope": "stored", "song": 1 },
                    "sourceRow": 0,
                    "targetRow": 2
                },
                {
                    "type": "move_song_row",
                    "target": { "scope": "stored", "song": 1 },
                    "sourceRow": 2,
                    "targetRow": 0
                },
                {
                    "type": "remove_song_row",
                    "target": { "scope": "stored", "song": 1 },
                    "row": 1
                }
            ]
        });
        let dry_run = state
            .apply_now(&json!({
                "operationSetId": "song-row-edits-dry",
                "expectedRevision": 1,
                "dryRun": true,
                "operations": edits["operations"].clone()
            }))
            .unwrap();
        assert_eq!(dry_run["status"], "dry_run");
        assert_eq!(dry_run["projectedRevision"], 2);
        assert_eq!(dry_run["projectedSong"]["rowCount"], 2);
        state.apply_now(&edits).unwrap();
        let edited = state
            .inspect_song(&json!({ "scope": "stored", "song": 1 }))
            .unwrap();
        assert_eq!(edited["rowCount"], 2);
        assert_eq!(edited["rows"][0]["patterns"][0]["pattern"], "A03");
        assert_eq!(edited["rows"][1]["patterns"][0]["pattern"], "B01");

        state
            .rollback_snapshot(&json!({ "snapshotId": "before-song", "expectedRevision": 2 }))
            .unwrap();
        let restored = state
            .inspect_song(&json!({ "scope": "stored", "song": 1 }))
            .unwrap();
        assert_eq!(restored["rowCount"], 0);
        assert_eq!(state.inspect_state()["revision"], 3);
    }

    #[test]
    fn macro_definitions_are_persistent_but_activation_is_transient() {
        let mut state = MockBridgeState::default();
        state
            .create_snapshot(&json!({ "snapshotId": "before-macros" }))
            .unwrap();
        let applied = state
            .apply_now(&json!({
                "operationSetId": "define-macros",
                "expectedRevision": 0,
                "operations": [
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
                            { "track": "SD", "parameter": "amp_pan", "depth": -32 }
                        ]
                    },
                    { "type": "copy_performance", "sourcePerformance": 1, "targetPerformance": 2 },
                    { "type": "clear_performance", "performance": 1 }
                ]
            }))
            .unwrap();
        assert_eq!(applied["resultingRevision"], 1);
        let kit = state.inspect_kit();
        assert_eq!(kit["macros"]["scenes"][0]["lockCount"], 0);
        assert_eq!(kit["macros"]["scenes"][1]["lockCount"], 2);
        assert_eq!(kit["macros"]["performances"][0]["lockCount"], 0);
        assert_eq!(kit["macros"]["performances"][1]["lockCount"], 1);

        state
            .set_active_scene(&json!({ "scene": 2, "lane": "nrpn" }))
            .unwrap();
        state
            .set_performance_macro(&json!({ "performance": 3, "amount": 96, "lane": "cc" }))
            .unwrap();
        let live = state.inspect_state();
        assert_eq!(live["revision"], 1);
        assert_eq!(live["liveMacros"]["activeScene"], 2);
        assert_eq!(live["liveMacros"]["performanceAmounts"]["3"], 96);

        let rolled_back = state
            .rollback_snapshot(&json!({ "snapshotId": "before-macros", "expectedRevision": 1 }))
            .unwrap();
        assert_eq!(rolled_back["revision"], 2);
        let restored = state.inspect_kit();
        assert_eq!(restored["macros"]["scenes"][1]["lockCount"], 0);
        assert_eq!(restored["macros"]["performances"][1]["lockCount"], 0);
        assert_eq!(state.inspect_state()["liveMacros"]["activeScene"], 2);
    }
}
