import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, redactConfig, formatConfigJson, latencyTone, formatLatency, summarizeUsageReport } from "../src/paseoOpsLogic.ts";

test("redactConfig masks secret-looking keys at any depth", () => {
  const out = redactConfig({
    daemon: { password: "hunter2", listen: "127.0.0.1:6767" },
    providers: { x: { apiKey: "sk-1", env: { GH_TOKEN: "t", PATH: "p" } } },
    list: [{ clientSecret: "s" }],
    empty: { token: "" },
  });
  assert.equal(out.daemon.password, REDACTED);
  assert.equal(out.daemon.listen, "127.0.0.1:6767");
  assert.equal(out.providers.x.apiKey, REDACTED);
  assert.equal(out.providers.x.env.GH_TOKEN, REDACTED);
  assert.equal(out.providers.x.env.PATH, "p");
  assert.equal(out.list[0].clientSecret, REDACTED);
  assert.equal(out.empty.token, "");
  assert.ok(!formatConfigJson({ password: "hunter2" }).includes("hunter2"));
});

test("latency formatting and tone", () => {
  assert.equal(formatLatency(null), "—");
  assert.equal(formatLatency(4.26), "4.3 ms");
  assert.equal(formatLatency(42.4), "42 ms");
  assert.equal(latencyTone(20), "ok");
  assert.equal(latencyTone(200), "warn");
  assert.equal(latencyTone(900), "hot");
  assert.equal(latencyTone(null), "none");
});

test("summarizeUsageReport covers available / error / unavailable", () => {
  const base = { id: "a", sourceLabel: "Claude", fetchedAt: "t" };
  const ok = summarizeUsageReport({ ...base, account: { label: "me" }, report: { status: "available", planLabel: "Max", windows: [{ label: "5h", usedPct: 41.6 }, { label: "7d", remainingPct: 80 }] } });
  assert.equal(ok.title, "Claude · me");
  assert.equal(ok.summary, "Max · 5h: 42% used · 7d: 80% left");
  assert.equal(summarizeUsageReport({ ...base, report: { status: "error", error: "boom" } }).summary, "boom");
  assert.equal(summarizeUsageReport({ ...base, report: { status: "unavailable", problem: { kind: "no_quota", detail: "none" } } }).summary, "no_quota: none");
});
