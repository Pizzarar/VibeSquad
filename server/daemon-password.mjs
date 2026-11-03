import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readRawPaseoConfig } from "./paseo-control.mjs";

export const DAEMON_PASSWORD_FILE = "daemon-password";
export const PASEO_LOCAL_CREDENTIAL_FILE = "local-credential";

export function vibeSquadHome() {
  return process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
}

export function daemonPasswordPath(home = vibeSquadHome()) {
  return join(home, DAEMON_PASSWORD_FILE);
}

export function readPaseoLocalCredential({ paseoHome, env = process.env } = {}) {
  const targetHome = paseoHome || env?.PASEO_HOME || process.env.PASEO_HOME || join(homedir(), ".paseo");
  const p = join(targetHome, PASEO_LOCAL_CREDENTIAL_FILE);
  if (!existsSync(p)) return "";
  try {
    const raw = readFileSync(p, "utf8");
    return raw.replace(/^\uFEFF/, "").replace(/\r?\n$/, "").trim();
  } catch {
    return "";
  }
}

export function readDaemonPassword({ home = vibeSquadHome(), env = process.env } = {}) {
  if (typeof env?.PASEO_DAEMON_PASSWORD === "string" && env.PASEO_DAEMON_PASSWORD.trim()) {
    return env.PASEO_DAEMON_PASSWORD.trim();
  }
  const p = daemonPasswordPath(home);
  if (!existsSync(p)) return "";
  try {
    const raw = readFileSync(p, "utf8");
    return raw.replace(/^\uFEFF/, "").replace(/\r?\n$/, "").trim();
  } catch {
    return "";
  }
}

export function daemonPasswordSource({ home = vibeSquadHome(), env = process.env, paseoHome } = {}) {
  if (typeof env?.PASEO_DAEMON_PASSWORD === "string" && env.PASEO_DAEMON_PASSWORD.trim()) {
    return "env";
  }
  const p = daemonPasswordPath(home);
  if (existsSync(p)) {
    try {
      const raw = readFileSync(p, "utf8").replace(/^\uFEFF/, "").replace(/\r?\n$/, "").trim();
      if (raw) return "file";
    } catch {}
  }
  if (readPaseoLocalCredential({ paseoHome, env })) {
    return "local-credential";
  }
  return "none";
}

export function isDaemonPasswordRequired({ paseoHome, configPath } = {}) {
  const target = configPath || join(paseoHome || process.env.PASEO_HOME || join(homedir(), ".paseo"), "config.json");
  if (!existsSync(target)) return false;
  try {
    const raw = readFileSync(target, "utf8").replace(/^\uFEFF/, "");
    const cfg = JSON.parse(raw);
    const pw = cfg?.daemon?.auth?.password;
    if (typeof pw === "string") return Boolean(pw.trim());
    return Boolean(pw);
  } catch {
    return false;
  }
}

export function writeDaemonPassword(password, { home = vibeSquadHome() } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const p = daemonPasswordPath(home);
  if (!password || !String(password).trim()) {
    rmSync(p, { force: true });
    return { configured: false, path: p };
  }
  const clean = String(password).replace(/\r?\n$/, "");
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${clean}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, p);
  try {
    chmodSync(p, 0o600);
  } catch {}
  return { configured: true, path: p };
}

export function readDaemonListen(opts = {}) {
  const env = opts.env ?? process.env;
  if (typeof env?.PASEO_DAEMON === "string" && env.PASEO_DAEMON.trim()) {
    const raw = env.PASEO_DAEMON.trim();
    const tls = /^wss:\/\//i.test(raw);
    const address = raw.replace(/^wss?:\/\//i, "").replace(/\/ws\/?$/i, "").replace(/\/$/, "");
    return { address, tls };
  }
  try {
    const { config } = readRawPaseoConfig(opts);
    const listen = config?.daemon?.listen ?? "127.0.0.1:6767";
    const tls = Boolean(config?.daemon?.tls?.enabled || config?.daemon?.tls?.cert || /^wss:\/\//i.test(String(listen)));
    const address = String(listen).replace(/^wss?:\/\//i, "").replace(/\/ws\/?$/i, "").replace(/\/$/, "").trim();
    if (!address) return null;
    return { address, tls };
  } catch {
    return { address: "127.0.0.1:6767", tls: false };
  }
}

export async function probeDaemonPassword(password, { listen, clientFactory, timeoutMs = 4000, ...opts } = {}) {
  const resolvedListen =
    typeof listen === "string"
      ? {
          address: listen.replace(/^wss?:\/\//i, "").replace(/\/ws\/?$/i, "").replace(/\/$/, ""),
          tls: /^wss:\/\//i.test(listen),
        }
      : listen !== undefined
        ? listen
        : readDaemonListen(opts);

  if (!resolvedListen?.address) {
    return {
      ok: false,
      unreachable: true,
      authFailureReason: null,
      error: "Paseo daemon is not running or listen address is unknown.",
    };
  }

  const factoryArgs = {
    endpoint: resolvedListen.address,
    tls: Boolean(resolvedListen.tls),
    ...(password ? { password } : {}),
    reconnect: { enabled: false },
  };

  const makeDefaultClient = (args) => {
    const rawAddr = String(args.endpoint || "");
    const wsUrl =
      rawAddr.startsWith("ws://") || rawAddr.startsWith("wss://")
        ? `${rawAddr.replace(/\/$/, "")}/ws`
        : `${args.tls ? "wss" : "ws"}://${rawAddr.replace(/\/$/, "")}/ws`;
    return new DaemonClient({
      url: wsUrl,
      clientId: `vibesquad-probe-${process.pid}-${Date.now().toString(36)}`,
      clientType: "cli",
      appVersion: "0.0.1",
      connectTimeoutMs: timeoutMs,
      ...(args.password ? { password: args.password } : { localCredential: () => readPaseoLocalCredential(opts) || null }),
      reconnect: { enabled: false },
    });
  };

  const client = (clientFactory || makeDefaultClient)(factoryArgs);
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => client.connect()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Daemon connection timed out")), timeoutMs);
        timer?.unref?.();
      }),
    ]);
    return { ok: true, unreachable: false, authFailureReason: null };
  } catch (err) {
    const detailReason =
      client?.getConnectionDetails?.()?.authFailureReason ||
      client?.authFailureReason ||
      err?.authFailureReason ||
      err?.reason ||
      null;
    const msg = String(err?.message || "");
    const matchedMsg = /password[_\s]+required/i.test(msg)
      ? "password_required"
      : /incorrect[_\s]+password/i.test(msg)
        ? "incorrect_password"
        : null;
    const reason =
      detailReason === "password_required" || detailReason === "incorrect_password"
        ? detailReason
        : matchedMsg;
    if (reason || /password_required|incorrect_password/i.test(msg)) {
      return {
        ok: false,
        unreachable: false,
        authFailureReason: reason || "incorrect_password",
        error: err?.message || "Authentication failed",
      };
    }
    return {
      ok: false,
      unreachable: true,
      authFailureReason: null,
      error: err?.message || "Daemon unreachable",
    };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client?.close?.();
    } catch {}
  }
}

export function getDaemonAuthStatus({ home = vibeSquadHome(), env = process.env, paseoHome, configPath } = {}) {
  const source = daemonPasswordSource({ home, env, paseoHome });
  return {
    ok: true,
    required: isDaemonPasswordRequired({ paseoHome, configPath }),
    configured: source !== "none",
    source,
  };
}
