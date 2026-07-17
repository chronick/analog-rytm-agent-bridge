import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { RytmPersistentOperation } from "../domain/types.ts";
import { RustDaemonClient } from "../rpc/RustDaemonClient.ts";

const execute = process.argv.includes("--execute");
const repository = fileURLToPath(new URL("../../", import.meta.url));
const snapshotId = "hardware-control-certification";
const client = new RustDaemonClient({
  command: "cargo",
  args: ["run", "--quiet", "--manifest-path", "daemon/Cargo.toml", "--", "serve", "--adapter", "hardware"],
  cwd: repository,
  requestTimeoutMs: 180_000,
});

const operations: RytmPersistentOperation[] = [
  { type: "set_track_machine", track: "BD", machine: "bdclassic" },
  { type: "set_sound_parameter", track: "BD", page: "machine", parameter: "lev", value: 91 },
  { type: "set_kit_parameter", track: "BD", parameter: "track_level", value: 99 },
  { type: "set_kit_parameter", track: "BD", parameter: "retrig.velocity_curve", value: 5 },
  { type: "set_kit_parameter", track: "BD", parameter: "retrig.always_on", value: true },
  { type: "set_sound_parameter", track: "BD", page: "sample", parameter: "tune", value: -1 },
  { type: "set_sound_parameter", track: "BD", page: "filter", parameter: "cutoff", value: 120 },
  { type: "set_sound_parameter", track: "BD", page: "amp", parameter: "pan", value: -5 },
  { type: "set_sound_parameter", track: "BD", page: "lfo", parameter: "speed", value: 40 },
  { type: "set_sound_parameter", track: "BD", page: "settings", parameter: "env_reset_filter", value: false },
  { type: "set_fx_parameter", effect: "delay", parameter: "feedback", value: 45 },
  { type: "set_fx_parameter", effect: "reverb", parameter: "decay", value: 45 },
  { type: "set_fx_parameter", effect: "distortion", parameter: "amount", value: 5 },
  { type: "set_fx_parameter", effect: "compressor", parameter: "threshold", value: 90 },
  { type: "set_fx_parameter", effect: "lfo", parameter: "speed", value: 40 },
  { type: "set_global_parameter", section: "routing", parameter: "route_to_main", track: "BD", value: true },
  { type: "set_global_parameter", section: "metronome", parameter: "active", value: true },
  { type: "set_global_parameter", section: "midi_sync", parameter: "clock_send", value: true },
  { type: "set_global_parameter", section: "midi_port", parameter: "receive_notes", value: false },
  { type: "set_global_parameter", section: "midi_channels", parameter: "auto_channel", value: 16 },
  { type: "set_global_parameter", section: "sequencer", parameter: "quantize_live_rec", value: true },
  { type: "set_global_parameter", section: "settings", parameter: "tempo", value: 123 },
];

let snapshotCreated = false;
let rollbackVerified = false;

