use crate::{
    hardware::RawState,
    state::{ApplyAt, EventEntry, OperationSetInput},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const STORE_SCHEMA: &str = "analog-rytm-hardware-state.v1";
const MIDI_CLOCKS_PER_STEP: u8 = 6;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClockSource {
    Generated,
    Observed,
}

impl ClockSource {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "generated" => Ok(Self::Generated),
            "observed" => Ok(Self::Observed),
            _ => Err(format!(
                "unsupported clock source {value:?}; expected generated or observed"
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareTransportState {
    pub epoch: String,
    pub playing: bool,
    pub clock_source: ClockSource,
    pub pattern: String,
    pub step: u8,
    pub beat: u64,
    pub measure: u64,
    pub steps_per_beat: u8,
    pub beats_per_measure: u8,
    pub pattern_length: u8,
    pub tempo: f64,
    pub absolute_step: u64,
    pub midi_clock: u64,
}

impl HardwareTransportState {
    pub fn new(epoch: String) -> Self {
        Self {
            epoch,
            playing: false,
            clock_source: ClockSource::Observed,
            pattern: "A01".to_string(),
            step: 0,
            beat: 0,
            measure: 0,
            steps_per_beat: 4,
            beats_per_measure: 4,
            pattern_length: 64,
            tempo: 120.0,
            absolute_step: 0,
            midi_clock: 0,
        }
    }

    pub fn begin_epoch(
        &mut self,
        epoch: String,
        pattern: String,
        pattern_length: u8,
        tempo: f64,
        clock_source: ClockSource,
    ) {
        self.epoch = epoch;
        self.playing = false;
        self.clock_source = clock_source;
        self.pattern = pattern;
        self.pattern_length = pattern_length.max(1);
        self.tempo = tempo;
        self.step = 0;
        self.beat = 0;
        self.measure = 0;
        self.absolute_step = 0;
        self.midi_clock = 0;
    }

    pub fn start(&mut self, epoch: String) {
        self.epoch = epoch;
        self.playing = true;
        self.step = 0;
        self.beat = 0;
        self.measure = 0;
        self.absolute_step = 0;
        self.midi_clock = 0;
    }

    pub fn tick(&mut self) -> Vec<&'static str> {
        if !self.playing {
            return Vec::new();
        }
        self.midi_clock += 1;
        if !self
            .midi_clock
            .is_multiple_of(u64::from(MIDI_CLOCKS_PER_STEP))
        {
            return Vec::new();
        }

        self.absolute_step += 1;
        self.step = (self.step + 1) % self.pattern_length;
        self.beat = (self.absolute_step / u64::from(self.steps_per_beat))
            % u64::from(self.beats_per_measure);
        self.measure = self.absolute_step
            / (u64::from(self.steps_per_beat) * u64::from(self.beats_per_measure));

        let mut boundaries = vec!["next_step"];
        if self
            .absolute_step
            .is_multiple_of(u64::from(self.steps_per_beat))
        {
            boundaries.push("next_beat");
        }
        if self
            .absolute_step
            .is_multiple_of(u64::from(self.steps_per_beat) * u64::from(self.beats_per_measure))
        {
            boundaries.push("next_measure");
        }
        if self.step == 0 {
            boundaries.push("next_pattern");
        }
        boundaries
    }

    pub fn resolve(&self, apply_at: &ApplyAt) -> Result<BoundaryTarget, String> {
        let requested_epoch = apply_at.transport_epoch().ok_or_else(|| {
            "applyAt.transportEpoch is required for hardware queueing".to_string()
        })?;
        if requested_epoch != self.epoch {
            return Err(format!(
                "applyAt.transportEpoch {requested_epoch:?} does not match current epoch {:?}",
                self.epoch
            ));
        }

        let absolute_step = match apply_at.kind() {
            "next_step" => self.absolute_step + 1,
            "next_beat" => next_multiple(self.absolute_step, u64::from(self.steps_per_beat)),
            "next_measure" => next_multiple(
                self.absolute_step,
                u64::from(self.steps_per_beat) * u64::from(self.beats_per_measure),
            ),
            "next_pattern" => self.absolute_step + u64::from(self.pattern_length - self.step),
            "pattern_step" => {
                let ApplyAt::PatternStep { pattern, step, .. } = apply_at else {
                    unreachable!("kind and variant must agree")
                };
                if pattern != &self.pattern {
                    return Err(format!(
                        "pattern_step targets {pattern}, but current transport pattern is {}",
                        self.pattern
                    ));
                }
                if *step >= self.pattern_length {
                    return Err(format!(
                        "pattern_step {} is outside current pattern length {}",
                        step, self.pattern_length
                    ));
                }
                let distance = if *step > self.step {
                    *step - self.step
                } else {
                    self.pattern_length - self.step + *step
                };
                self.absolute_step + u64::from(distance)
            }
            kind => return Err(format!("unsupported hardware boundary {kind:?}")),
        };
        Ok(BoundaryTarget {
            transport_epoch: self.epoch.clone(),
            kind: apply_at.kind().to_string(),
            absolute_step,
        })
    }
}

fn next_multiple(current: u64, size: u64) -> u64 {
    (current / size + 1) * size
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryTarget {
    pub transport_epoch: String,
    pub kind: String,
    pub absolute_step: u64,
}

impl BoundaryTarget {
    pub fn is_due(&self, transport: &HardwareTransportState) -> bool {
        self.transport_epoch == transport.epoch && transport.absolute_step >= self.absolute_step
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HardwareOperationStatus {
    Queued,
    Applied,
    Rejected,
}

impl HardwareOperationStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Applied => "applied",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareOperationSet {
    pub operation_set_id: String,
    pub input: OperationSetInput,
    pub target: BoundaryTarget,
    pub status: HardwareOperationStatus,
    pub submitted_at: String,
    pub queued_at: String,
    pub applied_at: Option<String>,
    pub applied_at_boundary: Option<String>,
    pub resulting_revision: Option<u64>,
    pub rejection_reason: Option<String>,
    pub result: Option<Value>,
}

impl HardwareOperationSet {
    pub fn public_value(&self) -> Value {
        let mut value = json!({
            "operationSetId": self.operation_set_id,
            "expectedRevision": self.input.expected_revision,
            "applyAt": self.input.apply_at,
            "latePolicy": self.input.late_policy,
            "operations": self.input.operations,
            "status": self.status.as_str(),
            "submittedAt": self.submitted_at,
            "queuedAt": self.queued_at,
            "resolvedBoundary": self.target,
        });
        if let Some(applied_at) = &self.applied_at {
            value["appliedAt"] = json!(applied_at);
        }
        if let Some(boundary) = &self.applied_at_boundary {
            value["appliedAtBoundary"] = json!(boundary);
        }
        if let Some(revision) = self.resulting_revision {
            value["resultingRevision"] = json!(revision);
        }
        if let Some(reason) = &self.rejection_reason {
            value["rejectionReason"] = json!(reason);
        }
        if let Some(result) = &self.result {
            if let Some(fields) = result.as_object() {
                let target = value
                    .as_object_mut()
                    .expect("operation-set public value is always an object");
                for (key, field) in fields {
                    target.insert(key.clone(), field.clone());
                }
            }
        }
        value
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DurableSnapshot {
    pub label: Option<String>,
    pub raw: RawState,
    pub summary: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableHardwareState {
    schema: String,
    pub revision: u64,
    pub id_counter: u64,
    pub operation_sets: Vec<HardwareOperationSet>,
    pub snapshots: HashMap<String, DurableSnapshot>,
    pub snapshot_order: Vec<String>,
    pub events: Vec<EventEntry>,
    pub last_observed_state: Option<Value>,
    pub transport: HardwareTransportState,
}

impl Default for DurableHardwareState {
    fn default() -> Self {
        Self {
            schema: STORE_SCHEMA.to_string(),
            revision: 0,
            id_counter: 1,
            operation_sets: Vec::new(),
            snapshots: HashMap::new(),
            snapshot_order: Vec::new(),
            events: Vec::new(),
            last_observed_state: None,
            transport: HardwareTransportState::new("uninitialized".to_string()),
        }
    }
}

pub struct HardwareScheduler {
    path: PathBuf,
    pub state: DurableHardwareState,
}

pub fn acquire_state_lock(state_path: &Path) -> Result<File, String> {
    let parent = state_path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "failed to create scheduler state directory {}: {error}",
            parent.display()
        )
    })?;
    let lock_path = state_path.with_extension("json.lock");
    let lock = File::create(&lock_path).map_err(|error| {
        format!(
            "failed to create scheduler state lock {}: {error}",
            lock_path.display()
        )
    })?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(std::fs::TryLockError::WouldBlock) => Err(format!(
            "another daemon already owns hardware state {}; refusing to run two instances against one store",
            state_path.display()
        )),
        Err(std::fs::TryLockError::Error(error)) => Err(format!(
            "failed to lock scheduler state {}: {error}",
            lock_path.display()
        )),
    }
}

impl HardwareScheduler {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, String> {
        let path = path.into();
        let state = if path.exists() {
            let bytes = fs::read(&path).map_err(|error| {
                format!("failed to read scheduler state {}: {error}", path.display())
            })?;
            let state: DurableHardwareState = serde_json::from_slice(&bytes).map_err(|error| {
                format!(
                    "failed to decode scheduler state {}: {error}",
                    path.display()
                )
            })?;
            if state.schema != STORE_SCHEMA {
                return Err(format!(
                    "unsupported scheduler state schema {:?}; expected {STORE_SCHEMA:?}",
                    state.schema
                ));
            }
            state
        } else {
            DurableHardwareState::default()
        };
        Ok(Self { path, state })
    }

    pub fn persist(&self) -> Result<(), String> {
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create scheduler state directory {}: {error}",
                parent.display()
            )
        })?;
        // Process-unique temp name: a fixed name would let two writers clobber
        // each other's in-flight temp file and race the rename.
        let temporary = self
            .path
            .with_extension(format!("json.tmp.{}", std::process::id()));
        let bytes = serde_json::to_vec_pretty(&self.state)
            .map_err(|error| format!("failed to encode scheduler state: {error}"))?;
        let mut file = File::create(&temporary).map_err(|error| {
            format!(
                "failed to create scheduler state {}: {error}",
                temporary.display()
            )
        })?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| {
                format!(
                    "failed to persist scheduler state {}: {error}",
                    temporary.display()
                )
            })?;
        fs::rename(&temporary, &self.path).map_err(|error| {
            format!(
                "failed to replace scheduler state {}: {error}",
                self.path.display()
            )
        })?;
        // The rename itself is only durable across power loss once the parent
        // directory entry is synced.
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                format!(
                    "failed to sync scheduler state directory {}: {error}",
                    parent.display()
                )
            })
    }

    pub fn next_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}-{}", self.state.id_counter);
        self.state.id_counter += 1;
        id
    }

    pub fn append_event(&mut self, event: Value) {
        let cursor = self.state.events.last().map_or(1, |entry| entry.cursor + 1);
        self.state.events.push(EventEntry {
            cursor,
            received_at: timestamp(),
            event,
        });
    }

    pub fn operation_by_id(&self, id: &str) -> Option<&HardwareOperationSet> {
        self.state
            .operation_sets
            .iter()
            .find(|record| record.operation_set_id == id)
    }

    pub fn operation_index_by_id(&self, id: &str) -> Option<usize> {
        self.state
            .operation_sets
            .iter()
            .position(|record| record.operation_set_id == id)
    }
}

