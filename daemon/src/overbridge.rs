use crate::audio::{AudioMode, MockSignal, RecordingContext};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, InputCallbackInfo, SampleFormat, Stream, StreamConfig, SupportedStreamConfig,
};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const PREFERRED_SAMPLE_RATE: u32 = 48_000;
const WRITER_QUEUE_BLOCKS: usize = 64;
const MIN_CAPTURE_MILLISECONDS: u64 = 100;
const MAX_CAPTURE_MILLISECONDS: u64 = 600_000;
const DRIVER_PATH: &str = "/Library/Audio/Plug-Ins/HAL/OverbridgeCoreAudioPlugin.driver";
const PLUGIN_PATH: &str = "/Library/Audio/Plug-Ins/Components/Analog Rytm.component";
const ENGINE_PATH: &str = "/Applications/Elektron/Overbridge Engine.app";
const ENGINE_INFO_PATH: &str = "/Applications/Elektron/Overbridge Engine.app/Contents/Info.plist";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptureMultitrackRequest {
    #[serde(default)]
    pub recording_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub snapshot_id: Option<String>,
    pub duration_ms: u64,
    #[serde(default)]
    pub mock_signal: MockSignal,
}

pub struct OverbridgeAudioService {
    mode: AudioMode,
    output_directory: PathBuf,
    port_match: String,
    completed: HashMap<String, Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StemDefinition {
    id: String,
    name: String,
    tracks: Vec<String>,
    source_channel_indices: Vec<usize>,
    channels: u16,
}

struct HardwareSelection {
    id: String,
    name: String,
    device: Device,
    config: SupportedStreamConfig,
    stems: Vec<StemDefinition>,
}

struct StemWriter {
    definition: StemDefinition,
    partial_path: PathBuf,
    final_path: PathBuf,
    writer: WavWriter<BufWriter<File>>,
}

#[derive(Default)]
struct StemStats {
    samples: u64,
    peak: f32,
    squared_sum: f64,
    clipped_samples: u64,
}

struct WriterResult {
    stems: Vec<(StemDefinition, PathBuf, StemStats)>,
}

#[derive(Default)]
struct CallbackMetrics {
    callback_count: AtomicU64,
    callback_latency_sum_ns: AtomicU64,
    callback_latency_max_ns: AtomicU64,
    callback_latency_min_ns: AtomicU64,
    previous_capture_ns: AtomicU64,
    previous_frame_count: AtomicU64,
    timestamp_gap_count: AtomicU64,
    timestamp_gap_max_ns: AtomicU64,
}

#[derive(Clone)]
struct CallbackState {
    sender: SyncSender<Vec<f32>>,
    notice_sender: mpsc::Sender<CaptureNotice>,
    source_channels: usize,
    sample_rate: u32,
    target_frames: u64,
    accepted_frames: Arc<AtomicU64>,
    dropped_blocks: Arc<AtomicU64>,
    target_reported: Arc<AtomicBool>,
    metrics: Arc<CallbackMetrics>,
}

enum CaptureNotice {
    TargetReached,
    Error(String),
}

impl OverbridgeAudioService {
    pub fn new(mode: AudioMode, output_directory: PathBuf, port_match: String) -> Self {
        Self {
            mode,
            output_directory: output_directory.join("overbridge"),
            port_match,
            completed: HashMap::new(),
        }
    }

    pub fn inspect_provider(&self) -> Result<Value, String> {
        fs::create_dir_all(&self.output_directory).map_err(error_string)?;
        if self.mode == AudioMode::Mock {
            return Ok(provider_inventory(
                true,
                "mock",
                Some(json!({
                    "id": "mock-overbridge-12",
                    "name": "Mock Analog Rytm Overbridge",
                    "channels": 12,
                    "sampleRate": PREFERRED_SAMPLE_RATE,
                    "sampleFormat": "f32",
                    "layout": stem_layout(12).expect("mock layout is supported"),
                })),
                json!({
                    "driverInstalled": true,
                    "pluginInstalled": true,
                    "engineInstalled": true,
                    "engineRunning": true,
                    "version": "mock",
                }),
                stale_partial_files(&self.output_directory)?,
                &self.output_directory,
            ));
        }

        let installation = overbridge_installation();
        let candidates = inspect_hardware_candidates(&self.port_match)?;
        let selected = candidates
            .iter()
            .find(|candidate| candidate["available"] == true);
        let stereo = candidates.iter().any(|candidate| {
            candidate["isRytm"] == true
                && candidate["configurations"]
                    .as_array()
                    .is_some_and(|configurations| {
                        configurations
                            .iter()
                            .any(|configuration| configuration["channels"] == 2)
                    })
        });
        let device_mode = if selected.is_some() {
            "overbridge"
        } else if stereo {
            "class_compliant"
        } else {
            "unavailable"
        };
        let mut inventory = provider_inventory(
            selected.is_some(),
            device_mode,
            selected.and_then(selected_device_summary),
            installation,
            stale_partial_files(&self.output_directory)?,
            &self.output_directory,
        );
        inventory["candidates"] = Value::Array(candidates);
        Ok(inventory)
    }

