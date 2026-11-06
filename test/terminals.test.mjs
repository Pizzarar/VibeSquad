import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalManager, loadNodePty } from "../server/terminals.mjs";
import { ScriptManager, listPackageScripts } from "../server/workspace-scripts.mjs";
import { handleTerminalsApi } from "../server/terminals-api.mjs";

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
