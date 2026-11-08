// Shared harness for the overlap guard: Playwright/Edge resolution, dist build, static server, API mocks.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require2 = createRequire(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const TEAMS_REGISTRY = {
  revision: "ui-overlap-guard",
  teams: [
    {
      id: "vibesquad", name: "VibeSquad", color: "#b07cf5",
      leadFlagTokens: 150000, leadAutoHandoffTokens: 250000, leadHardCapTokens: 300000,
      brainstormWarnTokens: 80000, brainstormRestartTokens: 150000,
      lanes: [
        { id: "riffbot", name: "RiffBot", hub: true, paths: ["VibeSquad"] },
        { id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"] },
      ],
      paths: ["VibeSquad"],
    },
  ],
};

export function resolvePlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_DIR) candidates.push(path.join(process.env.PLAYWRIGHT_DIR, "playwright-core"));
  for (const n of ["playwright-core", "playwright"]) {
    try { candidates.push(require2.resolve(n)); } catch {}
  }
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm/node_modules/@playwright/mcp/node_modules/playwright-core"));
    candidates.push(path.join(process.env.APPDATA, "npm/node_modules/@playwright/mcp/node_modules/playwright"));
  }
  for (const c of candidates) {
    try { return require2(c); } catch {}
  }
  return null;
}

export function findBrowser() {
  const l = process.env.LOCALAPPDATA;
  return [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    l && `${l}/Microsoft/Edge/Application/msedge.exe`,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    l && `${l}/Google/Chrome/Application/chrome.exe`,
  ].filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

/** Build dist/ when missing (or when UI_OVERLAP_REBUILD=1) so the guard sees this worktree's CSS. */
export async function ensureDist() {
  const distIndex = path.join(REPO_ROOT, "dist", "index.html");
  if (fs.existsSync(distIndex) && process.env.UI_OVERLAP_REBUILD !== "1") return;
  const viteBin = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  await new Promise((res, rej) => {
    const child = spawn(process.execPath, [viteBin, "build"], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", rej);
    child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`vite build failed:\n${err.slice(0, 3000)}`))));
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".txt": "text/plain", ".woff": "font/woff", ".woff2": "font/woff2",
};

export async function serveDist() {
  const distDir = path.join(REPO_ROOT, "dist");
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    let filePath = path.join(distDir, pathname === "/" ? "index.html" : pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(distDir, "index.html");
    res.setHeader("content-type", MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
    fs.createReadStream(filePath).on("error", () => { res.statusCode = 404; res.end("Not found"); }).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** Route mocks: teams registry, /health with exposed LAN IPs (EXPOSED banner), everything else {ok:true}. */
export async function installRoutes(context) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(p)) return route.fulfill({ status: 200, contentType: "font/woff2", body: "" });
    if (p === "/api/teams" && req.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TEAMS_REGISTRY) });
    if (p === "/__vibesquad/health") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, lanEnabled: true, exposedIps: ["192.168.1.20", "100.64.0.5"], configWarnings: [] }) });
    }
    if (p.startsWith("/__vibesquad/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    return route.continue();
  });
}
