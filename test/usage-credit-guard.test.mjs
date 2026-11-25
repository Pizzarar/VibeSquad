// usa-66 (idea-963): prepaid provider credit poll (DeepSeek), threshold needs-you with persisted dedupe & re-arm,
// secret non-leakage, settings threshold, and vs.arm / vs.arm-reason on merged unit rows (including ledger fold).
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CREDIT_POLL_INTERVAL_MS,
  CreditStore,
  createCreditPoller,
  fetchDeepSeekBalance,
  findDeepSeekApiKey,
  parseDeepSeekBalance,
  redactSecret,
} from "../runner/limits.mjs";
import { Runner } from "../runner/runner.mjs";
import { readCredits } from "../server/limits-read.mjs";
import {
  DEFAULT_CREDIT_THRESHOLD_USD,
  evaluateCreditAlerts,
  formatCreditAlertMessage,
  readCreditAlertState,
  startCreditGuardWatcher,
} from "../server/credit-guard.mjs";
import {
  clearUsageCache,
  getUsage,
  loadRunnerSettings,
  normalizeRunnerSettings,
  saveRunnerSettings,
} from "../server/providers-catalog.mjs";
import { ARM_LABEL, ARM_REASON_LABEL } from "../server/exp6-arm.mjs";
import "./helpers/keep-alive.mjs";

