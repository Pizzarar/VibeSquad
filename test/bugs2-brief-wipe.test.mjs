// docs/PLAN_BUGS_BATCH2.md URGENT block: the Who's here writer wiped docs/brainstorm/vibesquad.md to 80 bytes
// (2026-11-02 ~15:35Z), and (e) Who's here showed "none running / none" while the lane's Buddy and lead were live.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { snapshotIntoBrief } from "../server/hooks/agent-duties.ts";
import { performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";
import { writeBriefFile } from "../server/brief-write.mjs";
import { refreshWhosHere, whosHereBody } from "../server/whos-here.mjs";

// Mock-Paseo-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo.
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

const BIG = `# Brainstorm Summary · VIBESQUAD (\`vibesquad\`)\n\n> brief\n\n## Decided\n${"- a decision that matters\n".repeat(60)}\n## Open\n- none\n`;

async function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vs-brief-wipe-"));
  const keys = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  mkdirSync(process.env.VIBESQUAD_HOME, { recursive: true });
  // Hermetic registry: a real lane in ~/.vibesquad would redirect the brief to its project dir.
  writeFileSync(join(dir, "teams.json"), '{"teams":[]}');
  process.env.VIBESQUAD_TEAMS_FILE = join(dir, "teams.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  try {
    await fn(dir);
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
}

const historyOf = (lane) => {
  const d = join(process.env.VIBESQUAD_HOME, "brief-history", lane);
  return existsSync(d) ? readdirSync(d) : [];
};

// Live snapshots (paseo, 2026-11-02) of the two agents the vibesquad brief left out; role as it was then.
const HUB_BUDDY = {
  id: "a38b803b-0000-0000-0000-000000000000",
  title: "Hub Buddy",
  status: "idle",
  labels: { team: "vibesquad", lane: "vibesquad", lead: "vibesquad", role: "brainstorm", profile: "Brainstorm - Claude", "vs.restarted-from": "start-brainstorm", "vs.fresh-session": "brief" },
};
const HUB6 = {
  id: "ee6c4542-0000-0000-0000-000000000000",
  title: "★ Hub6 · handoff",
  status: "idle",
  labels: { role: "lead", team: "vibesquad", lane: "vibesquad", profile: "Lead - Claude", ord: "6", job: "handoff", "paseo.parent-server-id": "srv_y4w_YYb5vJ_0", "handoff-flagged": "1", "handoff-ready": "1" },
};

test("refreshWhosHere that reads an empty brief leaves the file untouched (the 80-byte wipe)", () =>
  withHome(async (dir) => {
    const f = join(dir, "docs", "brainstorm", "vibesquad.md");
    writeFileSync(f, "", "utf8");
    const r = refreshWhosHere({ laneId: "vibesquad", agents: [HUB_BUDDY, HUB6], rootDir: dir });
    assert.equal(r.changed, false);
    assert.equal(r.skipped, "not-a-brief");
    assert.equal(readFileSync(f, "utf8"), "");
    // A file that is only a Who's here section (what the wipe left) is not a brief either.
    writeFileSync(f, "\n\n## Who's here\n- Brainstorm: x\n- Lead: none\n- Workers: 0\n", "utf8");
    assert.equal(refreshWhosHere({ laneId: "vibesquad", agents: [HUB6], rootDir: dir }).skipped, "not-a-brief");
    assert.match(readFileSync(f, "utf8"), /Brainstorm: x/);
  }));

test("refreshWhosHere with an unknown agent list writes nothing", () =>
  withHome(async (dir) => {
    const f = join(dir, "docs", "brainstorm", "vibesquad.md");
    writeFileSync(f, BIG, "utf8");
    for (const agents of [null, undefined]) {
      assert.equal(refreshWhosHere({ laneId: "vibesquad", agents, rootDir: dir }).skipped, "agents-unknown");
    }
    assert.equal(readFileSync(f, "utf8"), BIG);
  }));

test("refreshWhosHere writes through writeBriefFile: backup kept, no temp files left", () =>
  withHome(async (dir) => {
    const f = join(dir, "docs", "brainstorm", "vibesquad.md");
    writeFileSync(f, BIG, "utf8");
    const r = refreshWhosHere({ laneId: "vibesquad", agents: [HUB_BUDDY, HUB6], rootDir: dir });
    assert.equal(r.changed, true);
    const out = readFileSync(f, "utf8");
    assert.ok(out.startsWith("# Brainstorm Summary"), "brief body kept");
    assert.match(out, /## Who's here\n- Brainstorm: Hub Buddy\n- Lead: ★ Hub6 · handoff\n- Workers: 0\n\n## Decided/);
    assert.equal(historyOf("vibesquad").length, 1, "the old brief was backed up");
    assert.deepEqual(readdirSync(join(dir, "docs", "brainstorm")), ["vibesquad.md"], "no .tmp left behind");
  }));

test("writeBriefFile refuses a big→tiny replace, keeps the old brief and backs it up", () =>
  withHome(async (dir) => {
    const f = join(dir, "docs", "brainstorm", "vibesquad.md");
    writeFileSync(f, BIG, "utf8");
    const tiny = "\n\n## Who's here\n- Brainstorm: BRAINSTORM · VIBESQUAD\n- Lead: none\n- Workers: 0";
    assert.throws(() => writeBriefFile(f, "vibesquad", tiny), /Refusing to replace/);
    assert.equal(readFileSync(f, "utf8"), BIG);
    const hist = historyOf("vibesquad");
    assert.equal(hist.length, 1);
    assert.equal(readFileSync(join(process.env.VIBESQUAD_HOME, "brief-history", "vibesquad", hist[0]), "utf8"), BIG);
  }));

test("(e) Who's here lists the live Hub Buddy and Hub6 from their real snapshots", () => {
  const body = whosHereBody([HUB_BUDDY, HUB6, { id: "w", status: "running", labels: { team: "vibesquad", lane: "vibesquad", role: "worker" } }], "vibesquad");
  assert.equal(body, "- Brainstorm: Hub Buddy\n- Lead: ★ Hub6 · handoff\n- Workers: 1");
  // Plugin list entries come as { agent } wrappers too.
  assert.equal(whosHereBody([{ agent: HUB_BUDDY }, { agent: HUB6 }], "vibesquad"), "- Brainstorm: Hub Buddy\n- Lead: ★ Hub6 · handoff\n- Workers: 0");
});

test("(e) a Buddy hard-limit retire over HTTP (no body.agents) reads the daemon instead of writing an empty roster", () =>
  withHome(async (dir) => {
    resetBrainstormRestartState();
    const f = join(dir, "docs", "brainstorm", "vibesquad.md");
    writeFileSync(f, BIG, "utf8");
    const agents = new Map(
      [
        { ...HUB_BUDDY, id: "bs-old", title: "BRAINSTORM · VIBESQUAD" },
        HUB_BUDDY,
        HUB6,
        { id: "w1", status: "running", labels: { team: "vibesquad", lane: "vibesquad", role: "worker" } },
      ].map((a) => [a.id, structuredClone(a)]),
    );
    const d = {
      async fetchAgents() {
        return { entries: [...agents.values()].filter((a) => !a.archivedAt).map((agent) => ({ agent })), pageInfo: { hasMore: false } };
      },
      async fetchAgent(id) {
        return { agent: agents.get(id) ?? null };
      },
      async detachAgent() {},
      async archiveAgent(id) {
        agents.get(id).archivedAt = "x";
        return { archivedAt: "x" };
      },
      async cancelAgent() {},
      async updateAgent(id, { name, labels }) {
        const a = agents.get(id);
        if (a) Object.assign(a, name ? { title: name } : {}, { labels: { ...a.labels, ...labels } });
      },
    };
    const r = await performBrainstormRestart({ agentId: "bs-old", reason: "auto-hard-limit", teamId: "vibesquad", laneId: "vibesquad", daemonClient: d, usedTokens: 200000 }, dir);
    assert.equal(r.retired, true, JSON.stringify(r));
    const out = readFileSync(f, "utf8");
    assert.match(out, /## Who's here\n- Brainstorm: Hub Buddy\n- Lead: ★ Hub6 · handoff\n- Workers: 1\n/);
    assert.ok(out.includes("## Decided"), "brief kept");
  }));

test("snapshotIntoBrief never appends to an empty read", () =>
  withHome(async (dir) => {
    const f = join(dir, "docs", "brainstorm", "vibesquad.md");
    writeFileSync(f, "", "utf8");
    utimesSync(f, new Date(0), new Date(0));
    const old = { id: "oldbuddy", updatedAt: new Date().toISOString() };
    assert.equal(snapshotIntoBrief(dir, "vibesquad", old, "last turn"), "missing");
    assert.equal(readFileSync(f, "utf8"), "");
    writeFileSync(f, BIG, "utf8");
    utimesSync(f, new Date(0), new Date(0));
    assert.equal(snapshotIntoBrief(dir, "vibesquad", old, "last turn"), "snapshotted");
    assert.equal(historyOf("vibesquad").length, 1, "snapshot write is backed up");
  }));
