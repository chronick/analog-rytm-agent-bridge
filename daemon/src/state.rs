use crate::samples::SampleService;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    time::{SystemTime, UNIX_EPOCH},
};

const TRACK_NAMES: [&str; 12] = [
    "BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB",
];

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
        value: f64,
    },
    ClearParameterLock {
        #[serde(default)]
        pattern: Option<String>,
        track: String,
        step: u8,
        parameter: String,
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEntry {
    pub cursor: u64,
    pub received_at: String,
    pub event: Value,
}

#[derive(Clone, Default)]
struct Pattern {
    slot: String,
    length: u8,
    track_lengths: BTreeMap<String, u8>,
    machines: BTreeMap<String, String>,
    sample_slots: BTreeMap<String, SampleSlot>,
    kit_parameters: BTreeMap<String, Value>,
    trigs: HashMap<String, Trig>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleSlot {
    slot: u8,
    sample_id: String,
}

#[derive(Clone)]
struct Trig {
    track: String,
    step: u8,
    velocity: u8,
    micro_timing: Option<i8>,
    condition: Option<String>,
    retrig: Option<bool>,
    locks: BTreeMap<String, f64>,
}

pub struct MockBridgeState {
    revision: u64,
    id_counter: u64,
    active_pattern: String,
    transport: TransportState,
    patterns: BTreeMap<String, Pattern>,
    operation_sets: Vec<OperationSetRecord>,
    snapshots: Vec<SnapshotRecord>,
    events: Vec<EventEntry>,
    samples: SampleService,
}

impl Default for MockBridgeState {
    fn default() -> Self {
        let active_pattern = "A01".to_string();
        let mut patterns = BTreeMap::new();
        patterns.insert(active_pattern.clone(), empty_pattern(&active_pattern));
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
            operation_sets: Vec::new(),
            snapshots: Vec::new(),
            events: Vec::new(),
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
            "activePattern": self.inspect_pattern(&self.active_pattern).expect("active pattern is valid"),
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
        let mut projected = self.patterns.clone();
        apply_operations(&mut projected, &operations, &pattern)?;
        Ok(json!({
            "validation": validation,
            "basePattern": base,
            "projectedPattern": pattern_summary(projected.remove(&pattern).unwrap_or_else(|| empty_pattern(&pattern))),
        }))
    }

    pub fn queue(&mut self, params: &Value) -> Result<Value, String> {
        let input = parse_operation_set(params)?;
        self.samples.validate_assignments(&input.operations)?;
        self.ensure_current_revision(input.expected_revision)?;
        if input.dry_run {
            return self.dry_run(&input);
        }
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
        self.ensure_current_revision(input.expected_revision)?;
        if input.dry_run {
            return self.dry_run(&input);
        }
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
        let mut projected = self.patterns.clone();
        apply_operations(&mut projected, &input.operations, &self.active_pattern)?;
        Ok(json!({
            "operationSetId": input.operation_set_id,
            "expectedRevision": input.expected_revision,
            "applyAt": input.apply_at,
            "latePolicy": input.late_policy,
            "operations": input.operations,
            "status": "dry_run",
            "validation": { "valid": true, "errors": [], "warnings": [] },
            "projectedRevision": self.revision + 1,
            "projectedPattern": pattern_summary(projected.remove(&self.active_pattern).unwrap_or_else(|| empty_pattern(&self.active_pattern))),
        }))
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
        apply_operations(&mut self.patterns, &operations, &self.active_pattern)?;
        self.revision += 1;
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
    for value in values {
        match serde_json::from_value::<PersistentOperation>(value.clone()) {
            Ok(operation) => {
                if let Err(error) = validate_operation(&operation) {
                    errors.push(error);
                }
            }
            Err(error) => errors.push(format!("invalid operation: {error}")),
        }
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
            validate_finite_range(*value, "value", 0.0, 127.0)?;
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
    }
    Ok(())
}

fn apply_operations(
    patterns: &mut BTreeMap<String, Pattern>,
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
                trig.locks.insert(parameter.clone(), *value);
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
        }
    }
    Ok(())
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

fn capabilities() -> Value {
    json!({
        "realtimeMidi": true,
        "sysExState": true,
        "patternEdit": true,
        "kitEdit": true,
        "machineEdit": true,
        "sampleSlotAssignment": true,
        "sampleTransfer": true,
        "sceneMacros": false,
        "performanceMacros": false,
        "songs": false,
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
}
