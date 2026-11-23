import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalManager, loadNodePty } from "../server/terminals.mjs";
import { ScriptManager, listPackageScripts } from "../server/workspace-scripts.mjs";
import { handleTerminalsApi } from "../server/terminals-api.mjs";
import { killTrees } from "../server/proc-tree.mjs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 40)); }
  return false;
};
// A "shell" that answers each stdin line and can spawn a long-lived grandchild.
const SHELL_JS = `
const { spawn } = require("node:child_process");
process.stdin.setEncoding("utf8");
let b = "";
process.stdin.on("data", (d) => {
  b += d; let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i); b = b.slice(i + 1);
    if (l === "grandchild") { const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); console.log("GC:" + c.pid); }
    else if (l === "quit") process.exit(3);
    else console.log("got:" + l);
  }
});
setInterval(() => {}, 1000);
`;
const fakeShell = { file: process.execPath, args: ["-e", SHELL_JS] };
const rmq = (d) => { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} };
const tmp = () => mkdtempSync(join(tmpdir(), "vs-term-"));

test("terminal: spawn, input, output replay, resize, rename", async () => {
  const dir = tmp();
  const m = new TerminalManager({ pty: null, shell: fakeShell });
  try {
    const t = await m.create({ cwd: dir, cols: 100, rows: 30 });
    assert.match(t.id, /^tm-[a-f0-9]{12}$/);
    assert.equal(t.cwd, dir);
    assert.deepEqual(m.list(dir).map((x) => x.id), [t.id]);
    assert.deepEqual(m.list(join(dir, "other")), []);
    m.input(t.id, "hello\r");
    assert.ok(await until(() => m.output(t.id).includes("got:hello")));
    m.resize(t.id, 120, 40);
    m.rename(t.id, "Build");
    assert.equal(m.list(dir)[0].name, "Build");
    const seen = [];
    const off = m.subscribe(t.id, { onData: (d) => seen.push(d), onExit: () => {} });
    assert.ok(seen.join("").includes("got:hello"), "subscribe replays scrollback");
    m.input(t.id, "again\r");
    assert.ok(await until(() => seen.join("").includes("got:again")));
    off();
  } finally { m.killAll(); rmq(dir); }
});

test("terminal: kill removes the shell and its whole process tree", async () => {
  const dir = tmp();
  const m = new TerminalManager({ pty: null, shell: fakeShell });
  try {
    const t = await m.create({ cwd: dir });
    m.input(t.id, "grandchild\r");
    assert.ok(await until(() => /GC:\d+/.test(m.output(t.id))));
    const gc = Number(/GC:(\d+)/.exec(m.output(t.id))[1]);
    assert.ok(alive(gc) && alive(t.pid));
    m.kill(t.id);
    assert.ok(await until(() => !alive(gc) && !alive(t.pid)), "shell and grandchild are gone");
    assert.throws(() => m.get(t.id), /not found/);
  } finally { m.killAll(); rmq(dir); }
});

test("terminal: shell exit is reported to subscribers and blocks further input", async () => {
  const dir = tmp();
  const m = new TerminalManager({ pty: null, shell: fakeShell });
  try {
    const t = await m.create({ cwd: dir });
    let exit;
    m.subscribe(t.id, { onData: () => {}, onExit: (e) => { exit = e; } });
    m.input(t.id, "quit\r");
    assert.ok(await until(() => exit));
    assert.equal(exit.code, 3);
    assert.throws(() => m.input(t.id, "x"), /exited/);
  } finally { m.killAll(); rmq(dir); }
});

test("terminal: killAll (the server-exit path) leaves no process behind; limits and arguments are enforced", async () => {
  const dir = tmp();
  const m = new TerminalManager({ pty: null, shell: fakeShell, max: 2 });
  try {
    await assert.rejects(m.create({}), /cwd required/);
    const a = await m.create({ cwd: dir });
    const b = await m.create({ cwd: dir });
    await assert.rejects(m.create({ cwd: dir }), /too many/);
    m.killAll({ sync: true });
    assert.ok(await until(() => !alive(a.pid) && !alive(b.pid)));
    assert.deepEqual(m.list(), []);
  } finally { m.killAll(); rmq(dir); }
});

