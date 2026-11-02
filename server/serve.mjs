import { createServer, get } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import { createReadStream, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  createVibesquadMiddleware,
  handleAuthStatus,
  handleDesktopInstaller,
  handleDesktopUpdateJson,
  handleHealth,
  readPaseo,
  setExposure,
} from "./vibesquad-api.mjs";
import {
  authenticate,
  getTls,
  handleCaCrt,
  handlePairRedeem,
  isAllowedHostHeader,
  isLocalBrowserSafe,
  isLoopbackOrigin,
  netConfig,
  sendUnpaired,
  trackSocket,
} from "./auth.mjs";
import "./brainstorm.mjs";
import "./inbox.mjs";
import { installVsShim } from "../cli/vs.mjs";
import { startPushWatcher } from "./push.mjs";
import { ensurePaseoDaemon } from "./first-run.mjs";
import { loadUserSettings } from "./user-settings.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const distDir = join(rootDir, "dist");
const fallbackDistDir = rootDir.includes(".worktrees") ? resolve(rootDir, "../..", "dist") : null;
const port = Number(process.env.VIBESQUAD_PORT || 4180);
const url = `http://localhost:${port}`;
const wantOpen = process.argv.includes("--open");

// Public default is loopback only; LAN/meshnet listeners are opt-in via CLI/env or ~/.vibesquad/settings.json.
export function resolveLanEnabled({ argv = process.argv, env = process.env, settings = loadUserSettings() } = {}) {
  if (argv.includes("--no-lan")) return false;
  if (argv.includes("--lan")) return true;
  const envVal = String(env.VIBESQUAD_LAN ?? "").trim().toLowerCase();
  if (envVal === "1" || envVal === "true") return true;
  if (envVal === "0" || envVal === "false") return false;
  return Boolean(settings?.lanEnabled);
}
const lanEnabled = resolveLanEnabled();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

// Restores and focuses an existing window titled "VibeSquad"; exit 0 = found and activated.
const FOCUS_PS = `
Add-Type -Namespace W -Name U -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
"@
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "VibeSquad*" } | Select-Object -First 1
if (-not $p) { exit 1 }
[W.U]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null
[W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
exit 0
`;

function focusExistingWindow() {
  return new Promise((ok) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", FOCUS_PS], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      ps.kill();
      ok(false);
    }, 8000);
    ps.on("error", () => ok(false));
    ps.on("exit", (code) => {
      clearTimeout(timer);
      ok(code === 0);
    });
  });
}

function findExe(candidates) {
  return candidates.find((c) => c.includes(sep) && existsSync(c)) ?? null;
}

function launchApp(exe) {
  // A bare name relies on PATH; spawn reports a missing binary via the error event.
  return new Promise((ok) => {
    const child = spawn(exe, [`--app=${url}`], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => ok(false));
    setTimeout(() => {
      child.unref();
      ok(true);
    }, 400);
  });
}

