// Runner entry point + local API. Loopback HTTP/JSON: any VS process (or curl) can talk to it,
// it survives VS restarts, and needs no framing code. Spike: no auth, 127.0.0.1 only.
//   node runner/server.mjs [--port 0] [--dir <log dir>]
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner } from './runner.mjs';

export function createServer(runner) {
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean); // agents, :id, action
      if (req.method === 'GET' && parts[0] === 'health') return json(res, 200, { ok: true, live: runner.live.size });
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
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const dir = arg('dir', path.join(os.homedir(), '.vibesquad', 'runner', 'agents'));
  const runner = new Runner({ dir });
  const server = createServer(runner);
  server.listen(Number(arg('port', 0)), '127.0.0.1', () => {
    console.log(JSON.stringify({ listening: server.address().port, dir }));
  });
  process.on('SIGINT', () => { runner.shutdown(); process.exit(0); });
}
