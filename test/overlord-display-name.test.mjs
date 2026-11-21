// idea-71: the hub-lane lead must read as one stable "Overlord" (its predecessor "(old) Overlord")
// across lead handoffs — never "★ Hub14" — and its face must not change per handoff.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentDisplayName, agentFaceSeed } from "../src/identity.ts";

const isHubLaneId = (laneKey) => laneKey === "vibesquad";
const ctx = { isHubLaneId };

const hubLead = { id: "hub-lead-aaaa", title: "★ Hub14", labels: { role: "lead", lane: "vibesquad", ord: "14" } };
const hubLeadJob = { id: "hub-lead-bbbb", title: "★ Hub14 · Keep the peace", labels: { role: "lead", lane: "vibesquad", ord: "14", job: "Keep the peace" } };
const formerHubLead = { id: "hub-lead-cccc", title: "(old) Hub13", labels: { role: "old-lead", lane: "vibesquad", ord: "13" } };
const nonHubLead = { id: "ade-1", title: "★ Ade1", labels: { role: "lead", lane: "ade", ord: "1" } };
const worker = { id: "w1", title: "Worker · fix (talk here: #2)", labels: { role: "worker", lane: "ade" } };
const buddy = { id: "b1", title: "Ade", labels: { role: "brainstorm", lane: "ade" } };

test("agentDisplayName: a hub lead reads Overlord (never Hub<ord>)", () => {
  assert.equal(agentDisplayName(hubLead, ctx), "Overlord");
  assert.equal(agentDisplayName({ ...hubLead, id: "different-id" }, ctx), "Overlord");
});

test("agentDisplayName: a hub lead with a job reads Overlord · job", () => {
  assert.equal(agentDisplayName(hubLeadJob, ctx), "Overlord · Keep the peace");
});

test("agentDisplayName: a former hub lead reads (old) Overlord", () => {
  assert.equal(agentDisplayName(formerHubLead, ctx), "(old) Overlord");
});

test("agentDisplayName: non-hub lead / worker / buddy keep cleanTitle behaviour", () => {
  assert.equal(agentDisplayName(nonHubLead, ctx), "★ Ade1"); // no "★ lead · " prefix to strip
  assert.equal(agentDisplayName(worker, ctx), "Worker · fix"); // "(talk here: …)" stripped
  assert.equal(agentDisplayName(buddy, ctx), "Ade");
});

test("agentDisplayName: no hub predicate means plain cleanTitle (hub lead stays its raw title)", () => {
  // Without isHubLaneId (or hub) the helper cannot know the lane is hub, so it falls back to cleanTitle.
  assert.equal(agentDisplayName(hubLead, {}), "★ Hub14");
});

test("agentDisplayName: positional hub:true names a hub lead resolved by cwd with no lane/lead labels", () => {
  // REVIEW_overlord_name_r1 Low 3: SquadTile knows the lane is the hub lane from lead.laneId, but the agent's own
  // labels can be empty (cwd-autofix). Without the positional hub flag the helper falls back to the raw title.
  const cwdResolvedHubLead = { id: "hub-lead-dddd", title: "★ Hub14", labels: { role: "lead", ord: "14" } };
  assert.equal(agentDisplayName(cwdResolvedHubLead, { hub: true }), "Overlord");
});

test("agentFaceSeed: two hub leads with different ids share the stable 'overlord' seed", () => {
  assert.equal(agentFaceSeed(hubLead, ctx), "overlord");
  assert.equal(agentFaceSeed(hubLeadJob, ctx), "overlord"); // different id, same seed
  assert.equal(agentFaceSeed(formerHubLead, ctx), "overlord");
});

test("agentFaceSeed: non-hub agents keep their id; positional hub:true also seeds overlord", () => {
  assert.equal(agentFaceSeed(worker, ctx), "w1");
  assert.equal(agentFaceSeed(nonHubLead, ctx), "ade-1");
  assert.equal(agentFaceSeed(hubLead, { hub: true }), "overlord");
});

// ── source guard: the touched Psycho files route agent names through the helper, not cleanTitle(.title) ──
const read = (f) => readFileSync(resolve(import.meta.dirname, "..", "src", f), "utf8");

test("source guard: touched Psycho surfaces no longer render a raw/cleaned agent title directly", () => {
  const app = read("App.tsx");
  assert.doesNotMatch(app, /cleanTitle\(a\.title\)/); // tree node + unsorted
  assert.doesNotMatch(app, /cleanTitle\(m\.agent\.title\)/); // tree row + Manage lane + Retire
  assert.doesNotMatch(app, /cleanTitle\(p\.lead\.agent\.title\)/); // handoff current lead
  assert.doesNotMatch(app, /cleanTitle\(p\.oldLead\.agent\.title\)/); // handoff old lead

  assert.doesNotMatch(read("ui.tsx"), /cleanTitle\(a\.title\)/);
  assert.doesNotMatch(read("ui.tsx"), /cleanTitle\(m\.agent\.title\)/);
  assert.doesNotMatch(read("PinGrid.tsx"), /cleanTitle\(m\.agent\.title\)/);
  assert.doesNotMatch(read("FocusRail.tsx"), /cleanTitle\(m\.agent\.title\)/);
  assert.doesNotMatch(read("WorkingBar.tsx"), /cleanTitle\(m\.agent\.title\)/);
  assert.doesNotMatch(read("AgentPanes.tsx"), /cleanTitle\(a\.title\)/);
  assert.doesNotMatch(read("DrawerHeader.tsx"), /agent\.title \?\? agent\.id\.slice/);
});
