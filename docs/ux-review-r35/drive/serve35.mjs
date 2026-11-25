// R35: R34 static server + an in-memory /api/teams registry (GET + PUT with revision) so Crunch/Main/order writes land.
// Usage: node serve35.mjs <dist> <port> [mainTeamId]
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const root = process.argv[2], port = +process.argv[3], mainId = process.argv[4];
const ex = JSON.parse(fs.readFileSync(process.env.TEAMS_JSON, "utf8"));
let rev = 1; let reg = { ...ex, teams: ex.teams.map((t) => (t.id === mainId ? { ...t, main: true } : t)) };
const types = { ".js":"text/javascript", ".css":"text/css", ".html":"text/html", ".svg":"image/svg+xml", ".png":"image/png", ".json":"application/json", ".webmanifest":"application/json", ".woff2":"font/woff2" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/storybook") && req.method === "HEAD") { res.writeHead(200); return res.end(); }
  if (u.pathname === "/api/teams") {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ...reg, revision: "r" + rev })); }
    if (req.method === "PUT") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const d = JSON.parse(b); reg = { ...reg, teams: d.teams }; rev++; console.log("PUT teams", JSON.stringify(d.teams.map((t) => [t.id, t.vibeMode, t.main]))); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ revision: "r" + rev })); }); return; }
  }
  if (u.pathname.startsWith("/api") || u.pathname.startsWith("/ws") || u.pathname.startsWith("/__vibesquad")) { res.writeHead(404); return res.end(); }
  let f = path.join(root, decodeURIComponent(u.pathname));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, "index.html");
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(port, "127.0.0.1");
