use crate::state::PersistentOperation;
use hound::{SampleFormat, WavReader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const SAMPLE_SCHEMA: &str = "analog-rytm-samples.v1";
const DEFAULT_DEVICE_DIRECTORY: &str = "/agent-bridge";
const RAM_SLOT_MIN: u8 = 1;
const RAM_SLOT_MAX: u8 = 127;
const TARGET_SAMPLE_RATE: u32 = 48_000;
const TARGET_CHANNELS: u16 = 1;
const TARGET_BITS_PER_SAMPLE: u16 = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SampleMode {
    Mock,
    Hardware,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedSample {
    sample_id: String,
    device_path: String,
    device_checksum: String,
    device_size: String,
    source_path: String,
    source_sha256: String,
    canonical_sha256: String,
    uploaded_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleRegistry {
    schema: String,
    samples: BTreeMap<String, ManagedSample>,
    ram_slots: BTreeMap<u8, String>,
}

impl Default for SampleRegistry {
    fn default() -> Self {
        Self {
            schema: SAMPLE_SCHEMA.to_string(),
            samples: BTreeMap::new(),
            ram_slots: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveEntry {
    pub kind: &'static str,
    pub name: String,
    pub device_path: String,
    pub size: String,
    pub size_bytes_approximate: u64,
    pub checksum: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RamSlot {
    pub slot: u8,
    pub occupied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_path: Option<String>,
    pub used_by_track: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAssignment {
    pub track: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_path: Option<String>,
}

#[derive(Clone, Debug)]
struct SourceAudio {
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    sample_format: &'static str,
    frames: u32,
    sha256: String,
}

pub struct SampleService {
    mode: SampleMode,
    cli_path: PathBuf,
    port_match: String,
    state_path: Option<PathBuf>,
    registry: SampleRegistry,
}

impl SampleService {
    pub fn mock() -> Self {
        Self {
            mode: SampleMode::Mock,
            cli_path: PathBuf::new(),
            port_match: "mock".to_string(),
            state_path: None,
            registry: SampleRegistry::default(),
        }
    }

    pub fn hardware(state_path: &Path, port_match: &str) -> Result<Self, String> {
        let cli_path = std::env::var_os("ANALOG_RYTM_ELEKTROID_CLI")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("elektroid-cli"));
        let sample_state_path = state_path.with_file_name("sample-state.json");
        let registry = load_registry(&sample_state_path)?;
        Ok(Self {
            mode: SampleMode::Hardware,
            cli_path,
            port_match: port_match.to_string(),
            state_path: Some(sample_state_path),
            registry,
        })
    }

    pub fn inspect(&mut self, params: &Value) -> Result<Value, String> {
        let drive_path = optional_string(params, "drivePath")?.unwrap_or("/");
        validate_device_path(drive_path, "drivePath")?;
        let include_ram = optional_bool(params, "includeRam")?.unwrap_or(true);
        let include_tracks = optional_bool(params, "includeTracks")?.unwrap_or(false);

        let (entries, ram_slots, tracks, adapter) = match self.mode {
            SampleMode::Mock => (
                self.mock_drive_entries(drive_path),
                self.mock_ram_slots(),
                Vec::new(),
                "mock",
            ),
            SampleMode::Hardware => {
                let device = self.resolve_device()?;
                let entries = self.hardware_drive_entries(device, drive_path)?;
                let ram = if include_ram {
                    self.hardware_ram_slots(device)?
                } else {
                    Vec::new()
                };
                let tracks = if include_tracks {
                    self.hardware_track_assignments(device)?
                } else {
                    Vec::new()
                };
                (entries, ram, tracks, "elektroid")
            }
        };
        if include_ram {
            self.reconcile_ram_registry(&ram_slots)?;
        }
        let occupied = ram_slots.iter().filter(|slot| slot.occupied).count();
        Ok(json!({
            "adapter": adapter,
            "drivePath": normalize_device_path(drive_path),
            "entries": entries,
            "ram": {
                "capacity": RAM_SLOT_MAX,
                "occupied": occupied,
                "free": usize::from(RAM_SLOT_MAX) - occupied,
                "slots": ram_slots,
            },
            "tracks": tracks,
            "identity": {
                "sampleId": "sha256(canonicalWavSha256,devicePath,deviceChecksum)",
                "deviceChecksum": "Elektron inventory checksum",
                "size": "Elektroid display size; sizeBytesApproximate is rounded",
            },
            "rollback": {
                "soundAssignment": "covered by bridge snapshots",
                "ramLoad": "identity-guarded clear is available",
                "driveUpload": "not automatically deleted by snapshot rollback",
            }
        }))
    }

    pub fn upload(&mut self, params: &Value) -> Result<Value, String> {
        let source_path = required_string(params, "sourcePath")?;
        let source_path = Path::new(source_path);
        let source = inspect_source(source_path)?;
        let directory =
            optional_string(params, "deviceDirectory")?.unwrap_or(DEFAULT_DEVICE_DIRECTORY);
        validate_device_path(directory, "deviceDirectory")?;
        if directory == "/" {
            return Err("deviceDirectory must not be the +Drive root".to_string());
        }
        let default_name = source_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "sourcePath must have a UTF-8 file name".to_string())?;
        let name = optional_string(params, "name")?.unwrap_or(default_name);
        validate_sample_name(name)?;
        let device_path = join_device_path(directory, name);

        if let Some(existing) = self.registry.samples.values().find(|sample| {
            sample.device_path == device_path && sample.source_sha256 == source.sha256
        }) {
            if self.mode == SampleMode::Mock
                || self.device_entry_matches(existing, directory, name)?
            {
                return Ok(upload_result(existing, &source, "already-present", false));
            }
        }

        match self.mode {
            SampleMode::Mock => {
                if self
                    .registry
                    .samples
                    .values()
                    .any(|sample| sample.device_path == device_path)
                {
                    return Err(format!(
                        "device sample path {device_path:?} is already managed by different content"
                    ));
                }
                let checksum = source.sha256[..8].to_string();
                let sample_id = stable_sample_id(&source.sha256, &device_path, &checksum);
                let managed = ManagedSample {
                    sample_id: sample_id.clone(),
                    device_path,
                    device_checksum: checksum,
                    device_size: format!(
                        "{}B",
                        fs::metadata(source_path).map_err(error_string)?.len()
                    ),
                    source_path: source_path.display().to_string(),
                    source_sha256: source.sha256.clone(),
                    canonical_sha256: source.sha256.clone(),
                    uploaded_at: timestamp(),
                };
                self.registry.samples.insert(sample_id, managed.clone());
                self.persist()?;
                Ok(upload_result(
                    &managed,
                    &source,
                    "uploaded-and-verified",
                    true,
                ))
            }
            SampleMode::Hardware => self.upload_hardware(source_path, source, directory, name),
        }
    }

    pub fn resolve_ram(&mut self, params: &Value) -> Result<Value, String> {
        let sample_id = required_string(params, "sampleId")?;
        validate_safe_id(sample_id, "sampleId")?;
        let requested_slot = optional_u8(params, "slot")?;
        if let Some(slot) = requested_slot {
            validate_ram_slot(slot)?;
        }
        let sample = self
            .registry
            .samples
            .get(sample_id)
            .cloned()
            .ok_or_else(|| format!("unknown sampleId: {sample_id}"))?;
        let slots = match self.mode {
            SampleMode::Mock => self.mock_ram_slots(),
            SampleMode::Hardware => {
                let device = self.resolve_device()?;
                self.hardware_ram_slots(device)?
            }
        };
        if let Some(existing) = slots
            .iter()
            .find(|slot| slot.device_path.as_deref() == Some(sample.device_path.as_str()))
        {
            if requested_slot.is_some_and(|slot| slot != existing.slot) {
                return Err(format!(
                    "sampleId {sample_id:?} is already loaded in RAM slot {}; refusing duplicate slot {}",
                    existing.slot,
                    requested_slot.expect("requested slot was checked")
                ));
            }
            self.registry
                .ram_slots
                .insert(existing.slot, sample_id.to_string());
            self.persist()?;
            return Ok(ram_result(
                sample_id,
                &sample.device_path,
                existing.slot,
                "already-resolved",
            ));
        }
        let slot = match requested_slot {
            Some(slot) => {
                let observed = slots
                    .iter()
                    .find(|entry| entry.slot == slot)
                    .ok_or_else(|| format!("RAM inventory omitted slot {slot}"))?;
                if observed.occupied {
                    return Err(format!(
                        "RAM slot {slot} is occupied by {}; explicit clear is required before replacement",
                        observed.device_path.as_deref().unwrap_or("an unresolved sample")
                    ));
                }
                slot
            }
            None => slots
                .iter()
                .find(|entry| !entry.occupied)
                .map(|entry| entry.slot)
                .ok_or_else(|| "Rytm sample RAM is full; no slot can be allocated".to_string())?,
        };

        if self.mode == SampleMode::Hardware {
            let device = self.resolve_device()?;
            self.run_cli(&[
                "-k".to_string(),
                "elektron:ram:cp".to_string(),
                format!("{device}:{}", sample.device_path),
                format!("{device}:/{slot}"),
            ])?;
            let observed = self.hardware_ram_slots(device)?;
            let verified = observed.iter().find(|entry| entry.slot == slot);
            if verified.and_then(|entry| entry.device_path.as_deref())
                != Some(sample.device_path.as_str())
            {
                return Err(format!(
                    "RAM slot {slot} readback did not resolve to {:?}",
                    sample.device_path
                ));
            }
        }
        self.registry.ram_slots.insert(slot, sample_id.to_string());
        self.persist()?;
        Ok(ram_result(
            sample_id,
            &sample.device_path,
            slot,
            "loaded-and-verified",
        ))
    }

    pub fn clear_ram(&mut self, params: &Value) -> Result<Value, String> {
        let sample_id = required_string(params, "sampleId")?;
        let slot = required_u8(params, "slot")?;
        validate_safe_id(sample_id, "sampleId")?;
        validate_ram_slot(slot)?;
        let sample = self
            .registry
            .samples
            .get(sample_id)
            .cloned()
            .ok_or_else(|| format!("unknown sampleId: {sample_id}"))?;
        let observed = match self.mode {
            SampleMode::Mock => self.mock_ram_slots(),
            SampleMode::Hardware => {
                let device = self.resolve_device()?;
                self.hardware_ram_slots(device)?
            }
        };
        let current = observed
            .iter()
            .find(|entry| entry.slot == slot)
            .ok_or_else(|| format!("RAM inventory omitted slot {slot}"))?;
        if !current.occupied {
            self.registry.ram_slots.remove(&slot);
            self.persist()?;
            return Ok(json!({ "status": "already-empty", "slot": slot, "sampleId": sample_id }));
        }
        if current.used_by_track {
            return Err(format!(
                "RAM slot {slot} is still assigned to a track; restore or reassign the Sound before clearing it"
            ));
        }
        if current.device_path.as_deref() != Some(sample.device_path.as_str()) {
            return Err(format!(
                "RAM slot {slot} contains {}; refusing to clear it for sampleId {sample_id:?}",
                current
                    .device_path
                    .as_deref()
                    .unwrap_or("an unresolved sample")
            ));
        }
        if self.mode == SampleMode::Hardware {
            let device = self.resolve_device()?;
            self.run_cli(&[
                "-k".to_string(),
                "elektron:ram:cl".to_string(),
                format!("{device}:/{slot}"),
            ])?;
            let verified = self.hardware_ram_slots(device)?;
            if verified
                .iter()
                .find(|entry| entry.slot == slot)
                .is_none_or(|entry| entry.occupied)
            {
                return Err(format!("RAM slot {slot} remained occupied after clear"));
            }
        }
        self.registry.ram_slots.remove(&slot);
        self.persist()?;
        Ok(json!({
            "status": "cleared-and-verified",
            "slot": slot,
            "sampleId": sample_id,
            "devicePath": sample.device_path,
            "driveSampleRetained": true,
        }))
    }

    pub fn validate_assignments(
        &mut self,
        operations: &[PersistentOperation],
    ) -> Result<(), String> {
        let assignments = operations
            .iter()
            .filter_map(|operation| match operation {
                PersistentOperation::AssignSampleSlot {
                    slot, sample_id, ..
                } => Some((*slot, sample_id.as_str())),
                _ => None,
            })
            .collect::<Vec<_>>();
        if assignments.is_empty() {
            return Ok(());
        }
        let slots = match self.mode {
            SampleMode::Mock => self.mock_ram_slots(),
            SampleMode::Hardware => {
                let device = self.resolve_device()?;
                self.hardware_ram_slots(device)?
            }
        };
        for (slot, sample_id) in assignments {
            validate_ram_slot(slot)?;
            let sample =
                self.registry.samples.get(sample_id).ok_or_else(|| {
                    format!("unknown sampleId in assign_sample_slot: {sample_id}")
                })?;
            let observed = slots
                .iter()
                .find(|entry| entry.slot == slot)
                .ok_or_else(|| format!("RAM inventory omitted slot {slot}"))?;
            if observed.device_path.as_deref() != Some(sample.device_path.as_str()) {
                return Err(format!(
                    "assign_sample_slot identity mismatch: slot {slot} contains {}, expected sampleId {sample_id:?} at {:?}",
                    observed.device_path.as_deref().unwrap_or("no sample"),
                    sample.device_path
                ));
            }
        }
        Ok(())
    }

    fn upload_hardware(
        &mut self,
        source_path: &Path,
        source: SourceAudio,
        directory: &str,
        name: &str,
    ) -> Result<Value, String> {
        let device = self.resolve_device()?;
        self.ensure_hardware_directory(device, directory)?;
        if self
            .hardware_drive_entries(device, directory)?
            .iter()
            .any(|entry| entry.name == name)
        {
            return Err(format!(
                "device sample path {:?} already exists without a matching managed source digest",
                join_device_path(directory, name)
            ));
        }
        let state_directory = self
            .state_path
            .as_deref()
            .and_then(Path::parent)
            .ok_or_else(|| "sample state directory is unavailable".to_string())?;
        let staging = state_directory.join("sample-staging");
        fs::create_dir_all(&staging).map_err(error_string)?;
        let staged_source = staging.join(format!("{name}.wav"));
        fs::copy(source_path, &staged_source).map_err(error_string)?;
        self.run_cli(&[
            "-k".to_string(),
            "elektron:sample:ul".to_string(),
            staged_source.display().to_string(),
            format!("{device}:{}", normalize_device_path(directory)),
        ])?;
        let entry = self
            .hardware_drive_entries(device, directory)?
            .into_iter()
            .find(|entry| entry.kind == "file" && entry.name == name)
            .ok_or_else(|| format!("uploaded sample {name:?} was absent from +Drive readback"))?;
        let verification_directory = state_directory
            .join("sample-verification")
            .join(&source.sha256[..16]);
        if verification_directory.exists() {
            fs::remove_dir_all(&verification_directory).map_err(error_string)?;
        }
        fs::create_dir_all(&verification_directory).map_err(error_string)?;
        self.run_cli(&[
            "-k".to_string(),
            "elektron:sample:dl".to_string(),
            format!("{device}:{}", entry.device_path),
            verification_directory.display().to_string(),
        ])?;
        let downloaded = verification_directory.join(format!("{name}.wav"));
        let canonical = inspect_source(&downloaded)?;
        if canonical.channels != TARGET_CHANNELS
            || canonical.sample_rate != TARGET_SAMPLE_RATE
            || canonical.bits_per_sample != TARGET_BITS_PER_SAMPLE
            || canonical.sample_format != "int"
        {
            return Err("downloaded Rytm sample did not match mono 48kHz PCM16".to_string());
        }
        let sample_id = stable_sample_id(&canonical.sha256, &entry.device_path, &entry.checksum);
        let managed = ManagedSample {
            sample_id: sample_id.clone(),
            device_path: entry.device_path,
            device_checksum: entry.checksum,
            device_size: entry.size,
            source_path: source_path.display().to_string(),
            source_sha256: source.sha256.clone(),
            canonical_sha256: canonical.sha256,
            uploaded_at: timestamp(),
        };
        self.registry.samples.insert(sample_id, managed.clone());
        self.persist()?;
        Ok(upload_result(
            &managed,
            &source,
            "uploaded-and-verified",
            true,
        ))
    }

    fn ensure_hardware_directory(&self, device: usize, directory: &str) -> Result<(), String> {
        let mut parent = "/".to_string();
        for segment in directory.split('/').filter(|segment| !segment.is_empty()) {
            let entries = self.hardware_drive_entries(device, &parent)?;
            let next = join_device_path(&parent, segment);
            match entries.iter().find(|entry| entry.name == segment) {
                Some(entry) if entry.kind == "directory" => {}
                Some(_) => return Err(format!("device path {next:?} is not a directory")),
                None => {
                    self.run_cli(&[
                        "-k".to_string(),
                        "elektron:sample:mkdir".to_string(),
                        format!("{device}:{next}"),
                    ])?;
                }
            }
            parent = next;
        }
        Ok(())
    }

    fn device_entry_matches(
        &self,
        sample: &ManagedSample,
        directory: &str,
        name: &str,
    ) -> Result<bool, String> {
        let device = self.resolve_device()?;
        Ok(self
            .hardware_drive_entries(device, directory)?
            .iter()
            .any(|entry| {
                entry.name == name
                    && entry.checksum == sample.device_checksum
                    && entry.size == sample.device_size
            }))
    }

    fn resolve_device(&self) -> Result<usize, String> {
        let output = self.run_cli(&["-k".to_string(), "ld".to_string()])?;
        output
            .lines()
            .filter_map(parse_device_line)
            .find(|(_, identity)| identity.contains(&self.port_match))
            .map(|(index, _)| index)
            .ok_or_else(|| {
                format!(
                    "elektroid-cli found no MIDI device containing {:?}",
                    self.port_match
                )
            })
    }

    fn hardware_drive_entries(
        &self,
        device: usize,
        directory: &str,
    ) -> Result<Vec<DriveEntry>, String> {
        let directory = normalize_device_path(directory);
        let output = self.run_cli(&[
            "-k".to_string(),
            "elektron:sample:ls".to_string(),
            format!("{device}:{directory}"),
        ])?;
        parse_drive_inventory(&output, &directory, &self.registry)
    }

    fn hardware_ram_slots(&self, device: usize) -> Result<Vec<RamSlot>, String> {
        let output = self.run_cli(&[
            "-k".to_string(),
            "elektron:ram:ls".to_string(),
            format!("{device}:/"),
        ])?;
        parse_ram_inventory(&output, &self.registry)
    }

    fn hardware_track_assignments(&self, device: usize) -> Result<Vec<TrackAssignment>, String> {
        let output = self.run_cli(&[
            "-k".to_string(),
            "elektron:track:ls".to_string(),
            format!("{device}:/"),
        ])?;
        parse_track_inventory(&output)
    }

    fn run_cli(&self, args: &[String]) -> Result<String, String> {
        let output = Command::new(&self.cli_path).args(args).output().map_err(|error| {
            format!(
                "could not execute elektroid-cli at {:?}: {error}; build chronick/elektroid commit 681fa8c or set ANALOG_RYTM_ELEKTROID_CLI",
                self.cli_path
            )
        })?;
        let stdout = String::from_utf8(output.stdout)
            .map_err(|error| format!("elektroid-cli stdout was not UTF-8: {error}"))?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        let errors = stderr
            .lines()
            .filter(|line| {
                !line.contains("audio_rtaudio.c:256:audio_init_int")
                    && !is_progress_line(line)
                    && !line.trim().is_empty()
            })
            .collect::<Vec<_>>();
        if !output.status.success() || !errors.is_empty() {
            return Err(format!(
                "elektroid-cli {} failed{}{}",
                args.join(" "),
                if errors.is_empty() { "" } else { ": " },
                errors.join("; ")
            ));
        }
        Ok(stdout)
    }

    fn mock_drive_entries(&self, directory: &str) -> Vec<DriveEntry> {
        let directory = normalize_device_path(directory);
        self.registry
            .samples
            .values()
            .filter_map(|sample| {
                let (parent, name) = split_device_path(&sample.device_path);
                (parent == directory).then(|| DriveEntry {
                    kind: "file",
                    name,
                    device_path: sample.device_path.clone(),
                    size: sample.device_size.clone(),
                    size_bytes_approximate: parse_human_size(&sample.device_size).unwrap_or(0),
                    checksum: sample.device_checksum.clone(),
                    sample_id: Some(sample.sample_id.clone()),
                })
            })
            .collect()
    }

    fn mock_ram_slots(&self) -> Vec<RamSlot> {
        (RAM_SLOT_MIN..=RAM_SLOT_MAX)
            .map(|slot| {
                let sample_id = self.registry.ram_slots.get(&slot).cloned();
                let device_path = sample_id
                    .as_ref()
                    .and_then(|id| self.registry.samples.get(id))
                    .map(|sample| sample.device_path.clone());
                RamSlot {
                    slot,
                    occupied: device_path.is_some(),
                    device_path,
                    used_by_track: false,
                    sample_id,
                }
            })
            .collect()
    }

    fn reconcile_ram_registry(&mut self, slots: &[RamSlot]) -> Result<(), String> {
        self.registry.ram_slots.clear();
        for slot in slots {
            if let Some(sample_id) = &slot.sample_id {
                self.registry.ram_slots.insert(slot.slot, sample_id.clone());
            }
        }
        self.persist()
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = &self.state_path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(error_string)?;
        }
        let temporary = path.with_extension("json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&self.registry).map_err(error_string)?,
        )
        .map_err(error_string)?;
        fs::rename(&temporary, path).map_err(error_string)
    }
}

fn parse_device_line(line: &str) -> Option<(usize, String)> {
    let (index, rest) = line.split_once(':')?;
    Some((index.trim().parse().ok()?, rest.trim().to_string()))
}

fn is_progress_line(line: &str) -> bool {
    line.rsplit_once(':')
        .and_then(|(_, value)| value.trim().strip_suffix('%'))
        .and_then(|value| value.trim().parse::<u8>().ok())
        .is_some_and(|percent| percent <= 100)
}

fn parse_drive_inventory(
    output: &str,
    directory: &str,
    registry: &SampleRegistry,
) -> Result<Vec<DriveEntry>, String> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut columns = line.split_whitespace();
            let entry_type = columns
                .next()
                .ok_or_else(|| format!("invalid +Drive inventory line: {line:?}"))?;
            let size = columns
                .next()
                .ok_or_else(|| format!("missing +Drive size: {line:?}"))?;
            let checksum = columns
                .next()
                .ok_or_else(|| format!("missing +Drive checksum: {line:?}"))?;
            let name = columns.collect::<Vec<_>>().join(" ");
            if name.is_empty() {
                return Err(format!("missing +Drive name: {line:?}"));
            }
            let device_path = join_device_path(directory, &name);
            let sample_id = registry
                .samples
                .values()
                .find(|sample| {
                    sample.device_path == device_path && sample.device_checksum == checksum
                })
                .map(|sample| sample.sample_id.clone());
            Ok(DriveEntry {
                kind: match entry_type {
                    "F" => "file",
                    "D" => "directory",
                    _ => return Err(format!("unknown +Drive entry type in {line:?}")),
                },
                name,
                device_path,
                size: size.to_string(),
                size_bytes_approximate: parse_human_size(size)?,
                checksum: checksum.to_string(),
                sample_id,
            })
        })
        .collect()
}

fn parse_ram_inventory(output: &str, registry: &SampleRegistry) -> Result<Vec<RamSlot>, String> {
    let mut slots = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.first() != Some(&"F") || columns.len() < 2 {
            return Err(format!("invalid RAM inventory line: {line:?}"));
        }
        let (slot_column, path_start) = if columns[1].parse::<u8>().is_ok() {
            (1, 2)
        } else {
            (2, 3)
        };
        let slot = columns
            .get(slot_column)
            .and_then(|value| value.parse::<u8>().ok())
            .ok_or_else(|| format!("invalid RAM slot in line: {line:?}"))?;
        validate_ram_slot(slot)?;
        let info_start = columns[path_start..]
            .iter()
            .position(|column| *column == "[")
            .map_or(columns.len(), |index| path_start + index);
        let path = columns[path_start..info_start].join(" ");
        let device_path = (!path.is_empty()).then_some(path);
        let sample_id = device_path.as_ref().and_then(|path| {
            registry
                .samples
                .values()
                .find(|sample| sample.device_path == *path)
                .map(|sample| sample.sample_id.clone())
        });
        slots.push(RamSlot {
            slot,
            occupied: device_path.is_some(),
            device_path,
            used_by_track: columns.contains(&"used"),
            sample_id,
        });
    }
    if slots.len() != usize::from(RAM_SLOT_MAX) {
        return Err(format!(
            "RAM inventory returned {} slots; expected {}",
            slots.len(),
            RAM_SLOT_MAX
        ));
    }
    Ok(slots)
}

fn parse_track_inventory(output: &str) -> Result<Vec<TrackAssignment>, String> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let columns = line.split_whitespace().collect::<Vec<_>>();
            if columns.first() != Some(&"F") || columns.len() < 3 {
                return Err(format!("invalid track inventory line: {line:?}"));
            }
            let track = columns[2]
                .parse::<u8>()
                .map_err(|_| format!("invalid track number in {line:?}"))?;
            let info = line
                .split_once("[ ")
                .map(|(_, value)| value.trim_end_matches(']').trim());
            let slot = info.and_then(|value| {
                value
                    .split(':')
                    .find_map(|part| part.strip_prefix("slot="))
                    .and_then(|value| value.parse().ok())
            });
            let device_path = info.and_then(|value| {
                value
                    .split_once("path=")
                    .map(|(_, path)| path.trim().to_string())
                    .filter(|path| !path.is_empty())
            });
            Ok(TrackAssignment {
                track,
                slot,
                device_path,
            })
        })
        .collect()
}

