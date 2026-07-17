import assert from "node:assert/strict";
import test from "node:test";
import {
  collectOperationValidation,
  validateOperationSetInput,
  validateSetActiveSceneInput,
  validateSetPerformanceMacroInput,
} from "../src/domain/validation.ts";
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
  classCompliantAudio: true,
  overbridgeAudio: false,
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

test("validates optional hardware transport epochs on musical boundaries", () => {
  assert.doesNotThrow(() => validateOperationSetInput({
    expectedRevision: 0,
    applyAt: { kind: "next_step", transportEpoch: "epoch-12" },
    latePolicy: "reject",
    operations: [{ type: "set_trig", track: "BD", step: 0 }],
  }, capabilities));
  assert.throws(() => validateOperationSetInput({
    expectedRevision: 0,
    applyAt: { kind: "next_step", transportEpoch: "unsafe epoch" },
    latePolicy: "reject",
    operations: [{ type: "set_trig", track: "BD", step: 0 }],
  }, capabilities), /applyAt.transportEpoch/);
});

test("keeps incomplete hardware features behind capability flags", () => {
  assert.throws(() => validateOperationSetInput({
    expectedRevision: 0,
    applyAt: { kind: "next_step" },
    latePolicy: "reject",
    operations: [{ type: "assign_sample_slot", track: "BD", step: undefined as never, slot: 1, sampleId: "kick-1" }],
  }, capabilities), /sampleSlotAssignment/);
});

test("validates declarative Scene and Performance definitions when capabilities are enabled", () => {
  const macroCapabilities = { ...capabilities, sceneMacros: true, performanceMacros: true };
  assert.doesNotThrow(() => validateOperationSetInput({
    expectedRevision: 0,
    applyAt: { kind: "next_measure" },
    latePolicy: "roll-forward",
    operations: [
      { type: "set_scene_lock", scene: 1, track: "BD", parameter: "sample_tune", value: 65 },
      {
        type: "replace_scene",
        scene: 2,
        locks: [
          { track: "SD", parameter: "filter_frequency", value: 96 },
          { track: "FX", parameter: "delay_feedback", value: 80 },
        ],
      },
      { type: "copy_scene", sourceScene: 1, targetScene: 3 },
      { type: "clear_scene", scene: 4 },
      { type: "set_performance_lock", performance: 1, track: "BD", parameter: "sample_tune", depth: 12 },
      {
        type: "replace_performance",
        performance: 2,
        locks: [
          { track: "SD", parameter: "amp_pan", depth: -32 },
          { track: "FX", parameter: "reverb_decay", depth: 24 },
        ],
      },
      { type: "copy_performance", sourcePerformance: 1, targetPerformance: 3 },
      { type: "clear_performance", performance: 4 },
    ],
  }, macroCapabilities));
});

test("rejects unavailable, duplicate, and out-of-range macro definitions", () => {
  assert.throws(() => validateOperationSetInput({
    expectedRevision: 0,
    applyAt: { kind: "next_step" },
    latePolicy: "reject",
    operations: [{ type: "clear_scene", scene: 1 }],
  }, capabilities), /sceneMacros/);

  const macroCapabilities = { ...capabilities, sceneMacros: true, performanceMacros: true };
  const result = collectOperationValidation([
    { type: "set_scene_lock", scene: 0, track: "BD", parameter: "sample_tune", value: 65 },
    {
      type: "replace_scene",
      scene: 1,
      locks: [
        { track: "FX", parameter: "delay_feedback", value: 80 },
        { track: "FX", parameter: "delay_feedback", value: 81 },
      ],
    },
    { type: "set_performance_lock", performance: 13, track: "BD", parameter: "sample_tune", depth: 12 },
    { type: "set_performance_lock", performance: 1, track: "BD", parameter: "sample_tune", depth: -129 },
  ], macroCapabilities);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 4);
});

test("validates transient macro control independently from persistent revisioning", () => {
  const macroCapabilities = { ...capabilities, sceneMacros: true, performanceMacros: true };
  assert.doesNotThrow(() => validateSetActiveSceneInput({ scene: null, lane: "cc" }, macroCapabilities));
  assert.doesNotThrow(() => validateSetActiveSceneInput({ scene: 12, lane: "nrpn" }, macroCapabilities));
  assert.doesNotThrow(() => validateSetPerformanceMacroInput({ performance: 1, amount: 127 }, macroCapabilities));
  assert.throws(() => validateSetActiveSceneInput({ scene: 13 }, macroCapabilities), /scene/);
  assert.throws(() => validateSetPerformanceMacroInput({ performance: 1, amount: 128 }, macroCapabilities), /amount/);
});