    pub fn capture_multitrack(
        &mut self,
        request: CaptureMultitrackRequest,
        context: RecordingContext,
    ) -> Result<Value, String> {
        validate_duration(request.duration_ms)?;
        fs::create_dir_all(&self.output_directory).map_err(error_string)?;
        let recording_id = request
            .recording_id
            .clone()
            .unwrap_or_else(generated_recording_id);
        validate_recording_id(&recording_id)?;
        if let Some(completed) = self.completed.get(&recording_id) {
            return if completed["declaration"] == declaration(&request) {
                Ok(completed.clone())
            } else {
                Err(format!(
                    "recordingId already exists with different multitrack parameters: {recording_id}"
                ))
            };
        }

        let recording_directory = self.output_directory.join(&recording_id);
        let metadata_path = recording_directory.join("recording.json");
        let metadata_partial_path = recording_directory.join("recording.json.partial");
        if metadata_path.exists() {
            let existing = read_json(&metadata_path)?;
            return if existing["declaration"] == declaration(&request) {
                self.completed.insert(recording_id, existing.clone());
                Ok(existing)
            } else {
                Err(format!(
                    "recordingId already exists with different multitrack parameters: {recording_id}"
                ))
            };
        }
        if recording_directory.exists() {
            return Err(format!(
                "multitrack recording output already exists and will not be overwritten: {}",
                recording_directory.display()
            ));
        }
        let (source_id, source_name, source_channels, sample_rate, source_format, stems, hardware) =
            match self.mode {
                AudioMode::Mock => (
                    "mock-overbridge-12".to_string(),
                    "Mock Analog Rytm Overbridge".to_string(),
                    12_u16,
                    PREFERRED_SAMPLE_RATE,
                    "f32".to_string(),
                    stem_layout(12).expect("mock layout is supported"),
                    None,
                ),
                AudioMode::Hardware => {
                    let selected = select_overbridge_input(
                        request.device_name.as_deref().unwrap_or(&self.port_match),
                    )?;
                    let source_id = selected.id.clone();
                    let source_name = selected.name.clone();
                    let source_channels = selected.config.channels();
                    let sample_rate = selected.config.sample_rate();
                    let source_format = sample_format_name(selected.config.sample_format());
                    let stems = selected.stems.clone();
                    (
                        source_id,
                        source_name,
                        source_channels,
                        sample_rate,
                        source_format,
                        stems,
                        Some(selected),
                    )
                }
            };

        fs::create_dir(&recording_directory).map_err(error_string)?;

        let writers = match create_stem_writers(&recording_directory, sample_rate, &stems) {
            Ok(writers) => writers,
            Err(error) => {
                let _ = fs::remove_dir_all(&recording_directory);
                return Err(error);
            }
        };
        let (sample_sender, sample_receiver) = mpsc::sync_channel(WRITER_QUEUE_BLOCKS);
        let writer_thread = thread::spawn(move || {
            write_multitrack_samples(writers, sample_receiver, usize::from(source_channels))
        });
        let (notice_sender, notice_receiver) = mpsc::channel();
        let target_frames = frames_for_duration(sample_rate, request.duration_ms);
        let accepted_frames = Arc::new(AtomicU64::new(0));
        let dropped_blocks = Arc::new(AtomicU64::new(0));
        let metrics = Arc::new(CallbackMetrics {
            callback_latency_min_ns: AtomicU64::new(u64::MAX),
            ..CallbackMetrics::default()
        });
        let mut stream: Option<Stream> = None;
        let started_at = timestamp();

        let start_result = match (self.mode, hardware) {
            (AudioMode::Mock, None) => send_mock_samples(
                &sample_sender,
                request.mock_signal,
                sample_rate,
                source_channels,
                target_frames,
            )
            .and_then(|()| {
                accepted_frames.store(target_frames, Ordering::SeqCst);
                notice_sender
                    .send(CaptureNotice::TargetReached)
                    .map_err(error_string)
            }),
            (AudioMode::Hardware, Some(selected)) => {
                let callback_state = CallbackState {
                    sender: sample_sender.clone(),
                    notice_sender: notice_sender.clone(),
                    source_channels: usize::from(source_channels),
                    sample_rate,
                    target_frames,
                    accepted_frames: Arc::clone(&accepted_frames),
                    dropped_blocks: Arc::clone(&dropped_blocks),
                    target_reported: Arc::new(AtomicBool::new(false)),
                    metrics: Arc::clone(&metrics),
                };
                build_hardware_stream(&selected.device, &selected.config, callback_state).and_then(
                    |built| {
                        built.play().map_err(|error| {
                            format!("could not start Overbridge CoreAudio input stream: {error}")
                        })?;
                        stream = Some(built);
                        Ok(())
                    },
                )
            }
            _ => Err("invalid Overbridge provider state".to_string()),
        };
        if let Err(error) = start_result {
            let _ = sample_sender.send(Vec::new());
            let _ = writer_thread.join();
            let _ = fs::remove_dir_all(&recording_directory);
            return Err(error);
        }

        let wait =
            Duration::from_millis(request.duration_ms).saturating_add(Duration::from_secs(5));
        let mut failure = match notice_receiver.recv_timeout(wait) {
            Ok(CaptureNotice::TargetReached) => None,
            Ok(CaptureNotice::Error(error)) => Some(error),
            Err(mpsc::RecvTimeoutError::Timeout) => Some(format!(
                "Overbridge capture timed out before reaching {} ms",
                request.duration_ms
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Some("Overbridge capture completion channel disconnected".to_string())
            }
        };
        while let Ok(notice) = notice_receiver.try_recv() {
            if let CaptureNotice::Error(error) = notice {
                failure.get_or_insert(error);
            }
        }
        if let Some(stream) = stream {
            if let Err(error) = stream.pause() {
                failure.get_or_insert_with(|| {
                    format!("could not pause Overbridge CoreAudio input stream: {error}")
                });
            }
        }
        sample_sender
            .send(Vec::new())
            .map_err(|_| "Overbridge writer disconnected before finish marker".to_string())?;
        let writer_result = writer_thread
            .join()
            .map_err(|_| "Overbridge writer thread panicked".to_string())??;

        let frames = accepted_frames.load(Ordering::SeqCst);
        let duration_ms = frames as f64 * 1_000.0 / f64::from(sample_rate);
        let duration_tolerance = (request.duration_ms as f64 * 0.05).max(50.0);
        let duration_within_tolerance =
            (duration_ms - request.duration_ms as f64).abs() <= duration_tolerance;
        if !duration_within_tolerance {
            failure.get_or_insert_with(|| {
                format!(
                    "captured duration {duration_ms:.3} ms is outside tolerance for expected {} ms",
                    request.duration_ms
                )
            });
        }
        let dropped_blocks = dropped_blocks.load(Ordering::SeqCst);
        if dropped_blocks > 0 {
            failure.get_or_insert_with(|| {
                format!("Overbridge callback dropped {dropped_blocks} writer queue blocks")
            });
        }

        let mut warnings = Vec::new();
        let mut stem_results = Vec::new();
        for (definition, final_path, stats) in writer_result.stems {
            let stem_frames = stats.samples / u64::from(definition.channels);
            let sample_count = stats.samples.max(1);
            let rms = (stats.squared_sum / sample_count as f64).sqrt();
            let silence = stats.peak <= 0.000_1 || rms <= 0.000_01;
            if silence {
                warnings.push(format!(
                    "stem {} is silent or below threshold",
                    definition.id
                ));
            }
            let bytes = fs::metadata(&final_path).map_err(error_string)?.len();
            stem_results.push(json!({
                "id": definition.id,
                "name": definition.name,
                "tracks": definition.tracks,
                "sourceChannelIndices": definition.source_channel_indices,
                "channels": definition.channels,
                "path": final_path.display().to_string(),
                "frames": stem_frames,
                "durationMs": stem_frames as f64 * 1_000.0 / f64::from(sample_rate),
                "bytes": bytes,
                "analysis": {
                    "peak": stats.peak,
                    "rms": rms,
                    "silence": silence,
                    "clipping": stats.clipped_samples > 0,
                    "clippedSamples": stats.clipped_samples,
                },
            }));
        }
        if let Some(error) = &failure {
            warnings.push(error.clone());
        }
        let callback_count = metrics.callback_count.load(Ordering::SeqCst);
        let latency_sum = metrics.callback_latency_sum_ns.load(Ordering::SeqCst);
        let latency_min = metrics.callback_latency_min_ns.load(Ordering::SeqCst);
        let disconnected = failure
            .as_deref()
            .is_some_and(|error| error.to_ascii_lowercase().contains("disconnect"));
        let stopped_at = timestamp();
        let metadata = json!({
            "schema": "analog-rytm-multitrack-recording.v1",
            "recordingId": recording_id,
            "status": if failure.is_some() { "failed" } else { "completed" },
            "provider": {
                "id": "elektron-overbridge-coreaudio",
                "name": "Elektron Overbridge",
                "optional": true,
                "controlDependency": false,
                "ownership": "Elektron Overbridge Engine and HAL driver",
            },
            "declaration": declaration(&request),
            "device": {
                "model": context.device_model,
                "inputId": source_id,
                "inputName": source_name,
                "sourceChannels": source_channels,
                "sampleRate": sample_rate,
                "sourceSampleFormat": source_format,
            },
            "pattern": context.pattern,
            "kit": context.kit,
            "revision": context.revision,
            "tempo": context.tempo,
            "routing": context.routing,
            "snapshotId": request.snapshot_id,
            "timestamps": { "startedAt": started_at, "stoppedAt": stopped_at },
            "stems": stem_results,
            "synchronization": {
                "clockDomain": "single_coreaudio_input_stream",
                "commonStartFrame": 0,
                "framesPerStem": frames,
                "maxFrameDrift": 0,
                "callbackCount": callback_count,
                "timestampGapCount": metrics.timestamp_gap_count.load(Ordering::SeqCst),
                "maxTimestampGapMs": nanos_to_ms(metrics.timestamp_gap_max_ns.load(Ordering::SeqCst)),
            },
            "latency": {
                "source": "coreaudio_callback_timestamp",
                "samples": callback_count,
                "minimumMs": (callback_count > 0).then(|| nanos_to_ms(latency_min)),
                "averageMs": (callback_count > 0).then(|| nanos_to_ms(latency_sum / callback_count)),
                "maximumMs": (callback_count > 0).then(|| nanos_to_ms(metrics.callback_latency_max_ns.load(Ordering::SeqCst))),
            },
            "analysis": {
                "expectedDurationMs": request.duration_ms,
                "durationMs": duration_ms,
                "durationWithinTolerance": duration_within_tolerance,
                "disconnected": disconnected,
                "droppedBlocks": dropped_blocks,
            },
            "metadataPath": metadata_path.display().to_string(),
            "warnings": warnings,
        });
        if let Err(error) = write_json_atomic(&metadata_partial_path, &metadata_path, &metadata) {
            return Err(format!(
                "{error}; multitrack WAV files remain in {}",
                recording_directory.display()
            ));
        }
        self.completed.insert(recording_id, metadata.clone());
        Ok(metadata)
    }
}

fn selected_device_summary(candidate: &Value) -> Option<Value> {
    let configuration = candidate["configurations"]
        .as_array()?
        .iter()
        .filter(|configuration| configuration["recorderSupported"] == true)
        .max_by_key(|configuration| {
            let preferred_rate = configuration["minSampleRate"]
                .as_u64()
                .is_some_and(|minimum| minimum <= u64::from(PREFERRED_SAMPLE_RATE))
                && configuration["maxSampleRate"]
                    .as_u64()
                    .is_some_and(|maximum| maximum >= u64::from(PREFERRED_SAMPLE_RATE));
            let preferred_format = configuration["sampleFormat"] == "f32";
            let preferred_layout = matches!(configuration["channels"].as_u64(), Some(12 | 20));
            u8::from(preferred_rate) * 4
                + u8::from(preferred_format) * 2
                + u8::from(preferred_layout)
        })?;
    let sample_rate = if configuration["minSampleRate"]
        .as_u64()
        .is_some_and(|minimum| minimum <= u64::from(PREFERRED_SAMPLE_RATE))
        && configuration["maxSampleRate"]
            .as_u64()
            .is_some_and(|maximum| maximum >= u64::from(PREFERRED_SAMPLE_RATE))
    {
        u64::from(PREFERRED_SAMPLE_RATE)
    } else {
        configuration["maxSampleRate"].as_u64()?
    };
    Some(json!({
        "id": candidate["id"].clone(),
        "name": candidate["name"].clone(),
        "channels": configuration["channels"].clone(),
        "sampleRate": sample_rate,
        "sampleFormat": configuration["sampleFormat"].clone(),
        "layout": configuration["layout"].clone(),
    }))
}

fn provider_inventory(
    available: bool,
    device_mode: &str,
    selected_device: Option<Value>,
    installation: Value,
    stale_partial_files: Vec<String>,
    output_directory: &Path,
) -> Value {
    json!({
        "schema": "analog-rytm-overbridge-provider.v1",
        "provider": {
            "id": "elektron-overbridge-coreaudio",
            "name": "Elektron Overbridge",
            "kind": "coreaudio_hal",
            "optional": true,
            "controlDependency": false,
        },
        "available": available,
        "deviceMode": device_mode,
        "selectedDevice": selected_device,
        "installation": installation,
        "ownership": {
            "usbAndDriver": "Elektron Overbridge Engine",
            "audioClient": "analog-rytm-agent-bridge during capture",
            "exclusiveMode": true,
            "note": "Close DAWs or standalone/plugin hosts that have claimed the Rytm before bridge capture.",
        },
        "expectedBuses": stem_layout(20).expect("documented AU layout"),
        "latency": {
            "reportedDuringCapture": true,
            "source": "CoreAudio capture and callback timestamps",
        },
        "synchronization": {
            "singleInputStream": true,
            "deinterleavedAfterCapture": true,
            "maxStructuralFrameDrift": 0,
        },
        "requirements": [
            "Analog Rytm USB CONFIG must be OVERBRIDGE, not USB AUDIO/MIDI",
            "Overbridge Engine and HAL driver must be installed and running",
            "No DAW or standalone host may exclusively own the device",
        ],
        "stalePartialFiles": stale_partial_files,
        "outputDirectory": output_directory.display().to_string(),
    })
}

fn overbridge_installation() -> Value {
    let driver_installed = Path::new(DRIVER_PATH).exists();
    let plugin_installed = Path::new(PLUGIN_PATH).exists();
    let engine_installed = Path::new(ENGINE_PATH).exists();
    json!({
        "driverInstalled": driver_installed,
        "pluginInstalled": plugin_installed,
        "engineInstalled": engine_installed,
        "engineRunning": process_running("/Overbridge Engine.app/Contents/MacOS/Overbridge Engine"),
        "version": plist_value(ENGINE_INFO_PATH, "CFBundleShortVersionString"),
        "driverPath": driver_installed.then_some(DRIVER_PATH),
        "pluginPath": plugin_installed.then_some(PLUGIN_PATH),
        "enginePath": engine_installed.then_some(ENGINE_PATH),
    })
}

fn inspect_hardware_candidates(port_match: &str) -> Result<Vec<Value>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|error| format!("could not enumerate CoreAudio input devices: {error}"))?;
    let mut candidates = Vec::new();
    for (index, device) in devices.enumerate() {
        let name = device.to_string();
        let is_rytm = audio_name_matches(&name, port_match);
        let configurations = match device.supported_input_configs() {
            Ok(configurations) => configurations
                .map(|configuration| {
                    let channels = configuration.channels();
                    json!({
                        "channels": channels,
                        "minSampleRate": configuration.min_sample_rate(),
                        "maxSampleRate": configuration.max_sample_rate(),
                        "sampleFormat": sample_format_name(configuration.sample_format()),
                        "recorderSupported": recorder_supports(configuration.sample_format()) && stem_layout(channels).is_some(),
                        "layout": stem_layout(channels),
                    })
                })
                .collect::<Vec<_>>(),
            Err(error) => {
                candidates.push(json!({
                    "id": hardware_device_id(&device, index),
                    "name": name,
                    "isRytm": is_rytm,
                    "available": false,
                    "configurations": [],
                    "error": format!("could not inspect input configurations: {error}"),
                }));
                continue;
            }
        };
        let available = is_rytm
            && configurations
                .iter()
                .any(|configuration| configuration["recorderSupported"] == true);
        candidates.push(json!({
            "id": hardware_device_id(&device, index),
            "name": name,
            "isRytm": is_rytm,
            "available": available,
            "configurations": configurations,
        }));
    }
    Ok(candidates)
}

