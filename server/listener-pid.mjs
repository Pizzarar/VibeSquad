// POSIX listener-pid lookup (forge-host A3, audit R3). Finds the pid listening on a TCP port with a bounded fallback chain:
// lsof, then ss, then /proc/net/tcp{,6} + a /proc/*/fd scan. A missing tool (ENOENT), a timeout, a parse failure or an empty
// result falls through to the next step; if all fail the answer is null (unknown). Never throws. Node built-ins only; exec/fs are
// injectable so every step runs on Windows. restart-runtime.mjs calls this off win32 only; the win32 netstat path is unchanged.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

const TIMEOUT_MS = 5000;
const defaultExec = (file, args, o) => execFileSync(file, args, { encoding: "utf8", timeout: o.timeout, stdio: ["ignore", "pipe", "ignore"] });
const pidOf = (s) => { const n = Number(s); return Number.isInteger(n) && n > 0 ? n : null; };

export function parseLsof(out) {
  for (const tok of String(out ?? "").split(/\s+/)) { const n = /^\d+$/.test(tok) ? pidOf(tok) : null; if (n) return n; }
  return null;
}

export function parseSs(out, port) {
  for (const line of String(out ?? "").split(/\r?\n/)) {
    const m = /pid=(\d+)/.exec(line);
    if (!m) continue;
    if (!new RegExp(`[:\]]${port}\s`).test(`${line} `)) continue; // only this port's row
    const n = pidOf(m[1]);
    if (n) return n;
  }
  return null;
}

/** Socket inodes in LISTEN state (0A) for `port` from the text of /proc/net/tcp or tcp6. */
export function parseProcNetTcp(text, port) {
  const inodes = [];
  const lines = String(text ?? "").split(/\r?\n/).slice(1);
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const p = /:([0-9A-Fa-f]+)$/.exec(f[1]);
    if (!p || parseInt(p[1], 16) !== port) continue;
    if (/^\d+$/.test(f[9]) && f[9] !== "0") inodes.push(f[9]);
  }
  return inodes;
}

/** Pid listening on `port`, or null. All of exec/readFile/readdir/readlink are test overrides. */
export function posixListenerPid(port, { exec = defaultExec, readFile = (p) => readFileSync(p, "utf8"), readdir = readdirSync, readlink = readlinkSync, timeoutMs = TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const o = { timeout: timeoutMs };
  const steps = [
    () => parseLsof(exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], o)),
    () => parseSs(exec("ss", ["-ltnpH", `sport = :${port}`], o), port),
    () => {
      const inodes = new Set();
      for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) { try { for (const i of parseProcNetTcp(readFile(f), port)) inodes.add(i); } catch { /* next */ } }
      if (!inodes.size) return null;
      for (const d of readdir("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        let fds; try { fds = readdir(`/proc/${d}/fd`); } catch { continue; } // gone or not ours
        for (const fd of fds) {
          let t; try { t = String(readlink(`/proc/${d}/fd/${fd}`)); } catch { continue; }
          const m = /^socket:\[(\d+)\]$/.exec(t);
          if (m && inodes.has(m[1])) return pidOf(d);
        }
      }
      return null;
    },
  ];
  for (const step of steps) { try { const n = step(); if (n) return n; } catch { /* fall through */ } }
  return null;
}
