import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_FORM, cadenceLabel, formFromSchedule, intervalToMs, isHeartbeat, toCreateRequest, toUpdateRequest, validateCron, validateForm,
} from "../src/scheduleForm.ts";

const f = (o = {}) => ({ ...EMPTY_FORM, prompt: "hi", cwd: "/tmp/x", ...o });

test("cron validation", () => {
  assert.equal(validateCron("0 9 * * 1-5"), null);
  assert.equal(validateCron("*/15 0,12 * * *"), null);
  assert.match(validateCron("* * * *"), /5 fields/);
  assert.match(validateCron("61 * * * *"), /outside/);
  assert.match(validateCron("*/0 * * * *"), /step/);
  assert.match(validateCron("5-2 * * * *"), /backwards/);
  assert.match(validateCron("a * * * *"), /cannot read/);
});

test("interval parsing", () => {
  assert.equal(intervalToMs("30", "m"), 1_800_000);
  assert.equal(intervalToMs("1.5", "h"), 5_400_000);
  assert.equal(intervalToMs("x", "m"), null);
  assert.equal(intervalToMs("0", "m"), null);
});

test("form validation", () => {
  assert.deepEqual(validateForm(f()), []);
  assert.ok(validateForm(f({ prompt: " " })).some((e) => /Prompt/.test(e)));
  assert.ok(validateForm(f({ cwd: "" })).some((e) => /Working directory/.test(e)));
  assert.ok(validateForm(f({ targetKind: "self" })).some((e) => /Pick an agent/.test(e)));
  assert.deepEqual(validateForm(f({ targetKind: "self", agentId: "a" })), []);
  assert.ok(validateForm(f({ cadenceKind: "every", intervalValue: "5", intervalUnit: "s" })).some((e) => /10 seconds/.test(e)));
  assert.ok(validateForm(f({ maxRuns: "0" })).some((e) => /Max runs/.test(e)));
  assert.ok(validateForm(f({ expiresAt: "nope" })).some((e) => /Expiry/.test(e)));
  assert.deepEqual(validateForm(f({ cwd: "", targetKind: "agent" }), "edit"), []);
});

test("create request mapping", () => {
  const r = toCreateRequest(f({ name: " zz ", cron: " 0  9 * * * ", timezone: "UTC", model: "m", maxRuns: "3", runOnCreate: true }));
  assert.deepEqual(r, {
    prompt: "hi",
    name: "zz",
    cadence: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp/x", model: "m" } },
    maxRuns: 3,
    runOnCreate: true,
  });
  const h = toCreateRequest(f({ targetKind: "self", agentId: "abc", cadenceKind: "every", intervalValue: "2", intervalUnit: "h" }));
  assert.deepEqual(h.target, { type: "self", agentId: "abc" });
  assert.deepEqual(h.cadence, { type: "every", everyMs: 7_200_000 });
  assert.equal("maxRuns" in h, false);
});

test("update request clears blanks with null", () => {
  const r = toUpdateRequest("s1", f({ name: "" }));
  assert.equal(r.id, "s1");
  assert.equal(r.name, null);
  assert.equal(r.maxRuns, null);
  assert.equal(r.expiresAt, null);
});

test("prefill + labels", () => {
  const s = { name: "n", prompt: "p", cadence: { type: "every", everyMs: 7_200_000 }, target: { type: "self", agentId: "a1" } };
  const form = formFromSchedule(s);
  assert.equal(form.cadenceKind, "every");
  assert.equal(form.intervalValue, "2");
  assert.equal(form.intervalUnit, "h");
  assert.equal(form.agentId, "a1");
  assert.equal(isHeartbeat(s), true);
  assert.equal(cadenceLabel(s.cadence), "every 2h");
  assert.equal(cadenceLabel({ type: "cron", expression: "0 2 * * *" }), "0 2 * * *");
});