fn select_overbridge_input(name_match: &str) -> Result<HardwareSelection, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|error| format!("could not enumerate CoreAudio input devices: {error}"))?;
    let mut saw_stereo_rytm = false;
    for (index, device) in devices.enumerate() {
        let name = device.to_string();
        if !audio_name_matches(&name, name_match) {
            continue;
        }
        let configurations = device.supported_input_configs().map_err(|error| {
            format!("could not inspect CoreAudio input configurations: {error}")
        })?;
        let mut best: Option<(u8, SupportedStreamConfig, Vec<StemDefinition>)> = None;
        for range in configurations {
            saw_stereo_rytm |= range.channels() == 2;
            let Some(stems) = stem_layout(range.channels()) else {
                continue;
            };
            if !recorder_supports(range.sample_format()) {
                continue;
            }
            let sample_rate = if range.min_sample_rate() <= PREFERRED_SAMPLE_RATE
                && range.max_sample_rate() >= PREFERRED_SAMPLE_RATE
            {
                PREFERRED_SAMPLE_RATE
            } else {
                range.max_sample_rate()
            };
            let config = range.with_sample_rate(sample_rate);
            let score = u8::from(sample_rate == PREFERRED_SAMPLE_RATE) * 4
                + u8::from(config.sample_format() == SampleFormat::F32) * 2
                + u8::from(matches!(config.channels(), 12 | 20));
            if best
                .as_ref()
                .is_none_or(|(best_score, _, _)| score > *best_score)
            {
                best = Some((score, config, stems));
            }
        }
        if let Some((_, config, stems)) = best {
            return Ok(HardwareSelection {
                id: hardware_device_id(&device, index),
                name,
                device,
                config,
                stems,
            });
        }
    }
    Err(if saw_stereo_rytm {
        "Overbridge multitrack unavailable: the Rytm exposes only class-compliant stereo; select USB CONFIG > OVERBRIDGE on the device and close other audio hosts".to_string()
    } else {
        format!(
            "Overbridge multitrack unavailable: no compatible CoreAudio input device name contains {name_match:?}"
        )
    })
}