fn inspect_source(path: &Path) -> Result<SourceAudio, String> {
    if !path.is_absolute() {
        return Err("sourcePath must be absolute".to_string());
    }
    if path.extension().and_then(|value| value.to_str()) != Some("wav") {
        return Err("sourcePath must reference a .wav file".to_string());
    }
    let metadata = fs::metadata(path).map_err(error_string)?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("sourcePath must reference a non-empty regular file".to_string());
    }
    let reader = WavReader::open(path).map_err(error_string)?;
    let spec = reader.spec();
    let frames = reader.duration();
    if frames == 0 {
        return Err("source WAV contains no audio frames".to_string());
    }
    let bytes = fs::read(path).map_err(error_string)?;
    Ok(SourceAudio {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        bits_per_sample: spec.bits_per_sample,
        sample_format: match spec.sample_format {
            SampleFormat::Int => "int",
            SampleFormat::Float => "float",
        },
        frames,
        sha256: sha256_hex(&bytes),
    })
}

fn upload_result(
    sample: &ManagedSample,
    source: &SourceAudio,
    status: &str,
    transferred: bool,
) -> Value {
    json!({
        "status": status,
        "transferred": transferred,
        "sampleId": sample.sample_id,
        "devicePath": sample.device_path,
        "deviceChecksum": sample.device_checksum,
        "deviceSize": sample.device_size,
        "sourceSha256": sample.source_sha256,
        "canonicalSha256": sample.canonical_sha256,
        "source": {
            "path": sample.source_path,
            "channels": source.channels,
            "sampleRate": source.sample_rate,
            "bitsPerSample": source.bits_per_sample,
            "sampleFormat": source.sample_format,
            "frames": source.frames,
        },
        "conversion": {
            "applied": source.channels != TARGET_CHANNELS
                || source.sample_rate != TARGET_SAMPLE_RATE
                || source.bits_per_sample != TARGET_BITS_PER_SAMPLE
                || source.sample_format != "int",
            "targetChannels": TARGET_CHANNELS,
            "targetSampleRate": TARGET_SAMPLE_RATE,
            "targetBitsPerSample": TARGET_BITS_PER_SAMPLE,
            "targetSampleFormat": "int",
        },
        "verified": ["name", "devicePath", "deviceChecksum", "deviceSize", "canonicalSha256"],
    })
}

