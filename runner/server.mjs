// Runner entry point + local API. Loopback HTTP/JSON: any VS process (or curl) can talk to it,
// it survives VS restarts, and needs no framing code.
//   node runner/server.mjs [--port 0] [--dir <agent log dir>] [--home <runner home>]
// Every request needs `Authorization: Bearer <token>`; the token lives in <home>/token (mode 0600).
// Discovery for VS: <home>/runner.json = { port, pid, startedAt }.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner } from './runner.mjs';

export const MAX_BODY_BYTES = 1024 * 1024;

export function tokenMatches(header, token) {
  const m = /^Bearer (.+)$/.exec(String(header ?? ''));
  if (!m || !token) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createServer(runner, { token, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let s = '';
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > maxBodyBytes) {
        dead = true;
        const err = new Error('request body too large');
        err.status = 413;
        reject(err);
        return;
      }
      s += c;
    });
    req.on('end', () => { if (!dead) { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } } });
    req.on('error', reject);
  });

  return http.createServer(async (req, res) => {
    try {
      if (token && !tokenMatches(req.headers.authorization, token)) return json(res, 401, { error: 'unauthorized' });
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > maxBodyBytes) { res.setHeader('connection', 'close'); return json(res, 413, { error: 'request body too large' }); }
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean); // agents, :id, action
      if (req.method === 'GET' && parts[0] === 'health') return json(res, 200, { ok: true, live: runner.live.size, pid: process.pid });
      if (parts[0] !== 'agents') return json(res, 404, { error: 'not found' });
      if (parts.length === 1) {
        if (req.method === 'POST') return json(res, 201, { id: runner.create(await readBody(req)) });
        if (req.method === 'GET') return json(res, 200, { ids: runner.list() });
      }
      const id = parts[1];
      if (parts.length === 2 && req.method === 'GET') {
        const s = runner.status(id);
        return s ? json(res, 200, s) : json(res, 404, { error: 'no such agent' });
      }
      if (parts[2] === 'timeline' && req.method === 'GET') {
        if (!runner.store.exists(id)) return json(res, 404, { error: 'no such agent' });
        const after = Number(url.searchParams.get('after') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? Infinity);
        const events = runner.timeline(id, after, limit);
        return json(res, 200, { events, next: events.length ? events[events.length - 1].seq + 1 : after });
      }
      if (parts[2] === 'input' && req.method === 'POST') {
        runner.send(id, (await readBody(req)).text);
        return json(res, 202, { ok: true });
      }
      if (parts[2] === 'cancel' && req.method === 'POST') {
        runner.cancel(id);
        return json(res, 202, { ok: true });
      }
      if (parts[2] === 'meta' && req.method === 'POST') {
        runner.updateMeta(id, await readBody(req));
        return json(res, 202, { ok: true });
      }
      if (parts[2] === 'archive' && req.method === 'POST') {
        runner.archive(id);
        return json(res, 202, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.message });
    }
  });
}

export function writeDiscovery(home, { port, token }) {
  mkdirSync(home, { recursive: true });
  const tokenFile = path.join(home, 'token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch { /* win32: ACL inherited from the user profile dir */ }
  writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const home = arg('home', path.join(os.homedir(), '.vibesquad', 'runner'));
  const dir = arg('dir', path.join(home, 'agents'));
  const token = randomBytes(32).toString('hex');
  const runner = new Runner({ dir });
  const server = createServer(runner, { token });
  server.listen(Number(arg('port', 0)), '127.0.0.1', () => {
    const port = server.address().port;
    writeDiscovery(home, { port, token });
    console.log(JSON.stringify({ listening: port, dir, home }));
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    runner.shutdown();
    try { rmSync(path.join(home, 'runner.json'), { force: true }); } catch { /* ignore */ }
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