test("idea-408: killTrees batches every pid into one taskkill (sync and async) and calls onDone once", () => {
  const syncCalls = [];
  const run = {
    spawnSync: (cmd, args, opts) => { syncCalls.push({ cmd, args, timeout: opts.timeout }); return { status: 0 }; },
    spawn: () => { throw new Error("sync path must not spawn async"); },
  };
  let done = 0;
  killTrees([101, 102, 0, 1, 101, 103], { sync: true, platform: "win32", run, onDone: () => done++ });
  assert.deepEqual(syncCalls, [{ cmd: "taskkill", args: ["/PID", "101", "/PID", "102", "/PID", "103", "/T", "/F"], timeout: 30000 }]);
  assert.equal(done, 1);

  // Async: one child, onDone only after it exits (not at call time), and only once even if error follows exit.
  const kids = [];
  const runAsync = {
    spawnSync: () => { throw new Error("async path must not block"); },
    spawn: (cmd, args) => { const c = new EventEmitter(); c.unref = () => {}; c.args = args; kids.push(c); return c; },
  };
  let asyncDone = 0;
  killTrees([201, 202], { platform: "win32", run: runAsync, onDone: () => asyncDone++ });
  assert.equal(kids.length, 1);
  assert.deepEqual(kids[0].args, ["/PID", "201", "/PID", "202", "/T", "/F"]);
  assert.equal(asyncDone, 0, "the PTY close must wait for the tree kill");
  kids[0].emit("exit", 0);
  kids[0].emit("error", new Error("late"));
  assert.equal(asyncDone, 1);

  // A taskkill that can't spawn still reports done; nothing to kill reports done without spawning.
  let failDone = 0;
  killTrees([301], { platform: "win32", run: { spawn: () => { throw new Error("ENOENT"); } }, onDone: () => failDone++ });
  assert.equal(failDone, 1);
  let emptyDone = 0;
  killTrees([0, null, undefined], { platform: "win32", run: { spawn: () => { throw new Error("no"); }, spawnSync: () => { throw new Error("no"); } }, onDone: () => emptyDone++ });
  assert.equal(emptyDone, 1);

  // Over the batch cap: one taskkill per 200 pids.
  const big = [];
  killTrees(Array.from({ length: 450 }, (_, i) => 1000 + i), { sync: true, platform: "win32", run: { spawnSync: (c, a) => { big.push(a.length); return { status: 0 }; } } });
  assert.deepEqual(big, [402, 402, 102]);
});

test("idea-570 L1: killTrees never targets this process; the async win32 path SIGKILLs roots when taskkill fails to spawn or errors", () => {
  const killed = [];
  const realKill = process.kill;
  process.kill = (p, s) => { killed.push([p, s]); return true; };
  try {
    const calls = [];
    let doneSelf = 0;
    killTrees([process.pid], { platform: "win32", run: { spawn: (c, a) => { calls.push(a); throw new Error("no"); } }, onDone: () => doneSelf++ });
    assert.deepEqual(calls, [], "own pid filtered out, nothing spawned");
    assert.deepEqual(killed, []);
    assert.equal(doneSelf, 1);

    let d1 = 0;
    killTrees([501, 502], { platform: "win32", run: { spawn: () => { throw new Error("ENOENT"); } }, onDone: () => d1++ });
    assert.deepEqual(killed, [[501, "SIGKILL"], [502, "SIGKILL"]]);
    assert.equal(d1, 1);

    killed.length = 0;
    const kid = new EventEmitter(); kid.unref = () => {};
    killTrees([601], { platform: "win32", run: { spawn: () => kid } });
    kid.emit("error", new Error("spawn failed"));
    assert.deepEqual(killed, [[601, "SIGKILL"]]);

    killed.length = 0;
    const ok = new EventEmitter(); ok.unref = () => {};
    killTrees([701], { platform: "win32", run: { spawn: () => ok } });
    ok.emit("exit", 0);
    assert.deepEqual(killed, [], "a clean taskkill exit needs no fallback");
  } finally { process.kill = realKill; }
});