fn ram_result(sample_id: &str, device_path: &str, slot: u8, status: &str) -> Value {
    json!({
        "status": status,
        "sampleId": sample_id,
        "devicePath": device_path,
        "slot": slot,
        "verified": true,
    })
}

fn load_registry(path: &Path) -> Result<SampleRegistry, String> {
    if !path.exists() {
        return Ok(SampleRegistry::default());
    }
    let registry: SampleRegistry =
        serde_json::from_slice(&fs::read(path).map_err(error_string)?)
            .map_err(|error| format!("could not decode sample registry {:?}: {error}", path))?;
    if registry.schema != SAMPLE_SCHEMA {
        return Err(format!(
            "unsupported sample registry schema {:?}; expected {SAMPLE_SCHEMA:?}",
            registry.schema
        ));
    }
    Ok(registry)
}

fn stable_sample_id(canonical_sha256: &str, device_path: &str, checksum: &str) -> String {
    let identity = format!("{canonical_sha256}\n{device_path}\n{checksum}");
    format!("sample-{}", &sha256_hex(identity.as_bytes())[..24])
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn parse_human_size(value: &str) -> Result<u64, String> {
    let (number, multiplier) = if let Some(value) = value.strip_suffix("KiB") {
        (value, 1024.0)
    } else if let Some(value) = value.strip_suffix("MiB") {
        (value, 1024.0 * 1024.0)
    } else if let Some(value) = value.strip_suffix("GiB") {
        (value, 1024.0 * 1024.0 * 1024.0)
    } else if let Some(value) = value.strip_suffix('B') {
        (value, 1.0)
    } else {
        return Err(format!("unsupported Elektroid size: {value:?}"));
    };
    let number = number
        .parse::<f64>()
        .map_err(|_| format!("invalid Elektroid size: {value:?}"))?;
    Ok((number * multiplier).round() as u64)
}

fn validate_sample_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 63 {
        return Err("name must contain 1 to 63 bytes".to_string());
    }
    if name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(char::is_control)
    {
        return Err(
            "name may not contain path separators, controls, or start with dot".to_string(),
        );
    }
    Ok(())
}

