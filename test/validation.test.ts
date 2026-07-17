import assert from "node:assert/strict";
import test from "node:test";
import { collectOperationValidation, validateOperationSetInput } from "../src/domain/validation.ts";
import type { RytmCapabilities } from "../src/domain/types.ts";

const capabilities: RytmCapabilities = {
  realtimeMidi: true,
  sysExState: true,
  patternEdit: true,
  kitEdit: true,
  machineEdit: true,
  sampleSlotAssignment: false,
  sampleTransfer: false,
  sceneMacros: false,
  performanceMacros: false,
  songs: false,
};

test("validates core persistent operations", () => {
  assert.doesNotThrow(() => validateOperationSetInput({
    operationSetId: "ops-1",
    expectedRevision: 0,
    applyAt: { kind: "next_measure" },
    latePolicy: "roll-forward",
    operations: [
      { type: "set_trig", pattern: "A01", track: "BD", step: 0, velocity: 110, condition: "1:2" },
      { type: "set_parameter_lock", track: "BD", step: 0, parameter: "filter_frequency", value: 88 },
      { type: "set_track_length", track: "CH", step: undefined as never, steps: 15 },
      { type: "set_sound_parameter", track: "BD", page: "filter", parameter: "filter_type", value: "Lp2" },
      { type: "set_fx_parameter", effect: "delay", parameter: "ping_pong", value: true },
      { type: "set_global_parameter", section: "routing", parameter: "route_to_main", track: "BD", value: false },
    ],
  }, capabilities));
});

test("rejects invalid ranges and unsafe atoms", () => {
  const result = collectOperationValidation([
    { type: "set_trig", pattern: "Q99", track: "BD", step: 0 },
    { type: "set_trig", track: "BD", step: 64 },
    { type: "set_trig", track: "BD", step: 0, condition: "bad condition" },
    { type: "set_parameter_lock", track: "BD", step: 0, parameter: "filter;frequency", value: 1 },
    { type: "set_sound_parameter", track: "BD", page: "filter", parameter: "bad parameter", value: 1 },
  ], capabilities);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 5);
});

test("keeps incomplete hardware features behind capability flags", () => {
  assert.throws(() => validateOperationSetInput({
    expectedRevision: 0,
    applyAt: { kind: "next_step" },
    latePolicy: "reject",
    operations: [{ type: "assign_sample_slot", track: "BD", step: undefined as never, slot: 1, sampleId: "kick-1" }],
  }, capabilities), /sampleSlotAssignment/);
});