fn stem_layout(channels: u16) -> Option<Vec<StemDefinition>> {
    let (stereo_buses, include_input) = match channels {
        10 => (false, false),
        12 => (false, true),
        18 => (true, false),
        20 => (true, true),
        _ => return None,
    };
    let buses = [
        ("main", "Main", &[][..]),
        ("bd", "BD 1", &["BD"][..]),
        ("sd", "SD 2", &["SD"][..]),
        ("rs_cp", "RS/CP 3/4", &["RS", "CP"][..]),
        ("bt", "BT 5", &["BT"][..]),
        ("lt", "LT 6", &["LT"][..]),
        ("mt_ht", "MT/HT 7/8", &["MT", "HT"][..]),
        ("ch_oh", "CH/OH 9/10", &["CH", "OH"][..]),
        ("cy_cb", "CY/CB 11/12", &["CY", "CB"][..]),
    ];
    let mut stems = Vec::new();
    for (bus_index, (id, name, tracks)) in buses.into_iter().enumerate() {
        let indices = if stereo_buses || bus_index == 0 {
            let start = if stereo_buses { bus_index * 2 } else { 0 };
            vec![start, start + 1]
        } else {
            vec![bus_index + 1]
        };
        stems.push(StemDefinition {
            id: id.to_string(),
            name: name.to_string(),
            tracks: tracks.iter().map(|track| (*track).to_string()).collect(),
            channels: indices.len() as u16,
            source_channel_indices: indices,
        });
    }
    if include_input {
        let start = if stereo_buses { 18 } else { 10 };
        stems.push(StemDefinition {
            id: "input".to_string(),
            name: "Input".to_string(),
            tracks: Vec::new(),
            source_channel_indices: vec![start, start + 1],
            channels: 2,
        });
    }
    Some(stems)
}

