use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig, SupportedStreamConfig,
};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const OUTPUT_CHANNELS: u16 = 2;
const PREFERRED_SAMPLE_RATE: u32 = 48_000;
const WRITER_QUEUE_BLOCKS: usize = 64;
const DEFAULT_MOCK_FRAMES: u64 = 4_800;
const MIN_CAPTURE_MILLISECONDS: u64 = 100;
const MAX_CAPTURE_MILLISECONDS: u64 = 600_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioMode {
    Mock,
    Hardware,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StartRecordingRequest {
    #[serde(default)]
    pub recording_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub expected_duration_ms: Option<u64>,
    #[serde(default)]
    pub mock_signal: MockSignal,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StopRecordingRequest {
    pub recording_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapturePatternAudioRequest {
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

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MockSignal {
    #[default]
    Tone,
    Silence,
    Clipped,
    Disconnect,
}

#[derive(Clone, Debug)]
pub struct RecordingContext {
    pub device_model: String,
    pub pattern: String,
    pub kit: Value,
    pub revision: u64,
    pub tempo: f64,
    pub routing: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputInventory {
    pub inputs: Vec<AudioInputInfo>,
    pub stale_partial_files: Vec<String>,
    pub output_directory: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputInfo {
    pub id: String,
    pub name: String,
    pub is_rytm: bool,
    pub default_config: Option<AudioStreamCapability>,
    pub configurations: Vec<AudioStreamCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamCapability {
    pub channels: u16,
    pub min_sample_rate: u32,
    pub max_sample_rate: u32,
    pub sample_format: String,
    pub recorder_supported: bool,
}

pub struct AudioService {
    mode: AudioMode,
    output_directory: PathBuf,
    port_match: String,
    active: Option<ActiveRecording>,
    completed: HashMap<String, Value>,
}

struct ActiveRecording {
    recording_id: String,
    request: StartRecordingRequest,
    started: Value,
    context: RecordingContext,
    snapshot_id: Option<String>,
    source: SelectedSource,
    started_at: String,
    final_path: PathBuf,
    partial_path: PathBuf,
    metadata_path: PathBuf,
    metadata_partial_path: PathBuf,
    expected_duration_ms: Option<u64>,
    target_frames: Option<u64>,
    accepted_frames: Arc<AtomicU64>,
    dropped_blocks: Arc<AtomicU64>,
    notice_receiver: Receiver<CaptureNotice>,
    capture: CaptureHandle,
    writer_thread: Option<JoinHandle<Result<WriterStats, String>>>,
}

enum CaptureHandle {
    Hardware {
        stream: Stream,
        finish_sender: SyncSender<Vec<f32>>,
    },
    Mock {
        sender: SyncSender<Vec<f32>>,
        signal: MockSignal,
    },
}

#[derive(Clone, Debug)]
struct SelectedSource {
    id: String,
    name: String,
    source_channels: u16,
    sample_rate: u32,
    source_sample_format: String,
}

enum CaptureNotice {
    TargetReached,
    Error(String),
}

#[derive(Default)]
struct WriterStats {
    samples: u64,
    peak: f32,
    squared_sum: f64,
    clipped_samples: u64,
}

#[derive(Clone)]
struct CallbackState {
    sender: SyncSender<Vec<f32>>,
    notice_sender: mpsc::Sender<CaptureNotice>,
    source_channels: usize,
    target_frames: Option<u64>,
    accepted_frames: Arc<AtomicU64>,
    dropped_blocks: Arc<AtomicU64>,
    target_reported: Arc<AtomicBool>,
}

impl AudioService {
    pub fn new(mode: AudioMode, output_directory: PathBuf, port_match: String) -> Self {
        Self {
            mode,
            output_directory,
            port_match,
            active: None,
            completed: HashMap::new(),
        }
    }

    pub fn list_inputs(&self) -> Result<AudioInputInventory, String> {
        fs::create_dir_all(&self.output_directory).map_err(|error| {
            format!(
                "could not create audio output directory {}: {error}",
                self.output_directory.display()
            )
        })?;
        let inputs = match self.mode {
            AudioMode::Mock => vec![AudioInputInfo {
                id: "mock-stereo".to_string(),
                name: "Mock Analog Rytm Stereo".to_string(),
                is_rytm: true,
                default_config: Some(AudioStreamCapability {
                    channels: OUTPUT_CHANNELS,
                    min_sample_rate: PREFERRED_SAMPLE_RATE,
                    max_sample_rate: PREFERRED_SAMPLE_RATE,
                    sample_format: "f32".to_string(),
                    recorder_supported: true,
                }),
                configurations: vec![AudioStreamCapability {
                    channels: OUTPUT_CHANNELS,
                    min_sample_rate: PREFERRED_SAMPLE_RATE,
                    max_sample_rate: PREFERRED_SAMPLE_RATE,
                    sample_format: "f32".to_string(),
                    recorder_supported: true,
                }],
                error: None,
            }],
            AudioMode::Hardware => list_hardware_inputs(&self.port_match)?,
        };
        Ok(AudioInputInventory {
            inputs,
            stale_partial_files: stale_partial_files(&self.output_directory)?,
            output_directory: self.output_directory.display().to_string(),
        })
    }

    pub fn start_recording(
        &mut self,
        request: StartRecordingRequest,
        context: RecordingContext,
    ) -> Result<Value, String> {
        let expected_duration_ms = request.expected_duration_ms;
        self.start_internal(request, context, expected_duration_ms)
    }

    pub fn stop_recording(&mut self, request: StopRecordingRequest) -> Result<Value, String> {
        self.stop_internal(&request.recording_id, None)
    }

    pub fn capture_pattern_audio(
        &mut self,
        request: CapturePatternAudioRequest,
        context: RecordingContext,
    ) -> Result<Value, String> {
        validate_duration(request.duration_ms)?;
        let start_request = StartRecordingRequest {
            recording_id: request.recording_id,
            device_name: request.device_name,
            snapshot_id: request.snapshot_id,
            expected_duration_ms: None,
            mock_signal: request.mock_signal,
        };
        let started = self.start_internal(start_request, context, Some(request.duration_ms))?;
        let recording_id = started["recordingId"]
            .as_str()
            .ok_or_else(|| "audio start response omitted recordingId".to_string())?
            .to_string();

        if self.mode == AudioMode::Mock {
            self.feed_mock_target()?;
        }
        let wait_duration =
            Duration::from_millis(request.duration_ms).saturating_add(Duration::from_secs(3));
        let notice = self
            .active
            .as_ref()
            .ok_or_else(|| "audio capture disappeared before completion".to_string())?
            .notice_receiver
            .recv_timeout(wait_duration);
        let failure = match notice {
            Ok(CaptureNotice::TargetReached) => None,
            Ok(CaptureNotice::Error(error)) => Some(error),
            Err(mpsc::RecvTimeoutError::Timeout) => Some(format!(
                "audio capture timed out before reaching {} ms",
                request.duration_ms
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Some("audio capture completion channel disconnected".to_string())
            }
        };
        self.stop_internal(&recording_id, failure)
    }

    pub fn shutdown(&mut self) -> Result<(), String> {
        let Some(recording_id) = self
            .active
            .as_ref()
            .map(|active| active.recording_id.clone())
        else {
            return Ok(());
        };
        self.stop_internal(
            &recording_id,
            Some("daemon shutdown stopped the active recording".to_string()),
        )?;
        Ok(())
    }

    fn start_internal(
        &mut self,
        request: StartRecordingRequest,
        context: RecordingContext,
        expected_duration_ms: Option<u64>,
    ) -> Result<Value, String> {
        if let Some(active) = &self.active {
            if request.recording_id.as_deref() == Some(active.recording_id.as_str()) {
                return if request == active.request {
                    Ok(active.started.clone())
                } else {
                    Err(format!(
                        "recordingId already exists with different start parameters: {}",
                        active.recording_id
                    ))
                };
            }
            return Err(format!(
                "recording {} is already active; stop it before starting another",
                active.recording_id
            ));
        }
        if let Some(duration_ms) = expected_duration_ms {
            validate_duration(duration_ms)?;
        }
        fs::create_dir_all(&self.output_directory).map_err(|error| {
            format!(
                "could not create audio output directory {}: {error}",
                self.output_directory.display()
            )
        })?;

        let start_request = request.clone();
        let recording_id = request
            .recording_id
            .clone()
            .unwrap_or_else(generated_recording_id);
        validate_recording_id(&recording_id)?;
        if let Some(completed) = self.completed.get(&recording_id) {
            return Ok(completed.clone());
        }
        let final_path = self.output_directory.join(format!("{recording_id}.wav"));
        let partial_path = self
            .output_directory
            .join(format!("{recording_id}.wav.partial"));
        let metadata_path = self.output_directory.join(format!("{recording_id}.json"));
        let metadata_partial_path = self
            .output_directory
            .join(format!("{recording_id}.json.partial"));
        for path in [
            &final_path,
            &partial_path,
            &metadata_path,
            &metadata_partial_path,
        ] {
            if path.exists() {
                return Err(format!(
                    "recording output already exists and will not be overwritten: {}",
                    path.display()
                ));
            }
        }

        let (source, hardware_device, hardware_config) = match self.mode {
            AudioMode::Mock => (
                SelectedSource {
                    id: "mock-stereo".to_string(),
                    name: "Mock Analog Rytm Stereo".to_string(),
                    source_channels: OUTPUT_CHANNELS,
                    sample_rate: PREFERRED_SAMPLE_RATE,
                    source_sample_format: "f32".to_string(),
                },
                None,
                None,
            ),
            AudioMode::Hardware => {
                let selected = select_hardware_input(
                    request.device_name.as_deref().unwrap_or(&self.port_match),
                )?;
                let source = SelectedSource {
                    id: selected.id,
                    name: selected.name,
                    source_channels: selected.config.channels(),
                    sample_rate: selected.config.sample_rate(),
                    source_sample_format: sample_format_name(selected.config.sample_format()),
                };
                (source, Some(selected.device), Some(selected.config))
            }
        };

        let wav_spec = WavSpec {
            channels: OUTPUT_CHANNELS,
            sample_rate: source.sample_rate,
            bits_per_sample: 32,
            sample_format: WavSampleFormat::Float,
        };
        let writer = WavWriter::create(&partial_path, wav_spec).map_err(|error| {
            format!(
                "could not create partial WAV {}: {error}",
                partial_path.display()
            )
        })?;
        let (sample_sender, sample_receiver) = mpsc::sync_channel(WRITER_QUEUE_BLOCKS);
        let writer_thread = thread::spawn(move || write_samples(writer, sample_receiver));
        let (notice_sender, notice_receiver) = mpsc::channel();
        let target_frames = expected_duration_ms
            .map(|milliseconds| frames_for_duration(source.sample_rate, milliseconds));
        let accepted_frames = Arc::new(AtomicU64::new(0));
        let dropped_blocks = Arc::new(AtomicU64::new(0));

        let capture = match self.mode {
            AudioMode::Mock => CaptureHandle::Mock {
                sender: sample_sender,
                signal: request.mock_signal,
            },
            AudioMode::Hardware => {
                let device = hardware_device.expect("hardware mode selected a device");
                let config = hardware_config.expect("hardware mode selected a configuration");
                let callback_state = CallbackState {
                    sender: sample_sender.clone(),
                    notice_sender: notice_sender.clone(),
                    source_channels: usize::from(config.channels()),
                    target_frames,
                    accepted_frames: Arc::clone(&accepted_frames),
                    dropped_blocks: Arc::clone(&dropped_blocks),
                    target_reported: Arc::new(AtomicBool::new(false)),
                };
                let stream = match build_hardware_stream(&device, &config, callback_state) {
                    Ok(stream) => stream,
                    Err(error) => {
                        let _ = sample_sender.send(Vec::new());
                        let _ = writer_thread.join();
                        let _ = fs::remove_file(&partial_path);
                        return Err(error);
                    }
                };
                if let Err(error) = stream.play() {
                    let _ = sample_sender.send(Vec::new());
                    let _ = writer_thread.join();
                    let _ = fs::remove_file(&partial_path);
                    return Err(format!("could not start CoreAudio input stream: {error}"));
                }
                CaptureHandle::Hardware {
                    stream,
                    finish_sender: sample_sender,
                }
            }
        };

        let started_at = timestamp();
        let result = json!({
            "schema": "analog-rytm-recording.v1",
            "recordingId": recording_id,
            "status": "recording",
            "startedAt": started_at,
            "partialPath": partial_path.display().to_string(),
            "device": {
                "model": context.device_model,
                "inputId": source.id,
                "inputName": source.name,
                "sourceChannels": source.source_channels,
                "capturedChannels": OUTPUT_CHANNELS,
                "sampleRate": source.sample_rate,
                "sourceSampleFormat": source.source_sample_format,
            },
            "pattern": context.pattern,
            "kit": context.kit,
            "revision": context.revision,
            "tempo": context.tempo,
            "routing": context.routing,
            "snapshotId": request.snapshot_id,
            "expectedDurationMs": expected_duration_ms,
        });
        self.active = Some(ActiveRecording {
            recording_id: result["recordingId"].as_str().unwrap().to_string(),
            request: start_request,
            started: result.clone(),
            context,
            snapshot_id: result["snapshotId"].as_str().map(str::to_string),
            source,
            started_at,
            final_path,
            partial_path,
            metadata_path,
            metadata_partial_path,
            expected_duration_ms,
            target_frames,
            accepted_frames,
            dropped_blocks,
            notice_receiver,
            capture,
            writer_thread: Some(writer_thread),
        });
        Ok(result)
    }

    fn feed_mock_target(&mut self) -> Result<(), String> {
        let active = self
            .active
            .as_mut()
            .ok_or_else(|| "no recording is active".to_string())?;
        let target_frames = active
            .target_frames
            .ok_or_else(|| "mock target feed requires a bounded recording".to_string())?;
        let CaptureHandle::Mock { sender, signal } = &active.capture else {
            return Err("mock target feed called for a hardware stream".to_string());
        };
        if *signal == MockSignal::Disconnect {
            let (notice_sender, notice_receiver) = mpsc::channel();
            notice_sender
                .send(CaptureNotice::Error(
                    "mock audio input disconnected".to_string(),
                ))
                .map_err(|error| error.to_string())?;
            active.notice_receiver = notice_receiver;
            return Ok(());
        }
        send_mock_samples(sender, *signal, active.source.sample_rate, target_frames)?;
        active
            .accepted_frames
            .store(target_frames, Ordering::SeqCst);
        // Mock generation is synchronous, so target completion is already authoritative.
        let (notice_sender, notice_receiver) = mpsc::channel();
        notice_sender
            .send(CaptureNotice::TargetReached)
            .map_err(|error| error.to_string())?;
        active.notice_receiver = notice_receiver;
        Ok(())
    }

    fn stop_internal(
        &mut self,
        recording_id: &str,
        mut failure: Option<String>,
    ) -> Result<Value, String> {
        if let Some(completed) = self.completed.get(recording_id) {
            return Ok(completed.clone());
        }
        let active_id = self
            .active
            .as_ref()
            .map(|active| active.recording_id.as_str())
            .ok_or_else(|| {
                format!("no recording is active; unknown recordingId {recording_id:?}")
            })?;
        if active_id != recording_id {
            return Err(format!(
                "recording {active_id} is active, not requested recording {recording_id}"
            ));
        }

        if self.mode == AudioMode::Mock {
            let active = self.active.as_mut().expect("active recording was checked");
            if active.accepted_frames.load(Ordering::SeqCst) == 0 {
                if let CaptureHandle::Mock { sender, signal } = &active.capture {
                    if *signal == MockSignal::Disconnect {
                        failure = Some("mock audio input disconnected".to_string());
                    } else {
                        let frames = active.target_frames.unwrap_or(DEFAULT_MOCK_FRAMES);
                        send_mock_samples(sender, *signal, active.source.sample_rate, frames)?;
                        active.accepted_frames.store(frames, Ordering::SeqCst);
                    }
                }
            }
        }

        let mut active = self.active.take().expect("active recording was checked");
        while let Ok(notice) = active.notice_receiver.try_recv() {
            if let CaptureNotice::Error(error) = notice {
                failure.get_or_insert(error);
            }
        }
        match active.capture {
            CaptureHandle::Hardware {
                stream,
                finish_sender,
            } => {
                if let Err(error) = stream.pause() {
                    failure.get_or_insert_with(|| {
                        format!("could not pause CoreAudio input stream: {error}")
                    });
                }
                if finish_sender.send(Vec::new()).is_err() {
                    failure.get_or_insert_with(|| {
                        "audio writer disconnected before its finish marker".to_string()
                    });
                }
            }
            CaptureHandle::Mock { sender, .. } => {
                if sender.send(Vec::new()).is_err() {
                    failure.get_or_insert_with(|| {
                        "mock audio writer disconnected before its finish marker".to_string()
                    });
                }
            }
        }
        let writer_stats = active
            .writer_thread
            .take()
            .expect("active recording has a writer")
            .join()
            .map_err(|_| "audio writer thread panicked".to_string())??;
        File::open(&active.partial_path)
            .and_then(|file| file.sync_all())
            .map_err(|error| {
                format!(
                    "could not sync partial WAV {}: {error}",
                    active.partial_path.display()
                )
            })?;
        fs::rename(&active.partial_path, &active.final_path).map_err(|error| {
            format!(
                "could not atomically finalize WAV {}: {error}",
                active.final_path.display()
            )
        })?;

        let frames = writer_stats.samples / u64::from(OUTPUT_CHANNELS);
        let duration_ms = frames as f64 * 1_000.0 / f64::from(active.source.sample_rate);
        let sample_count = writer_stats.samples.max(1);
        let rms = (writer_stats.squared_sum / sample_count as f64).sqrt();
        let silence = writer_stats.peak <= 0.000_1 || rms <= 0.000_01;
        let clipping = writer_stats.clipped_samples > 0;
        let duration_within_tolerance = active.expected_duration_ms.map(|expected| {
            let tolerance = (expected as f64 * 0.05).max(50.0);
            (duration_ms - expected as f64).abs() <= tolerance
        });
        if duration_within_tolerance == Some(false) {
            failure.get_or_insert_with(|| {
                format!(
                    "captured duration {duration_ms:.3} ms is outside tolerance for expected {} ms",
                    active.expected_duration_ms.unwrap_or_default()
                )
            });
        }
        let disconnected = failure
            .as_deref()
            .is_some_and(|message| message.to_ascii_lowercase().contains("disconnect"));
        let dropped_blocks = active.dropped_blocks.load(Ordering::SeqCst);
        let mut warnings = Vec::new();
        if silence {
            warnings
                .push("recording is silent or below the configured signal threshold".to_string());
        }
        if clipping {
            warnings.push(format!(
                "recording contains {} clipped samples",
                writer_stats.clipped_samples
            ));
        }
        if dropped_blocks > 0 {
            warnings.push(format!(
                "CoreAudio callback dropped {dropped_blocks} blocks because the writer queue was full"
            ));
        }
        if let Some(error) = &failure {
            warnings.push(error.clone());
        }

        let stopped_at = timestamp();
        let bytes = fs::metadata(&active.final_path)
            .map_err(|error| format!("could not inspect finalized WAV: {error}"))?
            .len();
        let metadata = json!({
            "schema": "analog-rytm-recording.v1",
            "recordingId": active.recording_id,
            "status": if failure.is_some() { "failed" } else { "completed" },
            "device": {
                "model": active.context.device_model,
                "inputId": active.source.id,
                "inputName": active.source.name,
                "sourceChannels": active.source.source_channels,
                "capturedChannels": OUTPUT_CHANNELS,
                "sampleRate": active.source.sample_rate,
                "sourceSampleFormat": active.source.source_sample_format,
            },
            "pattern": active.context.pattern,
            "kit": active.context.kit,
            "revision": active.context.revision,
            "tempo": active.context.tempo,
            "timestamps": {
                "startedAt": active.started_at,
                "stoppedAt": stopped_at,
            },
            "routing": active.context.routing,
            "snapshotId": active.snapshot_id,
            "audio": {
                "path": active.final_path.display().to_string(),
                "metadataPath": active.metadata_path.display().to_string(),
                "container": "wav",
                "sampleFormat": "f32le",
                "channels": OUTPUT_CHANNELS,
                "sampleRate": active.source.sample_rate,
                "frames": frames,
                "durationMs": duration_ms,
                "bytes": bytes,
            },
            "analysis": {
                "peak": writer_stats.peak,
                "rms": rms,
                "silence": silence,
                "clipping": clipping,
                "clippedSamples": writer_stats.clipped_samples,
                "expectedDurationMs": active.expected_duration_ms,
                "durationWithinTolerance": duration_within_tolerance,
                "disconnected": disconnected,
                "droppedBlocks": dropped_blocks,
            },
            "warnings": warnings,
        });
        if let Err(error) = write_json_atomic(
            &active.metadata_partial_path,
            &active.metadata_path,
            &metadata,
        ) {
            let restore_error = fs::rename(&active.final_path, &active.partial_path).err();
            return Err(match restore_error {
                Some(restore_error) => format!(
                    "{error}; finalized WAV could not be returned to partial state: {restore_error}"
                ),
                None => error,
            });
        }
        self.completed
            .insert(recording_id.to_string(), metadata.clone());
        Ok(metadata)
    }
}

struct HardwareSelection {
    id: String,
    name: String,
    device: Device,
    config: SupportedStreamConfig,
}

fn list_hardware_inputs(port_match: &str) -> Result<Vec<AudioInputInfo>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|error| format!("could not enumerate CoreAudio input devices: {error}"))?;
    let mut inputs = Vec::new();
    for (index, device) in devices.enumerate() {
        let name = device.to_string();
        let configurations = match device.supported_input_configs() {
            Ok(configurations) => configurations
                .map(|configuration| AudioStreamCapability {
                    channels: configuration.channels(),
                    min_sample_rate: configuration.min_sample_rate(),
                    max_sample_rate: configuration.max_sample_rate(),
                    sample_format: sample_format_name(configuration.sample_format()),
                    recorder_supported: recorder_supports(configuration.sample_format())
                        && configuration.channels() >= OUTPUT_CHANNELS,
                })
                .collect::<Vec<_>>(),
            Err(error) => {
                inputs.push(AudioInputInfo {
                    id: hardware_device_id(&device, index),
                    is_rytm: audio_name_matches(&name, port_match),
                    name,
                    default_config: None,
                    configurations: Vec::new(),
                    error: Some(format!("could not inspect input configurations: {error}")),
                });
                continue;
            }
        };
        let default_config =
            device
                .default_input_config()
                .ok()
                .map(|configuration| AudioStreamCapability {
                    channels: configuration.channels(),
                    min_sample_rate: configuration.sample_rate(),
                    max_sample_rate: configuration.sample_rate(),
                    sample_format: sample_format_name(configuration.sample_format()),
                    recorder_supported: recorder_supports(configuration.sample_format())
                        && configuration.channels() >= OUTPUT_CHANNELS,
                });
        inputs.push(AudioInputInfo {
            id: hardware_device_id(&device, index),
            is_rytm: audio_name_matches(&name, port_match),
            name,
            default_config,
            configurations,
            error: None,
        });
    }
    Ok(inputs)
}

fn select_hardware_input(name_match: &str) -> Result<HardwareSelection, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|error| format!("could not enumerate CoreAudio input devices: {error}"))?;
    for (index, device) in devices.enumerate() {
        let name = device.to_string();
        if !audio_name_matches(&name, name_match) {
            continue;
        }
        let config = preferred_input_config(&device)?;
        return Ok(HardwareSelection {
            id: hardware_device_id(&device, index),
            name,
            device,
            config,
        });
    }
    Err(format!(
        "no CoreAudio input device name contains {name_match:?}"
    ))
}

fn hardware_device_id(device: &Device, fallback_index: usize) -> String {
    device
        .id()
        .map(|id| id.to_string())
        .unwrap_or_else(|_| format!("coreaudio-{fallback_index}"))
}

fn preferred_input_config(device: &Device) -> Result<SupportedStreamConfig, String> {
    let configurations = device
        .supported_input_configs()
        .map_err(|error| format!("could not inspect CoreAudio input configurations: {error}"))?;
    let mut best: Option<(u8, SupportedStreamConfig)> = None;
    for range in configurations {
        if range.channels() < OUTPUT_CHANNELS || !recorder_supports(range.sample_format()) {
            continue;
        }
        let preferred_rate = PREFERRED_SAMPLE_RATE;
        let sample_rate = if range.min_sample_rate() <= preferred_rate
            && range.max_sample_rate() >= preferred_rate
        {
            preferred_rate
        } else {
            range.max_sample_rate()
        };
        let config = range.with_sample_rate(sample_rate);
        let score = u8::from(sample_rate == PREFERRED_SAMPLE_RATE) * 4
            + u8::from(config.channels() == OUTPUT_CHANNELS) * 2
            + u8::from(config.sample_format() == SampleFormat::F32);
        if best
            .as_ref()
            .is_none_or(|(best_score, _)| score > *best_score)
        {
            best = Some((score, config));
        }
    }
    best.map(|(_, config)| config).ok_or_else(|| {
        "CoreAudio input has no supported configuration with at least two channels and f32/i16/u16 samples".to_string()
    })
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
            "CoreAudio input disconnected or failed: {error}"
        )));
    };
    match config.sample_format() {
        SampleFormat::F32 => device
            .build_input_stream(
                stream_config,
                move |data: &[f32], _| submit_input(data, &callback_state, |sample| sample),
                error_callback,
                None,
            )
            .map_err(|error| format!("could not build f32 CoreAudio input stream: {error}")),
        SampleFormat::I16 => device
            .build_input_stream(
                stream_config,
                move |data: &[i16], _| {
                    submit_input(data, &callback_state, |sample| {
                        f32::from(sample) / f32::from(i16::MAX)
                    });
                },
                error_callback,
                None,
            )
            .map_err(|error| format!("could not build i16 CoreAudio input stream: {error}")),
        SampleFormat::U16 => device
            .build_input_stream(
                stream_config,
                move |data: &[u16], _| {
                    submit_input(data, &callback_state, |sample| {
                        (f32::from(sample) - 32_768.0) / 32_768.0
                    });
                },
                error_callback,
                None,
            )
            .map_err(|error| format!("could not build u16 CoreAudio input stream: {error}")),
        sample_format => Err(format!(
            "CoreAudio sample format {} is not supported by the recorder",
            sample_format_name(sample_format)
        )),
    }
}