fn validate_device_path(value: &str, field: &str) -> Result<(), String> {
    if !value.starts_with('/') || value.len() > 255 || value.contains("//") {
        return Err(format!(
            "{field} must be an absolute device path up to 255 bytes"
        ));
    }
    for segment in value.split('/').filter(|segment| !segment.is_empty()) {
        if segment == "."
            || segment == ".."
            || segment.contains('\\')
            || segment.chars().any(char::is_control)
        {
            return Err(format!("{field} contains an unsafe path segment"));
        }
    }
    Ok(())
}

fn validate_ram_slot(slot: u8) -> Result<(), String> {
    if !(RAM_SLOT_MIN..=RAM_SLOT_MAX).contains(&slot) {
        return Err("slot must be an integer between 1 and 127".to_string());
    }
    Ok(())
}

fn validate_safe_id(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("{field} must be a safe identifier"));
    }
    Ok(())
}

fn normalize_device_path(value: &str) -> String {
    if value == "/" {
        "/".to_string()
    } else {
        value.trim_end_matches('/').to_string()
    }
}

fn join_device_path(parent: &str, name: &str) -> String {
    let parent = normalize_device_path(parent);
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn split_device_path(path: &str) -> (String, String) {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    (
        if parent.is_empty() {
            "/".to_string()
        } else {
            parent.to_string()
        },
        name.to_string(),
    )
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    optional_string(value, field)?.ok_or_else(|| format!("params.{field} is required"))
}

fn optional_string<'a>(value: &'a Value, field: &str) -> Result<Option<&'a str>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "params must be a JSON object".to_string())?;
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(format!("params.{field} must be a string")),
    }
}