fn create_stem_writers(
    directory: &Path,
    sample_rate: u32,
    stems: &[StemDefinition],
) -> Result<Vec<StemWriter>, String> {
    stems
        .iter()
        .map(|definition| {
            let partial_path = directory.join(format!("{}.wav.partial", definition.id));
            let final_path = directory.join(format!("{}.wav", definition.id));
            let writer = WavWriter::create(
                &partial_path,
                WavSpec {
                    channels: definition.channels,
                    sample_rate,
                    bits_per_sample: 32,
                    sample_format: WavSampleFormat::Float,
                },
            )
            .map_err(|error| {
                format!(
                    "could not create Overbridge stem {}: {error}",
                    partial_path.display()
                )
            })?;
            Ok(StemWriter {
                definition: definition.clone(),
                partial_path,
                final_path,
                writer,
            })
        })
        .collect()
}

fn write_multitrack_samples(
    mut stems: Vec<StemWriter>,
    receiver: Receiver<Vec<f32>>,
    source_channels: usize,
) -> Result<WriterResult, String> {
    let mut stats = (0..stems.len())
        .map(|_| StemStats::default())
        .collect::<Vec<_>>();
    for block in receiver {
        if block.is_empty() {
            break;
        }
        for frame in block.chunks_exact(source_channels) {
            for (stem_index, stem) in stems.iter_mut().enumerate() {
                for source_index in &stem.definition.source_channel_indices {
                    let sample = frame[*source_index];
                    stem.writer.write_sample(sample).map_err(|error| {
                        format!("could not write Overbridge stem sample: {error}")
                    })?;
                    let magnitude = sample.abs();
                    let stem_stats = &mut stats[stem_index];
                    stem_stats.samples += 1;
                    stem_stats.peak = stem_stats.peak.max(magnitude);
                    stem_stats.squared_sum += f64::from(sample) * f64::from(sample);
                    stem_stats.clipped_samples += u64::from(magnitude >= 0.999);
                }
            }
        }
    }
    let mut results = Vec::new();
    for (stem, stats) in stems.into_iter().zip(stats) {
        stem.writer
            .finalize()
            .map_err(|error| format!("could not finalize Overbridge stem: {error}"))?;
        File::open(&stem.partial_path)
            .and_then(|file| file.sync_all())
            .map_err(error_string)?;
        fs::rename(&stem.partial_path, &stem.final_path).map_err(error_string)?;
        results.push((stem.definition, stem.final_path, stats));
    }
    Ok(WriterResult { stems: results })
}

