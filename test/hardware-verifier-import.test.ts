import assert from "node:assert/strict";
import test from "node:test";
import { runHardwareAudioVerification } from "../src/bin/verify-hardware-audio.ts";
import { runHardwareControlVerification } from "../src/bin/verify-hardware-control.ts";
import { runHardwareMacroVerification } from "../src/bin/verify-hardware-macros.ts";
import { runHardwareSampleVerification } from "../src/bin/verify-hardware-samples.ts";

test("hardware certification modules are inert when imported", () => {
  assert.equal(typeof runHardwareAudioVerification, "function");
  assert.equal(typeof runHardwareControlVerification, "function");
  assert.equal(typeof runHardwareMacroVerification, "function");
  assert.equal(typeof runHardwareSampleVerification, "function");
});