try {
  const health = await client.start();
  assert.equal(health.adapter, "hardware");
  assert.ok(health.methods.implemented.includes("operations.apply_now"));
  process.stderr.write("hardware daemon ready\n");

  const baselineState = asRecord(await client.inspectDeviceState());
  const baseline = certificationFields(baselineState);
  process.stderr.write("baseline inspected\n");

  const validation = await client.validateOperations(operations);
  assert.equal(validation.valid, true, validation.errors.join("; "));
  process.stderr.write("operations validated\n");

  const dryRun = asRecord(await client.applyOperationsNow({
    operationSetId: "hardware-control-dry-run",
    expectedRevision: 0,
    operations,
    dryRun: true,
  }));
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.projectedRevision, 1);
  const projected = certificationFieldsFromObjectState(asRecord(dryRun.projectedState));
  process.stderr.write("dry run projected\n");

  if (!execute) {
    console.log(JSON.stringify({ status: "validated-dry-run", operations: operations.length, baseline }, null, 2));
    process.exitCode = 0;
  } else {
    await client.snapshotState({ snapshotId, label: "Hardware control certification baseline" });
    snapshotCreated = true;
    process.stderr.write("raw rollback snapshot captured\n");

    const input = {
      operationSetId: "hardware-control-apply",
      expectedRevision: 0,
      operations,
    } as const;
    const applied = asRecord(await client.applyOperationsNow(input));
    assert.equal(applied.status, "applied");
    assert.equal(applied.changed, true);
    assert.equal(applied.resultingRevision, 1);
    process.stderr.write("operation set applied and read back\n");

    const replay = asRecord(await client.applyOperationsNow(input));
    assert.deepEqual(replay, applied);
    process.stderr.write("operationSetId replay verified\n");

    const observed = certificationFields(asRecord(await client.inspectDeviceState()));
    assert.deepEqual(observed, projected);
    process.stderr.write("representative object families verified\n");

    const rolledBack = asRecord(await client.rollbackSnapshot({ snapshotId, expectedRevision: 1 }));
    assert.equal(rolledBack.status, "restored-and-verified");
    assert.equal(rolledBack.revision, 2);
    rollbackVerified = true;
    const restored = certificationFields(asRecord(await client.inspectDeviceState()));
    assert.deepEqual(restored, baseline);
    process.stderr.write("snapshot rollback and baseline comparison verified\n");

    const events = await client.getEvents();
    const eventTypes = events.map((entry) => asRecord(entry.event).type);
    assert.ok(eventTypes.includes("operation_set.applied"));
    assert.ok(eventTypes.includes("snapshot.rolled_back"));

    console.log(JSON.stringify({
      status: "applied-readback-rollback-verified",
      operations: operations.length,
      appliedRevision: applied.resultingRevision,
      restoredRevision: rolledBack.revision,
      eventTypes,
      baseline,
      observed,
    }, null, 2));
  }
} finally {
  if (snapshotCreated && !rollbackVerified) {
    try {
      await client.rollbackSnapshot({ snapshotId });
      process.stderr.write("emergency snapshot rollback completed\n");
    } catch (error) {
      process.stderr.write(`EMERGENCY ROLLBACK FAILED: ${String(error)}\n`);
    }
  }
  await client.close();
}

function certificationFields(state: Record<string, unknown>): Record<string, unknown> {
  const evidence = asRecord(state.evidence);
  const kit = asRecord(evidence.kit);
  const sounds = kit.sounds as Array<Record<string, unknown>>;
  const sound = asRecord(sounds[0]);
  const machineParameters = asRecord(sound.machineParameters);
  const machineParameterBody = asRecord(machineParameters[Object.keys(machineParameters)[0]]);
  const fx = asRecord(kit.fx);
  const global = asRecord(evidence.global);
  const midi = asRecord(global.midi);
  return {
    machine: sound.machine,
    machineLevel: machineParameterBody.lev,
    trackLevel: (kit.trackLevels as unknown[])[0],
    retrigVelocityCurve: asRecord((kit.retrig as Array<Record<string, unknown>>)[0]?.parameters).velocity_curve,
    retrigAlwaysOn: asRecord((kit.retrig as Array<Record<string, unknown>>)[0]?.parameters).always_on,
    sampleTune: asRecord(sound.sample).tune,
    filterCutoff: asRecord(sound.filter).cutoff,
    ampPan: asRecord(sound.amp).pan,
    soundLfoSpeed: asRecord(sound.lfo).speed,
    envResetFilter: asRecord(sound.settings).env_reset_filter,
    delayFeedback: asRecord(fx.delay).feedback,
    reverbDecay: asRecord(fx.reverb).decay,
    distortionAmount: asRecord(fx.distortion).amount,
    compressorThreshold: asRecord(fx.compressor).threshold,
    fxLfoSpeed: asRecord(fx.lfo).speed,
    routeToMainFlags: asRecord(global.routing).routeToMainFlags,
    metronomeActive: asRecord(global.metronome).active,
    clockSend: asRecord(asRecord(midi.sync)).clock_send,
    receiveNotes: asRecord(asRecord(midi.port_config)).receive_notes,
    autoChannel: asRecord(asRecord(asRecord(midi.channels)).auto_channel).Channel,
    quantizeLiveRec: asRecord(global.sequencer).quantize_live_rec,
    tempo: asRecord(evidence.settings).tempo,
  };
}

function certificationFieldsFromObjectState(state: Record<string, unknown>): Record<string, unknown> {
  return certificationFields({
    evidence: {
      kit: state.kit,
      global: state.global,
      settings: state.settings,
    },
  });
}

function asRecord(value: unknown): Record<string, any> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}
