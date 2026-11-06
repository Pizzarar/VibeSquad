// Interactive shells keyed by directory, served to the UI over /__vibesquad/terminals/* (see terminals-api.mjs).
// Runner agents have no Paseo workspaceId, so the Paseo terminal RPCs can't reach them; this works from a cwd alone.
// Uses node-pty when it can be loaded (a real PTY / ConPTY); otherwise falls back to a piped shell with server-side echo.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { killTree, onServerExit } from "./proc-tree.mjs";

const SCROLLBACK_CHARS = 200_000;
export const MAX_TERMINALS = 16;
const EXITED_GRACE_MS = 30_000; // how long an exited terminal stays listed so clients can read its final output

let ptyPromise;
/** node-pty if present (optional dependency, or VS_NODE_PTY pointing at an installed copy); null otherwise. */
export function loadNodePty() {
  ptyPromise ??= (async () => {
    for (const spec of [process.env.VS_NODE_PTY, "node-pty"].filter(Boolean)) {
      try {
        const mod = await import(spec);
        const pty = mod.default?.spawn ? mod.default : mod;
        if (typeof pty.spawn === "function") return pty;
      } catch {}
    }
    return null;
  })();
  return ptyPromise;
}

export function defaultShell() {
  if (process.platform === "win32") return { file: process.env.VS_SHELL || "powershell.exe", args: ["-NoLogo"] };
  return { file: process.env.VS_SHELL || process.env.SHELL || "/bin/bash", args: [] };
}

/** Copy of `env` without the server's local owner tokens, for anything that runs user code. */
export const withoutTokens = (env) => {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^(VS_LOCAL_TOKEN|VIBESQUAD_TOKEN)$/i.test(k)) delete out[k];
  return out;
};
const shellEnv = () => withoutTokens({ ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" });

const clampDim = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number(v) || dflt));

export class TerminalManager {
  /** @param {{ pty?: any | null, shell?: {file:string,args:string[]}, max?: number, evictMs?: number }} [opts] pty: undefined = autodetect, null = force the piped fallback */
  constructor(opts = {}) {
    this.ptyOpt = opts.pty;
    this.shell = opts.shell ?? defaultShell();
    this.max = opts.max ?? MAX_TERMINALS;
    this.evictMs = opts.evictMs ?? EXITED_GRACE_MS;
    this.terms = new Map();
    onServerExit(() => this.killAll({ sync: true }));
  }

