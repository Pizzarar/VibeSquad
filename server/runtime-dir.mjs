// The one definition of "where is the synced runtime": sync-runtime, the restart-request loop and scripts/restart-runtime.mjs
// all read it here. Node built-ins only, so the detached restart script can import it without pulling the server in.
import os from "node:os";
import path from "node:path";

/**
 * Precedence: VIBESQUAD_RUNTIME_DIR > win32 `%LOCALAPPDATA%\VibeSquad\runtime` (else `~\AppData\Local\...`, today's exact path)
 * > `<VIBESQUAD_HOME or ~/.vibesquad>/runtime`. `platform` / `homedir` are injectable so every branch is testable anywhere.
 */
export function runtimeDir(env = process.env, { platform = process.platform, homedir = os.homedir } = {}) {
  const override = String(env.VIBESQUAD_RUNTIME_DIR ?? "").trim();
  if (override) return override;
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "VibeSquad", "runtime");
  }
  return path.join(env.VIBESQUAD_HOME || path.join(homedir(), ".vibesquad"), "runtime");
}