async function openBrowser() {
  if (await focusExistingWindow()) return;
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const browsers = [
    [join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), join(pf, "Microsoft", "Edge", "Application", "msedge.exe"), "msedge"],
    [join(pf, "Google", "Chrome", "Application", "chrome.exe"), join(pf86, "Google", "Chrome", "Application", "chrome.exe"), "chrome"],
  ];
  for (const list of browsers) {
    const exe = findExe(list) ?? list[list.length - 1];
    if (await launchApp(exe)) return;
  }
  // `start` is a cmd builtin; the empty "" is the window title argument.
  spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function isListening() {
  return new Promise((ok) => {
    const req = get(url + "/", { timeout: 1500 }, (res) => {
      res.resume();
      ok(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => ok(false));
  });
}

function fileIn(dir, urlPath) {
  let p;
  try {
    p = normalize(join(dir, decodeURIComponent(urlPath)));
  } catch {
    return null;
  }
  if (p !== dir && !p.startsWith(dir + sep)) return null;
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function findDistFile(urlPath) {
  const primary = fileIn(distDir, urlPath);
  if (primary) return primary;
  if (fallbackDistDir) {
    return fileIn(fallbackDistDir, urlPath);
  }
  return null;
}

function sendFile(res, file) {
  res.statusCode = 200;
  res.setHeader("content-type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
  if (file.includes(`${sep}assets${sep}`)) {
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  }
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

function renderMissingDistHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VibeSquad — Building Frontend…</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0c0b14;
    color: #eef2ff;
    font-family: "JetBrains Mono", Consolas, monospace;
    padding: 20px;
  }
  .card {
    max-width: 520px;
    width: 100%;
    padding: 24px;
    background: #121120;
    border: 1px solid #ff2a85;
    box-shadow: 0 0 28px rgba(255, 42, 133, 0.2);
  }
  h1 {
    margin: 0 0 10px;
    font-size: 16px;
    color: #ff2a85;
    text-transform: uppercase;
    letter-spacing: 1.2px;
  }
  p {
    margin: 0 0 14px;
    font-size: 12px;
    line-height: 1.6;
    color: #8a93b2;
  }
  .actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  .btn {
    padding: 10px 14px;
    background: #00f0ff;
    color: #05060d;
    border: none;
    font-family: inherit;
    font-size: 12px;
    font-weight: 800;
    text-decoration: none;
    cursor: pointer;
    text-transform: uppercase;
  }
  .btn-sec {
    padding: 10px 14px;
    background: #18172b;
    color: #eef2ff;
    border: 1px solid #282644;
    font-family: inherit;
    font-size: 12px;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>Frontend Not Built Yet (dist/index.html missing)</h1>
    <p>dist/index.html missing - run <code>npm run build</code> first, or connect to a VibeSquad server that is already running.</p>
    <p>Auto-reloading every 2 seconds…</p>
    <div class="actions">
      <a href="/__desktop/setup" class="btn">Change Server / Re-pair</a>
      <button type="button" class="btn-sec" onclick="window.location.reload()">Retry Now</button>
    </div>
  </div>
  <script>
    setTimeout(() => { window.location.reload(); }, 2000);
  </script>
</body>
</html>`;
}

// Mounts /__vibesquad/brainstorm-summary, /__vibesquad/vs-log, /__vibesquad/brainstorm-restart, /__vibesquad/push/*, /api/teams, etc.
const api = createVibesquadMiddleware(rootDir);

function handle(req, res) {
  api(req, res, () => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
      return res.end();
    }
    const path = (req.url ?? "/").split("?")[0];
    const file = findDistFile(path === "/" ? "/index.html" : path);
    if (file) return sendFile(res, file);
    // Missing asset (has an extension and is not /index.html) is a real 404; anything else is an SPA route.
    if (extname(path) && path !== "/index.html") {
      res.statusCode = 404;
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
      return res.end("not found");
    }
    const index = findDistFile("/index.html");
    if (!index) {
      res.statusCode = 500;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
      return res.end(renderMissingDistHtml());
    }
    sendFile(res, index);
  });
}

// Callers must have passed the auth + Origin allowlist before reaching this. The daemon only accepts its own origin.
function proxyUpgrade(req, socket, head) {
  const [host, p] = readPaseo(rootDir).listen.replace(/^wss?:\/\//, "").split(/:(?=\d+$)/);
  const upstream = connect(Number(p), host || "127.0.0.1");
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
  upstream.on("close", close);
  socket.on("close", close);
  upstream.on("connect", () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (name.toLowerCase() === "origin") continue;
      raw += `${name}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += `Origin: http://${host || "127.0.0.1"}:${p}\r\n`;
    upstream.write(raw + "\r\n");
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
}

function rejectUpgrade(socket, line) {
  socket.write(`HTTP/1.1 ${line}\r\n\r\n`);
  socket.destroy();
}

// Paired remote browsers send the https origin they loaded the app from (our own host/ip) or a loopback/tauri origin.
function isAllowedWsOrigin(origin) {
  if (isLoopbackOrigin(origin)) return true;
  try {
    return isAllowedHostHeader(new URL(origin).host);
  } catch {
    return false;
  }
}

/**
 * Where a plain-http request should go: the Host it used when this server answers to it, else the
 * meshnet name, else the meshnet IP (the TLS cert always carries it), else localhost. Never an empty
 * host: with no meshnet name configured the 426 page used to say "https://:4180" (PLAN_BUGS_BATCH1 block 5).
 */
export function httpsTargetHost(hostHeader, { port: p = port, meshnetHost = "", meshnetIp = "", allowed = isAllowedHostHeader } = {}) {
  if (hostHeader && allowed(hostHeader)) return /:\d+$/.test(hostHeader) ? hostHeader : `${hostHeader}:${p}`;
  return `${meshnetHost || meshnetIp || "localhost"}:${p}`;
}

export function createMeshnetMux({ port: p = port, meshnetHost = netConfig().meshnetHost, meshnetIp = netConfig().meshnetIp, tls = getTls() } = {}) {
  const target = (req) => httpsTargetHost(req.headers.host, { port: p, meshnetHost, meshnetIp });
  const handleMeshnetHttp = (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/ca.crt" && (req.method === "GET" || req.method === "HEAD")) {
      return handleCaCrt(req, res);
    }
    if ((path === "/VibeSquad-setup.exe" || path === "/__vibesquad/desktop/VibeSquad-setup.exe") && (req.method === "GET" || req.method === "HEAD")) {
      return handleDesktopInstaller(req, res, rootDir);
    }
    if (path === "/__vibesquad/desktop/update.json" && (req.method === "GET" || req.method === "HEAD")) {
      return handleDesktopUpdateJson(req, res, rootDir);
    }
    if ((path === "/api/health" || path === "/__vibesquad/health") && (req.method === "GET" || req.method === "HEAD")) {
      return handleHealth(req, res, rootDir);
    }
    if ((path === "/api/auth/status" || path === "/__vibesquad/auth/status") && (req.method === "GET" || req.method === "HEAD")) {
      return handleAuthStatus(req, res, rootDir);
    }
    if (path === "/pair" && req.method === "GET") {
      res.statusCode = 302;
      res.setHeader("location", `https://${target(req)}${req.url}`);
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
      return res.end();
    }
    // Phones type http://: send page loads straight to https instead of a dead-end 426.
    if (req.method === "GET" || req.method === "HEAD") {
      res.statusCode = 301;
      res.setHeader("location", `https://${target(req)}${req.url}`);
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
      return res.end();
    }
    res.statusCode = 426;
    res.setHeader("Upgrade", "TLS/1.3, HTTP/1.1");
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    res.end(`426 Upgrade Required — use https://${target(req)} (or GET /VibeSquad-setup.exe or GET /ca.crt)`);
  };

  const handleMeshnetHttps = (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/ca.crt" && (req.method === "GET" || req.method === "HEAD")) {
      return handleCaCrt(req, res);
    }
    if ((path === "/VibeSquad-setup.exe" || path === "/__vibesquad/desktop/VibeSquad-setup.exe") && (req.method === "GET" || req.method === "HEAD")) {
      return handleDesktopInstaller(req, res, rootDir);
    }
    if (path === "/__vibesquad/desktop/update.json" && (req.method === "GET" || req.method === "HEAD")) {
      return handleDesktopUpdateJson(req, res, rootDir);
    }
    if ((path === "/api/health" || path === "/__vibesquad/health") && (req.method === "GET" || req.method === "HEAD")) {
      return handleHealth(req, res, rootDir);
    }
    if ((path === "/api/auth/status" || path === "/__vibesquad/auth/status") && (req.method === "GET" || req.method === "HEAD")) {
      return handleAuthStatus(req, res, rootDir);
    }
    if (path === "/pair" && req.method === "GET") {
      return handlePairRedeem(req, res);
    }
    const dev = authenticate(req);
    if (!dev) return sendUnpaired(req, res);
    return handle(req, res);
  };

  const meshHttpServer = createServer(handleMeshnetHttp);
  const httpsServer = createHttpsServer(tls, handleMeshnetHttps);
  httpsServer.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    const dev = authenticate(req);
    if (!dev) return rejectUpgrade(socket, "401 Unauthorized");
    const origin = req.headers.origin;
    if (origin !== undefined && !isAllowedWsOrigin(origin)) return rejectUpgrade(socket, "403 Forbidden");
    trackSocket(dev.id, socket);
    proxyUpgrade(req, socket, head);
  });

  const mux = createTcpServer((socket) => {
    socket.once("readable", () => {
      const chunk = socket.read(1);
      if (!chunk) {
        socket.destroy();
        return;
      }
      const firstByte = chunk[0];
      socket.unshift(chunk);
      if (firstByte === 0x16) {
        httpsServer.emit("connection", socket);
      } else {
        meshHttpServer.emit("connection", socket);
      }
    });
    socket.on("error", () => socket.destroy());
  });
  return { mux, httpsServer, meshHttpServer };
}

