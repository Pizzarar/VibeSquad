// idea-105: benchmark the lead-handoff "repoint" step for N workers under the two label-payload shapes the code has
// used. Faithful mirror of the request fan-out in RunnerBackend.updateAgent (server/backend/runner-backend.mjs:1111-1135):
//   - old: the repoint loop re-sent each worker's FULL label set (role/lane/team/ord/...), so `mayMove` was true and every
//     worker paid two extra fetchAgent round-trips on top of the meta write (3 round-trips, serial per worker).
//   - new: only `vs.parent` is sent, so `mayMove` is false (one meta round-trip) and the workers run concurrently.
// Run: node scripts/bench-lead-handoff-repoint.mjs
const FIRST_CLASS = ["squad", "team", "lane", "role", "ord", "profile"];
const N = 30;
// Simulated per-round-trip latency. The live 11-10 observation was ~90 round-trips ≈ 4.8s, i.e. ~50ms each; pick a
// conservative in-process figure so the run is fast while still showing the serial-vs-concurrent gap.
const RTT_MS = 10;

const fullLabels = { team: "site", lane: "site-polish", role: "worker", ord: "3", job: "audit", "vs.parent": "succ" };

function roundTripsFor(labels) {
  const patch = { labels: {} };
  for (const [k, v] of Object.entries(labels)) {
    if (FIRST_CLASS.includes(k)) patch[k] = v;
    else patch.labels[k] = String(v);
  }
  const mayMove = patch.role !== undefined || patch.lane !== undefined || patch.labels?.role !== undefined;
  // one meta write, plus a fetchAgent before/after only when a first-class role/lane field is (re-)sent.
  return mayMove ? ["fetchAgent", "meta", "fetchAgent"] : ["meta"];
}

async function run(labelShape, { concurrent }) {
  const counts = { fetchAgent: 0, meta: 0 };
  const rtt = (kind) => new Promise((r) => setTimeout(() => { counts[kind]++; r(); }, RTT_MS));
  const one = async (i) => {
    for (const kind of roundTripsFor(labelShape(i))) await rtt(kind);
  };
  const t0 = Date.now();
  if (concurrent) await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
  else for (let i = 0; i < N; i++) await one(i);
  return { wallMs: Date.now() - t0, ...counts, roundTrips: counts.fetchAgent + counts.meta };
}

const before = await run((i) => ({ ...fullLabels, "vs.parent": "succ" }), { concurrent: false });
const after = await run(() => ({ "vs.parent": "succ" }), { concurrent: true });

console.log(`N=${N} workers`);
console.log(`before (full labels, serial):  fetchAgent=${before.fetchAgent} meta=${before.meta} roundTrips=${before.roundTrips} wall=${before.wallMs}ms`);
console.log(`after  (vs.parent, parallel): fetchAgent=${after.fetchAgent} meta=${after.meta} roundTrips=${after.roundTrips} wall=${after.wallMs}ms`);
console.log(`round-trip reduction: ${before.roundTrips} -> ${after.roundTrips} (${Math.round((1 - after.roundTrips / before.roundTrips) * 100)}% fewer)`);
