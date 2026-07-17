use crate::{
    audio::{
        AudioMode, AudioService, CapturePatternAudioRequest, RecordingContext,
        StartRecordingRequest, StopRecordingRequest,
    },
    describe_as_json,
    hardware::{parse_pattern_slot, DEFAULT_PORT_MATCH},
    hardware_control::HardwareBridgeState,
    hardware_description,
    hardware_scheduler::ClockSource,
    mock_description,
    overbridge::{CaptureMultitrackRequest, OverbridgeAudioService},
    state::MockBridgeState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{self, BufRead, Write},
    path::Path,
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::Duration,
};

pub const RPC_SCHEMA: &str = "analog-rytm-rpc.v1";
const REPLAY_CACHE_LIMIT: usize = 1024;
const TRACK_NAMES: [&str; 12] = [
    "BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB",
];
pub const DECLARED_METHODS: [&str; 32] = [
    "daemon.health",
    "daemon.describe",
    "device.inspect_state",
    "pattern.inspect",
    "song.inspect",
    "kit.inspect",
    "sound.inspect",
    "global.inspect",
    "operations.validate",
    "operations.propose",
    "operations.queue",
    "operations.apply_now",
    "realtime.set_parameter",
    "realtime.set_scene",
    "realtime.set_performance",
    "realtime.trigger_track",
    "realtime.set_transport",
    "realtime.change_pattern",
    "snapshot.create",
    "snapshot.rollback",
    "events.read",
    "state.reconcile",
    "samples.inspect",
    "samples.upload",
    "samples.resolve_ram",
    "samples.clear_ram",
    "audio.list_inputs",
    "audio.start_recording",
    "audio.stop_recording",
    "audio.capture_pattern",
    "audio.inspect_overbridge",
    "audio.capture_multitrack",
];

pub const MOCK_IMPLEMENTED_METHODS: [&str; 32] = DECLARED_METHODS;

pub const HARDWARE_IMPLEMENTED_METHODS: [&str; 32] = DECLARED_METHODS;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub schema: String,
    pub id: String,
    pub method: String,
    #[serde(default = "empty_object")]
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RpcEvent {
    pub schema: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendMode {
    Mock,
    Hardware,
}

impl BackendMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "mock" => Ok(Self::Mock),
            "hardware" => Ok(Self::Hardware),
            _ => Err(format!(
                "unsupported daemon adapter {value:?}; expected mock or hardware"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Mock => "mock",
            Self::Hardware => "hardware",
        }
    }
}

enum Backend {
    Mock(Box<MockBridgeState>),
    Hardware(Box<HardwareBridgeState>),
}

struct CachedResponse {
    request: Value,
    response: Value,
}

pub struct RpcServer {
    backend: Backend,
    audio: AudioService,
    overbridge: OverbridgeAudioService,
    replay_cache: HashMap<String, CachedResponse>,
    replay_order: VecDeque<String>,
    emitted_event_cursor: u64,
}

impl RpcServer {
    pub fn new(
        mode: BackendMode,
        port_match: &str,
        state_path: &Path,
        audio_directory: &Path,
        clock_source: ClockSource,
        force_next_verification_failure: bool,
    ) -> Result<Self, String> {
        let backend = match mode {
            BackendMode::Mock => Backend::Mock(Box::default()),
            BackendMode::Hardware => Backend::Hardware(Box::new(HardwareBridgeState::open(
                port_match,
                state_path,
                clock_source,
                force_next_verification_failure,
            )?)),
        };
        Ok(Self {
            backend,
            audio: AudioService::new(
                match mode {
                    BackendMode::Mock => AudioMode::Mock,
                    BackendMode::Hardware => AudioMode::Hardware,
                },
                audio_directory.to_path_buf(),
                port_match.to_string(),
            ),
            overbridge: OverbridgeAudioService::new(
                match mode {
                    BackendMode::Mock => AudioMode::Mock,
                    BackendMode::Hardware => AudioMode::Hardware,
                },
                audio_directory.to_path_buf(),
                port_match.to_string(),
            ),
            replay_cache: HashMap::new(),
            replay_order: VecDeque::new(),
            emitted_event_cursor: 0,
        })
    }

