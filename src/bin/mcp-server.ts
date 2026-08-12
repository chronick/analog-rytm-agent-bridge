#!/usr/bin/env -S node --experimental-transform-types
/**
 * MCP stdio entry point for the Analog Rytm agent bridge.
 *
 * The shebang carries the type-stripping flag so this runs directly as a `bin`
 * on the Node 22.14 floor this project supports; on Node 24 the flag is a
 * harmless no-op.
 *
 * Two adapters, one protocol:
 *
 *   --adapter mock       in-process mock transport, no hardware, no daemon.
 *                        Safe to point an agent at while you are still finding
 *                        out what the tools do.
 *   --adapter hardware   spawns the Rust daemon and talks to a connected
 *                        Analog Rytm MKII over CoreMIDI.
 *
 * Everything on stdout is MCP protocol. Diagnostics go to stderr, because a
 * stray log line on stdout corrupts the stream and the client silently drops
 * the connection.
 */
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";
import { RytmAgentService } from "../service/RytmAgentService.ts";
import { RytmMcpAdapter } from "../mcp/RytmMcpAdapter.ts";
import { serveRytmMcpOverStdio } from "../mcp/McpStdioServer.ts";

interface Options {
  adapter: "mock" | "hardware";
  stateDir?: string;
  clockSource?: string;
  daemonCommand: string;
  daemonArgs?: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = { adapter: "mock", daemonCommand: "cargo" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const valueOf = (flag: string): string => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      i += 1;
      return next;
    };
    if (arg === "--adapter" || arg.startsWith("--adapter=")) {
      const value = valueOf("--adapter");
      if (value !== "mock" && value !== "hardware") {
        throw new Error(`--adapter must be "mock" or "hardware", got "${value}"`);
      }
      options.adapter = value;
    } else if (arg === "--state-dir" || arg.startsWith("--state-dir=")) {
      options.stateDir = valueOf("--state-dir");
    } else if (arg === "--clock-source" || arg.startsWith("--clock-source=")) {
      options.clockSource = valueOf("--clock-source");
    } else if (arg === "--daemon-command" || arg.startsWith("--daemon-command=")) {
      options.daemonCommand = valueOf("--daemon-command");
    } else if (arg === "--help" || arg === "-h") {
      process.stderr.write(
        "usage: rytm-mcp-server [--adapter mock|hardware] [--state-dir DIR]\n" +
          "                      [--clock-source observed|generated]\n" +
          "                      [--daemon-command CMD]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function daemonArgsFor(options: Options): string[] {
  // Default to running the daemon straight out of the checkout, so the server
  // works from a fresh clone with no build step of its own.
  const args =
    options.daemonCommand === "cargo"
      ? ["run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve"]
      : ["serve"];
  args.push("--adapter", options.adapter);
  if (options.clockSource) args.push("--clock-source", options.clockSource);
  if (options.stateDir) args.push("--state-dir", options.stateDir);
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const service = new RytmAgentService();

  if (options.adapter === "mock") {
    // The mock service answers every tool in-process; no daemon to manage.
    const adapter = new RytmMcpAdapter(service);
    await serveRytmMcpOverStdio(adapter);
    process.stderr.write("rytm mcp server ready (mock adapter, no hardware)\n");
    return;
  }

  const client = new RustDaemonClient({
    command: options.daemonCommand,
    args: daemonArgsFor(options),
  });
  const health = await client.start();
  process.stderr.write(
    `rytm mcp server ready (hardware adapter, device ${health.connected ? "connected" : "not connected"})\n`,
  );

  const adapter = new RytmMcpAdapter(service, client);
  await serveRytmMcpOverStdio(adapter, { onClose: () => client.close() });

  const shutdown = async (): Promise<void> => {
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// import.meta.main is unavailable before Node 22.18/24, where it silently no-ops.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `rytm mcp server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