fn build_hardware_stream(
    device: &Device,
    config: &SupportedStreamConfig,
    callback_state: CallbackState,
) -> Result<Stream, String> {
    let stream_config: StreamConfig = (*config).into();
    let error_sender = callback_state.notice_sender.clone();
    let error_callback = move |error| {
        let _ = error_sender.send(CaptureNotice::Error(format!(
            "Overbridge CoreAudio input disconnected or failed: {error}"
        )));
    };
    match config.sample_format() {
        SampleFormat::F32 => device
            .build_input_stream(
                stream_config,
                move |data: &[f32], info| {
                    submit_input(data, info, &callback_state, |sample| sample)
                },
                error_callback,
                None,
            )
            .map_err(|error| format!("could not build f32 Overbridge stream: {error}")),
        SampleFormat::I16 => device
            .build_input_stream(
                stream_config,
                move |data: &[i16], info| {
                    submit_input(data, info, &callback_state, |sample| {
                        f32::from(sample) / f32::from(i16::MAX)
                    })
                },
                error_callback,
                None,
            )
            .map_err(|error| format!("could not build i16 Overbridge stream: {error}")),
        SampleFormat::U16 => device
            .build_input_stream(
                stream_config,
                move |data: &[u16], info| {
                    submit_input(data, info, &callback_state, |sample| {
                        (f32::from(sample) - 32_768.0) / 32_768.0
                    })
                },
                error_callback,
                None,
            )
            .map_err(|error| format!("could not build u16 Overbridge stream: {error}")),
        format => Err(format!(
            "Overbridge sample format {} is not supported",
            sample_format_name(format)
        )),
    }
}

fn submit_input<T: Copy>(
    data: &[T],
    info: &InputCallbackInfo,
    state: &CallbackState,
    convert: impl Fn(T) -> f32,
) {
    let available_frames = data.len() / state.source_channels;
    record_callback_metrics(info, available_frames, state);
    let accepted = state.accepted_frames.load(Ordering::Relaxed);
    let frame_count = usize::try_from(state.target_frames.saturating_sub(accepted))
        .unwrap_or(usize::MAX)
        .min(available_frames);
    if frame_count == 0 {
        return;
    }
    let mut output = Vec::with_capacity(frame_count * state.source_channels);
    for sample in data.iter().take(frame_count * state.source_channels) {
        output.push(convert(*sample).clamp(-1.0, 1.0));
    }
    match state.sender.try_send(output) {
        Ok(()) => {
            let total = state
                .accepted_frames
                .fetch_add(frame_count as u64, Ordering::SeqCst)
                + frame_count as u64;
            if total >= state.target_frames && !state.target_reported.swap(true, Ordering::SeqCst) {
                let _ = state.notice_sender.send(CaptureNotice::TargetReached);
            }
        }
        Err(TrySendError::Full(_)) => {
            state.dropped_blocks.fetch_add(1, Ordering::Relaxed);
        }
        Err(TrySendError::Disconnected(_)) => {
            let _ = state.notice_sender.send(CaptureNotice::Error(
                "Overbridge writer disconnected from CoreAudio callback".to_string(),
            ));
        }
    }
}