test("idea-408: PTY kill and killAll run the tree kill first, then close each PTY, and kill(id) does not block", async () => {
  const dir = tmp();
  const kids = [];
  const closed = [];
  // POSIX: SIGKILL is only sent synchronously; the root dies (and our loop reaps it) later, so at close time it can still
  // read alive (state R with the kill pending, or an unreaped zombie Z). There the order is proven by the SIGKILL already sent.
  const sigkilled = new Set();
  // A fake node-pty whose "shell" is a real process with a grandchild, so the tree kill is real.
  const fakePty = {
    spawn() {
      const c = spawn(process.execPath, ["-e", SHELL_JS], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32" });
      kids.push(c);
      const p = { pid: c.pid, onData: (fn) => c.stdout.on("data", (d) => fn(d.toString("utf8"))), onExit: (fn) => c.on("exit", (code) => fn({ exitCode: code })), write: (d) => c.stdin.write(d.replace(/\r/g, "\n")), resize() {}, kill: () => closed.push({ pid: c.pid, rootAlive: alive(c.pid), killSent: sigkilled.has(c.pid) }) };
      return p;
    },
  };
  const m = new TerminalManager({ pty: fakePty, shell: fakeShell });
  try {
    const a = await m.create({ cwd: dir });
    const b = await m.create({ cwd: dir });
    const c = await m.create({ cwd: dir });
    m.input(a.id, "grandchild\r");
    assert.ok(await until(() => /GC:\d+/.test(m.output(a.id))));
    const gc = Number(/GC:(\d+)/.exec(m.output(a.id))[1]);
    m.kill(a.id);
    if (process.platform === "win32") assert.equal(closed.length, 0, "taskkill runs async on the DELETE path; the PTY closes after it");
    assert.ok(await until(() => closed.length === 1));
    assert.ok(await until(() => !alive(a.pid) && !alive(gc)), "the grandchild went with the tree");
    if (process.platform === "win32") m.killAll({ sync: true });
    else {
      const realKill = process.kill;
      process.kill = (p, s) => { if (s === "SIGKILL") sigkilled.add(Math.abs(p)); return realKill.call(process, p, s); };
      try { m.killAll({ sync: true }); } finally { process.kill = realKill; }
    }
    assert.deepEqual(closed.slice(1).map((x) => x.pid).sort(), [b.pid, c.pid].sort());
    if (process.platform === "win32") assert.ok(closed.slice(1).every((x) => !x.rootAlive), "sync killAll closes each PTY only after the batched tree kill");
    else {
      assert.ok(closed.slice(1).every((x) => x.killSent), "sync killAll closes each PTY only after the batched tree kill (SIGKILL sent)");
      assert.ok(await until(() => !alive(b.pid) && !alive(c.pid)), "the SIGKILLed roots die");
    }
    assert.deepEqual(m.list(), []);
  } finally { for (const k of kids) { try { k.kill(); } catch {} } m.killAll(); rmq(dir); }
});

test("terminal: real PTY when node-pty is available", async (ctx) => {
  const pty = await loadNodePty();
  if (!pty) return ctx.skip("node-pty not installed");
  const dir = tmp();
  const m = new TerminalManager({ pty, shell: process.platform === "win32" ? { file: "cmd.exe", args: [] } : { file: "/bin/sh", args: [] } });
  try {
    const t = await m.create({ cwd: dir });
    assert.equal(t.pty, true);
    m.input(t.id, "echo vs-pty-ok\r");
    assert.ok(await until(() => m.output(t.id).includes("vs-pty-ok")));
    const pid = m.get(t.id).pid;
    assert.ok(pid > 1);
    m.kill(t.id);
    assert.ok(await until(() => !alive(pid)));
  } finally { m.killAll(); rmq(dir); }
});

// ---- scripts ----
const nodeRunner = (body) => () => ({ file: process.execPath, args: ["-e", body] });
function pkgDir(scripts) {
  const dir = tmp();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));
  return dir;
}

