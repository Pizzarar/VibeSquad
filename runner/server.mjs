// Runner entry point + local API. Loopback HTTP/JSON: any VS process (or curl) can talk to it,
// it survives VS restarts, and needs no framing code.
//   node runner/server.mjs [--port 0] [--dir <agent log dir>] [--home <runner home>]
// Every request needs `Authorization: Bearer <token>`; the token lives in <home>/token (mode 0600).
// Discovery for VS: <home>/runner.json = { port, pid, startedAt }.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner } from './runner.mjs';
import { acquireRunnerLock, releaseLock } from './lock.mjs';

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_INPUT_BYTES = 24 * 1024 * 1024; // /input carries base64 image attachments
const SSE_SKIP = new Set(['stderr', 'raw']); // noisy, never rendered
const SSE_HEARTBEAT_MS = 15000;

export function tokenMatches(header, token) {
  const m = /^Bearer (.+)$/.exec(String(header ?? ''));
  if (!m || !token) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createServer(runner, { token, maxBodyBytes = MAX_BODY_BYTES, maxInputBytes = MAX_INPUT_BYTES, heartbeatMs = SSE_HEARTBEAT_MS } = {}) {
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req, limit = maxBodyBytes) => new Promise((resolve, reject) => {
    let s = '';
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > limit) {
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
      const isInput = req.method === 'POST' && /^\/agents\/[^/]+\/input$/.test(req.url.split('?')[0]);
      if (declared > (isInput ? maxInputBytes : maxBodyBytes)) { res.setHeader('connection', 'close'); return json(res, 413, { error: 'request body too large' }); }
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean); // agents, :id, action
      if (req.method === 'GET' && parts[0] === 'health') return json(res, 200, { ok: true, live: runner.live.size, pid: process.pid });
      if (req.method === 'GET' && parts[0] === 'events' && parts.length === 1) {
        // SSE tail of every log append. Cleaned up on client disconnect; nothing buffers per client.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': ok\n\n');
        const off = runner.subscribe((id, ev) => {
          if (!SSE_SKIP.has(ev.type)) res.write(`data: ${JSON.stringify({ id, event: ev })}\n\n`);
        });
        const beat = setInterval(() => res.write(': hb\n\n'), heartbeatMs);
        beat.unref?.();
        const done = () => { off(); clearInterval(beat); };
        req.on('close', done);
        res.on('close', done);
        return;
      }
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
        const b = await readBody(req, maxInputBytes);
        runner.send(id, b.text, { images: b.images, activeTurnBehavior: b.activeTurnBehavior });
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

async function holderHealthy(home) {
  try {
    const { port } = JSON.parse(readFileSync(path.join(home, 'runner.json'), 'utf8'));
    const token = readFileSync(path.join(home, 'token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
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
  mkdirSync(home, { recursive: true });
  const lockFile = path.join(home, 'runner.lock');
  // One runner per home: if a live runner already owns the lock, leave its discovery files alone and exit 0.
  const lock = await acquireRunnerLock(home, { isHealthy: () => holderHealthy(home) });
  if (!lock.owned) {
    console.log(JSON.stringify({ alreadyRunning: lock.holder, home }));
    process.exit(0);
  }
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
    try { releaseLock(lockFile); } catch { /* ignore */ }
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  // Every way out kills the agents' process trees (claude.exe + its MCP sidecars). 'exit' covers process.exit and
  // a crash; shutdown() is idempotent. A hard kill (taskkill /F, power loss) cannot run any of this.
  process.on('exit', () => {
    try { runner.shutdown(); } catch { /* ignore */ }
    try { releaseLock(lockFile); } catch { /* ignore */ }
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGBREAK', stop);
  process.on('SIGHUP', stop);
  process.on('uncaughtException', (err) => { console.error(err); process.exitCode = 1; stop(); });
}