fn submit_input<T: Copy>(data: &[T], state: &CallbackState, convert: impl Fn(T) -> f32) {
    let accepted = state.accepted_frames.load(Ordering::Relaxed);
    let available_frames = data.len() / state.source_channels;
    let frame_count = state.target_frames.map_or(available_frames, |target| {
        usize::try_from(target.saturating_sub(accepted))
            .unwrap_or(usize::MAX)
            .min(available_frames)
    });
    if frame_count == 0 {
        return;
    }
    let mut output = Vec::with_capacity(frame_count * usize::from(OUTPUT_CHANNELS));
    for frame in data.chunks_exact(state.source_channels).take(frame_count) {
        output.push(convert(frame[0]).clamp(-1.0, 1.0));
        output.push(convert(frame[1]).clamp(-1.0, 1.0));
    }
    match state.sender.try_send(output) {
        Ok(()) => {
            let total = state
                .accepted_frames
                .fetch_add(frame_count as u64, Ordering::SeqCst)
                + frame_count as u64;
            if state.target_frames.is_some_and(|target| total >= target)
                && !state.target_reported.swap(true, Ordering::SeqCst)
            {
                let _ = state.notice_sender.send(CaptureNotice::TargetReached);
            }
        }
        Err(TrySendError::Full(_)) => {
            state.dropped_blocks.fetch_add(1, Ordering::Relaxed);
        }
        Err(TrySendError::Disconnected(_)) => {
            let _ = state.notice_sender.send(CaptureNotice::Error(
                "audio writer disconnected from the CoreAudio callback".to_string(),
            ));
        }
    }
}

