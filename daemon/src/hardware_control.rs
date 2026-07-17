use crate::{
    hardware::{
        apply_persistent_operations, canonical_capture_summary, inspect_song_state,
        inspect_work_buffer_state, parse_pattern_slot, query_pattern_summary, read_operation_state,
        read_snapshot_state, read_work_buffer_state, restore_raw_state, send_cc, send_nrpn,
        state_summary, write_capture_delta, write_capture_delta_with_test_verification_failure,
        ChangedObjects, RawState, RytmMidiSession,
    },
    hardware_scheduler::{
        acquire_state_lock, timestamp, BoundaryTarget, ClockSource, DurableSnapshot,
        HardwareOperationSet, HardwareOperationStatus, HardwareScheduler, HardwareTransportState,
    },
    samples::SampleService,
    state::{
        parse_operation_set, parse_operations, validation_result, EventEntry, LatePolicy,
        OperationSetInput,
    },
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::File,
    path::Path,
    time::{Duration, Instant},
};

const RECONNECT_INTERVAL: Duration = Duration::from_secs(1);
const MAX_GENERATED_TICKS_PER_POLL: usize = 8;
const TRACK_NAMES: [&str; 12] = [
    "BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB",
];

struct PendingNoteOff {
    deadline: Instant,
    channel: u8,
    note: u8,
}

pub struct HardwareBridgeState {
    session: Option<RytmMidiSession>,
    port_match: String,
    scheduler: HardwareScheduler,
    clock_source: ClockSource,
    next_reconnect_at: Instant,
    next_generated_clock: Option<Instant>,
    pending_note_offs: Vec<PendingNoteOff>,
    disconnected_reported: bool,
    force_next_verification_failure: bool,
    performance_amounts: BTreeMap<String, u8>,
    samples: SampleService,
    // Held for the daemon lifetime so a second daemon cannot silently share
    // and clobber the same durable state file.
    _state_lock: File,
}

impl HardwareBridgeState {
    pub fn open(
        port_match: &str,
        state_path: &Path,
        clock_source: ClockSource,
        force_next_verification_failure: bool,
    ) -> Result<Self, String> {
        let state_lock = acquire_state_lock(state_path)?;
        let mut state = Self {
            session: None,
            port_match: port_match.to_string(),
            scheduler: HardwareScheduler::load(state_path)?,
            clock_source,
            next_reconnect_at: Instant::now(),
            next_generated_clock: None,
            pending_note_offs: Vec::new(),
            disconnected_reported: false,
            force_next_verification_failure,
            performance_amounts: BTreeMap::new(),
            samples: SampleService::hardware(state_path, port_match)?,
            _state_lock: state_lock,
        };
        state.try_reconnect()?;
        Ok(state)
    }

    pub fn connected(&self) -> bool {
        self.session.is_some()
    }

    pub fn revision(&self) -> u64 {
        self.scheduler.state.revision
    }

    pub fn transport_state(&self) -> &HardwareTransportState {
        &self.scheduler.state.transport
    }

    pub fn operation_sets(&self) -> Vec<Value> {
        self.scheduler
            .state
            .operation_sets
            .iter()
            .map(HardwareOperationSet::public_value)
            .collect()
    }

    pub fn snapshot_summaries(&self) -> Vec<Value> {
        self.scheduler
            .state
            .snapshot_order
            .iter()
            .filter_map(|id| {
                self.scheduler
                    .state
                    .snapshots
                    .get(id)
                    .map(|snapshot| snapshot.summary.clone())
            })
            .collect()
    }

    pub fn inspect_summary(&mut self) -> Result<Value, String> {
        let summary = self.with_session(inspect_work_buffer_state)?;
        self.observe_summary(&summary, "inspect")?;
        Ok(self.with_live_macro_state(summary))
    }

    pub fn inspect_pattern(&mut self, pattern_index: usize) -> Result<Value, String> {
        self.with_session(|session| query_pattern_summary(session, pattern_index))
    }

    pub fn inspect_song(&mut self, params: &Value) -> Result<Value, String> {
        self.with_session(|session| inspect_song_state(session, params))
    }

    pub fn inspect_kit(&mut self) -> Result<Value, String> {
        self.inspect_summary().map(|summary| {
            let mut kit = summary["kit"].clone();
            kit["macros"]["livePerformanceAmounts"] =
                serde_json::to_value(&self.performance_amounts).unwrap_or_else(|_| json!({}));
            kit["macros"]["livePerformanceAmountsSource"] =
                json!(if self.performance_amounts.is_empty() {
                    "unknown"
                } else {
                    "sent"
                });
            kit
        })
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
        if let Err(error) = self.samples.validate_assignments(&operations) {
            return Ok(json!({
                "valid": false,
                "errors": [error],
                "warnings": [],
            }));
        }
        let mut capture =
            self.with_session(|session| read_operation_state(session, &operations))?;
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
        let mut capture =
            self.with_session(|session| read_operation_state(session, &operations))?;
        let before = canonical_capture_summary(&capture)?;
        let changed = apply_persistent_operations(&mut capture, &operations)?;
        let projected = canonical_capture_summary(&capture)?;
        Ok(json!({
            "validation": validation,
            "changedObjects": changed,
            "basePattern": before["pattern"].clone(),
            "projectedPattern": projected["pattern"].clone(),
            "baseState": compact_object_state(&before),
            "projectedState": compact_object_state(&projected),
        }))
    }

    pub fn queue(&mut self, params: &Value) -> Result<Value, String> {
        let input = parse_operation_set(params)?;
        let input_value = serde_json::to_value(&input).map_err(error_string)?;
        if let Some(existing) = self.existing_operation(&input, &input_value)? {
            return Ok(existing);
        }
        self.ensure_revision(input.expected_revision)?;
        if !self.scheduler.state.transport.playing {
            return Err(
                "hardware transport must be playing before operations can be queued".into(),
            );
        }
        let validation = self.validate(params)?;
        if validation["valid"] != Value::Bool(true) {
            return Ok(json!({ "status": "rejected", "validation": validation }));
        }
        let target = self.scheduler.state.transport.resolve(&input.apply_at)?;
        let operation_set_id = input
            .operation_set_id
            .clone()
            .unwrap_or_else(|| self.scheduler.next_id("ops"));
        if input.dry_run {
            return Ok(json!({
                "operationSetId": operation_set_id,
                "expectedRevision": input.expected_revision,
                "applyAt": input.apply_at,
                "latePolicy": input.late_policy,
                "operations": input.operations,
                "status": "dry_run",
                "validation": validation,
                "resolvedBoundary": target,
            }));
        }

        let now = timestamp();
        let record = HardwareOperationSet {
            operation_set_id: operation_set_id.clone(),
            input,
            target: target.clone(),
            status: HardwareOperationStatus::Queued,
            submitted_at: now.clone(),
            queued_at: now,
            applied_at: None,
            applied_at_boundary: None,
            resulting_revision: None,
            rejection_reason: None,
            result: None,
        };
        let public = record.public_value();
        self.scheduler.state.operation_sets.push(record);
        self.scheduler.append_event(json!({
            "type": "operation_set.queued",
            "operationSetId": operation_set_id,
            "resolvedBoundary": target,
            "revision": self.revision(),
        }));
        self.scheduler.persist()?;
        Ok(public)
    }

