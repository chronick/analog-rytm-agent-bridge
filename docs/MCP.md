# Using the bridge as an MCP server

The bridge ships an MCP stdio server that exposes all 32 semantic Rytm tools to
any MCP client — Claude Code, Claude Desktop, or your own agent runtime.

There are two adapters behind the same tool surface:

| Adapter | What it talks to | Use it when |
|---|---|---|
| `mock` (default) | An in-process mock transport | Trying the tools out, developing prompts, CI. No hardware, no daemon, nothing at risk. |
| `hardware` | The Rust daemon and a connected Analog Rytm MKII over CoreMIDI | You actually want to play the instrument. |

**Start with `mock`.** Every tool answers, so you can see the whole surface and
watch how an agent uses it before a real device is involved.

## Install

```bash
git clone https://github.com/chronick/analog-rytm-agent-bridge
cd analog-rytm-agent-bridge
npm install
```

Requirements: macOS (CoreMIDI/CoreAudio), Node ≥ 22.14, and — for the
`hardware` adapter — Rust ≥ 1.89 and an Analog Rytm MKII. Verify the server
runs before wiring it into a client:

```bash
npm run mcp
```

It should print `rytm mcp server ready (mock adapter, no hardware)` to stderr
and then wait. That is correct: an MCP server speaks protocol on stdout and
sits idle until a client connects. Press Ctrl-C.

## Claude Code

From inside the checkout:

```bash
claude mcp add rytm -- npm run mcp
```

For the real device, pass the hardware adapter through:

```bash
claude mcp add rytm-hw -- npm run mcp:hardware
```

Or commit a `.mcp.json` at your project root so the server travels with the
repo:

```json
{
  "mcpServers": {
    "rytm": {
      "command": "node",
      "args": [
        "--experimental-transform-types",
        "/absolute/path/to/analog-rytm-agent-bridge/src/bin/mcp-server.ts",
        "--adapter",
        "mock"
      ]
    }
  }
}
```

Confirm it attached with `claude mcp list`, then ask the agent something like
*"what's on pattern A01?"* — it should reach for `rytm_inspect_pattern`.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rytm": {
      "command": "node",
      "args": [
        "--experimental-transform-types",
        "/absolute/path/to/analog-rytm-agent-bridge/src/bin/mcp-server.ts",
        "--adapter",
        "hardware",
        "--clock-source",
        "observed"
      ],
      "cwd": "/absolute/path/to/analog-rytm-agent-bridge"
    }
  }
}
```

Use an **absolute path**, and set `cwd` to the checkout — the hardware adapter
launches the Rust daemon via `cargo run --manifest-path daemon/Cargo.toml`,
which needs to resolve from the repository root. Restart Claude Desktop after
editing.

## Any other MCP client

The server is a standard stdio MCP server; point your client at:

```
node --experimental-transform-types src/bin/mcp-server.ts [flags]
```

Or run the `bin` directly — its shebang carries the flag:

```
./src/bin/mcp-server.ts --adapter hardware
```

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--adapter mock\|hardware` | `mock` | Which transport backs the tools. |
| `--clock-source observed\|generated` | daemon default | Follow incoming MIDI clock, or generate 24 PPQN. |
| `--state-dir DIR` | `~/.analog-rytm-agent-bridge/` | Isolated durable store for queues, snapshots, revisions, events. |
| `--daemon-command CMD` | `cargo` | Run a prebuilt daemon binary instead of building through Cargo. |

## Before you point it at hardware

Work through [HARDWARE_SETUP.md](HARDWARE_SETUP.md) first, and take a backup —
this writes to a musical instrument. The safety model (validate-first,
snapshot, readback verification, byte-exact rollback) is described in the
[README](../README.md#the-safety-model); it protects the objects an operation
touches, not your whole device.

One habit worth building into your prompts: have the agent call
`rytm_describe_capabilities` first. It reports what the connected device and
firmware actually support, so unsupported operations come back as a refusal
instead of a corrupted object.

## Notes on behavior

- **A failed Rytm operation is not a protocol error.** Refusals and failures
  come back as a normal tool result with `isError: true` and a readable
  message, so the agent can see the reason and adapt rather than losing the
  connection.
- **Diagnostics go to stderr.** Stdout carries only protocol messages; a stray
  log line there would corrupt the stream. If you extend the server, keep to
  that rule — `test/mcp-stdio.test.ts` asserts it.
- **The mock adapter refuses hardware-only tools** (Song inspection, capability
  evidence, audio capture) with a message saying the daemon is required. That
  is expected, not a misconfiguration.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Client shows the server as failed immediately | Usually a relative path in the config. Use an absolute path to `mcp-server.ts`. |
| `hardware` adapter hangs on start | Cargo is building the daemon on first run. Run `cargo build --manifest-path daemon/Cargo.toml` once, first. |
| Tools list is empty | The client connected but the handshake did not complete — check the client's MCP log for the `initialize` exchange. |
| Hardware tools refuse with "daemon is required" | The server is running the `mock` adapter. Pass `--adapter hardware`. |
| Device not found | `cd daemon && cargo run -- midi-list` to confirm CoreMIDI sees the Rytm at all. |
