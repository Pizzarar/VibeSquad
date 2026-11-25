// R34 live-server check: serve a dist build, forward every non-static request (HTTP, SSE, WS upgrade) to the owner's
// live VibeSquad server on 127.0.0.1:4180 (read-only browsing). Optional delay (ms) holds /api/teams and the runner
// /events stream back, to mimic project data arriving well after first paint.
// Usage: node live.mjs <distDir> <port> [delayMs]
import http from "node:http"; import net from "node:net"; import fs from "node:fs"; import path from "node:path";
const root = process.argv[2], port = +process.argv[3], delay = +(process.argv[4] || 0), UP = 4180;
const types = { ".js":"text/javascript", ".css":"text/css", ".html":"text/html", ".svg":"image/svg+xml", ".png":"image/png", ".json":"application/json", ".webmanifest":"application/json", ".woff2":"font/woff2" };
const isData = (p) => p.startsWith("/api") || p.startsWith("/__vibesquad");
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (isData(u.pathname)) {
    const go = () => { const up = http.request({ host: "127.0.0.1", port: UP, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${UP}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); up.on("error", () => { try { res.writeHead(502); res.end(); } catch {} }); req.pipe(up); };
    const slow = delay && (u.pathname === "/api/teams" || u.pathname.endsWith("/runner/events"));
    return slow ? setTimeout(go, delay) : go();
  }
  let f = path.join(root, decodeURIComponent(u.pathname));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, "index.html");
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});
srv.on("upgrade", (req, sock, head) => { const up = net.connect(UP, "127.0.0.1", () => { up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries({ ...req.headers, host: `127.0.0.1:${UP}` }).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n"); up.write(head); sock.pipe(up).pipe(sock); }); up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy()); });
srv.listen(port, "127.0.0.1");