  async create({ cwd, name, cols, rows } = {}) {
    if (!cwd || typeof cwd !== "string") throw Object.assign(new Error("cwd required"), { status: 400 });
    if (this.terms.size >= this.max) throw Object.assign(new Error("too many terminals"), { status: 429 });
    cols = clampDim(cols, 2, 500, 80);
    rows = clampDim(rows, 2, 200, 24);
    const pty = this.ptyOpt === undefined ? await loadNodePty() : this.ptyOpt;
    const id = `tm-${randomBytes(6).toString("hex")}`;
    const t = {
      id, cwd, name: String(name || `Terminal ${this.listFor(cwd).length + 1}`).slice(0, 60),
      createdAt: Date.now(), exited: null, buf: "", events: new EventEmitter(), usesPty: Boolean(pty),
    };
    t.events.setMaxListeners(50);
    const emit = (data) => {
      if (!data) return;
      t.buf += data;
      if (t.buf.length > SCROLLBACK_CHARS) t.buf = t.buf.slice(-SCROLLBACK_CHARS);
      t.events.emit("data", data);
    };
    const finish = (code) => {
      if (t.exited) return;
      t.exited = { code: code ?? null };
      t.events.emit("exit", t.exited);
      setTimeout(() => { if (this.terms.get(id) === t) this.terms.delete(id); }, this.evictMs).unref();
    };
    if (pty) {
      const p = pty.spawn(this.shell.file, this.shell.args, { name: "xterm-256color", cwd, cols, rows, env: shellEnv() });
      Object.defineProperty(t, "pid", { get: () => p.pid, enumerable: true }); // ConPTY reports 0 until the agent is up
      p.onData(emit);
      p.onExit((e) => finish(e?.exitCode));
      t.write = (d) => p.write(d);
      t.resize = (c, r) => { try { p.resize(c, r); } catch {} };
      // Tree first: once the root shell is gone, taskkill /PID can no longer find its children.
      t.kill = () => { killTree(p.pid, { sync: true }); try { p.kill(); } catch {} };
      t.killSync = t.kill;
    } else {
      const child = spawn(this.shell.file, this.shell.args, {
        cwd, env: shellEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
      });
      t.pid = child.pid;
      child.stdout.on("data", (d) => emit(d.toString("utf8")));
      child.stderr.on("data", (d) => emit(d.toString("utf8")));
      child.on("error", (e) => { emit(`\r\n[shell failed: ${e.message}]\r\n`); finish(-1); });
      child.on("close", (code) => finish(code));
      child.stdin.on("error", () => {});
      // No TTY: the shell won't echo, so echo what is typed (CR becomes CRLF) and send complete lines.
      let line = "";
      let prev = "";
      t.write = (d) => {
        for (const ch of d) {
          const was = prev;
          prev = ch;
          if (ch === "\n" && was === "\r") continue; // CRLF is one newline
          if (ch === "\r" || ch === "\n") { emit("\r\n"); child.stdin.write(line + "\n"); line = ""; }
          else if (ch === "\x7f" || ch === "\b") { if (line) { line = line.slice(0, -1); emit("\b \b"); } }
          else if (ch === "\x03") { emit("^C\r\n"); line = ""; }
          else if (ch >= " ") { line += ch; emit(ch); }
        }
      };
      t.resize = () => {};
      t.kill = () => killTree(child.pid);
      t.killSync = () => killTree(child.pid, { sync: true });
    }
    this.terms.set(id, t);
    return this.info(t);
  }

  info(t) {
    return { id: t.id, cwd: t.cwd, name: t.name, pid: t.pid, pty: t.usesPty, exited: t.exited, createdAt: t.createdAt };
  }
  listFor(cwd) {
    return [...this.terms.values()].filter((t) => !cwd || t.cwd === cwd);
  }
  list(cwd) {
    return this.listFor(cwd).map((t) => this.info(t));
  }
  get(id) {
    const t = this.terms.get(id);
    if (!t) throw Object.assign(new Error("terminal not found"), { status: 404 });
    return t;
  }
  input(id, data) {
    const t = this.get(id);
    if (t.exited) throw Object.assign(new Error("terminal has exited"), { status: 409 });
    t.write(String(data ?? "").slice(0, 65_536));
  }
  resize(id, cols, rows) {
    const t = this.get(id);
    if (!t.exited) t.resize(clampDim(cols, 2, 500, 80), clampDim(rows, 2, 200, 24));
  }
  rename(id, name) {
    const t = this.get(id);
    t.name = String(name ?? "").slice(0, 60) || t.name;
  }
  /** Replays the scrollback, then live output. Returns an unsubscribe function. */
  subscribe(id, { onData, onExit }) {
    const t = this.get(id);
    if (t.buf) onData(t.buf);
    if (t.exited) { onExit(t.exited); return () => {}; }
    t.events.on("data", onData);
    t.events.on("exit", onExit);
    return () => { t.events.off("data", onData); t.events.off("exit", onExit); };
  }
  output(id) {
    return this.get(id).buf;
  }
  kill(id) {
    const t = this.get(id);
    this.terms.delete(id);
    if (!t.exited) t.kill();
  }
  killAll({ sync = false } = {}) {
    for (const t of this.terms.values()) {
      if (t.exited) continue;
      try { sync ? t.killSync() : t.kill(); } catch {}
    }
    this.terms.clear();
  }
}

let shared;
export const sharedTerminals = () => (shared ??= new TerminalManager());
