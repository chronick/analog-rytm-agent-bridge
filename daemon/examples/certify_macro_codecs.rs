//! Hardware certification tool for the maintained `rytm-rs` fork's typed Scene
//! and Performance definition codecs. It lives in the bridge, not in the fork:
//! this is agent-workflow tooling, not a codec.
//!
//! Without `--execute` the tool is read-only: it queries the work-buffer Kit,
//! builds the proposed definitions in memory, and prints the plan as JSON.
//!
//! With `--execute` it snapshots the work-buffer Kit, writes the controlled
//! Scene and Performance definitions, verifies the typed readback, and restores
//! the exact baseline. A rollback failure is reported separately from a
//! certification failure. Definition writes never activate a Scene.
//!
//! See `docs/CODEC_CERTIFICATION.md`.

use anyhow::{anyhow, bail, Context, Result};
use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use rytm_rs::object::Kit;
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
        let mut input = MidiInput::new("rytm-rs-macro-certification-input")?;
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

        let output = MidiOutput::new("rytm-rs-macro-certification-output")?;
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
                "rytm-rs-macro-certification-input",
                move |_stamp, message, _| {
                    let _ = sender.send(message.to_vec());
                },
                (),
            )
            .map_err(|error| anyhow!(error.to_string()))?;
        let output_connection = output
            .connect(&output_port, "rytm-rs-macro-certification-output")
            .map_err(|error| anyhow!(error.to_string()))?;

        Ok(Self {
            _input: input_connection,
            output: output_connection,
            receiver,
            input_name,
            output_name,
        })
    }

    fn query_work_buffer_kit(&mut self) -> Result<Vec<u8>> {
        while self.receiver.try_recv().is_ok() {}
        self.output
            .send(&KitQuery::new_targeting_work_buffer().as_sysex()?)
            .map_err(|error| anyhow!(error.to_string()))?;
        self.receive_sysex()
    }

    fn write_kit(&mut self, kit: &[u8]) -> Result<()> {
        self.output
            .send(kit)
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
        .query_work_buffer_kit()
        .context("failed to query baseline work-buffer Kit")?;
    RawSysexObject::from_sysex(&baseline).context("baseline Kit response is invalid")?;

    let mut project = RytmProject::try_default()?;
    project.update_from_sysex_response(&baseline)?;
    let current_scene_id = project.work_buffer().kit().current_scene_id_raw();
    define_certification_macros(project.work_buffer_mut().kit_mut())?;
    let proposed = project.work_buffer().kit().as_sysex()?;

    let plan = certification_summary(
        project.work_buffer().kit(),
        &session,
        current_scene_id,
        options.execute,
    )?;
    if !options.execute {
        println!("{}", serde_json::to_string_pretty(&plan)?);
        return Ok(());
    }

    fs::create_dir_all(&options.output_directory)?;
    fs::write(
        options.output_directory.join("macros-baseline-kit.syx"),
        &baseline,
    )?;

    let certification = (|| -> Result<Vec<u8>> {
        session.write_kit(&proposed)?;
        let observed = session
            .query_work_buffer_kit()
            .context("failed to read back macro definitions")?;
        let observed_kit = decode_kit(&observed)?;
        verify_certification_macros(&observed_kit, current_scene_id)?;
        fs::write(
            options.output_directory.join("macros-defined-kit.syx"),
            &observed,
        )?;
        Ok(observed)
    })();

    let restoration = (|| -> Result<Vec<u8>> {
        session
            .write_kit(&baseline)
            .context("failed to send baseline Kit during rollback")?;
        let restored = session
            .query_work_buffer_kit()
            .context("failed to read back baseline Kit during rollback")?;
        if restored != baseline {
            bail!("rollback readback differs from the captured baseline Kit");
        }
        fs::write(
            options.output_directory.join("macros-restored-kit.syx"),
            &restored,
        )?;
        Ok(restored)
    })();

    let observed = match (certification, restoration) {
        (Ok(observed), Ok(_)) => observed,
        (Err(certification_error), Ok(_)) => {
            return Err(certification_error.context("macro certification failed; rollback succeeded"))
        }
        (Ok(_), Err(restoration_error)) => {
            return Err(restoration_error.context("macro certification passed but rollback failed"))
        }
        (Err(certification_error), Err(restoration_error)) => {
            return Err(anyhow!(
                "macro certification failed: {certification_error:#}; EMERGENCY ROLLBACK FAILED: {restoration_error:#}"
            ))
        }
    };

    let report = json!({
        "schema": "rytm-rs-macro-certification.v1",
        "status": "write-readback-rollback-verified",
        "codecTargetFirmware": "1.70",
        "observedFirmware": options.observed_firmware,
        "device": "Analog Rytm MKII",
        "midiInput": session.input_name,
        "midiOutput": session.output_name,
        "baselineFingerprint": fingerprint(&baseline),
        "definedFingerprint": fingerprint(&observed),
        "restoredFingerprint": fingerprint(&baseline),
        "activeSceneDefinitionWriteInvariant": current_scene_id,
        "scenes": plan["scenes"],
        "performances": plan["performances"],
    });
    fs::write(
        options.output_directory.join("macros-certification.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn define_certification_macros(kit: &mut Kit) -> Result<()> {
    let bd = MacroTrack::try_voice(0)?;
    let sd = MacroTrack::try_voice(1)?;
    let bd_sample_tune = MacroParameter::try_from_raw(bd, 8)?;
    let sd_filter_frequency = MacroParameter::try_from_raw(sd, 20)?;
    let sd_amp_pan = MacroParameter::try_from_raw(sd, 30)?;
    let delay_feedback = MacroParameter::try_from_raw(MacroTrack::Fx, 3)?;
    let reverb_decay = MacroParameter::try_from_raw(MacroTrack::Fx, 11)?;

    kit.scene_definitions_mut()
        .replace(0, &[SceneLock::try_new(bd, bd_sample_tune, 65)?])?;
    kit.scene_definitions_mut().replace(
        1,
        &[
            SceneLock::try_new(sd, sd_filter_frequency, 96)?,
            SceneLock::try_new(MacroTrack::Fx, delay_feedback, 80)?,
        ],
    )?;
    kit.performance_definitions_mut()
        .replace(0, &[PerformanceLock::try_new(bd, bd_sample_tune, 12)?])?;
    kit.performance_definitions_mut().replace(
        1,
        &[
            PerformanceLock::try_new(sd, sd_amp_pan, -32)?,
            PerformanceLock::try_new(MacroTrack::Fx, reverb_decay, 24)?,
        ],
    )?;
    Ok(())
}

fn decode_kit(bytes: &[u8]) -> Result<Kit> {
    let mut project = RytmProject::try_default()?;
    project.update_from_sysex_response(bytes)?;
    Ok(project.work_buffer().kit().clone())
}

fn verify_certification_macros(kit: &Kit, current_scene_id: u8) -> Result<()> {
    let scene_zero = kit.scene_definitions().definition(0)?;
    let scene_one = kit.scene_definitions().definition(1)?;
    let performance_zero = kit.performance_definitions().definition(0)?;
    let performance_one = kit.performance_definitions().definition(1)?;
    if scene_zero.locks().len() != 1
        || scene_one.locks().len() != 2
        || performance_zero.locks().len() != 1
        || performance_one.locks().len() != 2
    {
        bail!("device did not retain the expected macro lock counts");
    }
    if kit.current_scene_id_raw() != current_scene_id {
        bail!("writing Scene definitions changed the active Scene ID");
    }
    let expected_scene_one = [(MacroTrack::try_voice(1)?, 20, 96), (MacroTrack::Fx, 3, 80)];
    for (lock, expected) in scene_one.locks().iter().zip(expected_scene_one) {
        if (lock.track(), lock.parameter().raw_id(), lock.value()) != expected {
            bail!("Scene multi-lock readback differs from the requested definition");
        }
    }
    let expected_performance_one = [
        (MacroTrack::try_voice(1)?, 30, -32),
        (MacroTrack::Fx, 11, 24),
    ];
    for (lock, expected) in performance_one.locks().iter().zip(expected_performance_one) {
        if (lock.track(), lock.parameter().raw_id(), lock.depth()) != expected {
            bail!("Performance multi-lock readback differs from the requested definition");
        }
    }
    Ok(())
}

fn certification_summary(
    kit: &Kit,
    session: &MidiSession,
    current_scene_id: u8,
    execute: bool,
) -> Result<serde_json::Value> {
    let scenes = [0, 1]
        .into_iter()
        .map(|id| {
            let definition = kit.scene_definitions().definition(id)?;
            Ok(json!({
                "id": id,
                "locks": definition.locks().iter().map(|lock| json!({
                    "track": lock.track().raw_id(),
                    "page": format!("{:?}", lock.parameter().page()).to_ascii_lowercase(),
                    "parameter": lock.parameter().name(),
                    "rawParameterId": lock.parameter().raw_id(),
                    "value": lock.value(),
                })).collect::<Vec<_>>(),
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let performances = [0, 1]
        .into_iter()
        .map(|id| {
            let definition = kit.performance_definitions().definition(id)?;
            Ok(json!({
                "id": id,
                "locks": definition.locks().iter().map(|lock| json!({
                    "track": lock.track().raw_id(),
                    "page": format!("{:?}", lock.parameter().page()).to_ascii_lowercase(),
                    "parameter": lock.parameter().name(),
                    "rawParameterId": lock.parameter().raw_id(),
                    "depth": lock.depth(),
                })).collect::<Vec<_>>(),
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({
        "schema": "rytm-rs-macro-certification-plan.v1",
        "status": if execute { "ready-to-execute" } else { "dry-run" },
        "midiInput": session.input_name,
        "midiOutput": session.output_name,
        "activeSceneDefinitionWriteInvariant": current_scene_id,
        "scenes": scenes,
        "performances": performances,
    }))
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
                "usage: certify_macro_codecs <output-directory> [--port-match <name>] [--observed-firmware <version>] [--execute]\n\
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
