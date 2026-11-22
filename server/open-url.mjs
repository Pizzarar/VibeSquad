// Non-Windows "open this URL in a browser" for the launcher (forge audit R10). Windows keeps its own
// Edge/Chrome app-window path in serve.mjs; this is the additive darwin/Linux branch.
import { spawn as realSpawn } from "node:child_process";

/** Opener binary for a platform, or null when the platform is not handled here. */
export function openerFor(platform) {
  if (platform === "darwin") return "open";
  if (platform === "win32") return null;
  return "xdg-open";
}

/** A Linux box with neither DISPLAY nor WAYLAND_DISPLAY is a headless forge: nothing to open a window on. */
export function hasDisplay(platform, env) {
  if (platform !== "linux") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Best-effort open. Returns "opened" | "headless" | "unsupported". A missing opener binary is reported via the
 * child's error event, which is swallowed, so it can never crash the server.
 */
export function openUrlPosix(target, { platform = process.platform, env = process.env, spawn = realSpawn } = {}) {
  const bin = openerFor(platform);
  if (!bin) return "unsupported";
  if (!hasDisplay(platform, env)) return "headless";
  try {
    const child = spawn(bin, [target], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref?.();
  } catch {
    // A synchronous spawn failure is equally non-fatal.
  }
  return "opened";
}