    pub fn new_mock() -> Self {
        Self::new(
            BackendMode::Mock,
            DEFAULT_PORT_MATCH,
            Path::new("unused-mock-state.json"),
            Path::new("unused-mock-recordings"),
            ClockSource::Observed,
            false,
        )
        .expect("mock backend cannot fail to open")
    }

    pub fn handle_line(&mut self, line: &str) -> Value {
        self.handle_messages(line)
            .into_iter()
            .next()
            .expect("every request produces a response")
    }

    pub fn handle_messages(&mut self, line: &str) -> Vec<Value> {
        let response = self.handle_request(line);
        let mut messages = vec![response];
        messages.extend(self.drain_rpc_events());
        messages
    }

    fn handle_request(&mut self, line: &str) -> Value {
        let raw = match serde_json::from_str::<Value>(line) {
            Ok(raw) => raw,
            Err(error) => {
                return error_response(
                    Value::Null,
                    "invalid_json",
                    format!("request is not valid JSON: {error}"),
                    false,
                    None,
                )
            }
        };
        let response_id = raw
            .get("id")
            .and_then(Value::as_str)
            .map_or(Value::Null, |id| json!(id));
        let request = match serde_json::from_value::<RpcRequest>(raw.clone()) {
            Ok(request) => request,
            Err(error) => {
                return error_response(
                    response_id,
                    "invalid_request",
                    format!("request does not match the RPC envelope: {error}"),
                    false,
                    None,
                )
            }
        };

        if let Some(cached) = self.replay_cache.get(&request.id) {
            if cached.request == raw {
                return cached.response.clone();
            }
            return error_response(
                json!(request.id),
                "request_id_conflict",
                "request ID was already used with a different payload",
                false,
                None,
            );
        }

        let response = if request.schema != RPC_SCHEMA {
            error_response(
                json!(request.id),
                "unsupported_schema",
                format!(
                    "unsupported schema {:?}; expected {RPC_SCHEMA:?}",
                    request.schema
                ),
                false,
                Some(json!({ "supported": [RPC_SCHEMA] })),
            )
        } else {
            match self.dispatch(&request) {
                Ok(result) => success_response(&request.id, result),
                Err(error) => error_response(
                    json!(request.id),
                    error.code,
                    error.message,
                    error.retryable,
                    error.details,
                ),
            }
        };
        self.cache_response(request.id, raw, response.clone());
        response
    }