const FAKE_KEY = "sk-test-fake-deepseek-key-9999";
const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
});
function makeTmp(prefix = "vs-usa66-") {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function makeHome() {
  const dir = makeTmp("vs-usa66-home-");
  mkdirSync(path.join(dir, "runner", "agents"), { recursive: true });
  return dir;
}
function writeAgentLog(home, id, events) {
  writeFileSync(path.join(home, "runner", "agents", `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
function fakeGit(commits) {
  const rev = [...commits].reverse();
  const lines = rev.map((c, i) => {
    const p1 = rev[i + 1]?.sha ?? "0000000";
    const p2 = `side${i}`;
    const ct = Math.floor(Date.parse(c.ts) / 1000);
    return `${c.sha}\x1f${p1} ${p2}\x1f${ct}\x1f${c.subject}`;
  });
  return (args) => {
    if (args[0] === "rev-parse") return rev[0]?.sha ?? "0000000";
    if (args[0] === "log" && args.includes("--numstat")) return "";
    if (args[0] === "log") return lines.join("\n") + "\n";
    return "";
  };
}

test("parseDeepSeekBalance: parses USD balance, prefers USD over CNY, handles string JSON and invalid payloads", () => {
  assert.deepEqual(
    parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "50.00" },
        { currency: "USD", total_balance: "7.12", granted_balance: "0.00", topped_up_balance: "7.12" },
      ],
    }),
    { balance: 7.12, currency: "USD", isAvailable: true },
  );
  assert.deepEqual(
    parseDeepSeekBalance(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.5" }] })),
    { balance: 12.5, currency: "CNY", isAvailable: true },
  );
  assert.equal(parseDeepSeekBalance({ is_available: false, balance_infos: [] }), null);
  assert.equal(parseDeepSeekBalance({ balance_infos: [{ currency: "USD", total_balance: "not-a-num" }] }), null);
  assert.equal(parseDeepSeekBalance("not json"), null);
  assert.equal(parseDeepSeekBalance(null), null);
});

test("findDeepSeekApiKey: reads env, opencode.db sqlite, auth.json fallback, and returns null when absent", async () => {
  // 1. Env takes precedence
  assert.equal(await findDeepSeekApiKey({ env: { DEEPSEEK_API_KEY: `  ${FAKE_KEY}  ` }, realHome: makeTmp() }), FAKE_KEY);

  // 2. opencode SQLite credential table in isolated temp home
  const fakeHomeDb = makeTmp("vs-opencode-db-");
  const dbDir = path.join(fakeHomeDb, ".local", "share", "opencode");
  mkdirSync(dbDir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dbDir, "opencode.db"));
  db.exec("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER)");
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?)").run(
    "cred_1",
    "deepseek",
    "DeepSeek",
    JSON.stringify({ type: "key", key: FAKE_KEY }),
    1,
    1000,
  );
  db.close();
  assert.equal(await findDeepSeekApiKey({ env: {}, realHome: fakeHomeDb }), FAKE_KEY);

  // 3. auth.json fallback
  const fakeHomeJson = makeTmp("vs-opencode-json-");
  const cfgDir = path.join(fakeHomeJson, ".config", "opencode");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path.join(cfgDir, "auth.json"), JSON.stringify({ deepseek: { key: FAKE_KEY } }));
  assert.equal(await findDeepSeekApiKey({ env: {}, realHome: fakeHomeJson }), FAKE_KEY);

  // 4. Missing everywhere -> null
  assert.equal(await findDeepSeekApiKey({ env: {}, realHome: makeTmp("vs-opencode-empty-") }), null);

  // 5. Real developer home is refused under test runner
  assert.equal(await findDeepSeekApiKey({ env: {}, realHome: os.homedir() }), null);
});

test("fetchDeepSeekBalance: refuses real network under test runner, handles no-key, 200 ok, HTTP/network errors without leaking key", async () => {
  // No key -> quiet no-key status, no network
  assert.deepEqual(await fetchDeepSeekBalance({ key: "" }), {
    provider: "deepseek",
    balance: null,
    currency: null,
    status: "no-key",
  });

  // Real network refused under test runner without fetchImpl
  await assert.rejects(fetchDeepSeekBalance({ key: FAKE_KEY }), /refusing to fetch DeepSeek balance/);

  // Mocked 200 response
  let seenAuth = "";
  const ok = await fetchDeepSeekBalance({
    key: FAKE_KEY,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.deepseek.com/user/balance");
      seenAuth = init.headers.Authorization;
      return {
        ok: true,
        json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "14.50" }] }),
      };
    },
  });
  assert.equal(seenAuth, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(ok, { provider: "deepseek", balance: 14.5, currency: "USD", status: "ok" });

  // Error path never leaks key even when fetch throws an error containing it
  const errRes = await fetchDeepSeekBalance({
    key: FAKE_KEY,
    fetchImpl: async () => { throw new Error(`network failure with ${FAKE_KEY}`); },
  });
  assert.deepEqual(errRes, { provider: "deepseek", balance: null, currency: null, status: "error" });
  assert.equal(JSON.stringify(errRes).includes(FAKE_KEY), false);
  assert.equal(redactSecret(`oops ${FAKE_KEY} leaked`, FAKE_KEY), "oops [REDACTED] leaked");
});

test("createCreditPoller + CreditStore: caches & throttles at 30 min, persists to credits.json, handles no-key quietly", async () => {
  const home = makeHome();
  const store = new CreditStore(path.join(home, "runner", "credits.json"));
  let t = Date.parse("2026-11-25T10:00:00Z");
  let fetchCalls = 0;

  // No-key case
  const noKeyPoller = createCreditPoller({
    store,
    now: () => t,
    resolveKey: async () => null,
    fetchImpl: async () => { fetchCalls++; throw new Error("should not fetch without key"); },
  });
  const nk = await noKeyPoller();
  assert.equal(fetchCalls, 0);
  assert.equal(nk.length, 1);
  assert.equal(nk[0].provider, "deepseek");
  assert.equal(nk[0].status, "no-key");
  assert.equal(nk[0].balance, null);

  // Live poll + 30 min throttle/cache
  const poller = createCreditPoller({
    store,
    minIntervalMs: CREDIT_POLL_INTERVAL_MS,
    now: () => t,
    resolveKey: async () => FAKE_KEY,
    fetchImpl: async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: fetchCalls === 1 ? "18.25" : "8.40" }] }),
      };
    },
  });
  const first = await poller();
  assert.equal(fetchCalls, 1);
  assert.equal(first[0].balance, 18.25);
  assert.equal(first[0].status, "ok");

  // 10 min later -> throttled, returns cached value without refetching
  t += 10 * 60_000;
  const cached = await poller();
  assert.equal(fetchCalls, 1);
  assert.equal(cached[0].balance, 18.25);

  // 31 min after first -> polls again
  t += 21 * 60_000;
  const second = await poller();
  assert.equal(fetchCalls, 2);
  assert.equal(second[0].balance, 8.4);

  // Persisted file has expected shape and NO secret key
  const rawDisk = readFileSync(path.join(home, "runner", "credits.json"), "utf8");
  assert.equal(rawDisk.includes(FAKE_KEY), false);
  const fromRead = readCredits(home);
  assert.equal(fromRead.length, 1);
  assert.equal(fromRead[0].provider, "deepseek");
  assert.equal(fromRead[0].balance, 8.4);
  assert.equal(fromRead[0].currency, "USD");
  assert.equal(fromRead[0].status, "ok");
  assert.ok(fromRead[0].checkedAt);

  // Exposed on getUsage({ home }) with no key leakage
  clearUsageCache();
  const usage = getUsage({ home, git: () => "" });
  assert.deepEqual(usage.credits, fromRead);
  assert.equal(usage.creditThresholdUsd, DEFAULT_CREDIT_THRESHOLD_USD);
  assert.equal(JSON.stringify(usage).includes(FAKE_KEY), false);
});

test("Runner polls credits after an opencode turn_done and persists credits.json", async () => {
  const home = makeTmp("vs-runner-credits-");
  let fetchCalls = 0;
  const adapter = {
    start({ emit }) {
      setImmediate(() => emit("turn_done", {}));
      return { send() {}, cancel() {}, kill() {} };
    },
  };
  const runner = new Runner({
    dir: path.join(home, "agents"),
    adapters: { opencode: adapter },
    pollCredits: true,
    creditResolveKey: async () => FAKE_KEY,
    creditFetch: async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "11.00" }] }) };
    },
  });
  runner.create({ provider: "opencode", cwd: home });
  await new Promise((r) => setTimeout(r, 50));
  runner.shutdown();
  assert.equal(fetchCalls, 1);
  assert.equal(existsSync(path.join(home, "credits.json")), true);
  const raw = readFileSync(path.join(home, "credits.json"), "utf8");
  assert.equal(raw.includes(FAKE_KEY), false);
  assert.equal(JSON.parse(raw).credits.deepseek.balance, 11);
});

test("credit-guard: threshold crossing fires once, dedupes across restart, re-arms above threshold, and respects settings threshold", async () => {
  const home = makeHome();
  // Settings default + configurable threshold
  assert.equal(normalizeRunnerSettings({}).creditGuard.thresholdUsd, 10);
  saveRunnerSettings({ creditGuard: { thresholdUsd: 15 } }, home);
  assert.equal(loadRunnerSettings(home).creditGuard.thresholdUsd, 15);
  assert.equal(formatCreditAlertMessage({ provider: "deepseek", balance: 7.12, currency: "USD", thresholdUsd: 10 }), "DeepSeek credit $7.12 < $10 threshold: top up");

  let t = Date.parse("2026-11-25T12:00:00Z");
  const logs = [];
  const log = async (entry) => { logs.push(entry); };
  const threshold = loadRunnerSettings(home).creditGuard.thresholdUsd; // 15

  // 1. Above threshold -> no alert
  let fired = await evaluateCreditAlerts({
    credits: [{ provider: "deepseek", balance: 20, currency: "USD", checkedAt: new Date(t).toISOString(), status: "ok" }],
    home,
    thresholdUsd: threshold,
    now: () => t,
    log,
  });
  assert.equal(fired.length, 0);
  assert.equal(logs.length, 0);

  // 2. Crosses below threshold -> fires ONCE
  t += 30 * 60_000;
  fired = await evaluateCreditAlerts({
    credits: [{ provider: "deepseek", balance: 12.34, currency: "USD", checkedAt: new Date(t).toISOString(), status: "ok" }],
    home,
    thresholdUsd: threshold,
    now: () => t,
    log,
  });
  assert.equal(fired.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].text, "DeepSeek credit $12.34 < $15 threshold: top up");
  assert.equal(logs[0].text.includes(FAKE_KEY), false);

  // 3. Still below threshold -> no second alert
  t += 30 * 60_000;
  fired = await evaluateCreditAlerts({
    credits: [{ provider: "deepseek", balance: 9.0, currency: "USD", checkedAt: new Date(t).toISOString(), status: "ok" }],
    home,
    thresholdUsd: threshold,
    now: () => t,
    log,
  });
  assert.equal(fired.length, 0);
  assert.equal(logs.length, 1);

  // 4. Simulated "server restart": fresh startCreditGuardWatcher reading persisted <home>/runner/credit-alerts.json does NOT re-fire
  assert.equal(readCreditAlertState(home).providers.deepseek.alerted, true);
  let balanceNow = 8.5;
  const watcherAfterRestart = startCreditGuardWatcher({
    home,
    intervalMs: 60_000,
    getThreshold: () => loadRunnerSettings(home).creditGuard.thresholdUsd,
    resolveKey: async () => FAKE_KEY,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: String(balanceNow) }] }),
    }),
    log,
    now: () => t,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  // Wait for initial tick from startCreditGuardWatcher
  await new Promise((r) => setTimeout(r, 30));
  watcherAfterRestart.stop();
  assert.equal(logs.length, 1, "restart must not re-fire already-alerted crossing");

  // 5. Error / no-key does not re-arm
  t += 30 * 60_000;
  await evaluateCreditAlerts({
    credits: [{ provider: "deepseek", balance: null, currency: null, checkedAt: new Date(t).toISOString(), status: "error" }],
    home,
    thresholdUsd: threshold,
    now: () => t,
    log,
  });
  assert.equal(readCreditAlertState(home).providers.deepseek.alerted, true);

  // 6. Rises back above threshold -> re-arms (no alert fired)
  t += 30 * 60_000;
  fired = await evaluateCreditAlerts({
    credits: [{ provider: "deepseek", balance: 50.0, currency: "USD", checkedAt: new Date(t).toISOString(), status: "ok" }],
    home,
    thresholdUsd: threshold,
    now: () => t,
    log,
  });
  assert.equal(fired.length, 0);
  assert.equal(readCreditAlertState(home).providers.deepseek.alerted, false);

  // 7. Crosses below threshold again after re-arm -> fires a second alert
  t += 30 * 60_000;
  fired = await evaluateCreditAlerts({
    credits: [{ provider: "deepseek", balance: 6.5, currency: "USD", checkedAt: new Date(t).toISOString(), status: "ok" }],
    home,
    thresholdUsd: threshold,
    now: () => t,
    log,
  });
  assert.equal(fired.length, 1);
  assert.equal(logs.length, 2);
  assert.equal(logs[1].text, "DeepSeek credit $6.50 < $15 threshold: top up");

  // Verify persisted state file never contains fake key
  const stateDisk = readFileSync(path.join(home, "runner", "credit-alerts.json"), "utf8");
  assert.equal(stateDisk.includes(FAKE_KEY), false);
});

test("merged unit rows carry implementerArm and implementerArmReason from vs.arm / vs.arm-reason including ledger fold", () => {
  clearUsageCache();
  const home = makeHome();

  writeAgentLog(home, "ag-neon", [
    {
      type: "created",
      ts: "2026-11-25T10:00:00Z",
      provider: "antigravity-cli",
      model: "gemini-4-neon",
      cwd: "/tmp/wt/unit-usa-arm1",
      meta: {
        role: "worker",
        lane: "usage",
        profile: "Implement",
        labels: {
          [ARM_LABEL]: "neon",
          [ARM_REASON_LABEL]: "alternation",
          "vs.route": "stakes=normal model=gemini-4-neon family=antigravity-cli",
        },
      },
    },
    { type: "turn_done", ts: "2026-11-25T10:05:00Z", costUsd: 0.25 },
  ]);

  writeAgentLog(home, "ag-sonnet", [
    {
      type: "created",
      ts: "2026-11-25T11:00:00Z",
      provider: "claude",
      model: "claude-sonnet-5-5",
      cwd: "/tmp/wt/unit-usa-arm2",
      meta: {
        role: "worker",
        lane: "usage",
        profile: "Implement",
        labels: {
          [ARM_LABEL]: "sonnet",
          [ARM_REASON_LABEL]: "capped:antigravity-cli",
          "vs.route": "stakes=normal model=claude-sonnet-5-5 family=claude",
        },
      },
    },
    { type: "turn_done", ts: "2026-11-25T11:05:00Z", costUsd: 1.5 },
  ]);

  writeAgentLog(home, "ag-noarm", [
    {
      type: "created",
      ts: "2026-11-25T12:00:00Z",
      provider: "claude",
      model: "claude-sonnet-5-5",
      cwd: "/tmp/wt/unit-usa-arm3",
      meta: { role: "worker", lane: "usage", profile: "Implement - Sonnet", labels: {} },
    },
    { type: "turn_done", ts: "2026-11-25T12:05:00Z", costUsd: 1.0 },
  ]);

  const gitAll = fakeGit([
    { sha: "arm1111", ts: "2026-11-25T10:10:00Z", subject: "Merge branch 'unit-usa-arm1' (review r1, @usa)" },
    { sha: "arm2222", ts: "2026-11-25T11:10:00Z", subject: "Merge branch 'unit-usa-arm2' (review r1, @usa)" },
    { sha: "arm3333", ts: "2026-11-25T12:10:00Z", subject: "Merge branch 'unit-usa-arm3' (review r1, @usa)" },
  ]);

  const u1 = getUsage({ home, git: gitAll, laneCodes: { usa: "usage" } });
  const byUnit = Object.fromEntries(u1.merged.units.map((m) => [m.unit, m]));
  assert.equal(byUnit["unit-usa-arm1"].implementerArm, "neon");
  assert.equal(byUnit["unit-usa-arm1"].implementerArmReason, "alternation");
  assert.equal(byUnit["unit-usa-arm2"].implementerArm, "sonnet");
  assert.equal(byUnit["unit-usa-arm2"].implementerArmReason, "capped:antigravity-cli");
  assert.equal(byUnit["unit-usa-arm3"].implementerArm, null);
  assert.equal(byUnit["unit-usa-arm3"].implementerArmReason, null);

  // Now simulate git window moving forward so arm1111/arm2222 fall off raw git and fold back from usage-ledger.jsonl
  clearUsageCache();
  const gitRecentOnly = fakeGit([
    { sha: "arm3333", ts: "2026-11-25T12:10:00Z", subject: "Merge branch 'unit-usa-arm3' (review r1, @usa)" },
  ]);
  const u2 = getUsage({ home, git: gitRecentOnly, laneCodes: { usa: "usage" } });
  const byUnit2 = Object.fromEntries(u2.merged.units.map((m) => [m.unit, m]));
  assert.equal(byUnit2["unit-usa-arm1"].fromLedger, true);
  assert.equal(byUnit2["unit-usa-arm1"].implementerArm, "neon");
  assert.equal(byUnit2["unit-usa-arm1"].implementerArmReason, "alternation");
  assert.equal(byUnit2["unit-usa-arm2"].fromLedger, true);
  assert.equal(byUnit2["unit-usa-arm2"].implementerArm, "sonnet");
  assert.equal(byUnit2["unit-usa-arm2"].implementerArmReason, "capped:antigravity-cli");
});
