// Paseo CLI shell-outs moved verbatim from cli/vs.mjs (runPaseo and its helpers). Only the PASEO_HOME
// value is now a parameter, so cli/vs.mjs keeps its import-time constant.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_CLI_TIMEOUT_MS = 1500;

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// shellQuote wraps every arg in double quotes and cmd.exe runs without delayed expansion (/V:OFF), so
// ^ & | < > ! are literal there. Only `"` (ends the quote), %VAR% expansion and line breaks / NUL can escape.
const UNSAFE_SHELL_ARG = /[\r\n\0"%]/;

export function run(command, args, timeoutMs) {
  try {
    if (process.platform === "win32" && (command === "paseo" || /\.(cmd|bat)$/i.test(command))) {
      if (args.some((a) => UNSAFE_SHELL_ARG.test(String(a)))) {
        return { status: null, stdout: "", stderr: "refusing argument with shell metacharacters", error: new Error("unsafe argument") };
      }
      const line = [command, ...args].map(shellQuote).join(" ");
      return spawnSync(line, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, shell: true });
    }
    return spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  } catch (err) {
    return { status: null, stdout: "", stderr: String(err?.message ?? err), error: err };
  }
}

export function hasCustomMockCli() {
  const cli = String(process.env.PASEO_CLI ?? "").trim();
  if (!cli || cli === "paseo" || cli === "paseo.cmd") return false;
  if (/[\\/]Programs[\\/]Paseo[\\/]resources[\\/]bin[\\/]paseo(?:\.cmd|\.exe)?$/i.test(cli)) return false;
  return true;
}

export function hasCustomOfflineStore(paseoHome) {
  if (hasCustomMockCli()) return false;
  if (!process.env.PASEO_HOME) return false;
  const defaultHome = path.resolve(path.join(os.homedir(), ".paseo"));
  if (path.resolve(paseoHome) === defaultHome) return false;
  return !fs.existsSync(path.join(paseoHome, "server-id"));
}

/** stdout of a `paseo <args>` run, or null when offline, refused, failed or timed out. */
export function runPaseoCli(paseoHome, args, timeoutMs = DEFAULT_CLI_TIMEOUT_MS) {
  if (hasCustomOfflineStore(paseoHome)) return null;
  const idArg = args[0] === "inspect" ? args[1] : args[0] === "agent" ? args[2] : undefined;
  if ((args[0] === "inspect" || args[0] === "agent") && !AGENT_ID_RE.test(String(idArg ?? ""))) return null;
  const cli = process.env.PASEO_CLI || "paseo";
  const effectiveTimeout = hasCustomMockCli() ? Math.max(timeoutMs, 5000) : timeoutMs;
  const result = run(cli, args, effectiveTimeout);
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? null;
}
