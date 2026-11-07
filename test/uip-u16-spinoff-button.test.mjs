// Unit U16 — Wire Up Inline Chat & Right-Rail Spin-Off (vs:spin-off, vs:send-to, vs:looks-done) Action Buttons.
// Behavioral + source verification against server/pin-ideas.mjs, src/pins.ts, src/PinGrid.tsx, src/PinIdeas.tsx, and src/Timeline.tsx.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { SPIN_OFF_MAX, parseSpinOff as parseSpinOffServer } from "../server/pin-ideas.mjs";
import { parseSpinOff as parseSpinOffClient, spinOffFrom } from "../src/pins.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const pinGridSrc = read("src/PinGrid.tsx");
const pinIdeasSrc = read("src/PinIdeas.tsx");
const timelineSrc = read("src/Timeline.tsx");

describe("U16: parseSpinOff behavioral tests (server/pin-ideas.mjs & src/pins.ts)", () => {
  test("SPIN_OFF_MAX is 10 and EFI RiffBot's 7-team spin-off proposal parses without truncating at 6", () => {
    assert.equal(SPIN_OFF_MAX, 10);
    const efiProposal = [
      "Here is the 7-team breakdown:",
      "```vs:spin-off",
      "Sim Core | deterministic engine & tick loop",
      "Economy & Balance | loot tables, trader pricing, stash progression",
      "UI Raid | HUD, inventory, health & extraction timers",
      "UI Shell & Hideout | main menu, crafting benches, trader screens",
      "UI Screens | post-raid summary, quests, flea market",
      "Art Pipeline | sprites, tilesets, animations, shaders",
      "Platform, QA & Security | save integrity, perf budgets, CI smoke",
      "```",
    ].join("\n");

    const parsedServer = parseSpinOffServer(efiProposal);
    const parsedClient = parseSpinOffClient(efiProposal);
    assert.equal(parsedServer?.length, 7);
    assert.deepEqual(parsedClient, parsedServer);
    assert.deepEqual(
      parsedServer.map((t) => t.name),
      [
        "Sim Core",
        "Economy & Balance",
        "UI Raid",
        "UI Shell & Hideout",
        "UI Screens",
        "Art Pipeline",
        "Platform, QA & Security",
      ],
    );
  });

  test("accepts a bare ``` fence whose first non-empty line is vs:spin-off (case-insensitive)", () => {
    const bareFence = [
      "Click Spin off on the block below:",
      "```",
      "",
      "  vs:Spin-Off  ",
      "Sim Core | deterministic engine",
      "UI Raid | raid HUD and inventory",
      "```",
    ].join("\n");
    const rows = parseSpinOffClient(bareFence);
    assert.deepEqual(rows, [
      { name: "Sim Core", brief: "deterministic engine" },
      { name: "UI Raid", brief: "raid HUD and inventory" },
    ]);
  });

  test("strips surrounding ** and ` from team names", () => {
    const formatted = [
      "```vs:spin-off",
      "- **Sim Core** | deterministic engine",
      "1. `UI Raid` | raid HUD and inventory",
      "* **`Art Pipeline`** | sprites and shaders",
      "```",
    ].join("\n");
    const rows = parseSpinOffClient(formatted);
    assert.deepEqual(rows, [
      { name: "Sim Core", brief: "deterministic engine" },
      { name: "UI Raid", brief: "raid HUD and inventory" },
      { name: "Art Pipeline", brief: "sprites and shaders" },
    ]);

    const offer = spinOffFrom("riffbot-1", [{ item: { type: "assistant_message", text: formatted, id: "msg-7" } }]);
    assert.equal(offer?.id, "riffbot-1:msg-7");
    assert.equal(offer?.teams.length, 3);
  });
});

