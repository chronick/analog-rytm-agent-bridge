//! Hardware certification support tool for the maintained `rytm-rs` fork's Song
//! codec: it records work-buffer Song position transitions while an operator
//! makes front-panel edits, so byte-level field meanings can be attributed. It
//! lives in the bridge, not in the fork: this is agent-workflow tooling, not a
//! codec.
//!
//! This tool is read-only against the device in every mode -- it only issues
//! work-buffer Song queries and never writes to the device. It has no
//! `--execute` flag for that reason; the sibling `certify_macro_codecs` and
//! `certify_song_codec` tools are the ones where `--execute` writes to the work
//! buffer and then restores it.
//!
//! See `docs/CODEC_CERTIFICATION.md`.

use anyhow::{anyhow, Context, Result};
use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use rytm_rs::prelude::*;
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DEFAULT_PORT_MATCH: &str = "Elektron Analog Rytm MKII";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);

struct MidiSession {
    _input: MidiInputConnection<()>,
    output: MidiOutputConnection,
    receiver: Receiver<Vec<u8>>,
    input_name: String,
    output_name: String,
}

impl MidiSession {
    fn open(port_match: &str) -> Result<Self> {
        let mut input = MidiInput::new("rytm-rs-song-transition-input")?;
        input.ignore(Ignore::None);
        let input_port = input
            .ports()
            .into_iter()
            .find(|port| {
                input
                    .port_name(port)
                    .is_ok_and(|name| name.contains(port_match))
            })
            .ok_or_else(|| anyhow!("no MIDI input contains {port_match:?}"))?;
        let input_name = input.port_name(&input_port)?;

        let output = MidiOutput::new("rytm-rs-song-transition-output")?;
        let output_port = output
            .ports()
            .into_iter()
            .find(|port| {
                output
                    .port_name(port)
                    .is_ok_and(|name| name.contains(port_match))
            })
            .ok_or_else(|| anyhow!("no MIDI output contains {port_match:?}"))?;
        let output_name = output.port_name(&output_port)?;

        let (sender, receiver) = mpsc::channel();
        let input_connection = input
            .connect(
                &input_port,
                "rytm-rs-song-transition-input",
                move |_stamp, message, _| {
                    let _ = sender.send(message.to_vec());
                },
                (),
            )
            .map_err(|error| anyhow!(error.to_string()))?;
        let output_connection = output
            .connect(&output_port, "rytm-rs-song-transition-output")
            .map_err(|error| anyhow!(error.to_string()))?;

        Ok(Self {
            _input: input_connection,
            output: output_connection,
            receiver,
            input_name,
            output_name,
        })
    }

    fn query_song(&mut self) -> Result<RawSysexObject> {
        while self.receiver.try_recv().is_ok() {}
        self.output
            .send(&SongQuery::new_targeting_work_buffer().as_sysex()?)
            .map_err(|error| anyhow!(error.to_string()))?;
        Ok(RawSysexObject::from_sysex(&self.receive_sysex()?)?)
    }

    fn receive_sysex(&self) -> Result<Vec<u8>> {
        let deadline = Instant::now() + RESPONSE_TIMEOUT;
        let mut response = Vec::new();
        let mut receiving = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(anyhow!("timed out waiting for a complete SysEx response"));
            }
            let message = match self.receiver.recv_timeout(remaining) {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => {
                    return Err(anyhow!("timed out waiting for a SysEx response"));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(anyhow!("MIDI input disconnected while waiting for SysEx"));
                }
            };
            for byte in message {
                if byte >= 0xF8 {
                    continue;
                }
                if !receiving {
                    if byte != 0xF0 {
                        continue;
                    }
                    receiving = true;
                }
                response.push(byte);
                if byte == 0xF7 {
                    return Ok(response);
                }
            }
        }
    }
}

