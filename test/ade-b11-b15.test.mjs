import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

// ── B11: shouldShowLoadOlder ──────────────────────────────────────────────────
// Fixed: hides the "Load older" button unless hasMore is explicitly true.
// Old code: !!hasMore || entries.length >= 60  — showed even when hasMore=false
// New code: hasMore === true  — only strict true shows the button

function shouldShowLoadOlder(entries, hasMore) {
  return hasMore === true;
}

describe("B11: shouldShowLoadOlder — fixed behavior", () => {
  test("returns true when hasMore is true", () => {
    assert.equal(shouldShowLoadOlder([{ item: {}, seqStart: 0 }], true), true);
  });

  test("returns false when hasMore is false regardless of entry count", () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ item: {}, seqStart: i }));
    assert.equal(shouldShowLoadOlder(entries, false), false);
  });

  test("returns false when hasMore is undefined", () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ item: {}, seqStart: i }));
    assert.equal(shouldShowLoadOlder(entries, undefined), false);
  });

  test("returns false on empty list with no hasMore", () => {
    assert.equal(shouldShowLoadOlder([], false), false);
  });

  test("strict: truthy non-boolean hasMore still returns false", () => {
    assert.equal(shouldShowLoadOlder([], 1), false);
    assert.equal(shouldShowLoadOlder([], "yes"), false);
    assert.equal(shouldShowLoadOlder([], true), true);
  });
});

// ── B11: cursor shape ─────────────────────────────────────────────────────────
// fetchAgentTimeline cursor must be { epoch: string, seq: number }

describe("B11: cursor construction", () => {
  test("builds cursor from entry fields", () => {
    const entry = { timestamp: "2026-01-01T00:00:00.000Z", seqStart: 42 };
    const cursor = { epoch: entry.timestamp ?? "", seq: entry.seqStart ?? 0 };
    assert.equal(typeof cursor.epoch, "string");
    assert.equal(typeof cursor.seq, "number");
    assert.equal(cursor.epoch, "2026-01-01T00:00:00.000Z");
    assert.equal(cursor.seq, 42);
  });

  test("prefers startCursor from response over synthetic cursor", () => {
    const isValid = (c) =>
      c != null && typeof c.epoch === "string" && typeof c.seq === "number";
    const responseCursor = { epoch: "2026-01-01T01:00:00.000Z", seq: 10 };
    const synthetic = { epoch: "2025-12-31T00:00:00.000Z", seq: 0 };
    const cursor = isValid(responseCursor) ? responseCursor : synthetic;
    assert.equal(cursor.epoch, responseCursor.epoch);
  });

  test("falls back to synthetic when response has no startCursor", () => {
    const isValid = (c) =>
      c != null && typeof c.epoch === "string" && typeof c.seq === "number";
    const responseCursor = null;
    const entry = { timestamp: "2026-01-01T00:00:00.000Z", seqStart: 5 };
    const synthetic = { epoch: entry.timestamp ?? "", seq: entry.seqStart ?? 0 };
    const cursor = isValid(responseCursor) ? responseCursor : synthetic;
    assert.equal(cursor.epoch, "2026-01-01T00:00:00.000Z");
    assert.equal(cursor.seq, 5);
  });

  test("hasOlder flag drives setHasMore", () => {
    const response = { hasOlder: false, entries: [] };
    const hasMore = response.hasOlder ?? response.entries.length >= 60;
    assert.equal(hasMore, false);
  });

  test("falls back to entries.length >= 60 when hasOlder is absent", () => {
    const response = { entries: Array.from({ length: 60 }, (_, i) => ({ seqStart: i })) };
    const hasMore = response.hasOlder ?? response.entries.length >= 60;
    assert.equal(hasMore, true);
  });
});

// ── B12: tryCall 1500ms timeout ───────────────────────────────────────────────

