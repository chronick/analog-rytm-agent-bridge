use analog_rytm_agent_daemon::{
    describe_as_json,
    hardware::{
        capture_state, configure_midi, create_demo_patterns, list_midi_ports, parse_pattern_slot,
        play_demo_patterns, query_identity, query_pattern_summary, restore_demo_patterns,
        restore_midi_config, validate_realtime_controls, RytmMidiSession, DEFAULT_PORT_MATCH,
    },
    hardware_scheduler::ClockSource,
    mock_description,
    rpc::{serve_stdio, BackendMode},
};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("--describe") | None => {
            println!("{}", describe_as_json(&mock_description()));
            Ok(())
        }
        Some("serve") => {
            let adapter = option_value(&args, "--adapter").unwrap_or("mock");
            let port_match = option_value(&args, "--port-match").unwrap_or(DEFAULT_PORT_MATCH);
            let state_directory = option_value(&args, "--state-dir")
                .map(PathBuf::from)
                .unwrap_or_else(default_state_directory);
            let clock_source = option_value(&args, "--clock-source").unwrap_or("observed");
            let force_verification_failure = args
                .iter()
                .any(|argument| argument == "--test-force-verification-failure");
            serve_stdio(
                BackendMode::parse(adapter)?,
                port_match,
                &state_directory.join("hardware-state.json"),
                ClockSource::parse(clock_source)?,
                force_verification_failure,
            )
        }
        Some("midi-list") => print_json(list_midi_ports()?),
        Some("identity") => {
            let mut session = RytmMidiSession::open(DEFAULT_PORT_MATCH)?;
            print_json(query_identity(&mut session)?)
        }
        Some("capture-state") => {
            let directory = required_path(&args, 1, "capture-state <directory>")?;
            let mut session = RytmMidiSession::open(DEFAULT_PORT_MATCH)?;
            print_json(capture_state(&mut session, directory)?)
        }
        Some("inspect-pattern") => {
            let slot = args
                .get(1)
                .ok_or_else(|| "usage: inspect-pattern <A01-H16>".to_string())?;
            let pattern_index = parse_pattern_slot(slot)?;
            let mut session = RytmMidiSession::open(DEFAULT_PORT_MATCH)?;
            print_json(query_pattern_summary(&mut session, pattern_index)?)
        }
        Some("configure-midi") => {
            require_execute(&args, "configure-midi --execute <capture-directory>")?;
            let directory =
                required_path(&args, 2, "configure-midi --execute <capture-directory>")?;
            let mut session = RytmMidiSession::open(DEFAULT_PORT_MATCH)?;
            print_json(configure_midi(&mut session, directory)?)
        }
        Some("restore-midi") => {
            require_execute(&args, "restore-midi --execute <capture-directory>")?;
            let directory = required_path(&args, 2, "restore-midi --execute <capture-directory>")?;
            let mut session = RytmMidiSession::open(DEFAULT_PORT_MATCH)?;
            print_json(restore_midi_config(&mut session, directory)?)
        }
        Some("validate-realtime") => {
            require_execute(&args, "validate-realtime --execute <capture-directory>")?;
            let directory =
                required_path(&args, 2, "validate-realtime --execute <capture-directory>")?;
            let mut session = RytmMidiSession::open(DEFAULT_PORT_MATCH)?;
            print_json(validate_realtime_controls(&mut session, directory)?)
        }
        Some("create-demo-patterns") => {
            require_execute(&args, "create-demo-patterns --execute <capture-directory>")?;
            let directory = required_path(
                &args,
                2,
                "create-demo-patterns --execute <capture-directory>",
            )?;
            let mut session = RytmMidiSession::open(DEFAULT_PORT_MATCH)?;
            print_json(create_demo_patterns(&mut session, directory)?)
        }
        Some("restore-patterns") => {
            require_execute(&args, "restore-patterns --execute <capture-directory>")?;
            let directory =
                required_path(&args, 2, "restore-patterns --execute <capture-directory>")?;
            let mut session = RytmMidiSession::open(DEFAULT_PORT_MATCH)?;
            print_json(restore_demo_patterns(&mut session, directory)?)
        }
        Some("play-demo-patterns") => {
            require_execute(&args, "play-demo-patterns --execute <baseline-directory>")?;
            let directory = required_path(
                &args,
                2,
                "play-demo-patterns --execute <baseline-directory>",
            )?;
            let mut session = RytmMidiSession::open(DEFAULT_PORT_MATCH)?;
            print_json(play_demo_patterns(&mut session, directory)?)
        }
        Some(other) => Err(format!("unknown command: {other}\n\n{}", usage())),
    }
}

fn default_state_directory() -> PathBuf {
    std::env::var_os("ANALOG_RYTM_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".analog-rytm-agent-bridge"))
        })
        .unwrap_or_else(|| PathBuf::from(".analog-rytm-agent-bridge"))
}

fn option_value<'a>(args: &'a [String], option: &str) -> Option<&'a str> {
    args.iter()
        .position(|argument| argument == option)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn require_execute(args: &[String], usage: &str) -> Result<(), String> {
    if args.get(1).map(String::as_str) != Some("--execute") {
        return Err(format!(
            "refusing hardware writes without the explicit --execute flag\nusage: {usage}"
        ));
    }
    Ok(())
}

fn required_path<'a>(args: &'a [String], index: usize, usage: &str) -> Result<&'a Path, String> {
    args.get(index)
        .map(Path::new)
        .ok_or_else(|| format!("usage: {usage}"))
}

fn print_json(value: Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn usage() -> &'static str {
    "commands: --describe, serve [--adapter mock|hardware] [--port-match <name>], midi-list, identity, capture-state <dir>, inspect-pattern <slot>, configure-midi --execute <dir>, restore-midi --execute <dir>, validate-realtime --execute <dir>, create-demo-patterns --execute <dir>, restore-patterns --execute <dir>, play-demo-patterns --execute <baseline-dir>"
}
