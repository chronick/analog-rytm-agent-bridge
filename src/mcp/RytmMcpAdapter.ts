import type {
  RytmCapturePatternAudioInput,
  RytmChangePatternInput,
  RytmClearSampleRamInput,
  RytmLiveParameterInput,
  RytmOperationSetInput,
  RytmPatternDeltaInput,
  RytmPersistentOperation,
  RytmRollbackInput,
  RytmSampleInventoryInput,
  RytmResolveSampleRamInput,
  RytmSetTransportInput,
  RytmSetActiveSceneInput,
  RytmSetPerformanceMacroInput,
  RytmSnapshotInput,
  RytmStartRecordingInput,
  RytmStopRecordingInput,
  RytmTriggerTrackInput,
  RytmUploadSampleInput,
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
        name: "rytm_set_active_scene",
        description: "Activate Scene 1-12 or send null to deactivate it over MIDI without rewriting the Kit.",
        inputSchema: {
          type: "object",
          properties: {
            scene: {
              anyOf: [
                { type: "integer", minimum: 1, maximum: 12 },
                { type: "null" },
              ],
            },
            lane: { enum: ["cc", "nrpn"] },
          },
          required: ["scene"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_set_performance_macro",
        description: "Set the transient amount of Performance macro 1-12 over MIDI without rewriting the Kit.",
        inputSchema: {
          type: "object",
          properties: {
            performance: { type: "integer", minimum: 1, maximum: 12 },
            amount: { type: "integer", minimum: 0, maximum: 127 },
            lane: { enum: ["cc", "nrpn"] },
          },
          required: ["performance", "amount"],
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
        name: "rytm_inspect_samples",
        description: "Inspect a compact +Drive sample directory, all RAM slots, and optional track assignments with stable managed sample IDs.",
        inputSchema: {
          type: "object",
          properties: {
            drivePath: { type: "string" },
            includeRam: { type: "boolean" },
            includeTracks: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "rytm_upload_sample",
        description: "Validate a local WAV, transfer it to the Rytm +Drive, read it back, and return a stable content identity.",
        inputSchema: {
          type: "object",
          properties: {
            sourcePath: { type: "string" },
            deviceDirectory: { type: "string" },
            name: { type: "string" },
          },
          required: ["sourcePath"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_resolve_sample_ram",
        description: "Idempotently load a managed +Drive sample into a free or requested Rytm RAM slot and verify readback.",
        inputSchema: {
          type: "object",
          properties: {
            sampleId: { type: "string" },
            slot: { type: "integer", minimum: 1, maximum: 127 },
          },
          required: ["sampleId"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_clear_sample_ram",
        description: "Clear a Rytm RAM slot only when its observed sample identity matches the supplied managed sample ID.",
        inputSchema: {
          type: "object",
          properties: {
            sampleId: { type: "string" },
            slot: { type: "integer", minimum: 1, maximum: 127 },
          },
          required: ["sampleId", "slot"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_list_audio_inputs",
        description: "List CoreAudio inputs, Rytm matches, stream capabilities, and stale partial recording files.",
        inputSchema: emptyInput,
      },
      {
        name: "rytm_start_recording",
        description: "Start an atomic stereo WAV recording with current Rytm state metadata.",
        inputSchema: recordingSchema(false),
      },
      {
        name: "rytm_stop_recording",
        description: "Stop and atomically finalize an active WAV recording and metadata sidecar.",
        inputSchema: {
          type: "object",
          properties: { recordingId: { type: "string" } },
          required: ["recordingId"],
          additionalProperties: false,
        },
      },
      {
        name: "rytm_capture_pattern_audio",
        description: "Capture a bounded stereo WAV for the current pattern with revision and routing metadata.",
        inputSchema: recordingSchema(true),
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
      case "rytm_set_active_scene":
        return this.daemon
          ? this.daemon.setActiveScene(args as RytmSetActiveSceneInput)
          : this.service.setActiveScene(args as RytmSetActiveSceneInput);
      case "rytm_set_performance_macro":
        return this.daemon
          ? this.daemon.setPerformanceMacro(args as RytmSetPerformanceMacroInput)
          : this.service.setPerformanceMacro(args as RytmSetPerformanceMacroInput);
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
      case "rytm_inspect_samples":
        if (!this.daemon) throw new Error("Rust Rytm daemon is required for sample management");
        return this.daemon.inspectSamples(args as RytmSampleInventoryInput);
      case "rytm_upload_sample":
        if (!this.daemon) throw new Error("Rust Rytm daemon is required for sample management");
        return this.daemon.uploadSample(args as RytmUploadSampleInput);
      case "rytm_resolve_sample_ram":
        if (!this.daemon) throw new Error("Rust Rytm daemon is required for sample management");
        return this.daemon.resolveSampleRam(args as RytmResolveSampleRamInput);
      case "rytm_clear_sample_ram":
        if (!this.daemon) throw new Error("Rust Rytm daemon is required for sample management");
        return this.daemon.clearSampleRam(args as RytmClearSampleRamInput);
      case "rytm_list_audio_inputs":
        if (!this.daemon) throw new Error("Rust Rytm daemon is required for audio capture");
        return this.daemon.listAudioInputs();
      case "rytm_start_recording":
        if (!this.daemon) throw new Error("Rust Rytm daemon is required for audio capture");
        return this.daemon.startRecording(args as RytmStartRecordingInput);
      case "rytm_stop_recording":
        if (!this.daemon) throw new Error("Rust Rytm daemon is required for audio capture");
        return this.daemon.stopRecording(args as RytmStopRecordingInput);
      case "rytm_capture_pattern_audio":
        if (!this.daemon) throw new Error("Rust Rytm daemon is required for audio capture");
        return this.daemon.capturePatternAudio(args as RytmCapturePatternAudioInput);
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

function recordingSchema(bounded: boolean): McpToolDescriptor["inputSchema"] {
  return {
    type: "object",
    properties: {
      recordingId: { type: "string", minLength: 1, maxLength: 128 },
      deviceName: { type: "string", minLength: 1 },
      snapshotId: { type: "string", minLength: 1 },
      ...(!bounded ? { expectedDurationMs: { type: "integer", minimum: 100, maximum: 600_000 } } : {}),
      ...(bounded ? { durationMs: { type: "integer", minimum: 100, maximum: 600_000 } } : {}),
    },
    required: bounded ? ["durationMs"] : undefined,
    additionalProperties: false,
  };
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
