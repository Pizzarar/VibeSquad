// Standalone timing: N synthetic agents in a temp dir (never ~/.vibesquad). Usage: node scripts/bench-runner-roster.mjs [N] [eventsPerAgent]
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';

const N = Number(process.argv[2] ?? 2000);
const EV = Number(process.argv[3] ?? 200);
const home = mkdtempSync(path.join(os.tmpdir(), 'vs-bench-'));
const dir = path.join(home, 'agents');
const fake = { start: () => ({ send() {}, cancel() {}, kill() {}, interrupt() {} }) };
const r = new Runner({ dir, adapters: { claude: fake }, maxLive: 5 });
for (let i = 0; i < N; i++) {
  const lines = [{ seq: 0, ts: 1, type: 'created', provider: 'claude', model: 'm', cwd: os.tmpdir(), meta: { role: 'worker' } }];
  for (let s = 1; s < EV; s++) lines.push({ seq: s, ts: 1 + s, type: s % 2 ? 'status' : 'text', status: 'idle', text: 'x'.repeat(300) });
  writeFileSync(path.join(dir, `rn-${String(i).padStart(12, '0')}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const ms = (t) => Math.round(Number(process.hrtime.bigint() - t) / 1e6);
let maxStall = 0; let last = Date.now();
const tick = setInterval(() => { const n = Date.now(); maxStall = Math.max(maxStall, n - last - 5); last = n; }, 5);
await new Promise((r2) => setTimeout(r2, 20)); maxStall = 0;
for (const pass of ['cold', 'warm']) {
  maxStall = 0; last = Date.now();
  const t = process.hrtime.bigint();
  const out = await ((r.statusAllAsync && !process.env.BENCH_SYNC) ? r.statusAllAsync() : r.statusAll());
  await new Promise((r2) => setTimeout(r2, 20));
  console.log(`${pass} statusAll: total ${ms(t)}ms, agents ${out.length}, max loop stall ${maxStall}ms`);
}
clearInterval(tick);
r.shutdown();
