// PERFECTION_AUDIT A4: clicking an audit:perfection triage card opens the hidden Perfection lane's Buddy chat.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { AUDIT_SOURCE, auditCardPin } from "../src/pins.ts";

const lane = (id, extra = {}) => ({ id, name: id, ...extra });
const view = (lanes) => ({
  team: { id: "vs", name: "VS", lanes: lanes.map((l) => l.lane) },
  lanes,
  members: [],
});
const entry = (l) => ({ lane: l, members: [], brainstorm: null, lead: null, topicBrainstorms: [] });
const v = view([entry(lane("bug-chaser", { kind: "bug", hidden: true })), entry(lane("perfection", { kind: "audit", hidden: true })), entry(lane("ui"))]);

describe("auditCardPin", () => {
  test("audit:perfection card resolves to the hidden audit lane", () => {
    assert.equal(auditCardPin(v, { source: AUDIT_SOURCE })?.lane.id, "perfection");
  });
  test("other cards keep their behaviour (null)", () => {
    assert.equal(auditCardPin(v, { source: "ui" }), null);
    assert.equal(auditCardPin(v, {}), null);
  });
  test("no audit lane -> null", () => {
    assert.equal(auditCardPin(view([entry(lane("ui"))]), { source: AUDIT_SOURCE }), null);
  });
});

describe("IdeaInbox wiring", () => {
  const src = readFileSync(new URL("../src/IdeaInbox.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  test("card click routes audit cards to onOpenLane, skipping inner controls", () => {
    assert.match(src, /auditCardPin\(view, card\)/);
    assert.match(src, /if \(!isInboxControlClick\(e\.target\)\) openAuditChat\(auditPin\)/);
    assert.match(src, /closest\("button, select, input, label, a, textarea"\)/);
  });
  test("App passes the quick-start handler to both inbox mounts", () => {
    assert.equal(app.split("onOpenLane={props.onQuickStart}").length - 1, 2);
  });
});
