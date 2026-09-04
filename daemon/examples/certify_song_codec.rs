//! Hardware certification tool for the maintained `rytm-rs` fork's typed Song
//! codec. It lives in the bridge, not in the fork: this is agent-workflow
//! tooling, not a codec.
//!
//! Without `--execute` the tool is read-only: it queries the work-buffer Song,
//! builds the proposed Song in memory, and prints the plan as JSON.
//!
//! With `--execute` it snapshots the work-buffer Song, writes the controlled
//! name, rows, pattern chain, repeats, and per-pattern track mutes, verifies the
//! typed readback, and restores the exact baseline. A rollback failure is
//! reported separately from a certification failure.
//!
//! See `docs/CODEC_CERTIFICATION.md`.

use anyhow::{anyhow, bail, Context, Result};
use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use rytm_rs::prelude::*;
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_PORT_MATCH: &str = "Elektron Analog Rytm MKII";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_SETTLE_TIME: Duration = Duration::from_millis(750);

struct MidiSession {
    _input: MidiInputConnection<()>,
    output: MidiOutputConnection,
    receiver: Receiver<Vec<u8>>,
    input_name: String,
    output_name: String,
}

impl MidiSession {
    fn open(port_match: &str) -> Result<Self> {
        let mut input = MidiInput::new("rytm-rs-song-certification-input")?;
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

        let output = MidiOutput::new("rytm-rs-song-certification-output")?;
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
                "rytm-rs-song-certification-input",
                move |_stamp, message, _| {
                    let _ = sender.send(message.to_vec());
                },
                (),
            )
            .map_err(|error| anyhow!(error.to_string()))?;
        let output_connection = output
            .connect(&output_port, "rytm-rs-song-certification-output")
            .map_err(|error| anyhow!(error.to_string()))?;