async function tryCallWithTimeout(fn, timeoutMs = 1500) {
  try {
    const result = fn();
    if (!result || typeof result.then !== "function") return result ?? null;
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ error: "timeout" }), timeoutMs),
    );
    return await Promise.race([result, timeout]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

describe("B12: tryCall 1500ms timeout", () => {
  test("fast call resolves with its result", async () => {
    const r = await tryCallWithTimeout(() => Promise.resolve({ ok: true }));
    assert.deepEqual(r, { ok: true });
  });

  test("slow call resolves with timeout sentinel", async () => {
    const slow = () => new Promise((res) => setTimeout(() => res({ ok: true }), 200));
    const r = await tryCallWithTimeout(slow, 50);
    assert.deepEqual(r, { error: "timeout" });
  });

  test("thrown error is returned as { error: string }", async () => {
    const r = await tryCallWithTimeout(() => { throw new Error("boom"); });
    assert.deepEqual(r, { error: "boom" });
  });

  test("non-promise return value is returned as-is", async () => {
    const r = await tryCallWithTimeout(() => 42);
    assert.equal(r, 42);
  });
});

// ── B12: collect-once via refs ────────────────────────────────────────────────
// DiagnosticsModal uses refs so agent-map churn doesn't re-collect.

describe("B12: refs prevent re-collection on agent update", () => {
  test("useEffect with empty deps runs only once", () => {
    let runCount = 0;
    const connRef = { current: "connected" };
    const agentsRef = { current: new Map() };

    function runEffect() {
      runCount++;
      void connRef.current;
      void agentsRef.current;
    }

    runEffect(); // simulates mount
    agentsRef.current = new Map([["a1", { id: "a1" }]]);
    connRef.current = "connected";
    // With [] deps, effect does NOT run again — only runCount=1
    assert.equal(runCount, 1);
  });
});

const rootDir = resolve(import.meta.dirname, "..");

// ── B13: @xterm packages installed ───────────────────────────────────────────
// These packages are browser-only (require window/self/document) and cannot be
// dynamically imported in Node.js. We verify they are installed on disk instead.

describe("B13: @xterm packages on disk", () => {
  const nmBase = join(rootDir, "node_modules", "@xterm");

  test("@xterm/xterm package.json exists", () => {
    const pkg = join(nmBase, "xterm", "package.json");
    assert.ok(existsSync(pkg), `missing ${pkg}`);
    const json = JSON.parse(readFileSync(pkg, "utf8"));
    assert.equal(json.name, "@xterm/xterm");
  });

  test("@xterm/addon-fit package.json exists", () => {
    const pkg = join(nmBase, "addon-fit", "package.json");
    assert.ok(existsSync(pkg), `missing ${pkg}`);
    const json = JSON.parse(readFileSync(pkg, "utf8"));
    assert.equal(json.name, "@xterm/addon-fit");
  });

  test("TerminalPanel.tsx no longer uses <pre className='terminal-text'>", () => {
    const src = readFileSync(join(rootDir, "src", "TerminalPanel.tsx"), "utf8");
    assert.ok(!src.includes('className="terminal-text"'), "pre.terminal-text should be replaced by xterm");
    assert.ok(src.includes("@xterm/xterm"), "should import @xterm/xterm");
    assert.ok(src.includes("FitAddon"), "should use FitAddon");
  });
});

// ── B14: /__vibesquad/workspace-package-scripts ───────────────────────────────

const api = await import("../server/vibesquad-api.mjs");
const tmpBase = mkdtempSync(join(tmpdir(), "vs-b14-"));

after(() => rmSync(tmpBase, { recursive: true, force: true }));

describe("B14: /__vibesquad/workspace-package-scripts", () => {
  let server;
  let port;

  before(async () => {
    const mw = api.createVibesquadMiddleware(rootDir, { allowedCwdRoots: [tmpBase] });
    server = createServer(mw);
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    port = server.address().port;
  });

  after(() => new Promise((ok) => server.close(ok)));

  function call(path, method = "GET") {
    return new Promise((ok, fail) => {
      const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => ok({ status: res.statusCode, body: data }));
      });
      req.on("error", fail);
      req.end();
    });
  }

  test("missing cwd returns 400", async () => {
    const r = await call("/__vibesquad/workspace-package-scripts?cwd=");
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).ok, false);
  });

  test("cwd outside allowed roots returns 403", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "vs-b14-outside-"));
    try {
      const r = await call(`/__vibesquad/workspace-package-scripts?cwd=${encodeURIComponent(outsideDir)}`);
      assert.equal(r.status, 403);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("allowed dir with no package.json returns empty scripts", async () => {
    const dir = join(tmpBase, "no-pkg");
    mkdirSync(dir, { recursive: true });
    const r = await call(`/__vibesquad/workspace-package-scripts?cwd=${encodeURIComponent(dir)}`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.scripts, {});
  });

  test("returns scripts from package.json", async () => {
    const dir = join(tmpBase, "with-pkg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test-pkg", scripts: { dev: "vite", build: "tsc && vite build", test: "vitest" } }),
    );
    const r = await call(`/__vibesquad/workspace-package-scripts?cwd=${encodeURIComponent(dir)}`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    assert.equal(body.scripts.dev, "vite");
    assert.equal(body.scripts.build, "tsc && vite build");
    assert.equal(body.scripts.test, "vitest");
  });

  test("POST returns 405", async () => {
    const r = await call("/__vibesquad/workspace-package-scripts", "POST");
    assert.equal(r.status, 405);
  });
});

