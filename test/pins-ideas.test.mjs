import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allLaneIds, bestOverlap, nameFromIdea, newPinBrief, parseSendTo, slugLaneId, uniqueLaneId } from "../src/pins.ts";

const lanes = [
  { id: "scav-ui", name: "Scavenging UI" },
  { id: "audio", name: "Audio", aliases: ["sound"] },
  { id: "fishing", name: "Fishing", state: "done" },
  { id: "_other", name: "Other" },
];

test("slug and dedupe", () => {
  assert.equal(slugLaneId("Scavenging UI!"), "scavenging-ui");
  assert.equal(slugLaneId("  Café  menus  "), "cafe-menus");
  assert.equal(slugLaneId("!!!"), "team");
  assert.ok(slugLaneId("a".repeat(80)).length <= 32);
  assert.equal(uniqueLaneId("audio", ["Audio", "audio-2"]), "audio-3");
  assert.equal(uniqueLaneId("fresh", ["audio"]), "fresh");
  assert.deepEqual(allLaneIds([{ lanes: [{ id: "a" }] }, { lanes: [{ id: "b" }, { id: "c" }] }]), ["a", "b", "c"]);
  const taken = allLaneIds([{ lanes: [{ id: "audio", aliases: ["Sound"] }] }]);
  assert.equal(uniqueLaneId(slugLaneId("Sound"), taken), "sound-2");
});

test("overlap offers the existing pinned team, weighted by the distinctive word", () => {
  assert.equal(bestOverlap("a loot screen for scavenging", lanes)?.lane.id, "scav-ui");
  assert.equal(bestOverlap("scavenge results page", lanes)?.lane.id, "scav-ui"); // shared 5-letter stem
  assert.equal(bestOverlap("sound effects for doors", lanes)?.lane.id, "audio"); // alias
  assert.equal(bestOverlap("UI polish for settings", lanes), null); // "ui" alone is too weak
  assert.equal(bestOverlap("crafting tree", lanes), null); // done teams are not offered
  assert.equal(bestOverlap("other", lanes), null);
  assert.equal(nameFromIdea("I just thought of a crafting tree.\nwith tiers"), "a crafting tree");
});

test("new brief puts the idea under Open with all sections", () => {
  const b = newPinBrief("crafting-tree", "Crafting tree", "tiers\nand unlocks");
  for (const h of ["## Who's here", "## Done when", "## Decided", "## Open", "## In flight"]) assert.ok(b.includes(h), h);
  assert.match(b, /## Open\n- tiers\n  and unlocks\n/);
  assert.ok(b.startsWith("# Brainstorm Summary · CRAFTING TREE (`crafting-tree`)"));
});

test("send-to marker parser", () => {
  const msg = "That sounds like Scavenging UI. Send it there?\n\n```\nvs:send-to scav-ui\nShow loot rarity colors\non the results page\n```\nAnything else?";
  assert.deepEqual(parseSendTo(msg), { laneId: "scav-ui", text: "Show loot rarity colors\non the results page" });
  assert.deepEqual(parseSendTo("`vs:send-to audio`\r\nlouder doors"), { laneId: "audio", text: "louder doors" });
  assert.equal(parseSendTo("I could post vs:send-to audio later."), null);
  assert.equal(parseSendTo("no marker"), null);
});

test("vs pin new writes the lane and brief, refuses overlaps", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-pin-new-"));
  try {
    const home = join(dir, "home");
    const root = join(dir, "root");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(root, "docs", "brainstorm"), { recursive: true });
    writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [{ id: "efi", name: "EFI", paths: [], lanes: lanes.slice(0, 2) }] }));
    const env = { ...process.env, VIBESQUAD_HOME: home, VIBESQUAD_ROOT: root, PASEO_AGENT_ID: "" };
    const vs = (...args) => spawnSync(process.execPath, ["cli/vs.mjs", "pin", "new", ...args], { env, encoding: "utf8" });

    const refused = vs("Scavenging loot", "--brief", "x", "--team", "efi");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Sounds like Scavenging UI \(scav-ui\)/);

    const ok = vs("Crafting tree", "--brief", "tiers", "--team", "efi");
    assert.equal(ok.status, 0, ok.stderr);
    const teams = JSON.parse(readFileSync(join(home, "teams.json"), "utf8"));
    assert.deepEqual(teams.teams[0].lanes.at(-1), { id: "crafting-tree", name: "Crafting tree", code: "Cra", state: "pinned" });
    assert.match(readFileSync(join(root, "docs", "brainstorm", "crafting-tree.md"), "utf8"), /## Open\n- tiers/);

    assert.equal(vs("Crafting tree", "--team", "efi").status, 1); // duplicate

    // the brief text drives the overlap match
    const byBrief = vs("Rarity colors", "--brief", "Show loot rarity colors on the scavenging results page", "--team", "efi");
    assert.equal(byBrief.status, 1);
    assert.match(byBrief.stderr, /Sounds like Scavenging UI/);

    // --force skips the refusal; alias "sound" blocks the slug, so the id gets -2
    const forced = vs("Sound", "--brief", "x", "--team", "efi", "--force");
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(JSON.parse(readFileSync(join(home, "teams.json"), "utf8")).teams[0].lanes.at(-1).id, "sound-2");

    // done teams never match, even on an exact name, with or without --force
    const cur = JSON.parse(readFileSync(join(home, "teams.json"), "utf8"));
    cur.teams[0].lanes.push({ id: "fishing", name: "Fishing", state: "done" });
    writeFileSync(join(home, "teams.json"), JSON.stringify(cur));
    const reborn = vs("Fishing", "--brief", "again", "--team", "efi");
    assert.equal(reborn.status, 0, reborn.stderr);
    assert.equal(JSON.parse(readFileSync(join(home, "teams.json"), "utf8")).teams[0].lanes.at(-1).id, "fishing-2");

    // vs pin merge folds source lane's Decided + Open into target lane, marks source done, and logs decision
    const vsMerge = (...args) => spawnSync(process.execPath, ["cli/vs.mjs", "pin", "merge", ...args], { env, encoding: "utf8" });
    const merged = vsMerge("sound-2", "crafting-tree", "--note", "unify crafting SFX with tier unlocks", "--team", "efi");
    assert.equal(merged.status, 0, merged.stderr);
    const mergedBrief = readFileSync(join(root, "docs", "brainstorm", "crafting-tree.md"), "utf8");
    assert.match(mergedBrief, /\[Merged Sound -> Crafting tree\] unify crafting SFX with tier unlocks/);
    assert.match(mergedBrief, /\[from Sound\] x/);
    const afterMergeTeams = JSON.parse(readFileSync(join(home, "teams.json"), "utf8"));
    assert.equal(afterMergeTeams.teams[0].lanes.find((l) => l.id === "sound-2").state, "done");
    const logLines = readFileSync(join(home, "teams", "efi", "log.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(logLines.some((e) => e.type === "decision" && e.text.includes("Merged Sound (sound-2) -> Crafting tree (crafting-tree)")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
