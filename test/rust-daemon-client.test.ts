import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RytmDaemonRpcError, RustDaemonClient } from "../src/rpc/RustDaemonClient.ts";

test("TypeScript client completes a real round trip through the Rust mock daemon", async () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const client = new RustDaemonClient({
    command: "cargo",
    args: [
      "run",
      "--quiet",
      "--manifest-path",
      fileURLToPath(new URL("../daemon/Cargo.toml", import.meta.url)),
      "--",
      "serve",
      "--adapter",
      "mock",
    ],
    cwd: repository,
    requestTimeoutMs: 60_000,
  });

  try {
    const health = await client.start();
    assert.equal(health.status, "ready");
    assert.equal(health.adapter, "mock");
    assert.ok(health.methods.declared.includes("operations.queue"));
    assert.ok(health.methods.implemented.includes("pattern.inspect"));

    const state = await client.inspectDeviceState() as {
      device: { activePattern: string };
      activePattern: { tracks: Array<{ track: string }> };
      queue: { supported: boolean };
    };
    assert.equal(state.device.activePattern, "A01");
    assert.equal(state.activePattern.tracks[0]?.track, "BD");
    assert.equal(state.queue.supported, false);

    const first = await client.request("pattern.inspect", { pattern: "B02" }, { requestId: "integration-replay" });
    const replay = await client.request("pattern.inspect", { pattern: "B02" }, { requestId: "integration-replay" });
    assert.deepEqual(replay, first);

    await assert.rejects(
      client.request("daemon.health", {}, { requestId: "integration-replay" }),
      (error: unknown) => error instanceof RytmDaemonRpcError && error.code === "request_id_conflict",
    );
  } finally {
    await client.close();
  }
});