test("scripts: lists package.json scripts, runs one, captures logs and exit code", async () => {
  const dir = pkgDir({ hello: "echo hi", "bad name": "x" });
  const m = new ScriptManager({ runner: nodeRunner('console.log("script-out"); process.exit(5)') });
  try {
    assert.deepEqual(Object.keys(listPackageScripts(dir)), ["hello", "bad name"]);
    assert.equal(m.list(dir).find((s) => s.scriptName === "hello").lifecycle, "stopped");
    m.start(dir, "hello");
    assert.equal(m.list(dir).find((s) => s.scriptName === "hello").lifecycle, "running");
    assert.ok(await until(() => m.list(dir).find((s) => s.scriptName === "hello").lifecycle === "stopped"));
    assert.match(m.logs(dir, "hello"), /script-out/);
    assert.equal(m.list(dir).find((s) => s.scriptName === "hello").exitCode, 5);
  } finally { m.stopAll(); rmq(dir); }
});

test("scripts: only names present in package.json can run; no shell metacharacters", () => {
  const dir = pkgDir({ ok: "echo", "evil;calc": "x" });
  const m = new ScriptManager({ runner: nodeRunner("") });
  try {
    assert.throws(() => m.start(dir, "missing"), /no package.json script/);
    assert.throws(() => m.start(dir, "evil;calc"), /no package.json script/);
    assert.throws(() => m.start(dir, "__proto__"), /no package.json script/);
  } finally { m.stopAll(); rmq(dir); }
});

test("scripts: stop kills the script's whole process tree; a running script can't be started twice", async () => {
  const dir = pkgDir({ dev: "x" });
  const body = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log("GC:"+c.pid);setInterval(()=>{},1000)';
  const m = new ScriptManager({ runner: nodeRunner(body) });
  try {
    const { pid } = m.start(dir, "dev");
    assert.throws(() => m.start(dir, "dev"), /already running/);
    assert.ok(await until(() => /GC:\d+/.test(m.logs(dir, "dev"))));
    const gc = Number(/GC:(\d+)/.exec(m.logs(dir, "dev"))[1]);
    m.stop(dir, "dev");
    assert.ok(await until(() => !alive(pid) && !alive(gc)), "script and grandchild are gone");
    assert.ok(await until(() => m.list(dir)[0].lifecycle === "stopped"));
    m.start(dir, "dev"); // restartable after a stop
    m.stopAll({ sync: true });
  } finally { m.stopAll(); rmq(dir); }
});

test("idea-570 L2: ScriptManager.stopAll clears runs, so a second stopAll (exit hook after SIGTERM) kills nothing again", async () => {
  const dir = pkgDir({ dev: "x" });
  const m = new ScriptManager({ runner: nodeRunner("setInterval(()=>{},1000)") });
  try {
    const { pid } = m.start(dir, "dev");
    assert.ok(alive(pid));
    m.stopAll({ sync: true });
    assert.equal(m.runs.size, 0);
    assert.ok(await until(() => !alive(pid)));
    assert.equal(m.list(dir)[0].lifecycle, "stopped");
  } finally { m.stopAll(); rmq(dir); }
});