fn main() -> Result<()> {
    let options = Options::parse()?;
    fs::create_dir_all(&options.output_directory).with_context(|| {
        format!(
            "failed to create fixture directory {}",
            options.output_directory.display()
        )
    })?;
    let mut session = MidiSession::open(&options.port_match)?;
    let started = Instant::now();
    let deadline = started + options.duration;
    let mut baseline: Option<Vec<u8>> = None;
    let mut previous: Option<Vec<u8>> = None;
    let mut transitions = Vec::new();

    eprintln!(
        "watching work-buffer Song for {} seconds; make one front-panel edit at a time",
        options.duration.as_secs()
    );
    while Instant::now() < deadline {
        let object = session.query_song()?;
        let decoded = object.decoded_bytes()?;
        if previous.as_ref() != Some(&decoded) {
            let index = transitions.len();
            let previous_changes = changed_bytes(previous.as_deref(), &decoded);
            let baseline_changes = changed_bytes(baseline.as_deref(), &decoded);
            let sysex_file = format!("transition-{index:02}.syx");
            let raw_file = format!("transition-{index:02}.raw");
            fs::write(options.output_directory.join(&sysex_file), object.bytes())?;
            fs::write(options.output_directory.join(&raw_file), &decoded)?;
            let transition = json!({
                "index": index,
                "elapsedMs": started.elapsed().as_millis(),
                "sysexFile": sysex_file,
                "rawFile": raw_file,
                "rawBytes": decoded.len(),
                "fingerprint": fingerprint(&decoded),
                "changesFromPrevious": previous_changes,
                "changesFromBaseline": baseline_changes,
            });
            println!("{}", serde_json::to_string(&transition)?);
            transitions.push(transition);
            baseline.get_or_insert_with(|| decoded.clone());
            previous = Some(decoded);
        }
        thread::sleep(options.interval);
    }

    let manifest = json!({
        "schema": "rytm-rs-song-transitions.v1",
        "capturedAtUnix": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        "device": "Analog Rytm MKII",
        "observedFirmware": options.observed_firmware,
        "midiInput": session.input_name,
        "midiOutput": session.output_name,
        "durationMs": options.duration.as_millis(),
        "intervalMs": options.interval.as_millis(),
        "transitions": transitions,
    });
    fs::write(
        options.output_directory.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    eprintln!("captured {} unique Song states", transitions.len());
    Ok(())
}

fn changed_bytes(previous: Option<&[u8]>, current: &[u8]) -> Vec<serde_json::Value> {
    previous.map_or_else(Vec::new, |previous| {
        previous
            .iter()
            .zip(current)
            .enumerate()
            .filter(|(_, (before, after))| before != after)
            .map(|(offset, (before, after))| {
                json!({
                    "offset": offset,
                    "hexOffset": format!("0x{offset:04X}"),
                    "before": before,
                    "after": after,
                })
            })
            .collect()
    })
}

struct Options {
    output_directory: PathBuf,
    port_match: String,
    observed_firmware: String,
    duration: Duration,
    interval: Duration,
}

impl Options {
    fn parse() -> Result<Self> {
        let mut arguments = std::env::args().skip(1);
        let output_directory = arguments.next().map(PathBuf::from).ok_or_else(|| {
            anyhow!(
                "usage: capture_song_transitions <output-directory> [--duration-seconds <seconds>] [--interval-ms <milliseconds>] [--port-match <name>] [--observed-firmware <version>]\n\
                 example: daemon/tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD"
            )
        })?;
        let mut port_match = DEFAULT_PORT_MATCH.to_string();
        let mut observed_firmware = "unknown-not-reported-by-device-identity".to_string();
        let mut duration = Duration::from_secs(180);
        let mut interval = Duration::from_millis(400);
        while let Some(option) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| anyhow!("missing value for {option}"))?;
            match option.as_str() {
                "--port-match" => port_match = value,
                "--observed-firmware" => observed_firmware = value,
                "--duration-seconds" => duration = Duration::from_secs(value.parse()?),
                "--interval-ms" => interval = Duration::from_millis(value.parse()?),
                _ => return Err(anyhow!("unknown option {option:?}")),
            }
        }
        Ok(Self {
            output_directory,
            port_match,
            observed_firmware,
            duration,
            interval,
        })
    }
}

fn fingerprint(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    format!("fnv1a64:{hash:016x}")
}