    pub fn apply_now(&mut self, params: &Value) -> Result<Value, String> {
        let normalized = normalize_immediate_params(params)?;
        let input = parse_operation_set(&normalized)?;
        let input_value = serde_json::to_value(&input).map_err(error_string)?;
        if let Some(existing) = self.existing_operation(&input, &input_value)? {
            return Ok(existing);
        }
        self.ensure_revision(input.expected_revision)?;
        self.samples.validate_assignments(&input.operations)?;

        let mut capture =
            self.with_session(|session| read_operation_state(session, &input.operations))?;
        let baseline = RawState::from_capture(&capture)?;
        let changed = apply_persistent_operations(&mut capture, &input.operations)?;
        let operation_set_id = input
            .operation_set_id
            .clone()
            .unwrap_or_else(|| self.scheduler.next_id("ops"));
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
                "projectedRevision": self.revision() + u64::from(changed.any()),
                "projectedState": compact_object_state(&canonical_capture_summary(&capture)?),
            }));
        }

        let write = self.write_delta(&capture, &baseline, &changed)?;
        if changed.any() {
            self.scheduler.state.revision += 1;
        }
        self.scheduler.state.last_observed_state = Some(write["state"].clone());
        let now = timestamp();
        let record = HardwareOperationSet {
            operation_set_id: operation_set_id.clone(),
            input,
            target: BoundaryTarget {
                transport_epoch: self.scheduler.state.transport.epoch.clone(),
                kind: "immediate".to_string(),
                absolute_step: self.scheduler.state.transport.absolute_step,
            },
            status: HardwareOperationStatus::Applied,
            submitted_at: now.clone(),
            queued_at: now.clone(),
            applied_at: Some(now.clone()),
            applied_at_boundary: Some("immediate".to_string()),
            resulting_revision: Some(self.revision()),
            rejection_reason: None,
            result: Some(applied_details(&changed, &write)),
        };
        let result = record.public_value();
        self.scheduler.state.operation_sets.push(record);
        self.scheduler.append_event(json!({
            "type": "operation_set.applied",
            "operationSetId": operation_set_id,
            "boundary": "immediate",
            "revision": self.revision(),
            "changed": changed.any(),
            "changedObjects": changed,
            "appliedAt": now,
            "acknowledgement": "verified",
        }));
        self.scheduler.persist()?;
        Ok(result)
    }

    pub fn set_live_parameter(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let track = required_string(object, "track")?;
        let track_index = track_index(track)?;
        let parameter = required_string(object, "parameter")?;
        if parameter != "track_level" {
            return Err("hardware realtime parameter currently supports track_level".to_string());
        }
        let value = midi_value(object.get("value"), "value")?;
        let lane = optional_string(object, "lane")?.unwrap_or("cc");
        let channel = self.track_channel(track_index)?;
        match lane {
            "cc" => self.with_session(|session| send_cc(session, channel, 95, value))?,
            "nrpn" => self.with_session(|session| send_nrpn(session, channel, 1, 100, value))?,
            _ => return Err("lane must be cc or nrpn".to_string()),
        }
        let result = json!({
            "track": TRACK_NAMES[track_index],
            "parameter": parameter,
            "value": value,
            "lane": lane,
            "channel": channel + 1,
            "status": "sent",
        });
        self.scheduler
            .append_event(json!({ "type": "live.parameter_sent", "input": result }));
        self.scheduler.persist()?;
        Ok(result)
    }

    pub fn set_active_scene(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let scene = match object.get("scene") {
            Some(Value::Null) => None,
            Some(value) => {
                let scene = value.as_u64().ok_or_else(|| {
                    "scene must be null or an integer between 1 and 12".to_string()
                })?;
                if !(1..=12).contains(&scene) {
                    return Err("scene must be null or an integer between 1 and 12".to_string());
                }
                Some(scene as u8)
            }
            None => return Err("params.scene is required".to_string()),
        };
        let lane = optional_string(object, "lane")?.unwrap_or("cc");
        if lane != "cc" && lane != "nrpn" {
            return Err("lane must be cc or nrpn".to_string());
        }
        let baseline = self.with_session(inspect_work_buffer_state)?;
        let previous = summary_active_scene(&baseline)?;
        let channel = summary_performance_channel(&baseline)?;
        if previous == scene {
            return Ok(json!({
                "scene": scene,
                "lane": lane,
                "channel": channel + 1,
                "status": "already-active",
                "verified": true,
            }));
        }

        let write_result = (|| -> Result<Value, String> {
            self.with_session(|session| send_active_scene(session, channel, scene, lane))?;
            let observed = self.with_session(inspect_work_buffer_state)?;
            if summary_active_scene(&observed)? != scene {
                return Err("active Scene readback did not match the requested value".to_string());
            }
            Ok(observed)
        })();
        let observed = match write_result {
            Ok(observed) => observed,
            Err(write_error) => {
                self.with_session(|session| {
                    send_active_scene(session, channel, previous, lane)
                })
                .map_err(|rollback_error| {
                    format!(
                        "active Scene write failed: {write_error}; transient rollback also failed: {rollback_error}"
                    )
                })?;
                let restored = self.with_session(inspect_work_buffer_state)?;
                if summary_active_scene(&restored)? != previous {
                    return Err(format!(
                        "active Scene write failed: {write_error}; transient rollback verification failed"
                    ));
                }
                return Err(format!(
                    "active Scene write failed and previous Scene was restored: {write_error}"
                ));
            }
        };
        self.scheduler.state.last_observed_state = Some(observed);
        let result = json!({
            "scene": scene,
            "lane": lane,
            "channel": channel + 1,
            "status": if scene.is_some() { "activated-and-verified" } else { "deactivated-and-verified" },
            "verified": true,
        });
        self.scheduler
            .append_event(json!({ "type": "live.scene_sent", "input": result }));
        self.scheduler.persist()?;
        Ok(result)
    }

    pub fn set_performance_macro(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let performance = required_u64(object.get("performance"), "performance")?;
        if !(1..=12).contains(&performance) {
            return Err("performance must be between 1 and 12".to_string());
        }
        let amount = required_u64(object.get("amount"), "amount")?;
        if amount > 127 {
            return Err("amount must be between 0 and 127".to_string());
        }
        let lane = optional_string(object, "lane")?.unwrap_or("cc");
        if lane != "cc" && lane != "nrpn" {
            return Err("lane must be cc or nrpn".to_string());
        }
        let key = performance.to_string();
        if self.performance_amounts.get(&key) == Some(&(amount as u8)) {
            return Ok(json!({
                "performance": performance,
                "amount": amount,
                "lane": lane,
                "status": "already-sent",
                "source": "sent-cache",
            }));
        }
        let channel = self.performance_channel()?;
        self.with_session(|session| {
            send_performance_amount(session, channel, performance as u8, amount as u8, lane)
        })?;
        self.performance_amounts.insert(key, amount as u8);
        let result = json!({
            "performance": performance,
            "amount": amount,
            "lane": lane,
            "channel": channel + 1,
            "status": "sent",
            "source": "sent-cache",
        });
        self.scheduler
            .append_event(json!({ "type": "live.performance_sent", "input": result }));
        self.scheduler.persist()?;
        Ok(result)
    }

    pub fn trigger_track(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let track_index = track_index(required_string(object, "track")?)?;
        let velocity = optional_midi_value(object.get("velocity"), "velocity")?.unwrap_or(100);
        if velocity == 0 {
            return Err("velocity must be between 1 and 127".to_string());
        }
        let duration_ms = optional_u64(object.get("durationMs"), "durationMs")?.unwrap_or(100);
        if !(1..=60_000).contains(&duration_ms) {
            return Err("durationMs must be between 1 and 60000".to_string());
        }
        let channel = self.track_channel(track_index)?;
        let note = track_index as u8;
        self.with_session(|session| session.send(&[0x90 | channel, note, velocity]))?;
        self.pending_note_offs.push(PendingNoteOff {
            deadline: Instant::now() + Duration::from_millis(duration_ms),
            channel,
            note,
        });
        let result = json!({
            "track": TRACK_NAMES[track_index],
            "velocity": velocity,
            "durationMs": duration_ms,
            "channel": channel + 1,
            "note": note,
            "status": "triggered",
        });
        self.scheduler
            .append_event(json!({ "type": "track.triggered", "input": result }));
        self.scheduler.persist()?;
        Ok(result)
    }

    pub fn set_transport(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let command = required_string(object, "command")?;
        let message = match command {
            "start" => 0xFA,
            "continue" => 0xFB,
            "stop" => 0xFC,
            _ => return Err("command must be start, stop, or continue".to_string()),
        };
        if let Some(tempo) = optional_f64(object.get("tempo"), "tempo")? {
            if !(30.0..=300.0).contains(&tempo) {
                return Err("tempo must be between 30 and 300".to_string());
            }
            self.scheduler.state.transport.tempo = tempo;
        }
        self.with_session(|session| session.send(&[message]))?;
        match command {
            "start" => {
                let epoch = self.scheduler.next_id("epoch");
                self.scheduler.state.transport.start(epoch);
                self.reconcile_queued_epochs()?;
                self.next_generated_clock = Some(Instant::now() + self.clock_interval());
            }
            "continue" => {
                self.scheduler.state.transport.playing = true;
                self.next_generated_clock = Some(Instant::now() + self.clock_interval());
            }
            "stop" => {
                self.scheduler.state.transport.playing = false;
                self.next_generated_clock = None;
            }
            _ => unreachable!(),
        }
        let transport =
            serde_json::to_value(&self.scheduler.state.transport).map_err(error_string)?;
        self.scheduler
            .append_event(json!({ "type": "transport.changed", "transport": transport }));
        self.scheduler.persist()?;
        Ok(transport)
    }

    pub fn change_pattern(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let pattern = required_string(object, "pattern")?.to_ascii_uppercase();
        let pattern_index = parse_pattern_slot(&pattern)?;
        let immediate = optional_bool(object.get("immediate"), "immediate")?.unwrap_or(false);
        let channel = self.program_change_channel()?;
        self.with_session(|session| session.send(&[0xC0 | channel, pattern_index as u8]))?;
        self.scheduler.state.transport.pattern.clone_from(&pattern);
        if immediate {
            self.scheduler.state.transport.step = 0;
            self.scheduler.state.transport.absolute_step = 0;
            self.scheduler.state.transport.midi_clock = 0;
        }
        let transport =
            serde_json::to_value(&self.scheduler.state.transport).map_err(error_string)?;
        self.scheduler.append_event(json!({
            "type": "pattern.changed",
            "pattern": pattern,
            "program": pattern_index,
            "channel": channel + 1,
            "transport": transport,
        }));
        self.scheduler.persist()?;
        Ok(transport)
    }

    pub fn create_snapshot(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let requested_id = optional_string(object, "snapshotId")?;
        let label = optional_string(object, "label")?.map(str::to_string);
        if label.as_ref().is_some_and(|label| label.len() > 80) {
            return Err("label must be 80 characters or fewer".to_string());
        }
        let snapshot_id = requested_id
            .map(str::to_string)
            .unwrap_or_else(|| self.scheduler.next_id("snapshot"));
        validate_safe_id(&snapshot_id, "snapshotId")?;
        if let Some(existing) = self.scheduler.state.snapshots.get(&snapshot_id) {
            if existing.label != label {
                return Err(format!(
                    "snapshotId already exists with a different label: {snapshot_id}"
                ));
            }
            return Ok(existing.summary.clone());
        }

        let capture = self.with_session(read_snapshot_state)?;
        let raw = RawState::from_capture(&capture)?;
        let summary = json!({
            "snapshotId": snapshot_id,
            "label": label,
            "revision": self.revision(),
            "createdAt": timestamp(),
            "activePattern": raw.summary["pattern"]["slot"].clone(),
            "objects": ["work_buffer_pattern", "work_buffer_kit", "work_buffer_global", "settings", "work_buffer_song", "stored_songs_1_16"],
        });
        self.scheduler
            .state
            .snapshot_order
            .push(snapshot_id.clone());
        self.scheduler.state.snapshots.insert(
            snapshot_id,
            DurableSnapshot {
                label,
                raw,
                summary: summary.clone(),
            },
        );
        self.scheduler
            .append_event(json!({ "type": "snapshot.created", "snapshot": summary }));
        self.scheduler.persist()?;
        Ok(summary)
    }

    pub fn rollback_snapshot(&mut self, params: &Value) -> Result<Value, String> {
        let object = require_object(params)?;
        let snapshot_id = required_string(object, "snapshotId")?;
        if let Some(expected_revision) =
            optional_u64(object.get("expectedRevision"), "expectedRevision")?
        {
            self.ensure_revision(expected_revision)?;
        }
        let raw = self
            .scheduler
            .state
            .snapshots
            .get(snapshot_id)
            .ok_or_else(|| format!("unknown snapshotId: {snapshot_id}"))?
            .raw
            .clone();
        let current = self.with_session(read_snapshot_state)?;
        let mut changed = changed_between(&RawState::from_capture(&current)?.summary, &raw.summary);
        changed.songs.retain(|key| raw.song_raw.contains_key(key));
        let observed = if changed.any() {
            self.with_session(|session| restore_raw_state(session, &raw, &changed))?
        } else {
            raw.summary.clone()
        };
        if changed.any() {
            self.scheduler.state.revision += 1;
        }
        self.scheduler.state.last_observed_state = Some(observed.clone());
        self.scheduler.append_event(json!({
            "type": "snapshot.rolled_back",
            "snapshotId": snapshot_id,
            "revision": self.revision(),
            "changed": changed.any(),
            "changedObjects": changed,
            "acknowledgement": "verified",
        }));
        self.scheduler.persist()?;
        Ok(json!({
            "status": if changed.any() { "restored-and-verified" } else { "already-converged" },
            "snapshotId": snapshot_id,
            "revision": self.revision(),
            "changedObjects": changed,
            "state": compact_object_state(&observed),
        }))
    }

    pub fn read_events(&self, params: &Value) -> Result<Value, String> {
        let after_cursor = optional_u64(params.get("afterCursor"), "afterCursor")?.unwrap_or(0);
        let limit = optional_u64(params.get("limit"), "limit")?.unwrap_or(1000);
        if !(1..=1000).contains(&limit) {
            return Err("limit must be between 1 and 1000".to_string());
        }
        serde_json::to_value(
            self.scheduler
                .state
                .events
                .iter()
                .filter(|event| event.cursor > after_cursor)
                .take(limit as usize)
                .collect::<Vec<_>>(),
        )
        .map_err(error_string)
    }

    pub fn inspect_samples(&mut self, params: &Value) -> Result<Value, String> {
        self.samples.inspect(params)
    }

    pub fn upload_sample(&mut self, params: &Value) -> Result<Value, String> {
        require_stopped_transport_for_sample_write(self.scheduler.state.transport.playing)?;
        let result = self.samples.upload(params)?;
        self.scheduler
            .append_event(json!({ "type": "sample.uploaded", "sample": result }));
        self.scheduler.persist()?;
        Ok(result)
    }

    pub fn resolve_sample_ram(&mut self, params: &Value) -> Result<Value, String> {
        require_stopped_transport_for_sample_write(self.scheduler.state.transport.playing)?;
        let result = self.samples.resolve_ram(params)?;
        self.scheduler
            .append_event(json!({ "type": "sample.ram_resolved", "sample": result }));
        self.scheduler.persist()?;
        Ok(result)
    }

    pub fn clear_sample_ram(&mut self, params: &Value) -> Result<Value, String> {
        require_stopped_transport_for_sample_write(self.scheduler.state.transport.playing)?;
        let result = self.samples.clear_ram(params)?;
        self.scheduler
            .append_event(json!({ "type": "sample.ram_cleared", "sample": result }));
        self.scheduler.persist()?;
        Ok(result)
    }

    pub fn reconcile(&mut self) -> Result<Value, String> {
        let previous = self.scheduler.state.last_observed_state.clone();
        let summary = self.with_session(inspect_work_buffer_state)?;
        let playing = self.scheduler.state.transport.playing;
        let summary_view = reconciliation_view(&summary, playing);
        let previous_view = previous
            .as_ref()
            .map(|state| reconciliation_view(state, playing));
        let changed = previous_view
            .as_ref()
            .is_some_and(|state| state != &summary_view);
        let changed_objects = previous_view
            .as_ref()
            .map(|state| changed_between(state, &summary_view))
            .unwrap_or_default();
        let midi_changed = previous_view
            .as_ref()
            .is_some_and(|state| state["midi"] != summary_view["midi"]);
        let compatibility_changed = previous_view
            .as_ref()
            .is_some_and(|state| state["compatibility"] != summary_view["compatibility"]);
        if changed {
            self.scheduler.state.revision += 1;
        }
        self.scheduler.state.last_observed_state = Some(summary.clone());
        self.refresh_transport_from_summary(&summary);
        self.scheduler.append_event(json!({
            "type": "state.reconciled",
            "changed": changed,
            "changedObjects": changed_objects,
            "midiChanged": midi_changed,
            "compatibilityChanged": compatibility_changed,
            "revision": self.revision(),
            "source": "explicit",
        }));
        self.scheduler.persist()?;
        Ok(json!({
            "status": "observed",
            "changed": changed,
            "changedObjects": changed_objects,
            "midiChanged": midi_changed,
            "compatibilityChanged": compatibility_changed,
            "revision": self.revision(),
            "state": compact_object_state(&summary),
        }))
    }

    pub fn events_after(&self, cursor: u64) -> Vec<EventEntry> {
        self.scheduler
            .state
            .events
            .iter()
            .filter(|event| event.cursor > cursor)
            .cloned()
            .collect()
    }

    pub fn last_event_cursor(&self) -> u64 {
        self.scheduler
            .state
            .events
            .last()
            .map_or(0, |entry| entry.cursor)
    }

    pub fn poll(&mut self) -> Result<(), String> {
        self.try_reconnect()?;
        if self.session.is_none() {
            return Ok(());
        }
        self.send_due_note_offs();
        self.process_observed_midi()?;
        self.send_generated_clock()?;
        self.apply_due_operations()
    }

    pub fn shutdown(&mut self) -> Result<(), String> {
        let mut send_errors = Vec::new();
        if let Some(session) = &mut self.session {
            if let Err(error) = session.send(&[0xFC]) {
                send_errors.push(error);
            }
            for channel in 0..16 {
                if let Err(error) = send_cc(session, channel, 123, 0) {
                    send_errors.push(error);
                }
            }
        }
        self.session = None;
        self.performance_amounts.clear();
        self.scheduler.state.transport.playing = false;
        self.next_generated_clock = None;
        self.scheduler.append_event(json!({
            "type": "connection.disconnected",
            "reason": "daemon_shutdown",
            "midiCleanup": if send_errors.is_empty() { "sent" } else { "failed" },
            "errors": send_errors,
        }));
        self.scheduler.persist()
    }

    fn try_reconnect(&mut self) -> Result<bool, String> {
        if self.session.is_some() {
            return Ok(true);
        }
        if Instant::now() < self.next_reconnect_at {
            return Ok(false);
        }
        self.next_reconnect_at = Instant::now() + RECONNECT_INTERVAL;
        let mut session = match RytmMidiSession::open(&self.port_match) {
            Ok(session) => session,
            Err(error) => {
                self.report_disconnected(&error)?;
                return Ok(false);
            }
        };
        let capture = match read_work_buffer_state(&mut session) {
            Ok(capture) => capture,
            Err(error) => {
                self.report_disconnected(&error)?;
                return Ok(false);
            }
        };
        let summary = state_summary(&capture.project);
        let input_name = session.input_name.clone();
        let output_name = session.output_name.clone();
        self.session = Some(session);
        self.performance_amounts.clear();
        self.disconnected_reported = false;

        let previous = self.scheduler.state.last_observed_state.clone();
        let was_playing = self.scheduler.state.transport.playing;
        let summary_view = reconciliation_view(&summary, was_playing);
        let changed = previous
            .as_ref()
            .is_some_and(|state| reconciliation_view(state, was_playing) != summary_view);
        if changed {
            self.scheduler.state.revision += 1;
        }
        self.scheduler.state.last_observed_state = Some(summary.clone());
        let epoch = self.scheduler.next_id("epoch");
        let pattern = summary["pattern"]["slot"]
            .as_str()
            .unwrap_or("A01")
            .to_string();
        let length = summary["pattern"]["masterLength"]
            .as_u64()
            .and_then(|value| u8::try_from(value).ok())
            .unwrap_or(64);
        let tempo = summary["settings"]["tempo"].as_f64().unwrap_or(120.0);
        self.scheduler.state.transport.begin_epoch(
            epoch,
            pattern,
            length,
            tempo,
            self.clock_source,
        );
        self.reconcile_queued_epochs()?;
        self.scheduler.append_event(json!({
            "type": "connection.connected",
            "input": input_name,
            "output": output_name,
            "revision": self.revision(),
            "externalStateChanged": changed,
            "transportEpoch": self.scheduler.state.transport.epoch,
        }));
        self.scheduler.append_event(json!({
            "type": "state.reconciled",
            "changed": changed,
            "revision": self.revision(),
            "source": "reconnect",
        }));
        self.scheduler.persist()?;
        Ok(true)
    }

    fn report_disconnected(&mut self, reason: &str) -> Result<(), String> {
        if !self.disconnected_reported {
            self.scheduler.append_event(json!({
                "type": "connection.disconnected",
                "reason": reason,
                "retryInMs": RECONNECT_INTERVAL.as_millis(),
            }));
            self.scheduler.persist()?;
            self.disconnected_reported = true;
        }
        Ok(())
    }

    fn mark_disconnected(&mut self, reason: &str) {
        self.session = None;
        self.performance_amounts.clear();
        self.scheduler.state.transport.playing = false;
        self.next_generated_clock = None;
        self.next_reconnect_at = Instant::now() + RECONNECT_INTERVAL;
        let _ = self.report_disconnected(reason);
    }

    fn with_session<T>(
        &mut self,
        operation: impl FnOnce(&mut RytmMidiSession) -> Result<T, String>,
    ) -> Result<T, String> {
        if self.session.is_none() && !self.try_reconnect()? {
            return Err(format!(
                "Analog Rytm MIDI port {:?} is disconnected",
                self.port_match
            ));
        }
        let result = operation(self.session.as_mut().expect("session was connected"));
        if let Err(error) = &result {
            if is_connection_error(error) {
                self.mark_disconnected(error);
            }
        }
        result
    }

    fn observe_summary(&mut self, summary: &Value, source: &str) -> Result<(), String> {
        let previous = self.scheduler.state.last_observed_state.as_ref();
        let playing = self.scheduler.state.transport.playing;
        let summary_view = reconciliation_view(summary, playing);
        let changed =
            previous.is_some_and(|state| reconciliation_view(state, playing) != summary_view);
        if changed {
            self.scheduler.state.revision += 1;
            self.scheduler.append_event(json!({
                "type": "state.reconciled",
                "changed": true,
                "revision": self.revision(),
                "source": source,
            }));
        }
        self.scheduler.state.last_observed_state = Some(summary.clone());
        self.refresh_transport_from_summary(summary);
        self.scheduler.persist()
    }

    fn refresh_transport_from_summary(&mut self, summary: &Value) {
        if let Some(pattern) = summary["pattern"]["slot"].as_str() {
            self.scheduler.state.transport.pattern = pattern.to_string();
        }
        if let Some(length) = summary["pattern"]["masterLength"]
            .as_u64()
            .and_then(|value| u8::try_from(value).ok())
        {
            self.scheduler.state.transport.pattern_length = length.max(1);
            self.scheduler.state.transport.step %= length.max(1);
        }
        if !self.scheduler.state.transport.playing {
            if let Some(tempo) = summary["settings"]["tempo"].as_f64() {
                self.scheduler.state.transport.tempo = tempo;
            }
        }
    }

    fn existing_operation(
        &self,
        input: &OperationSetInput,
        input_value: &Value,
    ) -> Result<Option<Value>, String> {
        let Some(id) = &input.operation_set_id else {
            return Ok(None);
        };
        let Some(existing) = self.scheduler.operation_by_id(id) else {
            return Ok(None);
        };
        let existing_input = serde_json::to_value(&existing.input).map_err(error_string)?;
        if existing_input != *input_value {
            return Err(format!(
                "operationSetId already exists with a different payload: {id}"
            ));
        }
        Ok(Some(existing.public_value()))
    }

    fn ensure_revision(&self, expected: u64) -> Result<(), String> {
        if expected != self.revision() {
            return Err(format!(
                "expected revision {expected}, current revision is {}",
                self.revision()
            ));
        }
        Ok(())
    }

    fn reconcile_queued_epochs(&mut self) -> Result<(), String> {
        let epoch = self.scheduler.state.transport.epoch.clone();
        let queued = self
            .scheduler
            .state
            .operation_sets
            .iter()
            .enumerate()
            .filter(|(_, record)| record.status == HardwareOperationStatus::Queued)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        for index in queued {
            if self.scheduler.state.operation_sets[index]
                .target
                .transport_epoch
                == epoch
            {
                continue;
            }
            let policy = self.scheduler.state.operation_sets[index]
                .input
                .late_policy
                .clone();
            match policy {
                LatePolicy::Reject => {
                    self.reject_record(
                        index,
                        format!(
                            "transport epoch changed before boundary; current epoch is {epoch}"
                        ),
                        "not_applied",
                    );
                }
                LatePolicy::RollForward => {
                    let apply_at = self.scheduler.state.operation_sets[index]
                        .input
                        .apply_at
                        .with_transport_epoch(epoch.clone());
                    // A boundary that cannot be resolved against the new epoch
                    // (for example a pattern-step target for a pattern that is
                    // no longer active) rejects only this record. Propagating
                    // the error would abort reconciliation on every reconnect
                    // and transport start, and the durable record would poison
                    // them forever.
                    match self.scheduler.state.transport.resolve(&apply_at) {
                        Ok(target) => {
                            let operation_set_id = self.scheduler.state.operation_sets[index]
                                .operation_set_id
                                .clone();
                            self.scheduler.state.operation_sets[index].target = target.clone();
                            self.scheduler.append_event(json!({
                                "type": "operation_set.reconciled",
                                "operationSetId": operation_set_id,
                                "action": "rolled_forward",
                                "resolvedBoundary": target,
                            }));
                        }
                        Err(error) => {
                            self.reject_record(
                                index,
                                format!(
                                    "boundary could not be rolled forward to epoch {epoch}: {error}"
                                ),
                                "not_applied",
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn send_due_note_offs(&mut self) {
        let now = Instant::now();
        let pending = std::mem::take(&mut self.pending_note_offs);
        let mut remaining = pending.into_iter();
        while let Some(note_off) = remaining.next() {
            if note_off.deadline > now {
                self.pending_note_offs.push(note_off);
                continue;
            }
            let result = self
                .with_session(|session| session.send(&[0x80 | note_off.channel, note_off.note, 0]));
            if result.is_err() {
                // Requeue the failed and remaining note-offs so a transient
                // send failure cannot leave notes ringing on the device.
                self.pending_note_offs.push(note_off);
                self.pending_note_offs.extend(remaining);
                break;
            }
        }
    }

    fn process_observed_midi(&mut self) -> Result<(), String> {
        let messages = self
            .session
            .as_ref()
            .map(RytmMidiSession::drain_midi_events)
            .unwrap_or_default();
        if self.clock_source != ClockSource::Observed {
            return Ok(());
        }
        for message in messages {
            for byte in message {
                match byte {
                    0xF8 => {
                        self.scheduler.state.transport.tick();
                        self.apply_due_operations()?;
                    }
                    0xFA => {
                        let epoch = self.scheduler.next_id("epoch");
                        self.scheduler.state.transport.start(epoch);
                        self.reconcile_queued_epochs()?;
                        self.scheduler.append_event(json!({
                            "type": "transport.changed",
                            "transport": self.scheduler.state.transport,
                            "source": "midi",
                        }));
                        self.scheduler.persist()?;
                    }
                    0xFB => {
                        self.scheduler.state.transport.playing = true;
                        self.scheduler.append_event(json!({
                            "type": "transport.changed",
                            "transport": self.scheduler.state.transport,
                            "source": "midi",
                        }));
                        self.scheduler.persist()?;
                    }
                    0xFC => {
                        self.scheduler.state.transport.playing = false;
                        self.scheduler.append_event(json!({
                            "type": "transport.changed",
                            "transport": self.scheduler.state.transport,
                            "source": "midi",
                        }));
                        self.scheduler.persist()?;
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }

    fn send_generated_clock(&mut self) -> Result<(), String> {
        if self.clock_source != ClockSource::Generated || !self.scheduler.state.transport.playing {
            return Ok(());
        }
        let interval = self.clock_interval();
        let mut deadline = self
            .next_generated_clock
            .unwrap_or_else(|| Instant::now() + interval);
        let mut ticks = 0;
        while Instant::now() >= deadline && ticks < MAX_GENERATED_TICKS_PER_POLL {
            self.with_session(|session| session.send(&[0xF8]))?;
            self.scheduler.state.transport.tick();
            self.apply_due_operations()?;
            deadline += interval;
            ticks += 1;
            if Instant::now() >= deadline + interval {
                deadline = Instant::now() + interval;
                break;
            }
        }
        self.next_generated_clock = Some(deadline);
        Ok(())
    }

    fn clock_interval(&self) -> Duration {
        Duration::from_secs_f64(60.0 / (self.scheduler.state.transport.tempo * 24.0))
    }

    fn apply_due_operations(&mut self) -> Result<(), String> {
        let due = self
            .scheduler
            .state
            .operation_sets
            .iter()
            .enumerate()
            .filter(|(_, record)| {
                record.status == HardwareOperationStatus::Queued
                    && record.target.is_due(&self.scheduler.state.transport)
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        for index in due {
            self.apply_queued_operation(index)?;
        }
        Ok(())
    }

    fn apply_queued_operation(&mut self, index: usize) -> Result<(), String> {
        let input = self.scheduler.state.operation_sets[index].input.clone();
        let operation_set_id = self.scheduler.state.operation_sets[index]
            .operation_set_id
            .clone();
        let boundary = self.scheduler.state.operation_sets[index]
            .target
            .kind
            .clone();
        if input.expected_revision != self.revision() {
            self.reject_record(
                index,
                format!(
                    "expected revision {}, current revision is {}",
                    input.expected_revision,
                    self.revision()
                ),
                "not_applied",
            );
            self.scheduler.persist()?;
            return Ok(());
        }

        let execution = self.execute_operations(&input);
        match execution {
            Ok((changed, write)) => {
                if changed.any() {
                    self.scheduler.state.revision += 1;
                }
                self.scheduler.state.last_observed_state = Some(write["state"].clone());
                let now = timestamp();
                let revision = self.revision();
                let record = &mut self.scheduler.state.operation_sets[index];
                record.status = HardwareOperationStatus::Applied;
                record.applied_at = Some(now.clone());
                record.applied_at_boundary = Some(boundary.clone());
                record.resulting_revision = Some(revision);
                record.result = Some(applied_details(&changed, &write));
                self.scheduler.append_event(json!({
                    "type": "operation_set.applied",
                    "operationSetId": operation_set_id,
                    "boundary": boundary,
                    "revision": revision,
                    "changed": changed.any(),
                    "changedObjects": changed,
                    "appliedAt": now,
                    "acknowledgement": "verified",
                }));
            }
            Err(error) => {
                let acknowledgement = failure_acknowledgement(&error);
                self.reject_record(index, error, acknowledgement);
            }
        }
        self.scheduler.persist()
    }

    fn execute_operations(
        &mut self,
        input: &OperationSetInput,
    ) -> Result<(ChangedObjects, Value), String> {
        self.samples.validate_assignments(&input.operations)?;
        let mut capture =
            self.with_session(|session| read_operation_state(session, &input.operations))?;
        let baseline = RawState::from_capture(&capture)?;
        let changed = apply_persistent_operations(&mut capture, &input.operations)?;
        let write = self.write_delta(&capture, &baseline, &changed)?;
        Ok((changed, write))
    }

    fn write_delta(
        &mut self,
        capture: &crate::hardware::StateCapture,
        baseline: &RawState,
        changed: &ChangedObjects,
    ) -> Result<Value, String> {
        let inject_failure = self.force_next_verification_failure && changed.any();
        if inject_failure {
            self.force_next_verification_failure = false;
        }
        self.with_session(|session| {
            if inject_failure {
                write_capture_delta_with_test_verification_failure(
                    session, capture, baseline, changed,
                )
            } else {
                write_capture_delta(session, capture, baseline, changed)
            }
        })
    }

    fn reject_record(&mut self, index: usize, reason: String, acknowledgement: &str) {
        let now = timestamp();
        let operation_set_id = self.scheduler.state.operation_sets[index]
            .operation_set_id
            .clone();
        let record = &mut self.scheduler.state.operation_sets[index];
        record.status = HardwareOperationStatus::Rejected;
        record.applied_at = Some(now.clone());
        record.rejection_reason = Some(reason.clone());
        record.result = Some(json!({ "acknowledgement": acknowledgement }));
        self.scheduler.append_event(json!({
            "type": "operation_set.rejected",
            "operationSetId": operation_set_id,
            "reason": reason,
            "rejectedAt": now,
            "acknowledgement": acknowledgement,
        }));
    }

    fn track_channel(&self, track_index: usize) -> Result<u8, String> {
        let summary = self
            .scheduler
            .state
            .last_observed_state
            .as_ref()
            .ok_or_else(|| "MIDI configuration has not been observed".to_string())?;
        let value = &summary["midi"]["trackChannels"][track_index];
        concrete_summary_channel(value, &format!("track {}", TRACK_NAMES[track_index]))
    }

    fn program_change_channel(&self) -> Result<u8, String> {
        let summary = self
            .scheduler
            .state
            .last_observed_state
            .as_ref()
            .ok_or_else(|| "MIDI configuration has not been observed".to_string())?;
        let configured = &summary["midi"]["programChangeInChannel"];
        if configured == "auto" {
            return concrete_summary_channel(&summary["midi"]["autoChannel"], "auto channel");
        }
        concrete_summary_channel(configured, "program change input")
    }

    fn performance_channel(&self) -> Result<u8, String> {
        let summary = self
            .scheduler
            .state
            .last_observed_state
            .as_ref()
            .ok_or_else(|| "MIDI configuration has not been observed".to_string())?;
        concrete_summary_channel(
            &summary["midi"]["performanceChannel"],
            "Performance channel",
        )
    }

    fn with_live_macro_state(&self, mut summary: Value) -> Value {
        summary["liveMacros"] = json!({
            "activeScene": summary["kit"]["macros"]["activeScene"].clone(),
            "activeSceneSource": "observed",
            "performanceAmounts": self.performance_amounts,
            "performanceAmountsSource": if self.performance_amounts.is_empty() {
                "unknown"
            } else {
                "sent"
            },
        });
        summary
    }
}

fn send_active_scene(
    session: &mut RytmMidiSession,
    channel: u8,
    scene: Option<u8>,
    lane: &str,
) -> Result<(), String> {
    let value = scene.unwrap_or(0);
    match lane {
        "cc" => send_cc(session, channel, 92, value),
        "nrpn" => send_nrpn(session, channel, 1, 104, value),
        _ => Err("lane must be cc or nrpn".to_string()),
    }?;
    std::thread::sleep(Duration::from_millis(75));
    Ok(())
}

fn send_performance_amount(
    session: &mut RytmMidiSession,
    channel: u8,
    performance: u8,
    amount: u8,
    lane: &str,
) -> Result<(), String> {
    const PERFORMANCE_CC: [u8; 12] = [35, 36, 37, 39, 40, 41, 42, 43, 44, 45, 46, 47];
    let index = usize::from(performance - 1);
    match lane {
        "cc" => send_cc(session, channel, PERFORMANCE_CC[index], amount),
        "nrpn" => send_nrpn(session, channel, 0, performance - 1, amount),
        _ => Err("lane must be cc or nrpn".to_string()),
    }
}

fn summary_active_scene(summary: &Value) -> Result<Option<u8>, String> {
    match &summary["kit"]["macros"]["activeScene"] {
        Value::Null => Ok(None),
        value => {
            let scene = value
                .as_u64()
                .ok_or_else(|| "active Scene summary is invalid".to_string())?;
            u8::try_from(scene)
                .map(Some)
                .map_err(|_| "active Scene summary is out of range".to_string())
        }
    }
}

fn summary_performance_channel(summary: &Value) -> Result<u8, String> {
    concrete_summary_channel(
        &summary["midi"]["performanceChannel"],
        "Performance channel",
    )
}

fn require_stopped_transport_for_sample_write(playing: bool) -> Result<(), String> {
    if playing {
        Err("sample upload and RAM mutation require transport to be stopped".to_string())
    } else {
        Ok(())
    }
}

fn applied_details(changed: &ChangedObjects, write: &Value) -> Value {
    json!({
        "changed": changed.any(),
        "changedObjects": changed,
        "writeStatus": write["status"].clone(),
        "observedState": compact_object_state(&write["state"]),
        "acknowledgement": "verified",
    })
}

fn compact_object_state(summary: &Value) -> Value {
    json!({
        "pattern": summary["pattern"].clone(),
        "kit": summary["kit"].clone(),
        "global": summary["global"].clone(),
        "settings": summary["settings"].clone(),
        "song": summary["song"].clone(),
        "songs": summary["songs"].clone(),
        "compatibility": summary["compatibility"].clone(),
    })
}

fn changed_between(current: &Value, target: &Value) -> ChangedObjects {
    let current = persistent_summary_view(current);
    let target = persistent_summary_view(target);
    let mut songs = std::collections::BTreeSet::new();
    if current["song"] != target["song"] {
        songs.insert("work_buffer".to_string());
    }
    let current_songs = current["songs"].as_object();
    let target_songs = target["songs"].as_object();
    for key in current_songs
        .into_iter()
        .flat_map(|songs| songs.keys())
        .chain(target_songs.into_iter().flat_map(|songs| songs.keys()))
    {
        if current["songs"][key] != target["songs"][key] {
            songs.insert(key.clone());
        }
    }
    ChangedObjects {
        pattern: current["pattern"] != target["pattern"],
        kit: current["kit"] != target["kit"],
        global: current["global"] != target["global"],
        settings: current["settings"] != target["settings"],
        songs: songs.into_iter().collect(),
    }
}

fn reconciliation_view(summary: &Value, transport_playing: bool) -> Value {
    let mut view = persistent_summary_view(summary);
    view.as_object_mut()
        .expect("state summary is an object")
        .remove("songs");
    if transport_playing {
        view["settings"]["tempo"] = json!("external-clock-active");
        view["pattern"]["tempo"] = json!("external-clock-active");
    }
    view
}

fn persistent_summary_view(summary: &Value) -> Value {
    let mut view = summary.clone();
    if view["kit"]["macros"].is_object() {
        view["kit"]["macros"]["activeScene"] = json!("transient");
        view["kit"]["macros"]["activeSceneRaw"] = json!("transient");
        view["kit"]["macros"]
            .as_object_mut()
            .expect("macros was checked as an object")
            .remove("livePerformanceAmounts");
        view["kit"]["macros"]
            .as_object_mut()
            .expect("macros was checked as an object")
            .remove("livePerformanceAmountsSource");
    }
    view.as_object_mut()
        .expect("state summary is an object")
        .remove("liveMacros");
    view
}

fn concrete_summary_channel(value: &Value, label: &str) -> Result<u8, String> {
    let channel = value
        .as_u64()
        .ok_or_else(|| format!("{label} MIDI channel is {value}"))?;
    if !(1..=16).contains(&channel) {
        return Err(format!("{label} uses invalid MIDI channel {channel}"));
    }
    Ok(channel as u8 - 1)
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

fn require_object(value: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "params must be a JSON object".to_string())
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} is required and must be a string"))
}

fn optional_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, String> {
    object
        .get(key)
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| format!("{key} must be a string"))
        })
        .transpose()
}

fn optional_bool(value: Option<&Value>, label: &str) -> Result<Option<bool>, String> {
    value
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| format!("{label} must be a boolean"))
        })
        .transpose()
}

fn optional_u64(value: Option<&Value>, label: &str) -> Result<Option<u64>, String> {
    value
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| format!("{label} must be a non-negative integer"))
        })
        .transpose()
}

fn required_u64(value: Option<&Value>, label: &str) -> Result<u64, String> {
    optional_u64(value, label)?.ok_or_else(|| format!("{label} is required"))
}

fn optional_f64(value: Option<&Value>, label: &str) -> Result<Option<f64>, String> {
    value
        .map(|value| {
            value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("{label} must be a finite number"))
        })
        .transpose()
}

fn optional_midi_value(value: Option<&Value>, label: &str) -> Result<Option<u8>, String> {
    value
        .map(|value| midi_value(Some(value), label))
        .transpose()
}

fn midi_value(value: Option<&Value>, label: &str) -> Result<u8, String> {
    let value = value
        .and_then(Value::as_u64)
        .filter(|value| *value <= 127)
        .ok_or_else(|| format!("{label} must be an integer between 0 and 127"))?;
    Ok(value as u8)
}

fn track_index(track: &str) -> Result<usize, String> {
    TRACK_NAMES
        .iter()
        .position(|candidate| candidate.eq_ignore_ascii_case(track))
        .ok_or_else(|| format!("track must be one of {}", TRACK_NAMES.join(", ")))
}

fn failure_acknowledgement(error: &str) -> &'static str {
    if error.contains("automatic rollback also failed") {
        "rollback_failed"
    } else if error.contains("baseline was restored") {
        "rollback_verified"
    } else {
        "not_applied"
    }
}