        Ok(Self {
            _input: input_connection,
            output: output_connection,
            receiver,
            input_name,
            output_name,
        })
    }

    fn query_work_buffer_song(&mut self) -> Result<Vec<u8>> {
        while self.receiver.try_recv().is_ok() {}
        self.output
            .send(&SongQuery::new_targeting_work_buffer().as_sysex()?)
            .map_err(|error| anyhow!(error.to_string()))?;
        self.receive_sysex()
    }

    fn write_song(&mut self, song: &[u8]) -> Result<()> {
        self.output
            .send(song)
            .map_err(|error| anyhow!(error.to_string()))?;
        thread::sleep(WRITE_SETTLE_TIME);
        Ok(())
    }

    fn receive_sysex(&self) -> Result<Vec<u8>> {
        let deadline = Instant::now() + RESPONSE_TIMEOUT;
        let mut response = Vec::new();
        let mut receiving = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                bail!("timed out waiting for a complete SysEx response");
            }
            let message = match self.receiver.recv_timeout(remaining) {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => bail!("timed out waiting for a SysEx response"),
                Err(RecvTimeoutError::Disconnected) => {
                    bail!("MIDI input disconnected while waiting for SysEx")
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
    let mut session = MidiSession::open(&options.port_match)?;
    let baseline = session
        .query_work_buffer_song()
        .context("failed to query baseline work-buffer Song")?;
    let baseline_song = Song::from_sysex(&baseline).context("baseline Song response is invalid")?;
    if baseline_song.as_sysex()? != baseline {
        bail!("typed baseline Song did not re-encode byte-for-byte");
    }

    let mut proposed_song = baseline_song.clone();
    proposed_song.set_name("AGENT SONG")?;
    let expected_rows = certification_rows()?;
    proposed_song.replace_rows(&expected_rows)?;
    let proposed = proposed_song.as_sysex()?;
    let plan = certification_summary(&proposed_song, &session, options.execute)?;
    if !options.execute {
        println!("{}", serde_json::to_string_pretty(&plan)?);
        return Ok(());
    }

    fs::create_dir_all(&options.output_directory)?;
    fs::write(
        options
            .output_directory
            .join("song-certification-baseline.syx"),
        &baseline,
    )?;

    let certification = (|| -> Result<Vec<u8>> {
        session.write_song(&proposed)?;
        let observed = session
            .query_work_buffer_song()
            .context("failed to read back the certification Song")?;
        let observed_song = Song::from_sysex(&observed)?;
        if observed_song.name() != "AGENT SONG" {
            bail!("device did not retain the requested Song name");
        }
        if observed_song.rows()? != expected_rows {
            bail!("device Song rows, repeats, patterns, or mutes differ from the request");
        }
        fs::write(
            options
                .output_directory
                .join("song-certification-defined.syx"),
            &observed,
        )?;
        Ok(observed)
    })();

    let restoration = (|| -> Result<Vec<u8>> {
        session
            .write_song(&baseline)
            .context("failed to send baseline Song during rollback")?;
        let restored = session
            .query_work_buffer_song()
            .context("failed to read back the baseline Song during rollback")?;
        if restored != baseline {
            bail!("rollback readback differs from the captured baseline Song");
        }
        fs::write(
            options
                .output_directory
                .join("song-certification-restored.syx"),
            &restored,
        )?;
        Ok(restored)
    })();

    let observed = match (certification, restoration) {
        (Ok(observed), Ok(_)) => observed,
        (Err(certification_error), Ok(_)) => {
            return Err(certification_error.context("Song certification failed; rollback succeeded"))
        }
        (Ok(_), Err(restoration_error)) => {
            return Err(restoration_error.context("Song certification passed but rollback failed"))
        }
        (Err(certification_error), Err(restoration_error)) => {
            return Err(anyhow!(
                "Song certification failed: {certification_error:#}; EMERGENCY ROLLBACK FAILED: {restoration_error:#}"
            ))
        }
    };

    let report = json!({
        "schema": "rytm-rs-song-certification.v1",
        "status": "write-readback-rollback-verified",
        "codecTargetFirmware": "1.70",
        "observedFirmware": options.observed_firmware,
        "device": "Analog Rytm MKII",
        "midiInput": session.input_name,
        "midiOutput": session.output_name,
        "baselineFingerprint": fingerprint(&baseline),
        "definedFingerprint": fingerprint(&observed),
        "restoredFingerprint": fingerprint(&baseline),
        "name": proposed_song.name(),
        "rows": rows_summary(&expected_rows),
        // OS 1.72 Song has no tempo overrides, per-row pattern-length overrides,
        // jumps, loops, row labels, or an explicit end-row command; rows,
        // repeats, pattern chains, name, and track mutes are what the codec
        // certifies.
        "certifiedFields": ["name", "rows", "repeats", "pattern_chains", "track_mutes"],
    });
    fs::write(
        options.output_directory.join("song-certification.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn certification_rows() -> Result<Vec<SongRow>> {
    let first = SongPattern::try_new(0)?;
    let mut second = SongPattern::try_new(1)?;
    second.set_track_muted(0, true)?;
    let mut third = SongPattern::try_new(16)?;
    third.set_track_muted(1, true)?;
    Ok(vec![
        SongRow::try_new(vec![first, second], 2)?,
        SongRow::try_new(vec![third], 1)?,
    ])
}

fn certification_summary(
    song: &Song,
    session: &MidiSession,
    execute: bool,
) -> Result<serde_json::Value> {
    Ok(json!({
        "schema": "rytm-rs-song-certification-plan.v1",
        "status": if execute { "ready-to-execute" } else { "dry-run" },
        "midiInput": session.input_name,
        "midiOutput": session.output_name,
        "name": song.name(),
        "rows": rows_summary(&song.rows()?),
        "certifiedFields": ["name", "rows", "repeats", "pattern_chains", "track_mutes"],
    }))
}

fn rows_summary(rows: &[SongRow]) -> Vec<serde_json::Value> {
    rows.iter()
        .enumerate()
        .map(|(row_index, row)| {
            json!({
                "row": row_index,
                "repeats": row.repeats(),
                "patterns": row.patterns().iter().map(|pattern| json!({
                    "index": pattern.pattern(),
                    "mutedTracksMask": pattern.muted_tracks_mask(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect()
}

struct Options {
    output_directory: PathBuf,
    port_match: String,
    observed_firmware: String,
    execute: bool,
}

impl Options {
    fn parse() -> Result<Self> {
        let mut arguments = std::env::args().skip(1);
        let output_directory = arguments.next().map(PathBuf::from).ok_or_else(|| {
            anyhow!(
                "usage: certify_song_codec <output-directory> [--port-match <name>] [--observed-firmware <version>] [--execute]\n\
                 example: daemon/tests/fixtures/rytm-rs-certification/mkii-connected-YYYY-MM-DD"
            )
        })?;
        let mut port_match = DEFAULT_PORT_MATCH.to_string();
        let mut observed_firmware = "unknown-not-reported-by-device-identity".to_string();
        let mut execute = false;
        while let Some(option) = arguments.next() {
            match option.as_str() {
                "--execute" => execute = true,
                "--port-match" => {
                    port_match = arguments
                        .next()
                        .ok_or_else(|| anyhow!("missing value for {option}"))?;
                }
                "--observed-firmware" => {
                    observed_firmware = arguments
                        .next()
                        .ok_or_else(|| anyhow!("missing value for {option}"))?;
                }
                _ => bail!("unknown option {option:?}"),
            }
        }
        Ok(Self {
            output_directory,
            port_match,
            observed_firmware,
            execute,
        })
    }
}

fn fingerprint(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    format!("fnv1a64:{hash:016x}")
}