// ---- HTTP surface + path validation ----
async function withApi(fn) {
  const root = tmp();
  const terminals = new TerminalManager({ pty: null, shell: fakeShell });
  const scripts = new ScriptManager({ runner: nodeRunner('console.log("api-out")') });
  const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b ? JSON.parse(b) : {})); });
  const sendJson = (res, code, data) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
  const resolveCwd = (cwd) => (cwd === root ? root : null);
  const server = createServer((req, res) => handleTerminalsApi(req, res, { readBody, sendJson, resolveCwd, terminals, scripts }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/__vibesquad`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try { await fn({ base, root, post, terminals, scripts }); }
  finally { terminals.killAll(); scripts.stopAll(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); rmq(root); }
}

test("api: refuses a cwd outside the known team/agent paths", async () => {
  await withApi(async ({ base, post, root }) => {
    const outside = tmp();
    try {
      assert.equal((await post("/terminals", { cwd: outside })).status, 403);
      assert.equal((await fetch(`${base}/terminals?cwd=${encodeURIComponent(outside)}`)).status, 403);
      assert.equal((await post("/workspace-scripts/start", { cwd: outside, name: "x" })).status, 403);
      assert.equal((await fetch(`${base}/workspace-scripts?cwd=${encodeURIComponent("\\\\evil\\share")}`)).status, 403);
      assert.equal((await post("/terminals", { cwd: root })).status, 201);
    } finally { rmq(outside); }
  });
});

test("api: create, stream output over SSE, input, kill, scripts start/stop/list", async () => {
  await withApi(async ({ base, post, root }) => {
    const { terminal } = await (await post("/terminals", { cwd: root, name: "t" })).json();
    const stream = await fetch(`${base}/terminals/${terminal.id}/stream`);
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body.getReader();
    assert.equal((await post(`/terminals/${terminal.id}/input`, { data: "ping\r" })).status, 200);
    assert.equal((await post(`/terminals/${terminal.id}/resize`, { cols: 90, rows: 20 })).status, 200);
    let text = "";
    const dec = new TextDecoder();
    while (!text.includes("got:ping")) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); }
    assert.match(text, /^data: \{"d":/m);
    assert.match(text, /got:ping/);
    const list = await (await fetch(`${base}/terminals?cwd=${encodeURIComponent(root)}`)).json();
    assert.equal(list.terminals.length, 1);
    assert.equal((await post(`/terminals/${terminal.id}/kill`, {})).status, 200);
    assert.equal((await post(`/terminals/${terminal.id}/input`, { data: "x" })).status, 404);
    await reader.cancel().catch(() => {});

    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { go: "x" } }));
    assert.equal((await post("/workspace-scripts/start", { cwd: root, name: "go" })).status, 200);
    assert.equal((await post("/workspace-scripts/start", { cwd: root, name: "nope" })).status, 404);
    assert.ok(await until(async () => (await (await fetch(`${base}/workspace-scripts/logs?cwd=${encodeURIComponent(root)}&name=go`)).json()).text.includes("api-out")));
    const scripts = await (await fetch(`${base}/workspace-scripts?cwd=${encodeURIComponent(root)}`)).json();
    assert.equal(scripts.scripts[0].scriptName, "go");
    assert.equal((await post("/workspace-scripts/stop", { cwd: root, name: "go" })).status, 200);
  });
});

// ---- review fixes ----
test("terminal: an exited shell is evicted after the grace period and stops counting toward the limit", async () => {
  const dir = tmp();
  const m = new TerminalManager({ pty: null, shell: fakeShell, max: 1, evictMs: 100 });
  try {
    const t = await m.create({ cwd: dir });
    await assert.rejects(m.create({ cwd: dir }), /too many/);
    m.input(t.id, "quit\n");
    assert.ok(await until(() => m.list(dir)[0]?.exited), "reports exited first");
    assert.ok(m.output(t.id).length >= 0, "still readable during the grace period");
    assert.ok(await until(() => m.list(dir).length === 0), "then evicted");
    const t2 = await m.create({ cwd: dir });
    assert.ok(t2.id);
  } finally { m.killAll(); rmq(dir); }
});

test("scripts: the server's local tokens are not passed to scripts", async () => {
  const dir = pkgDir({ dev: "x" });
  const saved = { a: process.env.VS_LOCAL_TOKEN, b: process.env.VIBESQUAD_TOKEN };
  process.env.VS_LOCAL_TOKEN = "secret-a"; process.env.VIBESQUAD_TOKEN = "secret-b";
  const m = new ScriptManager({ runner: nodeRunner('console.log("T:" + [process.env.VS_LOCAL_TOKEN, process.env.VIBESQUAD_TOKEN, process.env.PATH ? "path" : "nopath"].join(","))') });
  try {
    m.start(dir, "dev");
    assert.ok(await until(() => /T:/.test(m.logs(dir, "dev"))));
    assert.match(m.logs(dir, "dev"), /T:,,path/);
  } finally {
    for (const [k, v] of [["VS_LOCAL_TOKEN", saved.a], ["VIBESQUAD_TOKEN", saved.b]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    m.stopAll(); rmq(dir);
  }
});

test("terminal: piped fallback treats CRLF as one newline", async () => {
  const dir = tmp();
  const m = new TerminalManager({ pty: null, shell: fakeShell });
  try {
    const t = await m.create({ cwd: dir });
    m.input(t.id, "one\r\ntwo\r\n");
    assert.ok(await until(() => m.output(t.id).includes("got:two")));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((m.output(t.id).match(/got:/g) ?? []).length, 2, "no extra empty command from the \n of CRLF");
    assert.ok(!m.output(t.id).includes("got:\r") && !/got:\s*\n/.test(m.output(t.id).replace(/got:(one|two)/g, "")));
  } finally { m.killAll(); rmq(dir); }
});

test("api: streaming an unknown terminal or script is a real 404 and leaves no ping timer", async () => {
  await withApi(async ({ base, root }) => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    const r1 = await fetch(`${base}/terminals/tm-000000000000/stream`);
    assert.equal(r1.status, 404);
    assert.match(r1.headers.get("content-type"), /json/);
    const r2 = await fetch(`${base}/workspace-scripts/logs?stream=1&cwd=${encodeURIComponent(root)}&name=nope`);
    assert.equal(r2.status, 404);
    await r2.text();
    assert.ok(timers() <= before, "no leaked interval");
  });
});

test("terminal: poll is a cursor read (retained start, no gaps, dropped, exit only when drained, long-poll wake)", async () => {
  const dir = tmp();
  const m = new TerminalManager({ pty: null, shell: fakeShell });
  try {
    const t = await m.create({ cwd: dir });
    assert.deepEqual(m.poll(t.id), { text: "", next: 0, dropped: false, exited: null });
    m.input(t.id, "one\r");
    assert.ok(await until(() => m.output(t.id).includes("got:one")));
    const a = m.poll(t.id, 0, { maxChars: 4 });
    assert.equal(a.text.length, 4);
    assert.equal(a.next, 4);
    const b = m.poll(t.id, a.next);
    assert.equal(a.text + b.text, m.output(t.id), "chunks join to the exact output");
    assert.equal(m.poll(t.id, b.next).text, "");
    assert.equal(m.output(t.id, 5), m.output(t.id).slice(-5));
    const held = m.waitForData(t.id, b.next, 3000);
    m.input(t.id, "two\r");
    await held;
    assert.ok(await until(() => /got:two/.test(m.poll(t.id, b.next).text)));
    const t0 = Date.now();
    await m.waitForData(t.id, m.poll(t.id).next, 120);
    assert.ok(Date.now() - t0 >= 100, "an idle terminal holds the poll");
    m.input(t.id, "quit\r");
    assert.ok(await until(() => m.get(t.id).exited));
    const last = m.poll(t.id, 0, { maxChars: 3 });
    assert.equal(last.exited, null, "exit is withheld until the output is drained");
    const rest = m.poll(t.id, last.next);
    assert.deepEqual(rest.exited, { code: 3 });
  } finally { m.killAll(); rmq(dir); }
});
