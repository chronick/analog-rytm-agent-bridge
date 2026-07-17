import type {
  RytmChangePatternInput,
  RytmLiveParameterInput,
  RytmOperationSetInput,
  RytmPatternDeltaInput,
  RytmPersistentOperation,
  RytmRollbackInput,
  RytmSetTransportInput,
  RytmSnapshotInput,
  RytmTriggerTrackInput,
} from "../domain/types.ts";
import type { RytmAgentService } from "../service/RytmAgentService.ts";
import type { RytmDaemonApi } from "../rpc/types.ts";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const emptyInput = { type: "object" as const, additionalProperties: false };

export class RytmMcpAdapter {
  private readonly service: RytmAgentService;
  private readonly daemon?: RytmDaemonApi;

  constructor(service: RytmAgentService, daemon?: RytmDaemonApi) {
    this.service = service;
    this.daemon = daemon;
  }

  listTools(): McpToolDescriptor[] {
    return [
      { name: "rytm_daemon_health", description: "Report Rust daemon connection, adapter, protocol, and implemented-method health.", inputSchema: emptyInput },
      { name: "rytm_inspect_device_state", description: "Return compact Rytm device, transport, queue, snapshot, and active-pattern state.", inputSchema: emptyInput },
      {
        name: "rytm_inspect_pattern",
        description: "Return compact trig, machine, track-length, sample-slot, and kit-parameter summary for a pattern.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "rytm_inspect_kit",
        description: "Return compact track-level, retrig, Sound, FX, and control-input state for the active Kit.",
        inputSchema: emptyInput,
      },
      {
        name: "rytm_inspect_track_sound",
        description: "Return the active Kit Sound pages and machine parameters for one track.",
        inputSchema: {
          type: "object",
          properties: { track: { type: "string" } },
          required: ["track"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_inspect_global",
        description: "Return Global MIDI, routing, metronome, sequencer, and Settings state.",
        inputSchema: emptyInput,
      },
      {
        name: "rytm_propose_pattern_delta",
        description: "Validate operations and return a projected compact pattern summary without mutating state.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            operations: { type: "array", minItems: 1, items: { type: "object" } },
          },
          required: ["operations"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_validate_operations",
        description: "Validate persistent Rytm delta operations against current capability flags.",
        inputSchema: {
          type: "object",
          properties: { operations: { type: "array", minItems: 1, items: { type: "object" } } },
          required: ["operations"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_queue_operations",
        description: "Queue a revision-checked persistent operation set for a Rytm musical boundary.",
        inputSchema: operationSetSchema(["expectedRevision", "applyAt", "latePolicy", "operations"]),
      },
      {
        name: "rytm_apply_operations_now",
        description: "Apply a revision-checked persistent operation set immediately.",
        inputSchema: operationSetSchema(["expectedRevision", "operations"]),
      },
      {
        name: "rytm_set_live_parameter",
        description: "Send a realtime CC/NRPN-style parameter gesture. This does not persist project state.",
        inputSchema: {
          type: "object",
          properties: {
            track: { type: "string" },
            parameter: { type: "string" },
            value: { type: "number" },
            lane: { enum: ["cc", "nrpn"] },
          },
          required: ["parameter", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_trigger_track",
        description: "Trigger a Rytm track over the realtime MIDI lane.",
        inputSchema: {
          type: "object",
          properties: {
            track: { type: "string" },
            velocity: { type: "integer", minimum: 1, maximum: 127 },
            durationMs: { type: "integer", minimum: 1 },
          },
          required: ["track"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_set_transport",
        description: "Start, stop, or continue Rytm transport over MIDI.",
        inputSchema: {
          type: "object",
          properties: {
            command: { enum: ["start", "stop", "continue"] },
            tempo: { type: "number" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_change_pattern",
        description: "Change the active Rytm pattern over the realtime MIDI lane.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            immediate: { type: "boolean" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_snapshot_state",
        description: "Capture a rollback snapshot of the bridge's current Rytm state cache.",
        inputSchema: {
          type: "object",
          properties: {
            snapshotId: { type: "string" },
            label: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "rytm_rollback_snapshot",
        description: "Restore a captured state snapshot and increment the public revision.",
        inputSchema: {
          type: "object",
          properties: {
            snapshotId: { type: "string" },
            expectedRevision: { type: "integer", minimum: 0 },
          },
          required: ["snapshotId"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_get_events",
        description: "Read the Rytm bridge event journal after an optional cursor.",
        inputSchema: {
          type: "object",
          properties: {
            afterCursor: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 1000 },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    switch (name) {
      case "rytm_daemon_health":
        if (!this.daemon) throw new Error("Rust Rytm daemon is not configured");
        return this.daemon.health();
      case "rytm_inspect_device_state":
        return this.daemon ? this.daemon.inspectDeviceState() : this.service.inspectDeviceState();
      case "rytm_inspect_pattern":
        return this.daemon
          ? this.daemon.inspectPattern((args as { pattern?: string }).pattern)
          : this.service.inspectPattern((args as { pattern?: string }).pattern);
      case "rytm_inspect_kit":
        return this.daemon ? this.daemon.inspectKit() : this.service.inspectKit();
      case "rytm_inspect_track_sound":
        return this.daemon
          ? this.daemon.inspectSound((args as { track: string }).track)
          : this.service.inspectSound((args as { track: string }).track);
      case "rytm_inspect_global":
        return this.daemon ? this.daemon.inspectGlobal() : this.service.inspectGlobal();
      case "rytm_propose_pattern_delta":
        return this.daemon
          ? this.daemon.proposePatternDelta(args as RytmPatternDeltaInput)
          : this.service.proposePatternDelta(args as RytmPatternDeltaInput);
      case "rytm_validate_operations":
        return this.daemon
          ? this.daemon.validateOperations((args as { operations: RytmPersistentOperation[] }).operations)
          : this.service.validateOperations((args as { operations: RytmPersistentOperation[] }).operations);
      case "rytm_queue_operations":
        return this.daemon
          ? this.daemon.queueOperations(args as RytmOperationSetInput)
          : this.service.queueOperations(args as RytmOperationSetInput);
      case "rytm_apply_operations_now":
        return this.daemon
          ? this.daemon.applyOperationsNow(args as Omit<RytmOperationSetInput, "applyAt" | "latePolicy">)
          : this.service.applyOperationsNow(args as Omit<RytmOperationSetInput, "applyAt" | "latePolicy">);
      case "rytm_set_live_parameter":
        return this.daemon
          ? this.daemon.setLiveParameter(args as RytmLiveParameterInput)
          : this.service.setLiveParameter(args as RytmLiveParameterInput);
      case "rytm_trigger_track":
        return this.daemon
          ? this.daemon.triggerTrack(args as RytmTriggerTrackInput)
          : this.service.triggerTrack(args as RytmTriggerTrackInput);
      case "rytm_set_transport":
        return this.daemon
          ? this.daemon.setTransport(args as RytmSetTransportInput)
          : this.service.setTransport(args as RytmSetTransportInput);
      case "rytm_change_pattern":
        return this.daemon
          ? this.daemon.changePattern(args as RytmChangePatternInput)
          : this.service.changePattern(args as RytmChangePatternInput);
      case "rytm_snapshot_state":
        return this.daemon
          ? this.daemon.snapshotState(args as RytmSnapshotInput)
          : this.service.snapshotState(args as RytmSnapshotInput);
      case "rytm_rollback_snapshot":
        return this.daemon
          ? this.daemon.rollbackSnapshot(args as RytmRollbackInput)
          : this.service.rollbackSnapshot(args as RytmRollbackInput);
      case "rytm_get_events": {
        const input = args as { afterCursor?: number; limit?: number };
        return this.daemon
          ? this.daemon.getEvents(input.afterCursor ?? 0, input.limit ?? 100)
          : this.service.getEvents(input.afterCursor ?? 0, input.limit ?? 100);
      }
      default:
        throw new Error(`unknown Rytm MCP tool: ${name}`);
    }
  }
}

function operationSetSchema(required: string[]): McpToolDescriptor["inputSchema"] {
  return {
    type: "object",
    properties: {
      operationSetId: { type: "string" },
      expectedRevision: { type: "integer", minimum: 0 },
      applyAt: { type: "object" },
      latePolicy: { enum: ["roll-forward", "reject"] },
      operations: { type: "array", minItems: 1, items: { type: "object" } },
      dryRun: { type: "boolean" },
    },
    required,
    additionalProperties: false,
  };
}