    fn dispatch(&mut self, request: &RpcRequest) -> Result<Value, RpcDispatchError> {
        match request.method.as_str() {
            "daemon.health" => Ok(json!({
                "status": if self.backend_connected() { "ready" } else { "degraded" },
                "connected": self.backend_connected(),
                "adapter": self.backend_mode().as_str(),
                "protocolSchema": RPC_SCHEMA,
                "daemonSchema": "analog-rytm-daemon.v1",
                "processId": std::process::id(),
                "methods": {
                    "declared": DECLARED_METHODS,
                    "implemented": self.implemented_methods(),
                }
            })),
            "daemon.describe" => {
                let description = match self.backend {
                    Backend::Mock(_) => mock_description(),
                    Backend::Hardware(_) => hardware_description(),
                };
                serde_json::from_str(&describe_as_json(&description)).map_err(|error| {
                    RpcDispatchError::internal(format!(
                        "could not encode daemon description: {error}"
                    ))
                })
            }
            "device.inspect_state" => match &mut self.backend {
                Backend::Mock(state) => Ok(state.inspect_state()),
                Backend::Hardware(state) => {
                    let summary = state
                        .inspect_summary()
                        .map_err(RpcDispatchError::hardware)?;
                    Ok(hardware_state(
                        summary,
                        state.connected(),
                        state.revision(),
                        serde_json::to_value(state.transport_state()).map_err(|error| {
                            RpcDispatchError::internal(format!(
                                "could not encode transport: {error}"
                            ))
                        })?,
                        state.operation_sets(),
                        state.snapshot_summaries(),
                    ))
                }
            },
            "pattern.inspect" => {
                let slot = optional_string(&request.params, "pattern")?.unwrap_or("A01");
                let pattern_index =
                    parse_pattern_slot(slot).map_err(RpcDispatchError::validation)?;
                match &mut self.backend {
                    Backend::Mock(state) => state
                        .inspect_pattern(&slot.to_ascii_uppercase())
                        .map_err(RpcDispatchError::validation),
                    Backend::Hardware(state) => state
                        .inspect_pattern(pattern_index)
                        .map(|summary| hardware_pattern_summary(&summary))
                        .map_err(RpcDispatchError::hardware),
                }
            }
            "song.inspect" => match &mut self.backend {
                Backend::Mock(state) => state
                    .inspect_song(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .inspect_song(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "kit.inspect" => match &mut self.backend {
                Backend::Mock(state) => Ok(state.inspect_kit()),
                Backend::Hardware(state) => state.inspect_kit().map_err(RpcDispatchError::hardware),
            },
            "sound.inspect" => {
                let track_index = required_track_index(&request.params)?;
                match &mut self.backend {
                    Backend::Mock(state) => Ok(state.inspect_sound(track_index)),
                    Backend::Hardware(state) => state
                        .inspect_sound(track_index)
                        .map_err(RpcDispatchError::hardware),
                }
            }
            "global.inspect" => match &mut self.backend {
                Backend::Mock(state) => Ok(state.inspect_global()),
                Backend::Hardware(state) => {
                    state.inspect_global().map_err(RpcDispatchError::hardware)
                }
            },
            "operations.validate" => match &mut self.backend {
                Backend::Mock(state) => state
                    .validate(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .validate(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "operations.propose" => match &mut self.backend {
                Backend::Mock(state) => state
                    .propose(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .propose(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "operations.queue" => match &mut self.backend {
                Backend::Mock(state) => state
                    .queue(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .queue(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "operations.apply_now" => match &mut self.backend {
                Backend::Mock(state) => state
                    .apply_now(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .apply_now(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "realtime.set_parameter" => match &mut self.backend {
                Backend::Mock(state) => state
                    .set_live_parameter(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .set_live_parameter(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "realtime.set_scene" => match &mut self.backend {
                Backend::Mock(state) => state
                    .set_active_scene(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .set_active_scene(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "realtime.set_performance" => match &mut self.backend {
                Backend::Mock(state) => state
                    .set_performance_macro(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .set_performance_macro(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "realtime.trigger_track" => match &mut self.backend {
                Backend::Mock(state) => state
                    .trigger_track(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .trigger_track(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "realtime.set_transport" => match &mut self.backend {
                Backend::Mock(state) => state
                    .set_transport(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .set_transport(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "realtime.change_pattern" => match &mut self.backend {
                Backend::Mock(state) => state
                    .change_pattern(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .change_pattern(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "snapshot.create" => match &mut self.backend {
                Backend::Mock(state) => state
                    .create_snapshot(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .create_snapshot(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "snapshot.rollback" => match &mut self.backend {
                Backend::Mock(state) => state
                    .rollback_snapshot(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .rollback_snapshot(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "events.read" => match &self.backend {
                Backend::Mock(state) => state
                    .read_events(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(state) => state
                    .read_events(&request.params)
                    .map_err(RpcDispatchError::hardware),
            },
            "state.reconcile" => match &mut self.backend {
                Backend::Mock(state) => Ok(state.reconcile()),
                Backend::Hardware(state) => state.reconcile().map_err(RpcDispatchError::hardware),
            },
            "samples.inspect" => match &mut self.backend {
                Backend::Mock(state) => state
                    .inspect_samples(&request.params)
                    .map_err(RpcDispatchError::sample),
                Backend::Hardware(state) => state
                    .inspect_samples(&request.params)
                    .map_err(RpcDispatchError::sample),
            },
            "samples.upload" => match &mut self.backend {
                Backend::Mock(state) => state
                    .upload_sample(&request.params)
                    .map_err(RpcDispatchError::sample),
                Backend::Hardware(state) => state
                    .upload_sample(&request.params)
                    .map_err(RpcDispatchError::sample),
            },
            "samples.resolve_ram" => match &mut self.backend {
                Backend::Mock(state) => state
                    .resolve_sample_ram(&request.params)
                    .map_err(RpcDispatchError::sample),
                Backend::Hardware(state) => state
                    .resolve_sample_ram(&request.params)
                    .map_err(RpcDispatchError::sample),
            },
            "samples.clear_ram" => match &mut self.backend {
                Backend::Mock(state) => state
                    .clear_sample_ram(&request.params)
                    .map_err(RpcDispatchError::sample),
                Backend::Hardware(state) => state
                    .clear_sample_ram(&request.params)
                    .map_err(RpcDispatchError::sample),
            },
            "audio.list_inputs" => {
                serde_json::to_value(self.audio.list_inputs().map_err(RpcDispatchError::audio)?)
                    .map_err(|error| {
                        RpcDispatchError::internal(format!(
                            "could not encode audio inputs: {error}"
                        ))
                    })
            }
            "audio.start_recording" => {
                let input = parse_params::<StartRecordingRequest>(&request.params)?;
                let context = self.recording_context()?;
                self.audio
                    .start_recording(input, context)
                    .map_err(RpcDispatchError::audio)
            }
            "audio.stop_recording" => {
                let input = parse_params::<StopRecordingRequest>(&request.params)?;
                self.audio
                    .stop_recording(input)
                    .map_err(RpcDispatchError::audio)
            }
            "audio.capture_pattern" => {
                let input = parse_params::<CapturePatternAudioRequest>(&request.params)?;
                let context = self.recording_context()?;
                self.audio
                    .capture_pattern_audio(input, context)
                    .map_err(RpcDispatchError::audio)
            }
            "audio.inspect_overbridge" => self
                .overbridge
                .inspect_provider()
                .map_err(RpcDispatchError::audio),
            "audio.capture_multitrack" => {
                let input = parse_params::<CaptureMultitrackRequest>(&request.params)?;
                let context = self.recording_context()?;
                self.overbridge
                    .capture_multitrack(input, context)
                    .map_err(RpcDispatchError::audio)
            }
            "test.advance_mock_transport" => match &mut self.backend {
                Backend::Mock(state) => state
                    .advance_transport(&request.params)
                    .map_err(RpcDispatchError::validation),
                Backend::Hardware(_) => Err(hardware_capability_unavailable(&request.method)),
            },
            "test.delay" => match &self.backend {
                Backend::Mock(_) => {
                    let milliseconds = request
                        .params
                        .get("milliseconds")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| {
                        RpcDispatchError::validation(
                            "params.milliseconds must be a non-negative integer".to_string(),
                        )
                    })?;
                    if milliseconds > 10_000 {
                        return Err(RpcDispatchError::validation(
                            "params.milliseconds must be at most 10000".to_string(),
                        ));
                    }
                    thread::sleep(Duration::from_millis(milliseconds));
                    Ok(json!({ "delayedMs": milliseconds }))
                }
                Backend::Hardware(_) => Err(hardware_capability_unavailable(&request.method)),
            },
            method if DECLARED_METHODS.contains(&method) => {
                Err(hardware_capability_unavailable(method))
            }
            method => Err(RpcDispatchError {
                code: "method_not_found",
                message: format!("unknown RPC method {method:?}"),
                retryable: false,
                details: None,
            }),
        }
    }

    fn backend_mode(&self) -> BackendMode {
        match self.backend {
            Backend::Mock(_) => BackendMode::Mock,
            Backend::Hardware(_) => BackendMode::Hardware,
        }
    }

    fn recording_context(&mut self) -> Result<RecordingContext, RpcDispatchError> {
        match &mut self.backend {
            Backend::Mock(state) => {
                let inspected = state.inspect_state();
                let kit = state.inspect_kit();
                let global = state.inspect_global();
                Ok(RecordingContext {
                    device_model: inspected["device"]["model"]
                        .as_str()
                        .unwrap_or("Analog Rytm MKII")
                        .to_string(),
                    pattern: inspected["device"]["activePattern"]
                        .as_str()
                        .unwrap_or("A01")
                        .to_string(),
                    kit: json!({
                        "index": kit["index"].clone(),
                        "name": kit["name"].clone(),
                    }),
                    revision: inspected["revision"].as_u64().unwrap_or_default(),
                    tempo: inspected["transport"]["tempo"].as_f64().unwrap_or(120.0),
                    routing: global["global"]["routing"].clone(),
                })
            }
            Backend::Hardware(state) => {
                let summary = state
                    .inspect_summary()
                    .map_err(RpcDispatchError::hardware)?;
                Ok(RecordingContext {
                    device_model: "Analog Rytm MKII".to_string(),
                    pattern: summary["pattern"]["slot"]
                        .as_str()
                        .unwrap_or(&state.transport_state().pattern)
                        .to_string(),
                    kit: json!({
                        "index": summary["kit"]["index"].clone(),
                        "name": summary["kit"]["name"].clone(),
                    }),
                    revision: state.revision(),
                    tempo: state.transport_state().tempo,
                    routing: summary["global"]["routing"].clone(),
                })
            }
        }
    }

    fn backend_connected(&self) -> bool {
        match &self.backend {
            Backend::Mock(_) => true,
            Backend::Hardware(state) => state.connected(),
        }
    }

    fn implemented_methods(&self) -> &'static [&'static str] {
        match self.backend {
            Backend::Mock(_) => &MOCK_IMPLEMENTED_METHODS,
            Backend::Hardware(_) => &HARDWARE_IMPLEMENTED_METHODS,
        }
    }

    fn drain_rpc_events(&mut self) -> Vec<Value> {
        let events = match &self.backend {
            Backend::Mock(state) => state.events_after(self.emitted_event_cursor),
            Backend::Hardware(state) => state.events_after(self.emitted_event_cursor),
        };
        if let Some(last) = events.last() {
            self.emitted_event_cursor = last.cursor;
        }
        events
            .into_iter()
            .map(|entry| {
                let event_type = entry.event["type"].as_str().unwrap_or("unknown");
                json!({
                    "schema": RPC_SCHEMA,
                    "eventId": format!("event-{}", entry.cursor),
                    "type": event_type,
                    "payload": entry,
                })
            })
            .collect()
    }

    pub fn poll_messages(&mut self) -> Result<Vec<Value>, String> {
        if let Backend::Hardware(state) = &mut self.backend {
            state.poll()?;
        }
        Ok(self.drain_rpc_events())
    }

    pub fn shutdown(&mut self) -> Result<(), String> {
        let audio_result = self.audio.shutdown();
        let hardware_result = match &mut self.backend {
            Backend::Mock(_) => Ok(()),
            Backend::Hardware(state) => state.shutdown(),
        };
        audio_result.and(hardware_result)
    }

    fn cache_response(&mut self, id: String, request: Value, response: Value) {
        if self.replay_cache.len() >= REPLAY_CACHE_LIMIT {
            if let Some(oldest) = self.replay_order.pop_front() {
                self.replay_cache.remove(&oldest);
            }
        }
        self.replay_order.push_back(id.clone());
        self.replay_cache
            .insert(id, CachedResponse { request, response });
    }
}

pub fn serve_stdio(
    mode: BackendMode,
    port_match: &str,
    state_path: &Path,
    audio_directory: &Path,
    clock_source: ClockSource,
    force_next_verification_failure: bool,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let line = line.map_err(|error| format!("failed to read RPC request: {error}"));
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut stdout = io::stdout().lock();
    let mut server = RpcServer::new(
        mode,
        port_match,
        state_path,
        audio_directory,
        clock_source,
        force_next_verification_failure,
    )?;
    loop {
        match receiver.recv_timeout(Duration::from_millis(2)) {
            Ok(line) => {
                let line = line?;
                if !line.trim().is_empty() {
                    write_messages(&mut stdout, server.handle_messages(&line))?;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        write_messages(&mut stdout, server.poll_messages()?)?;
    }
    server.shutdown()?;
    Ok(())
}

fn write_messages(stdout: &mut impl Write, messages: Vec<Value>) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    for message in messages {
        serde_json::to_writer(&mut *stdout, &message)
            .map_err(|error| format!("failed to encode RPC response: {error}"))?;
        stdout
            .write_all(b"\n")
            .map_err(|error| format!("failed to write RPC response: {error}"))?;
    }
    stdout
        .flush()
        .map_err(|error| format!("failed to flush RPC response: {error}"))
}

fn hardware_capability_unavailable(method: &str) -> RpcDispatchError {
    RpcDispatchError {
        code: "capability_unavailable",
        message: format!(
            "hardware RPC method {method:?} is disabled until its snapshot, readback, and rollback path is verified"
        ),
        retryable: false,
        details: Some(json!({ "implementedMethods": HARDWARE_IMPLEMENTED_METHODS })),
    }
}

struct RpcDispatchError {
    code: &'static str,
    message: String,
    retryable: bool,
    details: Option<Value>,
}

impl RpcDispatchError {
    fn validation(message: String) -> Self {
        Self {
            code: "validation_failed",
            message,
            retryable: false,
            details: None,
        }
    }

    fn hardware(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let is_connection = lower.contains("disconnected")
            || lower.contains("no midi")
            || lower.contains("timed out waiting")
            || lower.contains("midi port");
        let is_validation = lower.contains("must be")
            || lower.contains("expected revision")
            || lower.contains("different payload")
            || lower.contains("outside current pattern")
            || lower.contains("does not match current epoch")
            || lower.contains("transport must be playing")
            || lower.contains("unsupported hardware boundary")
            || lower.contains("invalid operation set")
            || lower.contains("unknown sampleid")
            || lower.contains("assign_sample_slot identity mismatch")
            || lower.contains("ram slot");
        let rollback = if lower.contains("automatic rollback also failed") {
            Some("rollback_failed")
        } else if lower.contains("baseline was restored") {
            Some("rollback_verified")
        } else {
            None
        };
        Self {
            code: if is_validation {
                "validation_failed"
            } else if rollback.is_some() {
                "hardware_write_failed"
            } else {
                "hardware_error"
            },
            message,
            retryable: is_connection,
            details: rollback.map(|acknowledgement| json!({ "acknowledgement": acknowledgement })),
        }
    }

    fn audio(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let is_unavailable = lower.contains("overbridge multitrack unavailable");
        let is_validation = lower.contains("must be")
            || lower.contains("may contain only")
            || lower.contains("already active")
            || lower.contains("already exists")
            || lower.contains("unknown recordingid")
            || lower.contains("not requested recording");
        let is_connection = lower.contains("disconnect")
            || lower.contains("no coreaudio input")
            || lower.contains("could not enumerate coreaudio")
            || lower.contains("timed out");
        Self {
            code: if is_unavailable {
                "capability_unavailable"
            } else if is_validation {
                "validation_failed"
            } else if is_connection {
                "audio_disconnected"
            } else {
                "audio_error"
            },
            message,
            retryable: is_unavailable || is_connection,
            details: None,
        }
    }

    fn sample(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let is_connection = lower.contains("could not execute elektroid-cli")
            || lower.contains("found no midi device")
            || lower.contains("device disconnected")
            || lower.contains("timed out");
        let is_validation = lower.contains("must be")
            || lower.contains("is required")
            || lower.contains("unknown sampleid")
            || lower.contains("already")
            || lower.contains("occupied")
            || lower.contains("is full")
            || lower.contains("assigned to a track")
            || lower.contains("refusing")
            || lower.contains("identity mismatch")
            || lower.contains("outside 1..=127");
        Self {
            code: if is_validation {
                "validation_failed"
            } else if is_connection {
                "sample_transport_disconnected"
            } else {
                "sample_error"
            },
            message,
            retryable: is_connection,
            details: None,
        }
    }

    fn internal(message: String) -> Self {
        Self {
            code: "internal_error",
            message,
            retryable: false,
            details: None,
        }
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: &Value) -> Result<T, RpcDispatchError> {
    serde_json::from_value(params.clone()).map_err(|error| {
        RpcDispatchError::validation(format!("params do not match the method schema: {error}"))
    })
}

fn optional_string<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, RpcDispatchError> {
    let object = params
        .as_object()
        .ok_or_else(|| RpcDispatchError::validation("params must be a JSON object".to_string()))?;
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(RpcDispatchError::validation(format!(
            "params.{key} must be a string"
        ))),
    }
}

fn required_track_index(params: &Value) -> Result<usize, RpcDispatchError> {
    let track = optional_string(params, "track")?
        .ok_or_else(|| RpcDispatchError::validation("params.track is required".to_string()))?;
    TRACK_NAMES
        .iter()
        .position(|candidate| candidate.eq_ignore_ascii_case(track))
        .ok_or_else(|| {
            RpcDispatchError::validation(format!(
                "params.track must be one of {}",
                TRACK_NAMES.join(", ")
            ))
        })
}

fn empty_object() -> Value {
    json!({})
}

fn success_response(id: &str, result: Value) -> Value {
    json!({ "schema": RPC_SCHEMA, "id": id, "ok": true, "result": result })
}

fn error_response(
    id: Value,
    code: &'static str,
    message: impl Into<String>,
    retryable: bool,
    details: Option<Value>,
) -> Value {
    let mut error = json!({
        "code": code,
        "message": message.into(),
        "retryable": retryable,
    });
    if let Some(details) = details {
        error["details"] = details;
    }
    json!({ "schema": RPC_SCHEMA, "id": id, "ok": false, "error": error })
}

fn hardware_state(
    summary: Value,
    connected: bool,
    revision: u64,
    transport: Value,
    operation_sets: Vec<Value>,
    snapshots: Vec<Value>,
) -> Value {
    let pattern = hardware_pattern_summary(&summary["pattern"]);
    let active_pattern = pattern["pattern"].clone();
    json!({
        "revision": revision,
        "device": {
            "model": "Analog Rytm MKII",
            "connected": connected,
            "activePattern": active_pattern,
            "firmware": {
                "adapter": "rytm-rs",
                "adapterTargetFirmware": summary["compatibility"]["adapterTargetFirmware"].clone(),
                "observedFirmware": summary["compatibility"]["observedFirmware"].clone(),
                "compatibility": "unverified",
                "notes": summary["compatibility"]["notes"].clone(),
            },
            "capabilities": {
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
                "classCompliantAudio": true,
                "overbridgeAudio": true,
            },
        },
        "transport": transport,
        "liveMacros": summary["liveMacros"].clone(),
        "activePattern": pattern,
        "workBufferSong": summary["song"].clone(),
        "operationSets": operation_sets,
        "snapshots": snapshots,
        "evidence": {
            "kit": summary["kit"].clone(),
            "settings": summary["settings"].clone(),
            "global": summary["global"].clone(),
            "midi": summary["midi"].clone(),
            "song": summary["song"].clone(),
        },
    })
}

fn hardware_pattern_summary(summary: &Value) -> Value {
    let mut track_lengths = serde_json::Map::new();
    let mut trigs = Vec::new();
    for track in summary["tracks"].as_array().into_iter().flatten() {
        let Some(track_name) = track["track"].as_str() else {
            continue;
        };
        track_lengths.insert(track_name.to_string(), track["length"].clone());
        for trig in track["trigs"].as_array().into_iter().flatten() {
            let mut locks = serde_json::Map::new();
            if !trig["filterCutoffLock"].is_null() {
                locks.insert(
                    "filter_frequency".to_string(),
                    trig["filterCutoffLock"].clone(),
                );
            }
            let mut normalized = json!({
                "track": track_name,
                "step": trig["step"].clone(),
                "velocity": trig["velocity"].clone(),
                "locks": locks,
            });
            if !trig["microTiming"].is_null() {
                normalized["microTiming"] = trig["microTiming"].clone();
            }
            if trig["condition"]
                .as_str()
                .is_some_and(|condition| condition != "unset")
            {
                normalized["condition"] = trig["condition"].clone();
            }
            trigs.push(normalized);
        }
    }
    trigs.sort_by(|left, right| {
        left["step"]
            .as_u64()
            .cmp(&right["step"].as_u64())
            .then(left["track"].as_str().cmp(&right["track"].as_str()))
    });
    json!({
        "pattern": summary["slot"].clone(),
        "length": summary["masterLength"].clone(),
        "trackLengths": track_lengths,
        "machines": {},
        "sampleSlots": {},
        "kitParameters": {},
        "trigCount": trigs.len(),
        "trigs": trigs,
        "evidence": {
            "structureVersion": summary["structureVersion"].clone(),
            "kitNumber": summary["kitNumber"].clone(),
            "timeMode": summary["timeMode"].clone(),
            "swing": summary["swing"].clone(),
            "tempo": summary["tempo"].clone(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, method: &str, params: Value) -> String {
        json!({ "schema": RPC_SCHEMA, "id": id, "method": method, "params": params }).to_string()
    }

    #[test]
    fn reports_health_and_declared_methods() {
        let mut server = RpcServer::new_mock();
        let response = server.handle_line(&request("health-1", "daemon.health", json!({})));
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["adapter"], "mock");
        assert_eq!(
            response["result"]["methods"]["implemented"][0],
            "daemon.health"
        );
    }

    #[test]
    fn replays_identical_request_ids_and_rejects_conflicts() {
        let mut server = RpcServer::new_mock();
        let line = request("same-id", "pattern.inspect", json!({ "pattern": "B02" }));
        let first = server.handle_line(&line);
        let replay = server.handle_line(&line);
        assert_eq!(first, replay);

        let conflict = server.handle_line(&request("same-id", "daemon.health", json!({})));
        assert_eq!(conflict["ok"], false);
        assert_eq!(conflict["error"]["code"], "request_id_conflict");

        let mutation = request(
            "snapshot-replay",
            "snapshot.create",
            json!({ "snapshotId": "once" }),
        );
        let first_messages = server.handle_messages(&mutation);
        let replay_messages = server.handle_messages(&mutation);
        assert_eq!(first_messages.len(), 2);
        assert_eq!(replay_messages.len(), 1);
        assert_eq!(first_messages[0], replay_messages[0]);
    }

    #[test]
    fn returns_structured_protocol_and_validation_errors() {
        let mut server = RpcServer::new_mock();
        let invalid_json = server.handle_line("{");
        assert_eq!(invalid_json["error"]["code"], "invalid_json");

        let invalid_pattern = server.handle_line(&request(
            "pattern-1",
            "pattern.inspect",
            json!({ "pattern": "Z99" }),
        ));
        assert_eq!(invalid_pattern["error"]["code"], "validation_failed");

        let invalid_set = server.handle_line(&request(
            "queue-1",
            "operations.queue",
            json!({ "operations": [] }),
        ));
        assert_eq!(invalid_set["error"]["code"], "validation_failed");
    }

    #[test]
    fn inspects_compact_mock_state_and_patterns() {
        let mut server = RpcServer::new_mock();
        let state = server.handle_line(&request("state-1", "device.inspect_state", json!({})));
        assert_eq!(state["result"]["device"]["activePattern"], "A01");

        let pattern = server.handle_line(&request(
            "pattern-1",
            "pattern.inspect",
            json!({ "pattern": "H16" }),
        ));
        assert_eq!(pattern["result"]["pattern"], "H16");
        assert_eq!(pattern["result"]["trigCount"], 0);
    }

    #[test]
    fn emits_event_envelopes_after_mutating_responses() {
        let mut server = RpcServer::new_mock();
        let messages = server.handle_messages(&request(
            "snapshot-1",
            "snapshot.create",
            json!({ "snapshotId": "before" }),
        ));
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["ok"], true);
        assert_eq!(messages[1]["type"], "snapshot.created");
        assert_eq!(messages[1]["payload"]["cursor"], 1);
    }

    #[test]
    fn normalizes_hardware_patterns_to_the_agent_delta_schema() {
        let normalized = hardware_pattern_summary(&json!({
            "slot": "A01",
            "masterLength": 16,
            "structureVersion": 5,
            "kitNumber": 0,
            "timeMode": "Normal",
            "swing": 54,
            "tempo": 120.0,
            "tracks": [{
                "track": "BD",
                "length": 16,
                "trigs": [{
                    "step": 0,
                    "velocity": 108,
                    "microTiming": 0,
                    "condition": "unset",
                    "filterCutoffLock": 92,
                }],
            }],
        }));
        assert_eq!(normalized["pattern"], "A01");
        assert_eq!(normalized["trigCount"], 1);
        assert_eq!(normalized["trigs"][0]["track"], "BD");
        assert_eq!(normalized["trigs"][0]["locks"]["filter_frequency"], 92);
        assert!(normalized["trigs"][0].get("condition").is_none());
    }

    #[test]
    fn classifies_hardware_failures_for_deterministic_agent_recovery() {
        let timeout = RpcDispatchError::hardware(
            "timed out waiting for a complete SysEx response".to_string(),
        );
        assert_eq!(timeout.code, "hardware_error");
        assert!(timeout.retryable);

        let stale =
            RpcDispatchError::hardware("expected revision 3, current revision is 4".to_string());
        assert_eq!(stale.code, "validation_failed");
        assert!(!stale.retryable);

        let rollback = RpcDispatchError::hardware(
            "hardware write failed and baseline was restored: mismatch".to_string(),
        );
        assert_eq!(rollback.code, "hardware_write_failed");
        assert_eq!(
            rollback.details.unwrap()["acknowledgement"],
            "rollback_verified"
        );
    }

    #[test]
    fn classifies_overbridge_mode_as_a_retryable_optional_capability() {
        let unavailable = RpcDispatchError::audio(
            "Overbridge multitrack unavailable: the Rytm exposes only class-compliant stereo"
                .to_string(),
        );
        assert_eq!(unavailable.code, "capability_unavailable");
        assert!(unavailable.retryable);
    }
}
