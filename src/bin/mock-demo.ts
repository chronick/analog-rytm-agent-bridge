import { RytmMcpAdapter } from "../mcp/RytmMcpAdapter.ts";
import { RytmAgentService } from "../service/RytmAgentService.ts";

const service = new RytmAgentService();
await service.init();
const mcp = new RytmMcpAdapter(service);

await mcp.callTool("rytm_queue_operations", {
  operationSetId: "demo-kick",
  expectedRevision: 0,
  applyAt: { kind: "next_measure" },
  latePolicy: "roll-forward",
  operations: [
    { type: "set_trig", track: "BD", step: 0, velocity: 116 },
    { type: "set_parameter_lock", track: "BD", step: 0, parameter: "filter_frequency", value: 92 },
  ],
});

await service.advanceMockTransport(16);
console.log(JSON.stringify(await mcp.callTool("rytm_inspect_device_state", {}), null, 2));

