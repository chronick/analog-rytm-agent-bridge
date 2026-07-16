use analog_rytm_agent_daemon::{describe_as_json, mock_description};

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--describe") | None => println!("{}", describe_as_json(&mock_description())),
        Some(other) => {
            eprintln!("unknown argument: {other}");
            std::process::exit(2);
        }
    }
}

