// package.json scripts for a directory, started/stopped by name (never an arbitrary command) with logs kept for the UI.
// Served over /__vibesquad/workspace-scripts/* (see terminals-api.mjs). Keyed by directory, not Paseo workspaceId.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { killTree, onServerExit } from "./proc-tree.mjs";

const LOG_CHARS = 200_000;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.\-/@]{0,100}$/;

export function listPackageScripts(cwd) {
  const p = join(cwd, "package.json");
  if (!existsSync(p)) return {};
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
    const s = pkg?.scripts;
    return s && typeof s === "object" ? Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === "string")) : {};
  } catch {
    return {};
  }
}

export class ScriptManager {
  /** @param {{ runner?: (name: string, cwd: string) => {file:string,args:string[],shell?:boolean} }} [opts] */
  constructor(opts = {}) {
    this.runner = opts.runner ?? ((name) => ({ file: "npm", args: ["run", name], shell: process.platform === "win32" }));
    this.runs = new Map(); // `${cwd}\n${name}` -> run
    onServerExit(() => this.stopAll({ sync: true }));
  }
  key(cwd, name) { return `${cwd}\n${name}`; }

  list(cwd) {
    return Object.entries(listPackageScripts(cwd)).map(([scriptName, command]) => {
      const r = this.runs.get(this.key(cwd, scriptName));
      return {
        scriptName, command, type: "script", port: null,
        lifecycle: r && !r.exited ? "running" : "stopped",
        exitCode: r?.exited ? r.exited.code : null,
      };
    });
  }

  start(cwd, name) {
    const scripts = listPackageScripts(cwd);
    if (!SAFE_NAME.test(String(name)) || !Object.hasOwn(scripts, name)) {
      throw Object.assign(new Error(`no package.json script "${name}" in this directory`), { status: 404 });
    }
    const k = this.key(cwd, name);
    const existing = this.runs.get(k);
    if (existing && !existing.exited) throw Object.assign(new Error("script already running"), { status: 409 });
    const { file, args, shell } = this.runner(name, cwd);
    const run = { cwd, name, buf: "", exited: null, events: new EventEmitter(), startedAt: Date.now() };
    run.events.setMaxListeners(50);
    const emit = (d) => {
      run.buf += d;
      if (run.buf.length > LOG_CHARS) run.buf = run.buf.slice(-LOG_CHARS);
      run.events.emit("data", d);
    };
    const child = spawn(file, args, {
      cwd, shell: Boolean(shell), windowsHide: true, detached: process.platform !== "win32",
      env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"],
    });
    run.pid = child.pid;
    child.stdout.on("data", (d) => emit(d.toString("utf8")));
    child.stderr.on("data", (d) => emit(d.toString("utf8")));
    const done = (code) => {
      if (run.exited) return;
      run.exited = { code: code ?? null };
      run.events.emit("exit", run.exited);
    };
    child.on("error", (e) => { emit(`[failed to start: ${e.message}]\n`); done(-1); });
    child.on("close", done);
    this.runs.set(k, run);
    return { scriptName: name, lifecycle: "running", pid: run.pid };
  }

  stop(cwd, name) {
    const r = this.runs.get(this.key(cwd, name));
    if (!r || r.exited) return { scriptName: name, lifecycle: "stopped" };
    killTree(r.pid);
    return { scriptName: name, lifecycle: "stopping" };
  }

  logs(cwd, name) {
    return this.runs.get(this.key(cwd, name))?.buf ?? "";
  }

  subscribe(cwd, name, { onData, onExit }) {
    const r = this.runs.get(this.key(cwd, name));
    if (!r) throw Object.assign(new Error("script has not been started"), { status: 404 });
    if (r.buf) onData(r.buf);
    if (r.exited) { onExit(r.exited); return () => {}; }
    r.events.on("data", onData);
    r.events.on("exit", onExit);
    return () => { r.events.off("data", onData); r.events.off("exit", onExit); };
  }

  stopAll({ sync = false } = {}) {
    for (const r of this.runs.values()) if (!r.exited) killTree(r.pid, { sync });
  }
}

let shared;
export const sharedScripts = () => (shared ??= new ScriptManager());
