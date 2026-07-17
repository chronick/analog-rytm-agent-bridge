use crate::{
    hardware::{
        apply_persistent_operations, canonical_state_summary, inspect_work_buffer_state,
        read_work_buffer_state, restore_raw_state, state_summary, write_capture_delta,
        ChangedObjects, RawState, RytmMidiSession,
    },
    state::{
        parse_operation_set, parse_operations, validation_result, EventEntry, OperationSetInput,
    },
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

struct AppliedOperationSet {
    input: Value,
    result: Value,
}

struct HardwareSnapshot {
    label: Option<String>,
    raw: RawState,
    summary: Value,
}

pub struct HardwareBridgeState {
    session: RytmMidiSession,
    revision: u64,
    id_counter: u64,
    operation_sets: Vec<Value>,
    applied_by_id: HashMap<String, AppliedOperationSet>,
    snapshots: HashMap<String, HardwareSnapshot>,
    snapshot_order: Vec<String>,
    events: Vec<EventEntry>,
}

impl HardwareBridgeState {
    pub fn open(port_match: &str) -> Result<Self, String> {
        Ok(Self {
            session: RytmMidiSession::open(port_match)?,
            revision: 0,
            id_counter: 1,
            operation_sets: Vec::new(),
            applied_by_id: HashMap::new(),
            snapshots: HashMap::new(),
            snapshot_order: Vec::new(),
            events: Vec::new(),
        })
    }

    pub fn session_mut(&mut self) -> &mut RytmMidiSession {
        &mut self.session
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn operation_sets(&self) -> Vec<Value> {
        self.operation_sets.clone()
    }

    pub fn snapshot_summaries(&self) -> Vec<Value> {
        self.snapshot_order
            .iter()
            .filter_map(|id| {
                self.snapshots
                    .get(id)
                    .map(|snapshot| snapshot.summary.clone())
            })
            .collect()
    }

    pub fn inspect_summary(&mut self) -> Result<Value, String> {
        inspect_work_buffer_state(&mut self.session)
    }

    pub fn inspect_kit(&mut self) -> Result<Value, String> {
        self.inspect_summary().map(|summary| summary["kit"].clone())
    }

    pub fn inspect_sound(&mut self, track_index: usize) -> Result<Value, String> {
        self.inspect_summary()
            .map(|summary| summary["kit"]["sounds"][track_index].clone())
    }

    pub fn inspect_global(&mut self) -> Result<Value, String> {
        self.inspect_summary().map(|summary| {
            json!({
                "global": summary["global"].clone(),
                "settings": summary["settings"].clone(),
            })
        })
    }

    pub fn validate(&mut self, params: &Value) -> Result<Value, String> {
        let raw = params
            .get("operations")
            .ok_or_else(|| "params.operations is required".to_string())?;
        let generic = validation_result(raw);
        if generic["valid"] != Value::Bool(true) {
            return Ok(generic);
        }
        let operations = parse_operations(raw)?;
        let mut capture = read_work_buffer_state(&mut self.session)?;
        match apply_persistent_operations(&mut capture, &operations) {
            Ok(changed) => Ok(json!({
                "valid": true,
                "errors": [],
                "warnings": [],
                "changedObjects": changed,
            })),
            Err(error) => Ok(json!({
                "valid": false,
                "errors": [error],
                "warnings": [],
            })),
        }
    }

    pub fn propose(&mut self, params: &Value) -> Result<Value, String> {
        let raw = params
            .get("operations")
            .ok_or_else(|| "params.operations is required".to_string())?;
        let validation = self.validate(params)?;
        if validation["valid"] != Value::Bool(true) {
            return Ok(json!({ "validation": validation }));
        }
        let operations = parse_operations(raw)?;
        let mut capture = read_work_buffer_state(&mut self.session)?;
        let before = canonical_state_summary(&capture.project)?;
        let changed = apply_persistent_operations(&mut capture, &operations)?;
        let projected = canonical_state_summary(&capture.project)?;
        Ok(json!({
            "validation": validation,
            "changedObjects": changed,
            "basePattern": before["pattern"].clone(),
            "projectedPattern": projected["pattern"].clone(),
            "baseState": compact_object_state(&before),
            "projectedState": compact_object_state(&projected),
        }))
    }

    pub fn apply_now(&mut self, params: &Value) -> Result<Value, String> {
        let normalized = normalize_immediate_params(params)?;
        let input = parse_operation_set(&normalized)?;
        let input_value = serde_json::to_value(&input).map_err(error_string)?;
        if let Some(id) = &input.operation_set_id {
            if let Some(existing) = self.applied_by_id.get(id) {
                if existing.input != input_value {
                    return Err(format!(
                        "operationSetId already exists with a different payload: {id}"
                    ));
                }
                return Ok(existing.result.clone());
            }
        }
        self.ensure_revision(input.expected_revision)?;

        let mut capture = read_work_buffer_state(&mut self.session)?;
        let baseline = RawState::from_capture(&capture);
        let changed = apply_persistent_operations(&mut capture, &input.operations)?;
        let operation_set_id = input
            .operation_set_id
            .clone()
            .unwrap_or_else(|| self.next_id("ops"));

        if input.dry_run {
            return Ok(json!({
                "operationSetId": operation_set_id,
                "expectedRevision": input.expected_revision,
                "applyAt": input.apply_at,
                "latePolicy": input.late_policy,
                "operations": input.operations,
                "status": "dry_run",
                "validation": { "valid": true, "errors": [], "warnings": [] },
                "changedObjects": changed,
                "projectedRevision": self.revision + u64::from(changed.any()),
                "projectedState": compact_object_state(&canonical_state_summary(&capture.project)?),
            }));
        }

        let write = write_capture_delta(&mut self.session, &capture, &baseline, changed)?;
        if changed.any() {
            self.revision += 1;
        }
        let now = timestamp();
        let result = applied_result(
            &operation_set_id,
            &input,
            self.revision,
            changed,
            &write,
            &now,
        );
        self.operation_sets.push(result.clone());
        self.applied_by_id.insert(
            operation_set_id.clone(),
            AppliedOperationSet {
                input: input_value,
                result: result.clone(),
            },
        );
        self.append_event(json!({
            "type": "operation_set.applied",
            "operationSetId": operation_set_id,
            "boundary": "immediate",
            "revision": self.revision,
            "changed": changed.any(),
            "changedObjects": changed,
            "appliedAt": now,
        }));
        Ok(result)
    }

    pub fn create_snapshot(&mut self, params: &Value) -> Result<Value, String> {
        let object = params
            .as_object()
            .ok_or_else(|| "params must be a JSON object".to_string())?;
        let requested_id = object
            .get("snapshotId")
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| "snapshotId must be a string".to_string())
            })
            .transpose()?;
        let label = object
            .get("label")
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| "label must be a string".to_string())
            })
            .transpose()?
            .map(str::to_string);
        if label.as_ref().is_some_and(|label| label.len() > 80) {
            return Err("label must be 80 characters or fewer".to_string());
        }
        let snapshot_id = requested_id
            .map(str::to_string)
            .unwrap_or_else(|| self.next_id("snapshot"));
        validate_safe_id(&snapshot_id, "snapshotId")?;
        if let Some(existing) = self.snapshots.get(&snapshot_id) {
            if existing.label != label {
                return Err(format!(
                    "snapshotId already exists with a different label: {snapshot_id}"
                ));
            }
            return Ok(existing.summary.clone());
        }

        let capture = read_work_buffer_state(&mut self.session)?;
        let raw = RawState::from_capture(&capture);
        let summary = json!({
            "snapshotId": snapshot_id,
            "label": label,
            "revision": self.revision,
            "createdAt": timestamp(),
            "activePattern": raw.summary["pattern"]["slot"].clone(),
            "objects": ["work_buffer_pattern", "work_buffer_kit", "work_buffer_global", "settings"],
        });
        self.snapshot_order.push(snapshot_id.clone());
        self.snapshots.insert(
            snapshot_id,
            HardwareSnapshot {
                label,
                raw,
                summary: summary.clone(),
            },
        );
        self.append_event(json!({ "type": "snapshot.created", "snapshot": summary }));
        Ok(summary)
    }

    pub fn rollback_snapshot(&mut self, params: &Value) -> Result<Value, String> {
        let object = params
            .as_object()
            .ok_or_else(|| "params must be a JSON object".to_string())?;
        let snapshot_id = object
            .get("snapshotId")
            .and_then(Value::as_str)
            .ok_or_else(|| "snapshotId is required".to_string())?;
        if let Some(expected_revision) = object.get("expectedRevision") {
            self.ensure_revision(
                expected_revision
                    .as_u64()
                    .ok_or_else(|| "expectedRevision must be a non-negative integer".to_string())?,
            )?;
        }
        let raw = self
            .snapshots
            .get(snapshot_id)
            .ok_or_else(|| format!("unknown snapshotId: {snapshot_id}"))?
            .raw
            .clone();
        let current = read_work_buffer_state(&mut self.session)?;
        let changed = changed_between(&state_summary(&current.project), &raw.summary);
        let observed = if changed.any() {
            restore_raw_state(&mut self.session, &raw, changed)?
        } else {
            raw.summary.clone()
        };
        if changed.any() {
            self.revision += 1;
        }
        self.append_event(json!({
            "type": "snapshot.rolled_back",
            "snapshotId": snapshot_id,
            "revision": self.revision,
            "changed": changed.any(),
            "changedObjects": changed,
        }));
        Ok(json!({
            "status": if changed.any() { "restored-and-verified" } else { "already-converged" },
            "snapshotId": snapshot_id,
            "revision": self.revision,
            "changedObjects": changed,
            "state": compact_object_state(&observed),
        }))
    }

    pub fn read_events(&self, params: &Value) -> Result<Value, String> {
        let after_cursor = params
            .get("afterCursor")
            .map(|value| {
                value
                    .as_u64()
                    .ok_or_else(|| "afterCursor must be a non-negative integer".to_string())
            })
            .transpose()?
            .unwrap_or(0);
        let limit = params
            .get("limit")
            .map(|value| {
                value
                    .as_u64()
                    .filter(|limit| (1..=1000).contains(limit))
                    .ok_or_else(|| "limit must be an integer between 1 and 1000".to_string())
            })
            .transpose()?
            .unwrap_or(1000) as usize;
        serde_json::to_value(
            self.events
                .iter()
                .filter(|event| event.cursor > after_cursor)
                .take(limit)
                .collect::<Vec<_>>(),
        )
        .map_err(error_string)
    }

    pub fn reconcile(&mut self) -> Result<Value, String> {
        let state = self.inspect_summary()?;
        Ok(json!({
            "status": "observed",
            "changed": false,
            "revision": self.revision,
            "state": compact_object_state(&state),
        }))
    }

    pub fn events_after(&self, cursor: u64) -> Vec<EventEntry> {
        self.events
            .iter()
            .filter(|event| event.cursor > cursor)
            .cloned()
            .collect()
    }

    fn ensure_revision(&self, expected: u64) -> Result<(), String> {
        if expected != self.revision {
            return Err(format!(
                "expected revision {expected}, current revision is {}",
                self.revision
            ));
        }
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

fn applied_result(
    id: &str,
    input: &OperationSetInput,
    revision: u64,
    changed: ChangedObjects,
    write: &Value,
    now: &str,
) -> Value {
    json!({
        "operationSetId": id,
        "expectedRevision": input.expected_revision,
        "applyAt": input.apply_at,
        "latePolicy": input.late_policy,
        "operations": input.operations,
        "status": "applied",
        "submittedAt": now,
        "appliedAt": now,
        "appliedAtBoundary": "immediate",
        "resultingRevision": revision,
        "changed": changed.any(),
        "changedObjects": changed,
        "writeStatus": write["status"].clone(),
        "observedState": compact_object_state(&write["state"]),
    })
}

fn compact_object_state(summary: &Value) -> Value {
    json!({
        "pattern": summary["pattern"].clone(),
        "kit": summary["kit"].clone(),
        "global": summary["global"].clone(),
        "settings": summary["settings"].clone(),
        "compatibility": summary["compatibility"].clone(),
    })
}

fn changed_between(current: &Value, target: &Value) -> ChangedObjects {
    ChangedObjects {
        pattern: current["pattern"] != target["pattern"],
        kit: current["kit"] != target["kit"],
        global: current["global"] != target["global"],
        settings: current["settings"] != target["settings"],
    }
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

fn normalize_immediate_params(params: &Value) -> Result<Value, String> {
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
    Ok(Value::Object(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn immediate_operations_receive_scheduler_defaults() {
        let normalized = normalize_immediate_params(&json!({
            "expectedRevision": 0,
            "operations": [{ "type": "set_track_machine", "track": "BD", "machine": "bdclassic" }]
        }))
        .unwrap();
        let input = parse_operation_set(&normalized).unwrap();
        assert!(matches!(input.apply_at, crate::state::ApplyAt::NextStep));
        assert!(matches!(
            input.late_policy,
            crate::state::LatePolicy::Reject
        ));
    }
}
