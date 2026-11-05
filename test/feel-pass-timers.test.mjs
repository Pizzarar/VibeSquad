import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin, stepTimer } from "../plugin/index.server.ts";
import { perfClear, perfEnabled, perfEntries, perfEnd, perfEndPainted, perfRecord, perfReportText, perfSendBegin, perfSendEvent, perfSendResolved, perfStart } from "../src/perf.ts";

test("stepTimer records per-step ms and a total, and never throws", () => {
  const st = stepTimer();
  st.mark("a");
  st.mark("b");
  assert.deepEqual(st.steps.map(([n]) => n), ["a", "b"]);
  assert.match(st.summary(), /^total=\d+/);
  assert.ok(st.total() >= 0);
});

test("perf helpers are safe without a DOM and ?perf is off", () => {
  assert.equal(perfEnabled(), false); // no location in node
  perfClear();
  assert.equal(perfEnd("never-started", "x"), null);
  perfEndPainted("never-started", "x");
  perfStart("open-agent", "a1");
  assert.ok(perfEnd("open-agent", "a1") >= 0);
  perfRecord("roster-fetch", 12.34, "agents=3");
  perfSendBegin("a1", "vibesquad", "feel");
  perfSendResolved("a1");
  perfSendEvent("a1", false);
  assert.ok(perfEntries().length >= 2);
  assert.match(perfReportText(), /roster-fetch: n=1 median=12.3ms/);
});

test("PerfOverlay renders nothing unless ?perf is set", () => {
  const src = readFileSync(new URL("../src/PerfOverlay.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(!perfEnabled\(\)\) return null;/);
  assert.match(src, /clipboard\.writeText/);
});

test("before(agent.create) and agent.created each log one hook-timing metric", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-feel-test-"));
  const vsHome = join(dir, ".vibesquad");
  mkdirSync(vsHome, { recursive: true });
  const teamsFile = join(vsHome, "teams.json");
  writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "feel", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }));
  const profilesFile = join(vsHome, "profiles.json");
  writeFileSync(profilesFile, JSON.stringify({ profiles: [] }));
  const prev = { h: process.env.VIBESQUAD_HOME, t: process.env.VIBESQUAD_TEAMS_FILE, p: process.env.VIBESQUAD_PROFILES_PATH };
  process.env.VIBESQUAD_HOME = vsHome;
  process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
  process.env.VIBESQUAD_PROFILES_PATH = profilesFile;
  try {
    const before = new Map();
    const on = new Map();
    const server = {
      before: (n, f) => (before.set(n, f), () => {}),
      on: (n, f) => (on.set(n, f), () => {}),
    };
    createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {} })(server);
    const cwd = "/projects/VibeSquad";
    before.get("agent.create")({ request: { config: { cwd, provider: "claude", title: "w" }, labels: { team: "vibesquad", lane: "feel", role: "worker" } } });
    const agent = { id: "a1", cwd, title: "w", labels: { team: "vibesquad", lane: "feel", role: "worker" } };
    const paseo = {
      agents: {
        ref: () => ({ refresh: async () => ({ agent }), detach: async () => {}, send: async () => {}, timeline: { refetch: async () => ({ entries: [] }) } }),
        list: async () => ({ entries: [{ agent }] }),
      },
    };
    await on.get("agent.created")({ agent }, { paseo });
    await new Promise((r) => setImmediate(r)); // metrics flush after the hook returns
    const log = join(vsHome, "teams", "vibesquad", "log.jsonl");
    assert.ok(existsSync(log));
    const texts = readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).text);
    assert.equal(texts.filter((t) => t.startsWith("hook-timing hook=before.agent.create")).length, 1);
    assert.equal(texts.filter((t) => t.startsWith("hook-timing hook=agent.created")).length, 1);
    assert.ok(texts.some((t) => /^hook-timing hook=before\.agent\.create total=\d+/.test(t)));
  } finally {
    for (const [k, v] of [["VIBESQUAD_HOME", prev.h], ["VIBESQUAD_TEAMS_FILE", prev.t], ["VIBESQUAD_PROFILES_PATH", prev.p]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