fn send_mock_samples(
    sender: &SyncSender<Vec<f32>>,
    signal: MockSignal,
    sample_rate: u32,
    frames: u64,
) -> Result<(), String> {
    let mut offset = 0_u64;
    while offset < frames {
        let block_frames = (frames - offset).min(1_024);
        let mut block = Vec::with_capacity(block_frames as usize * usize::from(OUTPUT_CHANNELS));
        for frame in 0..block_frames {
            let index = offset + frame;
            let time = index as f32 / sample_rate as f32;
            let (left, right) = match signal {
                MockSignal::Tone => (
                    (time * 440.0 * std::f32::consts::TAU).sin() * 0.25,
                    (time * 660.0 * std::f32::consts::TAU).sin() * 0.25,
                ),
                MockSignal::Silence => (0.0, 0.0),
                MockSignal::Clipped => (1.0, -1.0),
                MockSignal::Disconnect => return Err("mock audio input disconnected".to_string()),
            };
            block.extend([left, right]);
        }
        sender
            .send(block)
            .map_err(|_| "mock audio writer disconnected".to_string())?;
        offset += block_frames;
    }
    Ok(())
}

fn write_samples(
    mut writer: WavWriter<BufWriter<File>>,
    receiver: Receiver<Vec<f32>>,
) -> Result<WriterStats, String> {
    let mut stats = WriterStats::default();
    for block in receiver {
        if block.is_empty() {
            break;
        }
        for sample in block {
            writer
                .write_sample(sample)
                .map_err(|error| format!("could not write WAV sample: {error}"))?;
            let magnitude = sample.abs();
            stats.peak = stats.peak.max(magnitude);
            stats.squared_sum += f64::from(sample) * f64::from(sample);
            stats.clipped_samples += u64::from(magnitude >= 0.999);
            stats.samples += 1;
        }
    }
    writer
        .finalize()
        .map_err(|error| format!("could not finalize WAV header: {error}"))?;
    Ok(stats)
}

