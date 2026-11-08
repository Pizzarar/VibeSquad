import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("Q1: queued indicator renders at the tail (after the transcript) and queuedAhead re-pins scroll", () => {
  const timeline = read("src/Timeline.tsx");
  // The queued spinner must come AFTER the transcript (shown.map) so stickToBottom keeps it on-screen.
  // On master it rendered ABOVE the transcript and scrolled out of view under a long handoff brief.
  const queuedIdx = timeline.indexOf('data-testid="tl-queued"');
  const mapIdx = timeline.indexOf("{shown.map((e, i) => (");
  assert.ok(queuedIdx !== -1, "tl-queued spinner exists");
  assert.ok(mapIdx !== -1, "transcript shown.map exists");
  assert.ok(queuedIdx > mapIdx, "the queued spinner renders after the transcript (tail), not above it");
  // queuedAhead participates in tailSig, so a queue change re-runs the stick-to-bottom effect.
  const tailSig = timeline.slice(timeline.indexOf("const tailSig = ["), timeline.indexOf('].join("|")'));
  assert.match(tailSig, /queuedAhead/);
  assert.match(timeline, /Queued, \$\{queuedAhead\} ahead — starts when a slot frees/);
});

test("Q2: PinGrid team/pin rows label a queued agent 'queued · N ahead'", () => {
  const pin = read("src/PinGrid.tsx");
  assert.match(pin, /const memberStatusLabel = \(agent: \{ status: string; queued\?: \{ ahead: number \} \}\)/);
  assert.match(pin, /agent\.queued \? `queued · \$\{agent\.queued\.ahead\} ahead`/);
  assert.match(pin, /<span className="muted small">\{memberStatusLabel\(m\.agent\)\}<\/span>/);
  // PinRow and PinTile also surface the queue position.
  assert.match(pin, /pin\.brainstorm\?\.agent\.queued/);
  assert.match(pin, /bs\.agent\.queued \? `queued · \$\{bs\.agent\.queued\.ahead\} ahead`/);
});

test("Q2: PinRail rail tile, StatusDot tooltip and sameMember surface the queue position", () => {
  const rail = read("src/PinRail.tsx");
  assert.match(rail, /bs\?\.agent\.queued \? `queued · \$\{bs\.agent\.queued\.ahead\} ahead` : line/);

  const ui = read("src/ui.tsx");
  assert.match(ui, /agent\.queued \? `queued · \$\{agent\.queued\.ahead\} ahead` : agent\.status/);
  assert.match(ui, /x\.queued\?\.ahead === y\.queued\?\.ahead/);

  const types = read("src/agentTypes.ts");
  assert.match(types, /queued\?: \{ ahead: number \}/);
});

test("Q2: vs who line shows queued(N) when the agent is queued", () => {
  const cli = read("cli/vs.mjs");
  assert.match(cli, /const status = entry\.queued \? `queued\(\$\{entry\.queued\.ahead\}\)` : entry\.status;/);
  assert.match(cli, /queued: a\.queued \?\? null/);
});