fn record_callback_metrics(info: &InputCallbackInfo, frames: usize, state: &CallbackState) {
    let timestamp = info.timestamp();
    let latency = timestamp.callback - timestamp.capture;
    let latency_ns = u64::try_from(latency.as_nanos()).unwrap_or(u64::MAX);
    state.metrics.callback_count.fetch_add(1, Ordering::Relaxed);
    state
        .metrics
        .callback_latency_sum_ns
        .fetch_add(latency_ns, Ordering::Relaxed);
    state
        .metrics
        .callback_latency_max_ns
        .fetch_max(latency_ns, Ordering::Relaxed);
    state
        .metrics
        .callback_latency_min_ns
        .fetch_min(latency_ns, Ordering::Relaxed);

    let capture_ns = u64::try_from(timestamp.capture.as_nanos()).unwrap_or(u64::MAX);
    let previous = state
        .metrics
        .previous_capture_ns
        .swap(capture_ns, Ordering::Relaxed);
    let previous_frames = state
        .metrics
        .previous_frame_count
        .swap(frames as u64, Ordering::Relaxed);
    if previous > 0 && capture_ns > previous && previous_frames > 0 {
        let observed = capture_ns - previous;
        let expected = previous_frames.saturating_mul(1_000_000_000) / u64::from(state.sample_rate);
        let tolerance = expected / 2 + 2_000_000;
        if observed > expected.saturating_add(tolerance) {
            state
                .metrics
                .timestamp_gap_count
                .fetch_add(1, Ordering::Relaxed);
            state
                .metrics
                .timestamp_gap_max_ns
                .fetch_max(observed - expected, Ordering::Relaxed);
        }
    }
}

fn send_mock_samples(
    sender: &SyncSender<Vec<f32>>,
    signal: MockSignal,
    sample_rate: u32,
    channels: u16,
    frames: u64,
) -> Result<(), String> {
    if signal == MockSignal::Disconnect {
        return Err("mock Overbridge input disconnected".to_string());
    }
    let mut offset = 0_u64;
    while offset < frames {
        let block_frames = (frames - offset).min(1_024);
        let mut block = Vec::with_capacity(block_frames as usize * usize::from(channels));
        for frame in 0..block_frames {
            let time = (offset + frame) as f32 / sample_rate as f32;
            for channel in 0..channels {
                let sample = match signal {
                    MockSignal::Tone => {
                        let frequency = 110.0 + f32::from(channel) * 37.0;
                        (time * frequency * std::f32::consts::TAU).sin() * 0.2
                    }
                    MockSignal::Silence => 0.0,
                    MockSignal::Clipped => {
                        if channel % 2 == 0 {
                            1.0
                        } else {
                            -1.0
                        }
                    }
                    MockSignal::Disconnect => unreachable!(),
                };
                block.push(sample);
            }
        }
        sender
            .send(block)
            .map_err(|_| "mock Overbridge writer disconnected".to_string())?;
        offset += block_frames;
    }
    Ok(())
}

fn declaration(request: &CaptureMultitrackRequest) -> Value {
    json!({
        "deviceName": request.device_name,
        "snapshotId": request.snapshot_id,
        "durationMs": request.duration_ms,
    })
}

fn read_json(path: &Path) -> Result<Value, String> {
    let mut file = File::open(path).map_err(error_string)?;
    let mut source = String::new();
    file.read_to_string(&mut source).map_err(error_string)?;
    serde_json::from_str(&source).map_err(error_string)
}

fn write_json_atomic(partial: &Path, final_path: &Path, value: &Value) -> Result<(), String> {
    let mut file = File::create(partial).map_err(error_string)?;
    serde_json::to_writer_pretty(&mut file, value).map_err(error_string)?;
    file.write_all(b"\n").map_err(error_string)?;
    file.sync_all().map_err(error_string)?;
    fs::rename(partial, final_path).map_err(error_string)
}

fn stale_partial_files(directory: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    collect_partial_files(directory, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_partial_files(directory: &Path, files: &mut Vec<String>) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(error_string)? {
        let path = entry.map_err(error_string)?.path();
        if path.is_dir() {
            collect_partial_files(&path, files)?;
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".partial"))
        {
            files.push(path.display().to_string());
        }
    }
    Ok(())
}

fn process_running(pattern: &str) -> Option<bool> {
    Command::new("/usr/bin/pgrep")
        .args(["-f", pattern])
        .status()
        .ok()
        .map(|status| status.success())
}

fn plist_value(path: &str, key: &str) -> Option<String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", path])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn recorder_supports(format: SampleFormat) -> bool {
    matches!(
        format,
        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
    )
}

fn audio_name_matches(name: &str, requested: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let requested = requested.to_ascii_lowercase();
    name.contains(&requested)
        || requested.contains(&name)
        || (name.contains("analog rytm") && requested.contains("analog rytm"))
}

fn hardware_device_id(device: &Device, fallback_index: usize) -> String {
    device
        .id()
        .map(|id| id.to_string())
        .unwrap_or_else(|_| format!("coreaudio-{fallback_index}"))
}

fn sample_format_name(format: SampleFormat) -> String {
    format!("{format:?}").to_ascii_lowercase()
}

