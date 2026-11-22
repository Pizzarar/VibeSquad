// forge-host A2 (audit R4, R27): POSIX process-group lifecycle. Agent CLIs lead their own process group (spawnNoShell
// detached off win32); killTree signals -pid SIGTERM, then SIGKILL after a grace, with a /proc ppid walk when the pid leads no
// group; sweepOrphans and the restart script's termGracefully/killHard are group-aware. The win32 paths stay taskkill.
// The fake-world tests inject platform + kill + proc table so they run on Windows too; real-process tests run off win32 only.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { killTree, spawnNoShell } from "../runner/spawn.mjs";
import { CHILDREN_FILE, sweepOrphans } from "../runner/children.mjs";
import { descendantsLeafFirst, flushTreeKills, parseProcStat, pendingTreeKills, posixKillTree, readProcTable } from "../server/proc-tree.mjs";
import { killHard, termGracefully } from "../scripts/restart-runtime.mjs";

const SELF = 10; // the fake runner: pid 10, leads group 10, parent 5, whose parent is init
const esrch = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
const eperm = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });

/**
 * A fake process world. procs: [pid, ppid, pgid, opts?]; opts.stubborn ignores SIGTERM, opts.start is the start time.
 * kill(-g, s) hits every live member of group g (ESRCH when none); kill(p, 0) probes. Every call is logged in `calls`.
 */
function world(procs, { epermGroups = [] } = {}) {
  const table = new Map();
  for (const [pid, ppid, pgid, o = {}] of procs) table.set(pid, { pid, ppid, pgid, start: o.start ?? String(pid * 7), stubborn: !!o.stubborn, alive: true });
  const calls = [];
  const apply = (p, sig) => { if (sig === "SIGKILL" || (sig === "SIGTERM" && !p.stubborn)) p.alive = false; };
  const killImpl = (target, sig) => {
    calls.push([target, sig]);
    if (target < 0) {
      if (epermGroups.includes(-target)) throw eperm();
      const members = [...table.values()].filter((p) => p.alive && p.pgid === -target);
      if (!members.length) throw esrch();
      if (sig !== 0) for (const p of members) apply(p, sig);
      return true;
    }
    const p = table.get(target);
    if (!p || !p.alive) throw esrch();
    if (sig !== 0) apply(p, sig);
    return true;
  };
  let reads = 0;
  const readTable = () => { reads++; return new Map([...table.values()].filter((p) => p.alive).map((p) => [p.pid, { pid: p.pid, ppid: p.ppid, pgid: p.pgid, start: p.start }])); };
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false, unref() { t.unrefd = true; } }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.cleared = true; };
  const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
  return {
    table, calls, killImpl, readTable, timers, fire, setTimer, clearTimer,
    get reads() { return reads; },
    alive: (pid) => !!table.get(pid)?.alive,
    posix: (extra = {}) => ({ killImpl, readTable, setTimer, clearTimer, selfPid: SELF, selfPgid: SELF, graceMs: 5000, ...extra }),
  };
}
const base = [[1, 0, 1], [5, 1, 5], [SELF, 5, SELF]];
const signalled = (calls) => calls.filter(([, s]) => s !== 0);

// ---- invariant 1: SIGTERM to -pid first, SIGKILL only after the grace and only if the group still lives -----------------

test("inv1: killTree on POSIX sends SIGTERM to -pid first; SIGKILL to -pid only after the grace, only while the group lives", () => {
  const w = world([...base, [100, SELF, 100], [101, 100, 100, { stubborn: true }], [102, 101, 100]]);
  const child = { pid: 100, exitCode: null, kill() { throw new Error("child.kill must not run: the group kill handled it"); } };
  assert.equal(killTree(child, { platform: "linux", posix: w.posix() }), true);
  assert.deepEqual(w.calls, [[-100, "SIGTERM"]], "first and only signal before the grace: SIGTERM to the group");
  assert.equal(w.timers.length, 1);
  assert.equal(w.timers[0].ms, 5000);
  assert.equal(w.timers[0].unrefd, true, "the grace timer never holds the process open");
  assert.equal(pendingTreeKills(), 1);
  assert.equal(w.alive(101), true, "a SIGTERM-ignoring member survives the SIGTERM");
  w.fire();
  assert.deepEqual(w.calls, [[-100, "SIGTERM"], [-100, 0], [-100, "SIGKILL"]]);
  assert.equal(w.alive(101), false);
  assert.equal(pendingTreeKills(), 0);
});