fn is_connection_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("no midi input")
        || lower.contains("no midi output")
        || lower.contains("midi input disconnected")
        || lower.contains("sending midi message failed")
        || lower.contains("timed out waiting")
        || lower.contains("connection")
        || lower.contains("disconnected")
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
        assert!(matches!(
            input.apply_at,
            crate::state::ApplyAt::NextStep { .. }
        ));
        assert!(matches!(input.late_policy, LatePolicy::Reject));
    }

    #[test]
    fn classifies_verified_and_failed_rollbacks() {
        assert_eq!(
            failure_acknowledgement("hardware write failed and baseline was restored: mismatch"),
            "rollback_verified"
        );
        assert_eq!(
            failure_acknowledgement("automatic rollback also failed: disconnected"),
            "rollback_failed"
        );
        assert_eq!(failure_acknowledgement("validation failed"), "not_applied");
    }

    #[test]
    fn converts_one_based_observed_channels_to_midi_status_channels() {
        assert_eq!(concrete_summary_channel(&json!(1), "track").unwrap(), 0);
        assert_eq!(concrete_summary_channel(&json!(16), "track").unwrap(), 15);
        assert!(concrete_summary_channel(&json!("off"), "track").is_err());
    }

    #[test]
    fn ignores_external_clock_tempo_but_not_persistent_settings_drift() {
        let first = json!({
            "pattern": { "tempo": 90 },
            "settings": { "tempo": 90, "fixedVelocity": { "amount": 100 } }
        });
        let mut second = first.clone();
        second["pattern"]["tempo"] = json!(120);
        second["settings"]["tempo"] = json!(120);
        assert_eq!(
            reconciliation_view(&first, true),
            reconciliation_view(&second, true)
        );

        second["settings"]["fixedVelocity"]["amount"] = json!(101);
        assert_ne!(
            reconciliation_view(&first, true),
            reconciliation_view(&second, true)
        );
    }

    #[test]
    fn ignores_unqueried_stored_songs_during_work_buffer_reconciliation() {
        let work_buffer = json!({
            "pattern": { "tempo": 90 },
            "settings": { "tempo": 90 },
            "song": { "target": { "scope": "work_buffer" }, "name": "ACTIVE" }
        });
        let mut operation_capture = work_buffer.clone();
        operation_capture["songs"] = json!({
            "work_buffer": work_buffer["song"].clone(),
            "stored:16": { "target": { "scope": "stored", "song": 16 }, "name": "CERT" }
        });

        assert_eq!(
            reconciliation_view(&work_buffer, false),
            reconciliation_view(&operation_capture, false)
        );
    }

    #[test]
    fn distinguishes_configuration_errors_from_transport_disconnects() {
        assert!(!is_connection_error("track BD MIDI channel is off"));
        assert!(is_connection_error(
            "MIDI input disconnected while waiting for SysEx"
        ));
        assert!(is_connection_error(
            "timed out waiting for a complete SysEx response"
        ));
    }

    #[test]
    fn sample_filesystem_writes_require_stopped_transport() {
        assert!(require_stopped_transport_for_sample_write(false).is_ok());
        assert!(require_stopped_transport_for_sample_write(true).is_err());
    }
}
