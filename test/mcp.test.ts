import assert from "node:assert/strict";
import test from "node:test";
import { RytmMcpAdapter } from "../src/mcp/RytmMcpAdapter.ts";
import type { RytmDaemonApi } from "../src/rpc/types.ts";
import { RytmAgentService } from "../src/service/RytmAgentService.ts";

test("exposes the initial Rytm MCP tool surface", () => {
  const adapter = new RytmMcpAdapter(new RytmAgentService());
  const tools = adapter.listTools();
  assert.equal(tools.length, 29);
  assert.ok(tools.some((tool) => tool.name === "rytm_daemon_health"));
  assert.ok(tools.some((tool) => tool.name === "rytm_inspect_track_sound"));
  assert.ok(tools.some((tool) => tool.name === "rytm_queue_operations"));
  assert.ok(tools.some((tool) => tool.name === "rytm_rollback_snapshot"));
  assert.ok(tools.some((tool) => tool.name === "rytm_capture_pattern_audio"));
  assert.ok(tools.some((tool) => tool.name === "rytm_inspect_samples"));
  assert.ok(tools.some((tool) => tool.name === "rytm_upload_sample"));
  assert.ok(tools.some((tool) => tool.name === "rytm_resolve_sample_ram"));
  assert.ok(tools.some((tool) => tool.name === "rytm_clear_sample_ram"));
  assert.ok(tools.some((tool) => tool.name === "rytm_set_active_scene"));
  assert.ok(tools.some((tool) => tool.name === "rytm_set_performance_macro"));
  assert.ok(tools.some((tool) => tool.name === "rytm_inspect_song"));
  assert.ok(tools.some((tool) => tool.name === "rytm_propose_song_delta"));
});

test("routes health and compact inspection through an optional daemon boundary", async () => {
  const service = new RytmAgentService();
  const daemon = {
    async health() { return { status: "ready" as const, connected: true, adapter: "mock" as const, protocolSchema: "analog-rytm-rpc.v1" as const, daemonSchema: "analog-rytm-daemon.v1" as const, processId: 1, methods: { declared: [], implemented: [] } }; },
    async inspectDeviceState() { return { source: "rust-daemon" }; },
    async inspectPattern(pattern?: string) { return { source: "rust-daemon", pattern }; },
    async inspectSong() { return { source: "rust-daemon", object: "song" }; },
    async proposeSongDelta() { return { source: "rust-daemon", object: "song-proposal" }; },
    async inspectKit() { return { source: "rust-daemon", object: "kit" }; },
    async inspectSound(track: string) { return { source: "rust-daemon", object: "sound", track }; },
    async inspectGlobal() { return { source: "rust-daemon", object: "global" }; },
  } as RytmDaemonApi;
  const adapter = new RytmMcpAdapter(service, daemon);

  const health = await adapter.callTool("rytm_daemon_health", {}) as { status: string };
  assert.equal(health.status, "ready");
  assert.deepEqual(await adapter.callTool("rytm_inspect_device_state", {}), { source: "rust-daemon" });
  assert.deepEqual(await adapter.callTool("rytm_inspect_pattern", { pattern: "B02" }), { source: "rust-daemon", pattern: "B02" });
  assert.deepEqual(await adapter.callTool("rytm_inspect_song", {}), { source: "rust-daemon", object: "song" });
  assert.deepEqual(await adapter.callTool("rytm_propose_song_delta", { operations: [] }), { source: "rust-daemon", object: "song-proposal" });
  assert.deepEqual(await adapter.callTool("rytm_inspect_kit", {}), { source: "rust-daemon", object: "kit" });
  assert.deepEqual(await adapter.callTool("rytm_inspect_track_sound", { track: "CH" }), { source: "rust-daemon", object: "sound", track: "CH" });
  assert.deepEqual(await adapter.callTool("rytm_inspect_global", {}), { source: "rust-daemon", object: "global" });
});

test("dispatches MCP-style calls to the Rytm service", async () => {
  const service = new RytmAgentService();
  await service.init();
  const adapter = new RytmMcpAdapter(service);

  const validation = await adapter.callTool("rytm_validate_operations", {
    operations: [{ type: "set_trig", track: "BD", step: 0 }],
  }) as { valid: boolean };
  assert.equal(validation.valid, true);

  const applied = await adapter.callTool("rytm_apply_operations_now", {
    operationSetId: "mcp-now",
    expectedRevision: 0,
    operations: [{ type: "set_trig", track: "BD", step: 0 }],
  }) as { status: string; resultingRevision: number };
  assert.equal(applied.status, "applied");
  assert.equal(applied.resultingRevision, 1);

  const pattern = await adapter.callTool("rytm_inspect_pattern", { pattern: "A01" }) as { trigCount: number };
  assert.equal(pattern.trigCount, 1);

  const sound = await adapter.callTool("rytm_inspect_track_sound", { track: "BD" }) as { track: string; machine: string };
  assert.equal(sound.track, "BD");
  assert.equal(sound.machine, "bdhard");

  await assert.rejects(adapter.callTool("not_a_tool", {}), /unknown Rytm MCP tool/);
});