fn write_json_atomic(partial_path: &Path, final_path: &Path, value: &Value) -> Result<(), String> {
    let mut file = File::create(partial_path).map_err(|error| {
        format!(
            "could not create metadata partial {}: {error}",
            partial_path.display()
        )
    })?;
    serde_json::to_writer_pretty(&mut file, value)
        .map_err(|error| format!("could not encode recording metadata: {error}"))?;
    file.write_all(b"\n")
        .map_err(|error| format!("could not terminate recording metadata: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("could not sync recording metadata: {error}"))?;
    fs::rename(partial_path, final_path).map_err(|error| {
        format!(
            "could not atomically finalize metadata {}: {error}",
            final_path.display()
        )
    })
}

fn stale_partial_files(directory: &Path) -> Result<Vec<String>, String> {
    let mut files = fs::read_dir(directory)
        .map_err(|error| format!("could not inspect audio output directory: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".partial"))
        })
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
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

fn sample_format_name(format: SampleFormat) -> String {
    format!("{format:?}").to_ascii_lowercase()
}

fn frames_for_duration(sample_rate: u32, milliseconds: u64) -> u64 {
    u64::from(sample_rate) * milliseconds / 1_000
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
        "recording-{}-{:09}",
        duration.as_secs(),
        duration.subsec_nanos()
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_mock_capture_writes_valid_wav_and_sidecar() {
        let directory = test_directory("bounded");
        let mut service = AudioService::new(
            AudioMode::Mock,
            directory.clone(),
            "Analog Rytm".to_string(),
        );
        let result = service
            .capture_pattern_audio(
                CapturePatternAudioRequest {
                    recording_id: Some("tone".to_string()),
                    device_name: None,
                    snapshot_id: Some("snapshot-1".to_string()),
                    duration_ms: 250,
                    mock_signal: MockSignal::Tone,
                },
                context(),
            )
            .unwrap();

        assert_eq!(result["status"], "completed");
        assert_eq!(result["audio"]["frames"], 12_000);
        assert_eq!(result["analysis"]["durationWithinTolerance"], true);
        assert_eq!(result["analysis"]["silence"], false);
        assert_eq!(result["snapshotId"], "snapshot-1");
        let reader = hound::WavReader::open(directory.join("tone.wav")).unwrap();
        assert_eq!(reader.spec().channels, OUTPUT_CHANNELS);
        assert_eq!(reader.spec().sample_rate, PREFERRED_SAMPLE_RATE);
        assert_eq!(reader.duration(), 12_000);
        assert!(directory.join("tone.json").is_file());
        assert!(!directory.join("tone.wav.partial").exists());
        assert!(!directory.join("tone.json.partial").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn start_and_stop_use_the_same_atomic_writer_path() {
        let directory = test_directory("start-stop");
        let mut service = AudioService::new(
            AudioMode::Mock,
            directory.clone(),
            "Analog Rytm".to_string(),
        );
        let started = service
            .start_recording(
                StartRecordingRequest {
                    recording_id: Some("manual".to_string()),
                    device_name: None,
                    snapshot_id: None,
                    expected_duration_ms: None,
                    mock_signal: MockSignal::Tone,
                },
                context(),
            )
            .unwrap();
        assert_eq!(started["status"], "recording");
        let replayed = service
            .start_recording(
                StartRecordingRequest {
                    recording_id: Some("manual".to_string()),
                    device_name: None,
                    snapshot_id: None,
                    expected_duration_ms: None,
                    mock_signal: MockSignal::Tone,
                },
                context(),
            )
            .unwrap();
        assert_eq!(replayed, started);
        let conflict = service
            .start_recording(
                StartRecordingRequest {
                    recording_id: Some("manual".to_string()),
                    device_name: None,
                    snapshot_id: Some("different".to_string()),
                    expected_duration_ms: None,
                    mock_signal: MockSignal::Tone,
                },
                context(),
            )
            .unwrap_err();
        assert!(conflict.contains("different start parameters"));
        assert!(directory.join("manual.wav.partial").is_file());
        let stopped = service
            .stop_recording(StopRecordingRequest {
                recording_id: "manual".to_string(),
            })
            .unwrap();
        assert_eq!(stopped["audio"]["frames"], DEFAULT_MOCK_FRAMES);
        assert!(directory.join("manual.wav").is_file());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn start_and_stop_honor_an_expected_duration() {
        let directory = test_directory("expected-duration");
        let mut service = AudioService::new(
            AudioMode::Mock,
            directory.clone(),
            "Analog Rytm".to_string(),
        );
        service
            .start_recording(
                StartRecordingRequest {
                    recording_id: Some("expected".to_string()),
                    device_name: None,
                    snapshot_id: None,
                    expected_duration_ms: Some(125),
                    mock_signal: MockSignal::Tone,
                },
                context(),
            )
            .unwrap();
        let stopped = service
            .stop_recording(StopRecordingRequest {
                recording_id: "expected".to_string(),
            })
            .unwrap();
        assert_eq!(stopped["audio"]["frames"], 6_000);
        assert_eq!(stopped["analysis"]["expectedDurationMs"], 125);
        assert_eq!(stopped["analysis"]["durationWithinTolerance"], true);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn signal_analysis_reports_silence_clipping_and_disconnects() {
        let directory = test_directory("analysis");
        let mut service = AudioService::new(
            AudioMode::Mock,
            directory.clone(),
            "Analog Rytm".to_string(),
        );
        let silence = service
            .capture_pattern_audio(capture_request("silence", MockSignal::Silence), context())
            .unwrap();
        assert_eq!(silence["analysis"]["silence"], true);

        let clipped = service
            .capture_pattern_audio(capture_request("clipped", MockSignal::Clipped), context())
            .unwrap();
        assert_eq!(clipped["analysis"]["clipping"], true);
        assert!(clipped["analysis"]["clippedSamples"].as_u64().unwrap() > 0);

        let disconnected = service
            .capture_pattern_audio(
                capture_request("disconnected", MockSignal::Disconnect),
                context(),
            )
            .unwrap();
        assert_eq!(disconnected["status"], "failed");
        assert_eq!(disconnected["analysis"]["disconnected"], true);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn inventory_reports_stale_partial_files_and_mock_capabilities() {
        let directory = test_directory("inventory");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("interrupted.wav.partial"), b"partial").unwrap();
        let service = AudioService::new(
            AudioMode::Mock,
            directory.clone(),
            "Analog Rytm".to_string(),
        );
        let inventory = service.list_inputs().unwrap();
        assert_eq!(
            inventory.inputs[0]
                .default_config
                .as_ref()
                .unwrap()
                .channels,
            2
        );
        assert_eq!(inventory.stale_partial_files.len(), 1);
        assert!(inventory.stale_partial_files[0].ends_with("interrupted.wav.partial"));
        fs::remove_dir_all(directory).unwrap();
    }

    fn capture_request(recording_id: &str, mock_signal: MockSignal) -> CapturePatternAudioRequest {
        CapturePatternAudioRequest {
            recording_id: Some(recording_id.to_string()),
            device_name: None,
            snapshot_id: None,
            duration_ms: 100,
            mock_signal,
        }
    }

    fn context() -> RecordingContext {
        RecordingContext {
            device_model: "Analog Rytm MKII".to_string(),
            pattern: "A01".to_string(),
            kit: json!({ "index": 0, "name": "MOCK KIT" }),
            revision: 7,
            tempo: 123.0,
            routing: json!({ "usbOut": "Stereo" }),
        }
    }

    fn test_directory(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "analog-rytm-audio-{label}-{}-{nanos}",
            std::process::id()
        ))
    }
}