describe("U16: PinGrid.tsx exports noteTimelineOffers and wires usePreview", () => {
  test("exports noteTimelineOffers(agentId, entries) calling setLooksDoneId and noteSendTo", () => {
    assert.match(
      pinGridSrc,
      /export function noteTimelineOffers\(agentId:\s*string,\s*entries:\s*TimelineEntry\[\]\)\s*\{\s*setLooksDoneId\(agentId,\s*looksDoneIdFrom\(agentId,\s*entries\)\);\s*noteSendTo\(agentId,\s*entries\);\s*\}/,
    );
  });

  test("usePreview calls noteTimelineOffers(agentId, entries) and keeps useLooksDoneId exported", () => {
    assert.match(pinGridSrc, /export function useLooksDoneId\(/);
    const previewIdx = pinGridSrc.indexOf("export function usePreview");
    assert.ok(previewIdx >= 0, "usePreview found");
    const previewSlice = pinGridSrc.slice(previewIdx, previewIdx + 400);
    assert.match(previewSlice, /noteTimelineOffers\(agentId,\s*entries\)/);
  });
});

describe("U16: PinIdeas.tsx exports findPinForAgent and renders LooksDoneCard in SendToBar", () => {
  test("exports findPinForAgent searching hubPinForSquad and pinsForSquad across derived().views", () => {
    assert.match(pinIdeasSrc, /export function findPinForAgent\(agentId\?:\s*string\s*\|\s*null\):\s*Pin\s*\|\s*null/);
    const fnStart = pinIdeasSrc.indexOf("export function findPinForAgent");
    const fnSlice = pinIdeasSrc.slice(fnStart, fnStart + 900);
    assert.match(fnSlice, /derived\(\)\.views/);
    assert.match(fnSlice, /hubPinForSquad\(v\)/);
    assert.match(fnSlice, /pinsForSquad\(v\)/);
    assert.match(fnSlice, /p\.brainstorm\?\.agent\.id === agentId/);
    assert.match(fnSlice, /p\.lead\?\.agent\.id === agentId/);
    assert.match(fnSlice, /p\.workers\.some/);
  });

  test("SendToBar renders LooksDoneCard alongside SendToCard and SpinOffCard", () => {
    const barStart = pinIdeasSrc.indexOf("export function SendToBar");
    assert.ok(barStart >= 0, "SendToBar found");
    const barSlice = pinIdeasSrc.slice(barStart, barStart + 500);
    assert.match(barSlice, /looksDoneFor\(pin,\s*useLooksDoneId\(bsId\)\)/);
    assert.match(barSlice, /\{looksDoneId && <LooksDoneCard pin=\{pin\} messageId=\{looksDoneId\} \/>\}/);
    assert.match(barSlice, /\{offer && <SendToCard pin=\{pin\} offer=\{offer\} variant="bar" \/>\}/);
    assert.match(barSlice, /\{spin && <SpinOffCard pin=\{pin\} offer=\{spin\} variant="bar" \/>\}/);
  });
});

describe("U16: Timeline.tsx feeds noteTimelineOffers in useTimeline and renders inline action cards in MarkdownRenderer", () => {
  // noteAgentSeq joined the same effect in 50f95f9 (B7), so the if-body is a block now.
  test("useTimeline feeds noteTimelineOffers(agentId, entries) in a useEffect", () => {
    assert.match(
      timelineSrc,
      /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(agentId\s*&&\s*entries\.length\)\s*\{\s*noteTimelineOffers\(agentId,\s*entries\);\s*noteAgentSeq\(agentId,\s*maxEntrySeq\(entries\)\);\s*\}\s*\},\s*\[agentId,\s*entries\]\);/,
    );
  });

  test("MarkdownRenderer renders inline SpinOffCard, SendToCard, and LooksDoneCard beneath code blocks", () => {
    assert.match(timelineSrc, /data-testid="tl-spinoff-block"/);
    assert.match(timelineSrc, /<SpinOffCard\s+pin=\{pin\}\s+offer=\{\{\s*id:\s*liveSpinOff\?\.id\s*\?\?\s*`\$\{agentId\s*\?\?\s*"inline"\}:inline:\$\{i\}`,\s*teams\s*\}\}\s+variant="bar"\s*\/>/);
    assert.match(timelineSrc, /data-testid="tl-sendto-block"/);
    assert.match(timelineSrc, /<SendToCard\s+pin=\{pin\}\s+offer=\{\{\s*\.\.\.parsedSendTo,\s*id:\s*liveSendTo\?\.id\s*\?\?\s*`\$\{agentId\s*\?\?\s*"inline"\}:inline:\$\{i\}`\s*\}\}\s+variant="bar"\s*\/>/);
    assert.match(timelineSrc, /data-testid="tl-looksdone-block"/);
    assert.match(timelineSrc, /<LooksDoneCard\s+pin=\{pin\}\s+messageId=\{liveLooksDoneId\s*\?\?\s*`\$\{agentId\s*\?\?\s*"inline"\}:inline:\$\{i\}`\}\s*\/>/);
  });
});
