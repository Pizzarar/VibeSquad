// Done-check 2 measurement, through the runner's own HTTP API with real CLIs.
//   node runner/measure.mjs [--n 3] [--providers claude,opencode] [--claude-model claude-haiku-5-5]
// Times are ms from the client's create/send call (wall clock) to the matching log event ts.
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { Runner } from './runner.mjs';
import { createServer } from './server.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('n', 3));
const providers = arg('providers', 'claude,opencode').split(',');
const models = { claude: arg('claude-model', 'claude-haiku-5-5'), opencode: undefined };

const runner = new Runner({ dir: mkdtempSync(path.join(os.tmpdir(), 'vs-measure-')) });
const server = createServer(runner);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(id, pred, timeoutMs = 120000) {
  const t0 = Date.now();
  let after = 0;
  while (Date.now() - t0 < timeoutMs) {
    const { events, next } = await api('GET', `/agents/${id}/timeline?after=${after}`);
    for (const e of events) if (pred(e)) return e;
    after = next;
    const st = await api('GET', `/agents/${id}`);
    if (st.status === 'exited') throw new Error(`agent exited: ${JSON.stringify(st.exit)}`);
    await sleep(5);
  }
  throw new Error('timeout');
}

const rows = [];
for (const provider of providers) {
  for (let run = 1; run <= N; run++) {
    const row = { provider, run };
    try {
      const t0 = Date.now();
      const { id } = await api('POST', '/agents', { provider, model: models[provider], cwd: os.tmpdir(), prompt: 'reply ok', meta: { lane: 'own', role: 'worker' } });
      if (!id) throw new Error('create failed');
      row.createCall = Date.now() - t0;
      const first = await waitFor(id, (e) => e.type === 'output');
      row.firstOutput = first.ts - t0;
      const done = await waitFor(id, (e) => e.type === 'turn_done');
      row.done = done.ts - t0;
      const doneSeq = done.seq;

      const t1 = Date.now();
      await api('POST', `/agents/${id}/input`, { text: 'reply ok again' });
      const second = await waitFor(id, (e) => e.type === 'output' && e.seq > doneSeq);
      row.sendToFirstOutput = second.ts - t1;
      await waitFor(id, (e) => e.type === 'turn_done' && e.seq > second.seq);

      const t2 = performance.now();
      const tl = await api('GET', `/agents/${id}/timeline`);
      row.timelineFetch = +(performance.now() - t2).toFixed(1);
      row.events = tl.events.length;
      const out = tl.events.filter((e) => e.type === 'output').map((e) => e.text).join('');
      row.reply = out.slice(0, 40);
      row.model = tl.events.find((e) => e.type === 'session')?.model ?? models[provider] ?? '(opencode default)';
      runner.kill(id);
    } catch (err) {
      row.error = err.message;
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
console.log('\n| provider | run | create call | create→first output | create→done | send→first output (turn 2) | timeline fetch | events |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(r.error
    ? `| ${r.provider} | ${r.run} | ERROR: ${r.error} |||||| `
    : `| ${r.provider} | ${r.run} | ${r.createCall} ms | ${r.firstOutput} ms | ${r.done} ms | ${r.sendToFirstOutput} ms | ${r.timelineFetch} ms | ${r.events} |`);
}
runner.shutdown();
server.close();
setTimeout(() => process.exit(0), 300);
