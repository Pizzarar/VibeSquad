import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const root = process.argv[2], port = +process.argv[3];
const types = { ".js":"text/javascript", ".css":"text/css", ".html":"text/html", ".svg":"image/svg+xml", ".png":"image/png", ".json":"application/json", ".webmanifest":"application/json", ".woff2":"font/woff2" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/storybook") && req.method === "HEAD") { res.writeHead(200); return res.end(); }
  if (u.pathname.startsWith("/api") || u.pathname.startsWith("/ws")) { res.writeHead(404); return res.end(); }
  let f = path.join(root, decodeURIComponent(u.pathname));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, "index.html");
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(port, "127.0.0.1");
