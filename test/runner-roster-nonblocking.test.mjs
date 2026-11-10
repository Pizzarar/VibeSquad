// A full-roster status scan (GET /agents?full=1) must not block POST /agents: the scan yields between slices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer } from '../runner/server.mjs';

const N = 1500;
const fake = { start: () => ({ send() {}, cancel() {}, kill() {}, interrupt() {} }) };

function seed(dir) {
  for (let i = 0; i < N; i++) {
    const lines = [{ seq: 0, ts: 1, type: 'created', provider: 'claude', model: 'm', cwd: os.tmpdir(), meta: {} }];
    for (let s = 1; s < 150; s++) lines.push({ seq: s, ts: 1 + s, type: 'text', text: 'x'.repeat(300) });
    writeFileSync(path.join(dir, `rn-${String(i).padStart(12, '0')}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
}

test('statusAllAsync matches statusAll', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vs-nb-'));
  const r = new Runner({ dir: path.join(home, 'agents'), adapters: { claude: fake }, maxLive: 5 });
  seed(path.join(home, 'agents'));
  const a = await r.statusAllAsync(1);
  assert.deepEqual(a, r.statusAll());
  assert.equal(a.length, N);
  r.shutdown();
});

test('POST /agents answers fast while GET /agents?full=1 scans a large cold roster', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vs-nb-'));
  const dir = path.join(home, 'agents');
  const r = new Runner({ dir, adapters: { claude: fake }, maxLive: 5 });
  seed(dir);
  const srv = createServer(r, { token: 't' });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  try {
    const t0 = Date.now();
    const scan = fetch(`${base}/agents?full=1`, { headers }).then((x) => x.json()).then((j) => ({ j, ms: Date.now() - t0 }));
    await new Promise((ok) => setTimeout(ok, 30)); // scan is in flight
    const t1 = Date.now();
    const res = await fetch(`${base}/agents`, { method: 'POST', headers, body: JSON.stringify({ provider: 'claude', cwd: os.tmpdir(), meta: {} }) });
    const postMs = Date.now() - t1;
    assert.equal(res.status, 201);
    const { j, ms: scanMs } = await scan;
    assert.ok(j.agents.length >= N);
    console.log(`# POST /agents ${postMs}ms while full scan took ${scanMs}ms`);
    assert.ok(postMs < scanMs / 2 && postMs < 300, `POST ${postMs}ms vs scan ${scanMs}ms`);
  } finally { srv.close(); r.shutdown(); }
});