fn frames_for_duration(sample_rate: u32, milliseconds: u64) -> u64 {
    u64::from(sample_rate) * milliseconds / 1_000
}

fn nanos_to_ms(nanoseconds: u64) -> f64 {
    nanoseconds as f64 / 1_000_000.0
}

fn validate_duration(milliseconds: u64) -> Result<(), String> {
    if !(MIN_CAPTURE_MILLISECONDS..=MAX_CAPTURE_MILLISECONDS).contains(&milliseconds) {
        return Err(format!(
            "durationMs must be between {MIN_CAPTURE_MILLISECONDS} and {MAX_CAPTURE_MILLISECONDS}"
        ));
    }
    Ok(())
}

fn validate_recording_id(recording_id: &str) -> Result<(), String> {
    if recording_id.is_empty() || recording_id.len() > 128 {
        return Err("recordingId must contain between 1 and 128 characters".to_string());
    }
    if !recording_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(
            "recordingId may contain only ASCII letters, digits, period, hyphen, and underscore"
                .to_string(),
        );
    }
    Ok(())
}

fn generated_recording_id() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "overbridge-{}-{:09}",
        duration.as_secs(),
        duration.subsec_nanos()
    )
}

fn timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}Z", duration.as_secs(), duration.subsec_millis())
}

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_documented_hal_and_audio_unit_channel_layouts() {
        let hal = stem_layout(12).expect("12-channel HAL layout");
        assert_eq!(hal.len(), 10);
        assert_eq!(hal[0].source_channel_indices, [0, 1]);
        assert_eq!(hal[1].name, "BD 1");
        assert_eq!(hal[3].tracks, ["RS", "CP"]);
        assert_eq!(hal[8].name, "CY/CB 11/12");
        assert_eq!(hal[9].source_channel_indices, [10, 11]);

        let audio_unit = stem_layout(20).expect("20-channel AU-style layout");
        assert_eq!(audio_unit.len(), 10);
        assert_eq!(audio_unit[3].source_channel_indices, [6, 7]);
        assert_eq!(audio_unit[9].source_channel_indices, [18, 19]);
        assert!(stem_layout(2).is_none());
        assert!(stem_layout(14).is_none());
    }

    #[test]
    fn flattens_the_selected_hardware_configuration_for_clients() {
        let candidate = json!({
            "id": "coreaudio:rytm",
            "name": "Analog Rytm",
            "configurations": [
                {
                    "channels": 18,
                    "minSampleRate": 44_100,
                    "maxSampleRate": 44_100,
                    "sampleFormat": "i16",
                    "recorderSupported": true,
                    "layout": stem_layout(18).unwrap(),
                },
                {
                    "channels": 12,
                    "minSampleRate": 48_000,
                    "maxSampleRate": 48_000,
                    "sampleFormat": "f32",
                    "recorderSupported": true,
                    "layout": stem_layout(12).unwrap(),
                },
            ]
        });
        let selected = selected_device_summary(&candidate).unwrap();
        assert_eq!(selected["channels"], 12);
        assert_eq!(selected["sampleRate"], 48_000);
        assert_eq!(selected["layout"].as_array().unwrap().len(), 10);
        assert!(selected.get("configurations").is_none());
    }

    #[test]
    fn mock_capture_writes_synchronized_non_silent_stems_and_replays() {
        let directory = std::env::temp_dir().join(format!(
            "analog-rytm-overbridge-test-{}",
            generated_recording_id()
        ));
        let mut service = OverbridgeAudioService::new(
            AudioMode::Mock,
            directory.clone(),
            "Analog Rytm".to_string(),
        );
        let provider = service.inspect_provider().expect("mock provider");
        assert_eq!(provider["available"], true);
        assert_eq!(
            provider["selectedDevice"]["layout"]
                .as_array()
                .unwrap()
                .len(),
            10
        );
        let request = CaptureMultitrackRequest {
            recording_id: Some("mock-stems".to_string()),
            device_name: None,
            snapshot_id: Some("baseline".to_string()),
            duration_ms: 125,
            mock_signal: MockSignal::Tone,
        };
        let result = service
            .capture_multitrack(request.clone(), context())
            .expect("mock multitrack capture");
        assert_eq!(result["status"], "completed");
        assert_eq!(result["stems"].as_array().unwrap().len(), 10);
        assert_eq!(result["synchronization"]["framesPerStem"], 6_000);
        assert_eq!(result["synchronization"]["maxFrameDrift"], 0);
        for stem in result["stems"].as_array().unwrap() {
            assert_eq!(stem["frames"], 6_000);
            assert_eq!(stem["analysis"]["silence"], false);
            assert!(Path::new(stem["path"].as_str().unwrap()).is_file());
        }
        assert_eq!(
            service
                .capture_multitrack(request, context())
                .expect("idempotent replay"),
            result
        );
        fs::remove_dir_all(directory).ok();
    }

    fn context() -> RecordingContext {
        RecordingContext {
            device_model: "Analog Rytm MKII".to_string(),
            pattern: "A01".to_string(),
            kit: json!({ "index": 0, "name": "MOCK" }),
            revision: 3,
            tempo: 120.0,
            routing: json!({}),
        }
    }
}
