use crate::{
    describe_as_json,
    hardware::{
        inspect_work_buffer_state, parse_pattern_slot, query_pattern_summary, RytmMidiSession,
        DEFAULT_PORT_MATCH,
    },
    hardware_description, mock_description,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{self, BufRead, Write},
};

pub const RPC_SCHEMA: &str = "analog-rytm-rpc.v1";
const REPLAY_CACHE_LIMIT: usize = 1024;
const TRACK_NAMES: [&str; 12] = [
    "BD", "SD", "RS", "CP", "BT", "LT", "MT", "HT", "CH", "OH", "CY", "CB",
];

pub const DECLARED_METHODS: [&str; 16] = [
    "daemon.health",
    "daemon.describe",
    "device.inspect_state",
    "pattern.inspect",
    "operations.validate",
    "operations.propose",
    "operations.queue",
    "operations.apply_now",
    "realtime.set_parameter",
    "realtime.trigger_track",
    "realtime.set_transport",
    "realtime.change_pattern",
    "snapshot.create",
    "snapshot.rollback",
    "events.read",
    "state.reconcile",
];

pub const IMPLEMENTED_METHODS: [&str; 4] = [
    "daemon.health",
    "daemon.describe",
    "device.inspect_state",
    "pattern.inspect",
];

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
    Mock,
    Hardware(RytmMidiSession),
}

struct CachedResponse {
    request: Value,
    response: Value,
}

pub struct RpcServer {
    backend: Backend,
    replay_cache: HashMap<String, CachedResponse>,
    replay_order: VecDeque<String>,
}

impl RpcServer {
    pub fn new(mode: BackendMode, port_match: &str) -> Result<Self, String> {
        let backend = match mode {
            BackendMode::Mock => Backend::Mock,
            BackendMode::Hardware => Backend::Hardware(RytmMidiSession::open(port_match)?),
        };
        Ok(Self {
            backend,
            replay_cache: HashMap::new(),
            replay_order: VecDeque::new(),
        })
    }

    pub fn new_mock() -> Self {
        Self::new(BackendMode::Mock, DEFAULT_PORT_MATCH).expect("mock backend cannot fail to open")
    }

    pub fn handle_line(&mut self, line: &str) -> Value {
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
                "status": "ready",
                "connected": true,
                "adapter": self.backend_mode().as_str(),
                "protocolSchema": RPC_SCHEMA,
                "daemonSchema": "analog-rytm-daemon.v1",
                "processId": std::process::id(),
                "methods": {
                    "declared": DECLARED_METHODS,
                    "implemented": IMPLEMENTED_METHODS,
                }
            })),
            "daemon.describe" => {
                let description = match self.backend {
                    Backend::Mock => mock_description(),
                    Backend::Hardware(_) => hardware_description(),
                };
                serde_json::from_str(&describe_as_json(&description)).map_err(|error| {
                    RpcDispatchError::internal(format!(
                        "could not encode daemon description: {error}"
                    ))
                })
            }
            "device.inspect_state" => match &mut self.backend {
                Backend::Mock => Ok(mock_state()),
                Backend::Hardware(session) => inspect_work_buffer_state(session)
                    .map(hardware_state)
                    .map_err(RpcDispatchError::hardware),
            },
            "pattern.inspect" => {
                let slot = optional_string(&request.params, "pattern")?.unwrap_or("A01");
                let pattern_index =
                    parse_pattern_slot(slot).map_err(RpcDispatchError::validation)?;
                match &mut self.backend {
                    Backend::Mock => Ok(mock_pattern(slot.to_ascii_uppercase(), pattern_index)),
                    Backend::Hardware(session) => query_pattern_summary(session, pattern_index)
                        .map_err(RpcDispatchError::hardware),
                }
            }
            method if DECLARED_METHODS.contains(&method) => Err(RpcDispatchError {
                code: "not_implemented",
                message: format!(
                    "RPC method {method:?} is declared but not implemented in this milestone"
                ),
                retryable: false,
                details: Some(json!({ "implementedMethods": IMPLEMENTED_METHODS })),
            }),
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
            Backend::Mock => BackendMode::Mock,
            Backend::Hardware(_) => BackendMode::Hardware,
        }
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

pub fn serve_stdio(mode: BackendMode, port_match: &str) -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut server = RpcServer::new(mode, port_match)?;
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("failed to read RPC request: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let response = server.handle_line(&line);
        serde_json::to_writer(&mut stdout, &response)
            .map_err(|error| format!("failed to encode RPC response: {error}"))?;
        stdout
            .write_all(b"\n")
            .map_err(|error| format!("failed to write RPC response: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("failed to flush RPC response: {error}"))?;
    }
    Ok(())
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
        Self {
            code: "hardware_error",
            message,
            retryable: true,
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

fn mock_state() -> Value {
    let pattern = mock_pattern("A01".to_string(), 0);
    json!({
        "revision": 0,
        "device": {
            "model": "Analog Rytm MKII",
            "connected": true,
            "adapter": "mock",
            "activePattern": "A01",
            "compatibility": {
                "adapter": "mock",
                "adapterTargetFirmware": null,
                "observedFirmware": null,
                "status": "mock",
                "notes": ["Mock daemon. No MIDI or SysEx transport is open."],
            },
        },
        "transport": {
            "playing": false,
            "pattern": "A01",
            "step": 0,
            "beat": 0,
            "measure": 0,
            "tempo": 120.0,
        },
        "activePattern": pattern,
        "kit": { "index": 0, "name": "MOCK", "trackLevels": vec![100; 12] },
        "settings": { "tempo": 120.0, "selectedTrack": "BD", "mutedTracks": [] },
        "midi": {},
        "queue": { "supported": false, "pending": 0 },
        "snapshots": { "supported": false, "count": 0 },
    })
}

fn hardware_state(summary: Value) -> Value {
    let pattern = summary["pattern"].clone();
    let active_pattern = pattern["slot"].clone();
    let tempo = summary["settings"]["tempo"].clone();
    json!({
        "revision": null,
        "device": {
            "model": "Analog Rytm MKII",
            "connected": true,
            "adapter": "hardware",
            "activePattern": active_pattern,
            "compatibility": summary["compatibility"].clone(),
        },
        "transport": {
            "playing": null,
            "pattern": pattern["slot"].clone(),
            "step": null,
            "beat": null,
            "measure": null,
            "tempo": tempo,
        },
        "activePattern": pattern,
        "kit": summary["kit"].clone(),
        "settings": summary["settings"].clone(),
        "midi": summary["midi"].clone(),
        "queue": { "supported": false, "pending": 0 },
        "snapshots": { "supported": false, "count": 0 },
    })
}

fn mock_pattern(slot: String, index: usize) -> Value {
    json!({
        "index": index,
        "slot": slot,
        "structureVersion": "mock",
        "kitNumber": 0,
        "masterLength": 16,
        "swing": 50,
        "tempo": 120.0,
        "tracks": TRACK_NAMES.iter().map(|track| json!({
            "track": track,
            "length": 16,
            "trigs": [],
        })).collect::<Vec<_>>(),
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

        let pending = server.handle_line(&request(
            "queue-1",
            "operations.queue",
            json!({ "operations": [] }),
        ));
        assert_eq!(pending["error"]["code"], "not_implemented");
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
        assert_eq!(pattern["result"]["index"], 127);
        assert_eq!(pattern["result"]["tracks"].as_array().unwrap().len(), 12);
    }
}
