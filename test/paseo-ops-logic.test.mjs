import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, maskSecretValue, formatMaskedJson, redactConfig, formatConfigJson, latencyTone, formatLatency, summarizeUsageReport } from "../src/paseoOpsLogic.ts";

test("redactConfig is an allowlist: unknown leaves hidden, keys visible", () => {
  const out = redactConfig({
    relay: { enabled: true, endpoint: "relay.example", signingKey: "abc" },
    auth: { enabled: true, password: "hunter2", accessKey: "k", publicKey: "p", relayKey: "r" },
    mcp: { injectIntoAgents: true, extra: "x" },
    providers: { claude: { enabled: true, env: { OPENAI: "sk-proj-abcdefghij", PATH: "p" }, args: ["--token=ghp_abcdefghij"], command: ["c"] } },
    terminalProfiles: [{ id: "t", name: "T", command: "run --key abc", args: ["a"], env: { X: "y" } }],
    appendSystemPrompt: "secret prompt",
    listen: "0.0.0.0:6767",
    empty: { token: "" },
  });
  assert.equal(out.relay.enabled, true);
  assert.equal(out.relay.endpoint, REDACTED);
  assert.equal(out.relay.signingKey, REDACTED);
  assert.equal(out.auth.enabled, true);
  for (const k of ["password", "accessKey", "publicKey", "relayKey"]) assert.equal(out.auth[k], REDACTED, k);
  assert.equal(out.mcp.injectIntoAgents, true);
  assert.equal(out.mcp.extra, REDACTED);
  assert.equal(out.providers.claude.enabled, true);
  assert.equal(out.providers.claude.env.OPENAI, REDACTED);
  assert.equal(out.providers.claude.env.PATH, REDACTED);
  assert.deepEqual(out.providers.claude.args, [REDACTED]);
  assert.deepEqual(out.providers.claude.command, [REDACTED]);
  assert.equal(out.terminalProfiles[0].id, "t");
  assert.equal(out.terminalProfiles[0].command, REDACTED);
  assert.deepEqual(out.terminalProfiles[0].args, [REDACTED]);
  assert.equal(out.terminalProfiles[0].env.X, REDACTED);
  assert.equal(out.appendSystemPrompt, REDACTED);
  assert.equal(out.listen, REDACTED);
  assert.equal(out.empty.token, "");
});

test("allowlisted strings are value-masked as a backstop", () => {
  const samples = ["sk-abcdefghijkl", "ghp_abcdefghijkl", "github_pat_abcdefghij", "eyJhbGciOiJI.eyJzdWIiOiJ4", "xoxb-123456-abc", "AIza" + "a".repeat(30), "Bearer abc.def", "$2b$10$" + "a".repeat(50), "https://user:pw@host/x"];
  for (const v of samples) {
    assert.equal(maskSecretValue(v), REDACTED, v);
    assert.equal(redactConfig({ app: { baseUrl: v }, cors: { allowedOrigins: [v] } }).app.baseUrl, REDACTED);
  }
  const ok = redactConfig({ app: { baseUrl: "http://localhost:5173" }, providers: { claude: { enabled: false } } });
  assert.equal(ok.app.baseUrl, "http://localhost:5173");
  assert.equal(ok.providers.claude.enabled, false);
  assert.ok(!formatMaskedJson({ a: "ghp_abcdefghijkl", b: "fine" }).includes("ghp_"));
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
  assert.equal(summarizeUsageReport({ ...base, report: { status: "unavailable", problem: { kind: "rejected", status: 401 } } }).summary, "rejected: HTTP 401");
  assert.equal(summarizeUsageReport({ ...base, report: { status: "unavailable", problem: { kind: "expired", expiresAt: "2026-01-01" } } }).summary, "expired: 2026-01-01");
});
