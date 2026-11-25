// idea-941: owner-set, time-boxed rollout window for the idea-883 merge/push verdict gate.
//
// The gate FAILS CLOSED by default: with no window (absent, unreadable, malformed, forged, future-dated, over-long or
// expired) a missing or FAIL verdict refuses exactly as idea-883 does. Only an active window downgrades a *missing*
// verdict to a loud warning; a recorded FAIL still refuses inside the window (a FAIL is the reviewer's real verdict, the
// rollout gap is only about digests written before the server restarted onto the verdict-writer build).
//
// Trust model: the window file (~/.vibesquad/verdict-rollout-window.json) is MACed with HMAC-SHA256 keyed by the
// per-install owner secret (~/.vibesquad/local-token, the same secret every owner verb's proof rests on: X1
// hasOwnerProof / ownerProofFromEnv). Only the owner verb `vs push-guard window open` writes it, and it refuses from an
// agent shell (VS_AGENT_ID / PASEO_AGENT_ID / VS_AGENT_TOKEN set) or without owner proof. An agent that writes the file
// by hand cannot produce a valid MAC without the owner's secret, so the gate ignores it (and says so). The window's
// expiry is inside the MAC, so it cannot be extended, and it is capped at VERDICT_WINDOW_MAX_MS. Nothing is inferred
// from server-start files or capability markers: a rollback, a missing restart or a forged marker never weakens the gate.
// Closing the window (deleting the file) only tightens the gate, so `close` needs no owner proof.
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localTokenPath, readLocalToken } from "./local-token.mjs";

export const VERDICT_WINDOW_FILE = "verdict-rollout-window.json";
/** Longest window the owner may open in one go (re-open to extend; each open is a fresh owner action). */
export const VERDICT_WINDOW_MAX_MS = 24 * 60 * 60 * 1000;
/** Clock skew tolerated on `openedAt` (a window "opened" further in the future than this is invalid). */
const SKEW_MS = 5 * 60 * 1000;
const MAC_LABEL = "vs-verdict-rollout-window:v1";

const homeOf = (home, env = process.env) => path.resolve(home || env.VIBESQUAD_HOME || process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
export const verdictWindowPath = (home, env) => path.join(homeOf(home, env), VERDICT_WINDOW_FILE);

function macOf(token, { openedAt, until, reason }) {
  return createHmac("sha256", token).update([MAC_LABEL, openedAt, until, reason].join("\0")).digest("hex");
}

/** "90m" / "4h" / "1d" / "3600s" -> ms; null when unparseable or non-positive. */
export function parseWindowDuration(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i.exec(String(text ?? ""));
  if (!m) return null;
  const ms = Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

/** True when `env` is an agent shell (mirrors cli/vs.mjs assertOwnerShell / assertKillBackgroundOwner). */
export function isAgentShell(env = process.env) {
  return ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN"].some((k) => String(env[k] ?? "").trim());
}

/**
 * The window as the gate sees it, read offline. `state`:
 *   "none"    no window file (normal: the gate fails closed)
 *   "active"  valid owner MAC, openedAt <= now < until, until - openedAt <= max
 *   "expired" valid owner MAC, but now >= until
 *   "invalid" unreadable / malformed / bad MAC / no owner secret to check it with / over-long / future-dated
 * Only "active" changes the gate's behavior.
 */
export function readVerdictWindow({ home, env = process.env, now = Date.now(), tokenFile } = {}) {
  const dir = homeOf(home, env);
  const file = path.join(dir, VERDICT_WINDOW_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { state: "none", active: false, file };
    return { state: "invalid", active: false, file, problem: `unreadable (${err?.code ?? err?.message ?? err})` };
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return { state: "invalid", active: false, file, problem: "not JSON" };
  }
  const openedAt = typeof rec?.openedAt === "string" ? rec.openedAt : "";
  const until = typeof rec?.until === "string" ? rec.until : "";
  const reason = typeof rec?.reason === "string" ? rec.reason : "";
  const mac = typeof rec?.mac === "string" ? rec.mac : "";
  const openedMs = Date.parse(openedAt);
  const untilMs = Date.parse(until);
  const base = { active: false, file, openedAt, until, reason };
  if (!Number.isFinite(openedMs) || !Number.isFinite(untilMs) || !/^[0-9a-f]{64}$/.test(mac)) return { ...base, state: "invalid", problem: "malformed" };
  const token = readLocalToken(tokenFile ?? localTokenPath(dir));
  if (!token) return { ...base, state: "invalid", problem: "no owner secret (local-token) to verify it with" };
  const want = Buffer.from(macOf(token, { openedAt, until, reason }), "hex");
  if (!timingSafeEqual(want, Buffer.from(mac, "hex"))) return { ...base, state: "invalid", problem: "MAC does not verify (not opened by the owner verb)" };
  if (untilMs - openedMs > VERDICT_WINDOW_MAX_MS || untilMs <= openedMs) return { ...base, state: "invalid", problem: "duration outside (0, 24h]" };
  if (openedMs > now + SKEW_MS) return { ...base, state: "invalid", problem: "opened in the future" };
  if (now >= untilMs) return { ...base, state: "expired" };
  return { ...base, state: "active", active: true, remainingMs: untilMs - now };
}

/**
 * Owner verb: open (or replace) the window for `durationMs` (<= 24h). Refuses from an agent shell or without the owner's
 * local token (the MAC key). Returns the written record (without the MAC).
 */
export function openVerdictWindow({ home, env = process.env, durationMs, reason = "", now = Date.now(), tokenFile } = {}) {
  if (isAgentShell(env)) throw new Error("vs push-guard window open is an owner verb; it never runs from an agent shell (VS_AGENT_ID / PASEO_AGENT_ID / VS_AGENT_TOKEN is set). Ask the owner.");
  const dir = homeOf(home, env);
  const token = readLocalToken(tokenFile ?? localTokenPath(dir));
  if (!token) throw new Error("vs push-guard window open: no owner proof (no readable local token under the VibeSquad home); only the owner's shell may open the rollout window.");
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("vs push-guard window open: --for <duration> is required (e.g. --for 4h; max 24h).");
  if (durationMs > VERDICT_WINDOW_MAX_MS) throw new Error("vs push-guard window open: the window is capped at 24h; re-open it to extend.");
  const openedAt = new Date(now).toISOString();
  const until = new Date(now + durationMs).toISOString();
  const why = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const rec = { openedAt, until, reason: why, by: "owner", idea: "idea-941" };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, VERDICT_WINDOW_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...rec, mac: macOf(token, { openedAt, until, reason: why }) }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ...rec, file };
}

/** Close the window (only tightens the gate, so any caller may). Returns true when a file was removed. */
export function closeVerdictWindow({ home, env = process.env } = {}) {
  const file = verdictWindowPath(home, env);
  try {
    fs.rmSync(file);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

const fmtLeft = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

/** One-line status for `vs push-guard window status` and the gate's notes. */
export function describeVerdictWindow(win) {
  if (!win || win.state === "none") return "verdict rollout window: none (the verdict gate fails closed)";
  if (win.state === "active") return `verdict rollout window: ACTIVE until ${win.until} (${fmtLeft(win.remainingMs)} left; opened ${win.openedAt}${win.reason ? `: ${win.reason}` : ""})`;
  if (win.state === "expired") return `verdict rollout window: expired at ${win.until} (ignored; the verdict gate fails closed)`;
  return `verdict rollout window: INVALID, ignored (${win.problem}); the verdict gate fails closed. File: ${win.file}`;
}