fn optional_bool(value: &Value, field: &str) -> Result<Option<bool>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "params must be a JSON object".to_string())?;
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("params.{field} must be a boolean")),
    }
}

fn optional_u8(value: &Value, field: &str) -> Result<Option<u8>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "params must be a JSON object".to_string())?;
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_u64()
            .and_then(|value| u8::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| format!("params.{field} must be an integer between 0 and 255")),
        Some(_) => Err(format!("params.{field} must be an integer")),
    }
}

fn required_u8(value: &Value, field: &str) -> Result<u8, String> {
    optional_u8(value, field)?.ok_or_else(|| format!("params.{field} is required"))
}

fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}Z", now.as_secs(), now.subsec_millis())
}

fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_drive_inventory_with_spaced_names() {
        let registry = SampleRegistry::default();
        let entries = parse_drive_inventory(
            "D         0B 00000000 KICKS\nF   85.45KiB cef4153b Kick Dusty\n",
            "/factory",
            &registry,
        )
        .unwrap();
        assert_eq!(entries[0].device_path, "/factory/KICKS");
        assert_eq!(entries[1].name, "Kick Dusty");
        assert_eq!(entries[1].size_bytes_approximate, 87_501);
    }

    #[test]
    fn parses_all_ram_slot_shapes() {
        let mut input = String::new();
        for slot in 1..=127 {
            if slot == 127 {
                input.push_str("F   85.45KiB 127 /factory/KICKS/Kick Dusty [ used ]\n");
            } else {
                input.push_str(&format!("F            {slot:03} \n"));
            }
        }
        let slots = parse_ram_inventory(&input, &SampleRegistry::default()).unwrap();
        assert_eq!(slots.len(), 127);
        assert!(!slots[0].occupied);
        assert_eq!(
            slots[126].device_path.as_deref(),
            Some("/factory/KICKS/Kick Dusty")
        );
        assert!(slots[126].used_by_track);
    }

    #[test]
    fn parses_rytm_track_inventory() {
        let tracks = parse_track_inventory(
            "F            0 1\nF            1 2 [ slot=5:path=/incoming/kick ]\n",
        )
        .unwrap();
        assert_eq!(tracks[0].track, 1);
        assert_eq!(tracks[1].slot, Some(5));
        assert_eq!(tracks[1].device_path.as_deref(), Some("/incoming/kick"));
    }

    #[test]
    fn device_paths_reject_traversal() {
        assert!(validate_device_path("/agent-bridge", "path").is_ok());
        assert!(validate_device_path("/../factory", "path").is_err());
        assert!(validate_device_path("relative", "path").is_err());
    }

    #[test]
    fn sample_ids_are_content_and_path_stable() {
        let first = stable_sample_id("abc", "/agent-bridge/kick", "1234");
        assert_eq!(first, stable_sample_id("abc", "/agent-bridge/kick", "1234"));
        assert_ne!(
            first,
            stable_sample_id("abc", "/agent-bridge/snare", "1234")
        );
    }

    #[test]
    fn accepts_only_bounded_cli_progress_as_nondiagnostic_stderr() {
        assert!(is_progress_line("/tmp/kick.wav:   0 %"));
        assert!(is_progress_line("/tmp/kick.wav: 100 %"));
        assert!(!is_progress_line("/tmp/kick.wav: 101 %"));
        assert!(!is_progress_line("device: transfer failed"));
    }
}