pub fn timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "unix:{}.{:03}",
        duration.as_secs(),
        duration.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::LatePolicy;

    fn apply_at(kind: &str, epoch: &str) -> ApplyAt {
        serde_json::from_value(json!({ "kind": kind, "transportEpoch": epoch })).unwrap()
    }

    #[test]
    fn resolves_all_boundaries_against_an_explicit_epoch_and_midi_clock() {
        let mut transport = HardwareTransportState::new("epoch-1".to_string());
        transport.pattern_length = 16;
        transport.playing = true;

        assert_eq!(
            transport
                .resolve(&apply_at("next_step", "epoch-1"))
                .unwrap()
                .absolute_step,
            1
        );
        assert_eq!(
            transport
                .resolve(&apply_at("next_beat", "epoch-1"))
                .unwrap()
                .absolute_step,
            4
        );
        assert_eq!(
            transport
                .resolve(&apply_at("next_measure", "epoch-1"))
                .unwrap()
                .absolute_step,
            16
        );
        assert_eq!(
            transport
                .resolve(&apply_at("next_pattern", "epoch-1"))
                .unwrap()
                .absolute_step,
            16
        );
        assert!(transport.resolve(&apply_at("next_step", "stale")).is_err());

        let mut crossed = Vec::new();
        for _ in 0..24 {
            crossed.extend(transport.tick());
        }
        assert_eq!(transport.step, 4);
        assert!(crossed.contains(&"next_beat"));
    }

    #[test]
    fn atomically_persists_queue_events_and_transport() {
        let directory = std::env::temp_dir().join(format!(
            "analog-rytm-scheduler-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("state.json");
        let mut scheduler = HardwareScheduler::load(&path).unwrap();
        scheduler.state.transport.epoch = "epoch-persisted".to_string();
        let input = OperationSetInput {
            operation_set_id: Some("ops-persisted".to_string()),
            expected_revision: 0,
            apply_at: apply_at("next_measure", "epoch-persisted"),
            late_policy: LatePolicy::RollForward,
            operations: serde_json::from_value(json!([
                { "type": "set_kit_parameter", "track": "BD", "parameter": "track_level", "value": 99 }
            ]))
            .unwrap(),
            dry_run: false,
        };
        scheduler.state.operation_sets.push(HardwareOperationSet {
            operation_set_id: "ops-persisted".to_string(),
            input,
            target: BoundaryTarget {
                transport_epoch: "epoch-persisted".to_string(),
                kind: "next_measure".to_string(),
                absolute_step: 16,
            },
            status: HardwareOperationStatus::Queued,
            submitted_at: timestamp(),
            queued_at: timestamp(),
            applied_at: None,
            applied_at_boundary: None,
            resulting_revision: None,
            rejection_reason: None,
            result: None,
        });
        scheduler.append_event(json!({ "type": "operation_set.queued" }));
        scheduler.persist().unwrap();

        let restored = HardwareScheduler::load(&path).unwrap();
        assert_eq!(restored.state.transport.epoch, "epoch-persisted");
        assert_eq!(restored.state.operation_sets.len(), 1);
        assert_eq!(restored.state.events.len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn loads_snapshots_written_before_song_raw_was_added() {
        let snapshot: DurableSnapshot = serde_json::from_value(json!({
            "label": "legacy",
            "raw": {
                "pattern_raw": [],
                "kit_raw": [],
                "global_raw": [],
                "settings_raw": [],
                "summary": { "pattern": {}, "kit": {}, "global": {}, "settings": {} }
            },
            "summary": { "snapshotId": "legacy" }
        }))
        .unwrap();
        assert!(snapshot.raw.song_raw.is_empty());
    }
}
