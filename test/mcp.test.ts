import assert from "node:assert/strict";
import test from "node:test";
import { RytmMcpAdapter } from "../src/mcp/RytmMcpAdapter.ts";
import { RytmAgentService } from "../src/service/RytmAgentService.ts";

test("exposes the initial Rytm MCP tool surface", () => {
  const adapter = new RytmMcpAdapter(new RytmAgentService());
  const tools = adapter.listTools();
  assert.equal(tools.length, 14);
  assert.ok(tools.some((tool) => tool.name === "rytm_daemon_health"));
  assert.ok(tools.some((tool) => tool.name === "rytm_queue_operations"));
  assert.ok(tools.some((tool) => tool.name === "rytm_rollback_snapshot"));
});

test("routes health and compact inspection through an optional daemon boundary", async () => {
  const service = new RytmAgentService();
  const daemon = {
    async health() { return { status: "ready" as const, connected: true, adapter: "mock" as const, protocolSchema: "analog-rytm-rpc.v1" as const, daemonSchema: "analog-rytm-daemon.v1" as const, processId: 1, methods: { declared: [], implemented: [] } }; },
    async inspectDeviceState() { return { source: "rust-daemon" }; },
    async inspectPattern(pattern?: string) { return { source: "rust-daemon", pattern }; },
  };
  const adapter = new RytmMcpAdapter(service, daemon);

  const health = await adapter.callTool("rytm_daemon_health", {}) as { status: string };
  assert.equal(health.status, "ready");
  assert.deepEqual(await adapter.callTool("rytm_inspect_device_state", {}), { source: "rust-daemon" });
  assert.deepEqual(await adapter.callTool("rytm_inspect_pattern", { pattern: "B02" }), { source: "rust-daemon", pattern: "B02" });
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

  await assert.rejects(adapter.callTool("not_a_tool", {}), /unknown Rytm MCP tool/);
});