if (wantOpen && (await isListening())) {
  await openBrowser();
  process.exit(0);
}

export const server = createServer(handle);
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws")) return socket.destroy();
  // Cross-site WebSocket hijacking: a browser page can open ws://127.0.0.1 with any Origin.
  if (!authenticate(req)) {
    const origin = req.headers.origin;
    if (!isLocalBrowserSafe(req) || origin === undefined || !isLoopbackOrigin(origin)) return rejectUpgrade(socket, "403 Forbidden");
  }
  proxyUpgrade(req, socket, head);
});
server.on("error", async (e) => {
  // Lost a race with another launcher: if it is ours, behave like the already-running case.
  if (e.code === "EADDRINUSE" && (await isListening())) {
    if (wantOpen) await openBrowser();
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);

if (isMain) {
  try {
    installVsShim();
  } catch {}
  if (loadUserSettings().startPaseoWithVibeSquad !== false) {
    void ensurePaseoDaemon({ listen: readPaseo(rootDir).listen });
  }
  server.listen(port, "127.0.0.1", () => {
    console.log(`VibeSquad serving ${distDir} on ${url}`);
    let activeMuxes = [];
    const applyLanListeners = (wantLan) => {
      for (const m of activeMuxes) {
        try {
          m.close();
        } catch {}
      }
      activeMuxes = [];
      const { meshnetIp, meshnetHost, lanIp } = netConfig();
      const bindIps = wantLan ? [...new Set([lanIp, meshnetIp].filter((ip) => ip && ip !== "127.0.0.1"))] : [];
      setExposure(wantLan, bindIps, applyLanListeners);
      if (!wantLan) {
        console.log("Loopback only. Pass --lan (or VIBESQUAD_LAN=1) or enable in Settings to listen on LAN/meshnet.");
        return;
      }
      if (bindIps.length > 0) {
        try {
          const tls = getTls();
          for (const ip of bindIps) {
            const { mux } = createMeshnetMux({ port, meshnetHost, tls });
            mux.on("error", (err) => {
              console.warn(`TLS/HTTP mux listener on ${ip}:${port} failed:`, err.message);
            });
            mux.listen(port, ip, () => {
              const label = ip === lanIp ? `Home LAN https://${ip}:${port}` : `Meshnet https://${meshnetHost}:${port} (${ip}:${port})`;
              console.log(`VibeSquad HTTPS/HTTP mux serving on ${label}`);
            });
            activeMuxes.push(mux);
          }
        } catch (err) {
          console.warn("TLS setup skipped:", err);
        }
      }
    };
    applyLanListeners(lanEnabled);
    startPushWatcher(rootDir);

    if (wantOpen) void openBrowser();
  });
}
