import { spawn } from "node:child_process";

export const ES_CONTINUOUS = 0x80000000;
export const ES_SYSTEM_REQUIRED = 0x00000001;
export const ES_HOLD_FLAGS = 0x80000001;

const KEEP_AWAKE_PS = `
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[W.K]::SetThreadExecutionState(2147483649) | Out-Null
try {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line -eq 'release') { break }
  }
} finally {
  [W.K]::SetThreadExecutionState(2147483648) | Out-Null
}
`.trim();

export function countRunningAgents(agents = []) {
  if (!Array.isArray(agents)) return 0;
  let count = 0;
  for (const a of agents) {
    if (a && !a.archivedAt && a.status === "running") {
      count += 1;
    }
  }
  return count;
}

export function createWindowsWakeLockApplier({ spawnImpl = spawn } = {}) {
  let child = null;

  const stopChild = () => {
    if (!child) return;
    const proc = child;
    child = null;
    try {
      proc.stdin?.write("release\n");
      proc.stdin?.end();
    } catch {}
    try {
      proc.kill();
    } catch {}
  };

  return (hold) => {
    if (hold) {
      if (child && child.exitCode === null && !child.killed) return;
      stopChild();
      try {
        const proc = spawnImpl(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", KEEP_AWAKE_PS],
          { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
        );
        proc.unref?.();
        proc.on?.("error", () => {
          if (child === proc) child = null;
        });
        proc.on?.("exit", () => {
          if (child === proc) child = null;
        });
        child = proc;
      } catch {
        child = null;
      }
    } else {
      stopChild();
    }
  };
}

export function createKeepAwakeController({
  enabled: initialEnabled = true,
  platform = process.platform,
  applyState,
  spawnImpl = spawn,
} = {}) {
  let enabled = Boolean(initialEnabled);
  let holding = false;
  let runningCount = 0;
  let lastChangedAt = null;
  let transitions = 0;

  const applier =
    typeof applyState === "function"
      ? applyState
      : platform === "win32"
        ? createWindowsWakeLockApplier({ spawnImpl })
        : () => {};

  const syncHold = () => {
    const shouldHold = enabled && runningCount > 0;
    if (shouldHold === holding) return;
    holding = shouldHold;
    transitions += 1;
    lastChangedAt = new Date().toISOString();
    applier(holding);
  };

  const getState = () => ({
    enabled,
    holding,
    runningCount,
    lastChangedAt,
    transitions,
  });

  const update = (agents) => {
    if (Array.isArray(agents)) {
      runningCount = countRunningAgents(agents);
    }
    syncHold();
    return getState();
  };

  const setEnabled = (nextEnabled, agents) => {
    enabled = Boolean(nextEnabled);
    if (Array.isArray(agents)) {
      runningCount = countRunningAgents(agents);
    }
    syncHold();
    return getState();
  };

  const dispose = () => {
    if (holding) {
      holding = false;
      transitions += 1;
      lastChangedAt = new Date().toISOString();
      applier(false);
    }
    return getState();
  };

  return {
    update,
    setEnabled,
    getState,
    dispose,
  };
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader?.("content-type", "application/json");
  res.setHeader?.("cache-control", "no-store, no-cache, must-revalidate");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  if (req && req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export async function handleKeepAwakeRequest(req, res, controller) {
  const method = (req?.method || "GET").toUpperCase();
  if (method === "GET") {
    sendJson(res, 200, { ok: true, ...controller.getState() });
    return;
  }
  if (method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
      return;
    }
    if (typeof body?.enabled === "boolean") {
      controller.setEnabled(body.enabled, Array.isArray(body?.agents) ? body.agents : undefined);
    } else if (Array.isArray(body?.agents)) {
      controller.update(body.agents);
    }
    sendJson(res, 200, { ok: true, ...controller.getState() });
    return;
  }
  sendJson(res, 405, { ok: false, error: "Method not allowed" });
}
