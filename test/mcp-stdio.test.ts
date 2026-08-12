import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Drives the real MCP stdio entry point as a child process, speaking the
 * protocol over the pipe exactly as a client would. A unit test against the
 * adapter would not catch the failures that actually break an MCP server:
 * a stray write to stdout, a missing capability, or a handler that throws
 * instead of returning an error result.
 */
const SERVER = fileURLToPath(new URL("../src/bin/mcp-server.ts", import.meta.url));
const PROTOCOL_VERSION = "2025-06-18";

class StdioClient {
  #child: ReturnType<typeof spawn>;
  #buffer = "";
  #pending = new Map<number, (message: Record<string, unknown>) => void>();
  #nextId = 1;
  stderr = "";

  constructor() {
    this.#child = spawn(
      process.execPath,
      ["--experimental-transform-types", SERVER, "--adapter", "mock"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#child.stdout!.setEncoding("utf8");
    this.#child.stdout!.on("data", (chunk: string) => this.#onData(chunk));
    this.#child.stderr!.setEncoding("utf8");
    this.#child.stderr!.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line) as Record<string, unknown>;
        const resolve = this.#pending.get(message.id as number);
        if (resolve) {
          this.#pending.delete(message.id as number);
          resolve(message);
        }
      }
      newline = this.#buffer.indexOf("\n");
    }
  }

  request(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}; stderr: ${this.stderr}`)),
        15_000,
      );
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.#child.stdin!.write(`${payload}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.#child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    this.#child.kill();
  }
}

describe("mcp stdio server", () => {
  let client: StdioClient;

  before(() => {
    client = new StdioClient();
  });

  after(() => {
    client.close();
  });

  it("completes the initialize handshake and advertises tools", async () => {
    const response = await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    });
    const result = response.result as Record<string, unknown>;
    assert.equal(response.error, undefined);
    assert.ok(result.protocolVersion, "server negotiated a protocol version");
    assert.ok(
      (result.capabilities as Record<string, unknown>).tools,
      "server advertises the tools capability",
    );
    assert.equal(
      (result.serverInfo as Record<string, unknown>).name,
      "analog-rytm-agent-bridge",
    );
    client.notify("notifications/initialized");
  });

  it("lists every adapter tool with a usable schema", async () => {
    const response = await client.request("tools/list");
    const tools = (response.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.ok(tools.length >= 30, `expected the full surface, got ${tools.length}`);
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      "rytm_inspect_device_state",
      "rytm_propose_pattern_delta",
      "rytm_apply_operations_now",
      "rytm_rollback_snapshot",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string", `${tool.name} needs a description`);
      assert.equal(
        (tool.inputSchema as Record<string, unknown>).type,
        "object",
        `${tool.name} needs an object input schema`,
      );
    }
  });

  it("calls a tool and returns its result as text content", async () => {
    const response = await client.request("tools/call", {
      name: "rytm_inspect_device_state",
      arguments: {},
    });
    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.notEqual(result.isError, true, `unexpected error: ${result.content?.[0]?.text}`);
    assert.equal(result.content[0].type, "text");
    const state = JSON.parse(result.content[0].text) as Record<string, unknown>;
    assert.ok("revision" in state, "device state carries a revision");
  });

  it("reports a refused operation as isError rather than a protocol failure", async () => {
    const response = await client.request("tools/call", {
      name: "rytm_inspect_song",
      arguments: {},
    });
    // The mock adapter has no daemon, so Song inspection is refused. The point
    // is that the client still gets a well-formed result it can read.
    assert.equal(response.error, undefined, "must not surface as a JSON-RPC error");
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /daemon/i);
  });

  it("keeps stdout free of anything but protocol messages", () => {
    assert.match(client.stderr, /rytm mcp server ready/, "diagnostics belong on stderr");
  });
});