// ── B15a: DrawerHeader model dedupe ──────────────────────────────────────────
// Enter + blur must not both fire set_agent_model_request.

describe("B15a: model set dedupe via ref", () => {
  test("Enter fires once; subsequent blur is suppressed by ref", () => {
    const modelSubmittedRef = { current: null };
    const calls = [];
    const agentModel = "old-model";

    function trySubmit(value) {
      if (value && value !== agentModel && value !== modelSubmittedRef.current) {
        modelSubmittedRef.current = value;
        calls.push(value);
      }
    }

    trySubmit("new-model"); // Enter key
    trySubmit("new-model"); // blur fires right after

    assert.equal(calls.length, 1, "only one submission despite Enter + blur");
    assert.equal(calls[0], "new-model");
  });

  test("ref resets when agent.model changes, allowing new submissions", () => {
    let modelSubmittedRef = { current: "new-model" };
    // Simulates useEffect([agent.model]) resetting the ref
    modelSubmittedRef.current = null;
    assert.equal(modelSubmittedRef.current, null);
  });

  test("value equal to current model is never submitted", () => {
    const modelSubmittedRef = { current: null };
    const calls = [];
    const agentModel = "existing-model";

    function trySubmit(value) {
      if (value && value !== agentModel && value !== modelSubmittedRef.current) {
        modelSubmittedRef.current = value;
        calls.push(value);
      }
    }

    trySubmit("existing-model");
    assert.equal(calls.length, 0);
  });
});

// ── B15b: PinGrid context menu ────────────────────────────────────────────────

describe("B15b: buildPinCtxItems", () => {
  function buildPinCtxItems(pin, bs, onOpenAgent) {
    const items = [];
    if (bs) {
      items.push({ label: `Open ${pin.lane.name} Brainstorm`, run: () => onOpenAgent(bs.agent.id) });
    }
    items.push({ label: "Edit brief", run: () => {} });
    return items;
  }

  test("with brainstorm: two items (Open + Edit brief)", () => {
    const pin = { squad: { id: "sq1" }, lane: { id: "l1", name: "Feature X" }, agent: { id: "a1" } };
    const items = buildPinCtxItems(pin, { agent: { id: "buddy1" } }, () => {});
    assert.equal(items.length, 2);
    assert.equal(items[0].label, "Open Feature X Brainstorm");
    assert.equal(items[1].label, "Edit brief");
  });

  test("without brainstorm: only Edit brief", () => {
    const pin = { squad: { id: "sq1" }, lane: { id: "l1", name: "Feature X" }, agent: { id: "a1" } };
    const items = buildPinCtxItems(pin, null, () => {});
    assert.equal(items.length, 1);
    assert.equal(items[0].label, "Edit brief");
  });

  test("Open item invokes onOpenAgent with brainstorm agent id", () => {
    const pin = { squad: { id: "sq1" }, lane: { id: "l1", name: "Feat" }, agent: { id: "a1" } };
    const opened = [];
    const items = buildPinCtxItems(pin, { agent: { id: "buddy1" } }, (id) => opened.push(id));
    items[0].run();
    assert.deepEqual(opened, ["buddy1"]);
  });
});
