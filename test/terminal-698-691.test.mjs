import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TerminalManager, loadNodePty } from "../server/terminals.mjs";
import { chunkInput, exitNotice, isCopyKey, isPasteKey, LOST_NOTICE, makeInputSender } from "../src/terminalIo.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait for done(): fails (false) after stallMs without progress() changing, after maxMs overall (checked every tick, so steady output can't dodge it), or once exited(). */
async function waitProgress(done, { progress, exited, stallMs, maxMs, startedAt = Date.now() }) {
  let last = progress(), progressAt = Date.now();
  while (!done()) {
    const now = Date.now(), p = progress();
    if (p !== last) { last = p; progressAt = now; }
    if (now - startedAt > maxMs || now - progressAt > stallMs) return false;
    if (exited()) return done();
    await sleep(50);
  }
  return true;
}
const hasPty = Boolean(await loadNodePty());

test("idea-698: a 30 MB flood through the pty neither kills it nor stalls a subscriber (backpressure ruled out)", { skip: !hasPty }, async () => {
  const m = new TerminalManager({ shell: { file: "/bin/bash", args: [] } });
  try {
    const t = await m.create({ cwd: "/tmp" });
    let got = 0;
    m.subscribe(t.id, { onData: (d) => { got += d.length; }, onExit: () => {} });
    m.input(t.id, "yes 'long apt-like output line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | head -c 30000000; echo FLOOD_$((40+2))\r");
    // idea-993: no fixed wall-clock budget. Under full-suite CPU load the 30 MB drain legitimately takes longer than any
    // fixed number we pick (and one deadline shared by both waits starved the second). Wait for the pty to finish
    // (marker, then the full count) and give up only when it makes no progress for STALL_MS.
    const STALL_MS = 20000;
    const MAX_WAIT_MS = 120000; // hard ceiling: a slow trickle that keeps resetting the stall timer still fails loudly
    const startedAt = Date.now();
    const waitDrained = (done) => waitProgress(done, { progress: () => got, exited: () => Boolean(m.get(t.id).exited), stallMs: STALL_MS, maxMs: MAX_WAIT_MS, startedAt });
    // idea-927: the pty echoes the typed command line, so a literal marker matches the echo at once, long before the
    // flood ends. FLOOD_42 only exists once the shell has expanded it, i.e. after head finished.
    await waitDrained(() => m.output(t.id).includes("FLOOD_42"));
    assert.ok(m.output(t.id).includes("FLOOD_42"), `flood marker never arrived (got ${got} chars, stalled ${STALL_MS} ms)`);
    // The marker can reach the ring before the last flood chunks reach this subscriber's onData: wait for the count.
    await waitDrained(() => got >= 30_000_000);
    assert.ok(got >= 30_000_000, `got ${got} of 30000000 chars`);
    assert.equal(m.get(t.id).exited, null);
    assert.ok(m.output(t.id).length <= 200_000);
  } finally { m.killAll({ sync: true }); }
});

test("idea-993: waitProgress hits the hard ceiling even while output keeps arriving", async () => {
  let n = 0;
  const t0 = Date.now();
  const ok = await waitProgress(() => false, { progress: () => ++n, exited: () => false, stallMs: 10_000, maxMs: 300 });
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(await waitProgress(() => false, { progress: () => 0, exited: () => false, stallMs: 150, maxMs: 10_000 }), false);
  assert.equal(await waitProgress(() => true, { progress: () => 0, exited: () => false, stallMs: 1, maxMs: 1 }), true);
});

test("idea-698: server shutdown tells subscribers it was a server restart, before the kill", async () => {
  const m = new TerminalManager({ pty: null, shell: { file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } });
  const t = await m.create({ cwd: "/tmp" });
  const exits = [];
  m.subscribe(t.id, { onData: () => {}, onExit: (e) => exits.push(e) });
  m.killAll({ sync: true });
  await sleep(300);
  assert.deepEqual(exits, [{ code: null, reason: "server-restart" }]);
});

test("idea-698: notices say restart / lost / plain exit", () => {
  assert.match(exitNotice(null, "server-restart"), /server restarted/);
  assert.match(exitNotice(0), /exited with code 0/);
  assert.match(exitNotice(null), /\[process exited\]/);
  assert.match(LOST_NOTICE, /connection to the terminal was lost/);
  const shells = src("vsShells.ts");
  assert.match(shells, /onLost\?\.\(\)/);
  assert.match(shells, /!sawExit && !ctl\.signal\.aborted/);
  const panel = src("TerminalPanel.tsx");
  assert.equal((panel.match(/LOST_NOTICE/g) ?? []).length, 3); // import + both streams
});

const key = (key, o = {}) => ({ key, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...o });

test("idea-691: paste keys are left to the browser's native paste event", () => {
  assert.ok(isPasteKey(key("v", { ctrlKey: true })));
  assert.ok(isPasteKey(key("V", { ctrlKey: true, shiftKey: true })));
  assert.ok(isPasteKey(key("v", { metaKey: true })));
  assert.ok(isPasteKey(key("Insert", { shiftKey: true })));
  assert.ok(!isPasteKey(key("v")));
  assert.ok(!isPasteKey(key("v", { ctrlKey: true, altKey: true })));
  assert.ok(!isPasteKey(key("Insert")));
});

test("idea-691: Ctrl+C copies only with a selection (else it stays SIGINT)", () => {
  assert.ok(!isCopyKey(key("c", { ctrlKey: true }), false));
  assert.ok(isCopyKey(key("c", { ctrlKey: true }), true));
  assert.ok(isCopyKey(key("C", { ctrlKey: true, shiftKey: true }), true));
  assert.ok(!isCopyKey(key("x", { ctrlKey: true }), true));
});

test("idea-691: panel wires key handler, right-click fallback and ordered input", () => {
  const p = src("TerminalPanel.tsx");
  assert.match(p, /attachCustomKeyEventHandler/);
  assert.match(p, /addEventListener\("contextmenu"/);
  assert.match(p, /window\.isSecureContext/); // http LAN: fall through to the native menu, no clipboard API
  assert.match(p, /term\.paste\(/);
  assert.match(p, /sendInput\(terminalId, data\)/);
});

test("idea-691: big paste is chunked under the server's 64 KiB cap and POSTed in order", async () => {
  assert.equal(chunkInput("a".repeat(40_000)).length, 3);
  const seen = [];
  const send = makeInputSender(async (id, d) => { await sleep(d.length > 100 ? 20 : 0); seen.push([id, d.length]); });
  const big = "x".repeat(40_000);
  send("t1", "a"); send("t1", big); send("t1", "b"); await send("t2", "z");
  await sleep(200);
  assert.deepEqual(seen.filter(([i]) => i === "t1").map(([, n]) => n), [1, 16384, 16384, 7232, 1]);
});
