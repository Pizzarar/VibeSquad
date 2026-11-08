import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("Q1: Timeline renders the queued spinner and AgentDrawer feeds it queued.ahead", () => {
  const timeline = read("src/Timeline.tsx");
  // The queued spinner is gated only on queuedAhead (not on an empty transcript), so a queued
  // agent shows "Queued, N ahead" even when the brief is already the first message.
  assert.match(timeline, /queuedAhead !== undefined/);
  assert.match(timeline, /data-testid="tl-queued"/);
  assert.match(timeline, /Queued, \$\{queuedAhead\} ahead — starts when a slot frees/);

  const drawer = read("src/AgentDrawer.tsx");
  const tlBlock = drawer.slice(drawer.indexOf("<Timeline"), drawer.indexOf("/>", drawer.indexOf("<Timeline")) + 2);
  assert.match(tlBlock, /queuedAhead=\{\(agent as \{ queued\?: \{ ahead: number \} \}\)\.queued\?\.ahead\}/);
});

test("Q2: PinGrid team/pin rows label a queued agent 'queued · N ahead'", () => {
  const pin = read("src/PinGrid.tsx");
  assert.match(pin, /const memberStatusLabel = \(agent: \{ status: string; queued\?: \{ ahead: number \} \}\)/);
  assert.match(pin, /agent\.queued \? `queued · \$\{agent\.queued\.ahead\} ahead`/);
  assert.match(pin, /<span className="muted small">\{memberStatusLabel\(m\.agent\)\}<\/span>/);
});

test("Q2: vs who line shows queued(N) when the agent is queued", () => {
  const cli = read("cli/vs.mjs");
  assert.match(cli, /const status = entry\.queued \? `queued\(\$\{entry\.queued\.ahead\}\)` : entry\.status;/);
  assert.match(cli, /queued: a\.queued \?\? null/);
});