test("inv1: no SIGKILL when the whole group died on SIGTERM within the grace", () => {
  const w = world([...base, [110, SELF, 110], [111, 110, 110]]);
  killTree({ pid: 110, exitCode: null, kill() {} }, { platform: "linux", posix: w.posix() });
  w.fire();
  assert.deepEqual(w.calls, [[-110, "SIGTERM"], [-110, 0]], "probe only: the group is gone, no SIGKILL");
  assert.equal(pendingTreeKills(), 0);
});

test("inv1: spawnNoShell spawns detached off win32 (group leader), keeps stdio piped and never unrefs; win32 options unchanged", () => {
  const seen = [];
  const mk = () => ({ pid: 7, unref() { throw new Error("spawnNoShell must not unref"); }, once() {} });
  const spawnImpl = (file, args, opts) => { seen.push(opts); return mk(); };
  const resolved = { file: "agent", args: [] };
  spawnNoShell("agent", ["-p"], { resolved, platform: "linux", cwd: "/w" }, spawnImpl);
  spawnNoShell("agent", ["-p"], { resolved, platform: "win32", cwd: "C:\\w" }, spawnImpl);
  assert.equal(seen[0].detached, true);
  assert.deepEqual(seen[0].stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(seen[0].shell, false);
  assert.equal("platform" in seen[0], false, "platform is ours, not a spawn option");
  assert.deepEqual(seen[1], { cwd: "C:\\w", shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }, "win32: exactly the old options, no detached key");
});

// ---- invariant 2: ESRCH at any stage is success, never a throw ----------------------------------------------------------

test("inv2: ESRCH on the group and on the pid = already dead: no throw, no timer, no fallback kill", () => {
  const w = world([...base]); // pid 120 does not exist at all
  let childKills = 0;
  assert.equal(killTree({ pid: 120, exitCode: null, kill() { childKills++; } }, { platform: "linux", posix: w.posix() }), true);
  assert.deepEqual(w.calls, [[-120, "SIGTERM"], [120, 0]]);
  assert.equal(childKills, 0);
  assert.equal(w.timers.length, 0);
  assert.equal(pendingTreeKills(), 0);
  assert.deepEqual(posixKillTree(120, w.posix()), { mode: "gone" });
});

test("inv2: ESRCH at the escalation probe, at SIGKILL and mid-walk never throws", () => {
  // Group exits between SIGTERM and the grace.
  const w = world([...base, [130, SELF, 130, { stubborn: true }]]);
  assert.equal(posixKillTree(130, w.posix()).mode, "group");
  w.table.get(130).alive = false;
  assert.doesNotThrow(() => w.fire());
  assert.deepEqual(signalled(w.calls), [[-130, "SIGTERM"]]);
  // A kill implementation that throws ESRCH for every signal after the first (process races to exit).
  let n = 0;
  const racy = (t, s) => { n++; if (n > 1) throw esrch(); return true; };
  const w2 = world([...base, [131, SELF, 131]]);
  assert.equal(posixKillTree(131, w2.posix({ killImpl: racy })).mode, "group");
  assert.doesNotThrow(() => w2.fire());
  // Walk where a descendant dies before it is signalled.
  const w3 = world([...base, [132, SELF, SELF], [133, 132, SELF], [134, 133, SELF]]);
  const killImpl = (t, s) => { if (t === 134) throw esrch(); return w3.killImpl(t, s); };
  assert.equal(posixKillTree(132, w3.posix({ killImpl })).mode, "walk");
  assert.doesNotThrow(() => w3.fire());
  assert.equal(pendingTreeKills(), 0);
});

// ---- invariant 3: /proc walk hits every descendant leaf-first; never pid 1, the runner, or the runner's group --------------

test("inv3: a pid that leads no group falls back to the proc-table walk: every descendant, leaves first, the pid last", () => {
  // 200 was started without detached: it sits in the runner's group 10, so kill(-200) is ESRCH.
  const w = world([...base, [200, SELF, SELF], [201, 200, SELF], [202, 200, SELF], [203, 201, SELF], [204, 203, 204], [300, 5, 300]]);
  const r = posixKillTree(200, w.posix());
  assert.equal(r.mode, "walk");
  const order = signalled(w.calls).filter(([t]) => t > 0).map(([t]) => t);
  assert.deepEqual(new Set(order), new Set([200, 201, 202, 203, 204]), "every descendant, also one that left the group (204)");
  const at = (p) => order.indexOf(p);
  assert.ok(at(204) < at(203) && at(203) < at(201) && at(201) < at(200) && at(202) < at(200), `leaf-first: ${order}`);
  assert.equal(order.at(-1), 200, "the root last");
  for (const [t] of w.calls) {
    assert.notEqual(t, 1); assert.notEqual(t, -1); assert.notEqual(t, 0);
    assert.notEqual(t, SELF, "never the runner"); assert.notEqual(t, -SELF, "never the runner's group");
    assert.notEqual(Math.abs(t), 300, "never an unrelated process"); assert.notEqual(t, 5, "never the runner's parent");
  }
  assert.deepEqual(signalled(w.calls).filter(([t]) => t < 0), [[-200, "SIGTERM"]], "the only group signal was the ESRCH attempt on -200");
  w.fire();
});

test("inv3: walk escalation SIGKILLs survivors whose start time still matches, skips a reused pid", () => {
  const w = world([...base, [210, SELF, SELF, { stubborn: true }], [211, 210, SELF, { stubborn: true }], [212, 210, SELF, { stubborn: true }]]);
  posixKillTree(210, w.posix());
  w.table.get(212).start = "reused"; // 212 exited and a stranger got the pid during the grace
  w.calls.length = 0;
  w.fire();
  const kills = w.calls.filter(([, s]) => s === "SIGKILL").map(([t]) => t);
  assert.deepEqual(kills.sort(), [210, 211]);
});

test("inv3: walk guards: never pid 1 or the runner even in a malformed table; refuses the runner, its ancestors, pid <= 1", () => {
  // Malformed: init listed as a child of 221 (the runner's own chain is not in the table, so 220 is not its ancestor).
  const w = world([[1, 221, 1], [SELF, 999, SELF], [220, 5, 220], [221, 220, 220]]);
  const r = posixKillTree(220, w.posix({ killImpl: (t, s) => { if (t < 0) throw eperm(); return w.killImpl(t, s); } }));
  assert.equal(r.mode, "walk");
  assert.deepEqual(r.targets, [221, 220], "pid 1 dropped from the walk");
  for (const [t] of w.calls) { assert.notEqual(t, 1); assert.notEqual(t, SELF); assert.notEqual(t, -SELF); }
  w.fire();
  // A table where the target is the runner's ancestor (the runner would be a descendant): refused, nothing signalled.
  const a = world([...base, [225, 1, 225]]);
  a.table.get(5).ppid = 225;
  assert.deepEqual(posixKillTree(225, a.posix({ killImpl: (t, s) => { if (t < 0) throw eperm(); return a.killImpl(t, s); } })), { mode: "refused" });
  assert.deepEqual(signalled(a.calls).filter(([t]) => t > 0), []);
  // A sane table: the runner, its parent (ancestor) and init are refused outright.
  const s = world([...base]);
  assert.deepEqual(posixKillTree(SELF, s.posix()), { mode: "refused" });
  assert.deepEqual(posixKillTree(1, s.posix()), { mode: "refused" });
  assert.deepEqual(posixKillTree(0, s.posix()), { mode: "refused" });
  assert.deepEqual(posixKillTree(5, s.posix({ selfPgid: 5 })), { mode: "refused" }, "the runner's own group leader (an ancestor) is never walked");
  assert.ok(!s.calls.some(([t, sig]) => sig !== 0 && (t === 5 || t === -5 || t === SELF || t === -SELF || t === 1)), JSON.stringify(s.calls));
  assert.equal(pendingTreeKills(), 0);
});

test("inv3: EPERM on the group (not ours to signal) also falls back to the walk", () => {
  const w = world([...base, [230, SELF, 230], [231, 230, 230]], { epermGroups: [230] });
  assert.equal(posixKillTree(230, w.posix()).mode, "walk");
  assert.deepEqual(signalled(w.calls).filter(([t]) => t > 0).map(([t]) => t), [231, 230]);
  w.fire();
});

test("inv3: proc table helpers: stat parsing with parens in comm, leaf-first order, /proc reader", () => {
  assert.deepEqual(parseProcStat("4242 (my (odd) proc) S 4000 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 98765 100 1"), { pid: 4242, ppid: 4000, pgid: 4242, start: "98765" });
  assert.equal(parseProcStat("garbage"), null);
  const t = new Map([[2, { pid: 2, ppid: 1 }], [3, { pid: 3, ppid: 2 }], [4, { pid: 4, ppid: 3 }], [5, { pid: 5, ppid: 2 }], [6, { pid: 6, ppid: 9 }]]);
  assert.deepEqual(descendantsLeafFirst(2, t), [4, 3, 5]);
  const files = { "/p/7/stat": "7 (a) S 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 11 0 0", "/p/8/stat": "8 (b c) S 7 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12 0 0" };
  const table = readProcTable({ procDir: "/p", readdir: () => ["7", "8", "self", "net"], read: (f) => { if (!(f in files)) throw esrch(); return files[f]; } });
  assert.deepEqual([...table.values()], [{ pid: 7, ppid: 1, pgid: 7, start: "11" }, { pid: 8, ppid: 7, pgid: 7, start: "12" }]);
  const viaPs = readProcTable({ readdir: () => { throw new Error("no /proc"); }, run: () => ({ stdout: "  1     0     1\n 40     1    40\n" }) });
  assert.deepEqual(viaPs.get(40), { pid: 40, ppid: 1, pgid: 40, start: null });
});

test("inv3: the runner's own process group is never signalled as a group", () => {
  // A target that happens to be the leader of the runner's group but is not an ancestor in the table (stale table).
  const w = world([...base, [240, SELF, 240]]);
  const r = posixKillTree(240, w.posix({ selfPgid: 240 }));
  assert.ok(!w.calls.some(([t]) => t === -240), "kill(-ownPgid) never sent");
  assert.equal(r.mode, "walk");
  w.fire();
});

// ---- sweepOrphans + restart script: group-aware --------------------------------------------------------------------------

test("sweepOrphans: the default kill is the group-aware tree kill off win32 and taskkill /T on win32", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-procgroups-"));
  try {
    const rec = { pid: 250, name: "claude", startedAt: 1000 };
    writeFileSync(path.join(home, CHILDREN_FILE), JSON.stringify([rec]));
    const w = world([...base, [250, 1, 250], [251, 250, 250]]);
    const r = sweepOrphans(home, { inspect: () => ({ name: "claude", createdMs: 1000 }), alive: () => true, killOpts: { platform: "linux", posix: w.posix() } });
    assert.deepEqual(r.killed, [250]);
    assert.deepEqual(w.calls[0], [-250, "SIGTERM"]);
    assert.equal(w.alive(251), false, "the orphan's descendants went with it");
    w.fire();
    writeFileSync(path.join(home, CHILDREN_FILE), JSON.stringify([rec]));
    const spawned = [];
    const spawnImpl = (cmd, args, opts) => { spawned.push([cmd, args, opts.shell]); return { on() {}, unref() {} }; };
    sweepOrphans(home, { inspect: () => ({ name: "claude", createdMs: 1000 }), alive: () => true, killOpts: { platform: "win32", spawnImpl } });
    assert.deepEqual(spawned, [["taskkill", ["/pid", "250", "/T", "/F"], false]]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("restart termGracefully/killHard: POSIX signal the group a detached server leads, else the pid alone; never a walk", () => {
  // 260 leads its group (started detached), with a non-detached child; 270 leads none and ignores SIGTERM.
  const w = world([...base, [260, 1, 260], [261, 260, 260], [270, 1, 1, { stubborn: true }], [271, 270, 1]]);
  const posix = { killImpl: w.killImpl, readTable: () => { throw new Error("restart never walks the proc table"); }, selfPid: SELF, selfPgid: SELF };
  termGracefully(260, { win: false, posix });
  assert.equal(w.alive(261), false, "the server's non-detached child went with the group");
  killHard(260, { win: false, posix });
  termGracefully(270, { win: false, posix });
  killHard(270, { win: false, posix });
  assert.deepEqual(signalled(w.calls), [
    [-260, "SIGTERM"], // group
    [-260, "SIGKILL"], // ESRCH: already gone (probe follows), no throw
    [-270, "SIGTERM"], [270, "SIGTERM"], // no group led by 270: the pid alone
    [-270, "SIGKILL"], [270, "SIGKILL"],
  ]);
  assert.equal(w.alive(271), true, "no descendant walk from the restart script (it would reach the detached runner)");
  assert.equal(pendingTreeKills(), 0, "no escalation timer: stopProc escalates itself");
  assert.doesNotThrow(() => killHard(999, { win: false, posix }), "ESRCH everywhere");
});

// ---- invariant 4: win32 paths unchanged ------------------------------------------------------------------------------------

test("inv4: win32 killTree still runs taskkill /pid <pid> /T /F without a shell and never touches the POSIX path", () => {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  const posix = { killImpl: () => { throw new Error("POSIX kill on win32"); }, readTable: () => { throw new Error("proc table on win32"); } };
  assert.equal(killTree({ pid: 42, exitCode: null, kill() { throw new Error("should not"); } }, { platform: "win32", spawnImpl, posix }), true);
  assert.deepEqual(calls, [{ cmd: "taskkill", args: ["/pid", "42", "/T", "/F"], opts: { shell: false, windowsHide: true, stdio: "ignore" } }]);
  // taskkill spawn throws: same fallback as before (child.kill), still not the POSIX path.
  let killed = 0;
  killTree({ pid: 43, exitCode: null, kill() { killed++; } }, { platform: "win32", spawnImpl: () => { throw new Error("no taskkill"); }, posix });
  assert.equal(killed, 1);
  assert.equal(killTree({ pid: 44, exitCode: 0 }, { platform: "win32", spawnImpl, posix }), false, "an exited child: nothing to do");
});

test("inv4: win32 restart termGracefully/killHard still run taskkill /PID (graceful) and /PID /T /F (hard)", () => {
  const runs = [];
  const run = (cmd, args, opts) => { runs.push([cmd, args, opts]); return { status: 0 }; };
  const posix = { killImpl: () => { throw new Error("POSIX kill on win32"); } };
  termGracefully(77, { win: true, run, posix });
  killHard(77, { win: true, run, posix });
  assert.deepEqual(runs, [
    ["taskkill", ["/PID", "77"], { windowsHide: true, stdio: "ignore", timeout: 10000 }],
    ["taskkill", ["/PID", "77", "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 }],
  ]);
});

// ---- invariant 5: no double-kill race --------------------------------------------------------------------------------------

test("inv5: a second killTree during the grace does not throw, re-signal, or add a timer; flush escalates and clears", () => {
  const w = world([...base, [280, SELF, 280, { stubborn: true }]]);
  const child = { pid: 280, exitCode: null, kill() { throw new Error("no"); } };
  assert.equal(killTree(child, { platform: "linux", posix: w.posix() }), true);
  assert.doesNotThrow(() => assert.equal(killTree(child, { platform: "linux", posix: w.posix() }), true));
  assert.deepEqual(posixKillTree(280, w.posix()), { mode: "pending" });
  assert.equal(w.timers.length, 1, "one grace timer, not two");
  assert.equal(pendingTreeKills(), 1);
  assert.deepEqual(signalled(w.calls), [[-280, "SIGTERM"]], "no second SIGTERM");
  flushTreeKills(); // what process 'exit' runs: escalate now, drop the timer
  assert.equal(w.timers[0].cleared, true);
  assert.equal(pendingTreeKills(), 0);
  assert.deepEqual(signalled(w.calls), [[-280, "SIGTERM"], [-280, "SIGKILL"]]);
  w.fire(); // the cleared timer does nothing
  assert.deepEqual(signalled(w.calls), [[-280, "SIGTERM"], [-280, "SIGKILL"]]);
  // After the grace a fresh kill of the same pid starts a new cycle.
  const w2 = world([...base, [281, SELF, 281]]);
  posixKillTree(281, w2.posix());
  w2.fire();
  assert.equal(pendingTreeKills(), 0);
  assert.equal(posixKillTree(281, w2.posix()).mode, "gone");
});

// ---- real processes (POSIX only) -------------------------------------------------------------------------------------------

const posixOnly = { skip: process.platform === "win32" ? "POSIX process groups: runs on Linux/macOS" : false };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const childrenOf = (pid) => [...(readProcTable()?.values() ?? [])].filter((p) => p.ppid === pid).map((p) => p.pid);
async function waitFor(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return fn(); }

test("real: spawnNoShell child leads its own group; killTree takes the whole tree down", posixOnly, async () => {
  const child = spawnNoShell("sh", ["-c", "sleep 60 & sleep 60 & wait"], {});
  child.on("error", () => {});
  assert.ok(await waitFor(() => childrenOf(child.pid).length >= 2), "the shell started its sleeps");
  const kids = childrenOf(child.pid);
  assert.equal(readProcTable().get(child.pid)?.pgid, child.pid, "the child leads its own process group");
  const exited = new Promise((r) => child.once("exit", r));
  assert.equal(killTree(child, { posix: { graceMs: 2000 } }), true);
  await exited;
  assert.ok(await waitFor(() => kids.every((p) => !isAlive(p))), `descendants gone: ${kids.filter(isAlive)}`);
  flushTreeKills();
});

test("real: a SIGTERM-ignoring tree gets SIGKILL after the grace", posixOnly, async () => {
  const child = spawnNoShell("sh", ["-c", "trap '' TERM; sleep 60 & wait; sleep 60"], {});
  child.on("error", () => {});
  assert.ok(await waitFor(() => childrenOf(child.pid).length >= 1));
  const kids = childrenOf(child.pid);
  const exited = new Promise((r) => child.once("exit", (code, sig) => r(sig)));
  killTree(child, { posix: { graceMs: 300 } });
  assert.equal(await exited, "SIGKILL");
  assert.ok(await waitFor(() => kids.every((p) => !isAlive(p))));
});

test("real: a non-leader pid is killed by the /proc walk, descendants included", posixOnly, async () => {
  const child = spawn("sh", ["-c", "sleep 60 & sleep 60 & wait"], { stdio: "ignore" }); // not detached: shares our group
  child.on("error", () => {});
  assert.ok(await waitFor(() => childrenOf(child.pid).length >= 2));
  const kids = childrenOf(child.pid);
  const r = posixKillTree(child.pid, { graceMs: 1000 });
  assert.equal(r.mode, "walk");
  assert.ok(await waitFor(() => kids.every((p) => !isAlive(p)) && !isAlive(child.pid)));
  assert.ok(isAlive(process.pid));
  flushTreeKills();
});
