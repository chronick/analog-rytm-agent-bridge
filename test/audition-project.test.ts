import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOONSHOT_TEMPO, resolveTempoPlan } from "../src/bin/audition-project.ts";

// resolveTempoPlan is the hardware-free half of `npm run audition:project`:
// argv in, {slots, tempos, source, warnings} out. The audition loop itself
// needs a device, so everything testable about tempo selection lives here.

function withTempoFile(body: (path: string) => void, contents: string): void {
  const directory = mkdtempSync(join(tmpdir(), "audition-tempos-"));
  try {
    const path = join(directory, "tempos.json");
    writeFileSync(path, contents);
    body(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("--tempo applies one bpm to every requested slot", () => {
  const plan = resolveTempoPlan(["E01", "E02", "--tempo", "128"]);
  assert.equal(plan.source, "uniform");
  assert.deepEqual(plan.slots, ["E01", "E02"]);
  assert.deepEqual(plan.tempos, { E01: 128, E02: 128 });
  assert.deepEqual(plan.warnings, []);
  // The stale Moonshot label (E01 is 120 in the built-in table) is not used.
  assert.notEqual(plan.tempos.E01, MOONSHOT_TEMPO.E01);
});

test("--tempo without slots falls back to the built-in slot list, and says so", () => {
  const plan = resolveTempoPlan(["--tempo", "121.43"]);
  assert.equal(plan.source, "uniform");
  assert.deepEqual(plan.slots, Object.keys(MOONSHOT_TEMPO));
  assert.equal(plan.tempos.A01, 121.43);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /no slots given/);
});

test("--tempo rejects a non-positive or missing bpm", () => {
  assert.throws(() => resolveTempoPlan(["E01", "--tempo", "0"]), /--tempo requires a positive bpm/);
  assert.throws(() => resolveTempoPlan(["E01", "--tempo", "fast"]), /--tempo requires a positive bpm/);
  assert.throws(() => resolveTempoPlan(["E01", "--tempo"]), /--tempo requires a positive bpm/);
});

test("--tempos reads a bare slot -> bpm map from disk", () => {
  withTempoFile((path) => {
    const plan = resolveTempoPlan(["E01", "E02", "--tempos", path]);
    assert.equal(plan.source, "file");
    assert.deepEqual(plan.slots, ["E01", "E02"]);
    assert.deepEqual(plan.tempos, { E01: 118, E02: 119.5 });
    assert.deepEqual(plan.warnings, []);
  }, JSON.stringify({ E01: 118, E02: 119.5, E03: 120 }));
});

test("--tempos accepts a { tempos: {...} } wrapper and defaults the slot list to the declaration", () => {
  withTempoFile((path) => {
    const plan = resolveTempoPlan(["--tempos", path]);
    assert.equal(plan.source, "file");
    assert.deepEqual(plan.slots, ["E01", "E04"]);
    assert.deepEqual(plan.tempos, { E01: 118, E04: 122 });
  }, JSON.stringify({ tempos: { E01: 118, E04: 122 } }));
});

test("an explicit map fails fast on a slot it does not declare", () => {
  withTempoFile((path) => {
    assert.throws(
      () => resolveTempoPlan(["E01", "E04", "--tempos", path]),
      /no tempo declared for E04/,
    );
  }, JSON.stringify({ E01: 118 }));
});

test("--tempos rejects malformed declarations", () => {
  withTempoFile((path) => {
    assert.throws(() => resolveTempoPlan(["--tempos", path]), /not valid JSON/);
  }, "{ nope");
  withTempoFile((path) => {
    assert.throws(() => resolveTempoPlan(["--tempos", path]), /is not a pattern slot/);
  }, JSON.stringify({ Z99: 120 }));
  withTempoFile((path) => {
    assert.throws(() => resolveTempoPlan(["--tempos", path]), /must be a positive number/);
  }, JSON.stringify({ E01: "120" }));
  withTempoFile((path) => {
    assert.throws(() => resolveTempoPlan(["--tempos", path]), /declares no tempos/);
  }, JSON.stringify({}));
  assert.throws(() => resolveTempoPlan(["--tempos"]), /--tempos requires a path/);
});

test("--tempo and --tempos are mutually exclusive", () => {
  withTempoFile((path) => {
    assert.throws(
      () => resolveTempoPlan(["E01", "--tempo", "128", "--tempos", path]),
      /mutually exclusive/,
    );
  }, JSON.stringify({ E01: 118 }));
});

test("the Moonshot table still works but is no longer silent", () => {
  const plan = resolveTempoPlan(["E01", "A03"]);
  assert.equal(plan.source, "moonshot");
  assert.deepEqual(plan.slots, ["E01", "A03"]);
  assert.deepEqual(plan.tempos, { E01: MOONSHOT_TEMPO.E01, A03: MOONSHOT_TEMPO.A03 });
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /built-in Moonshot tempo table/);
  assert.match(plan.warnings[0], /--tempo <bpm> or --tempos <map\.json>/);
});

test("no arguments auditions the whole Moonshot table, warned", () => {
  const plan = resolveTempoPlan([]);
  assert.equal(plan.source, "moonshot");
  assert.deepEqual(plan.slots, Object.keys(MOONSHOT_TEMPO));
  assert.equal(plan.tempos.F12, MOONSHOT_TEMPO.F12);
  assert.match(plan.warnings[0], /built-in Moonshot tempo table/);
});

test("a slot outside the Moonshot table keeps the 130 bpm fallback, with a warning", () => {
  const plan = resolveTempoPlan(["G01"]);
  assert.equal(plan.source, "moonshot");
  assert.deepEqual(plan.tempos, { G01: 130 });
  assert.equal(plan.warnings.length, 2);
  assert.match(plan.warnings[1], /no Moonshot tempo for G01/);
});

test("resolveTempoPlan does not read the filesystem unless --tempos is given", () => {
  const reader = () => {
    throw new Error("should not be called");
  };
  assert.equal(resolveTempoPlan(["E01"], reader).source, "moonshot");
  assert.equal(resolveTempoPlan(["E01", "--tempo", "128"], reader).source, "uniform");
});
