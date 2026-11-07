import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PACK_PROFILES, LEAD_NOTE_BODY, BRAINSTORM_NOTE_BODY, SHARED_NOTE_PREFIX } from "../server/profiles.mjs";
import { STANDING_RULES } from "../server/lessons.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const BAD = /paseo (wait|ls|la|--help|agent|inspect|send)b|Paseo MCP|Paseo message/;
const BAD_TOOLS = /create_agent|send_agent_prompt|wait_for_agent/; // hook names legitimately appear in plugin code
const flat = (v) => (Array.isArray(v) ? v.join("\n") : String(v));

test("lead, brainstorm and worker prompt text names only vs / VS MCP tools", () => {
  const notes = DEFAULT_PACK_PROFILES.map((p) => p.notes || "");
  const sources = {
    shared: flat(SHARED_NOTE_PREFIX),
    lead: flat(LEAD_NOTE_BODY),
    brainstorm: flat(BRAINSTORM_NOTE_BODY),
    lessons: flat(STANDING_RULES),
    pack: notes.join("\n"),
    plugin: readFileSync(resolve(ROOT, "plugin/index.server.ts"), "utf8"),
    ui: readFileSync(resolve(ROOT, "src/profiles.ts"), "utf8"),
    brainstormSrc: readFileSync(resolve(ROOT, "server/brainstorm.mjs"), "utf8"),
  };
  for (const [name, text] of Object.entries(sources)) {
    // Code comments may name the Paseo API they wrap; only prompt strings matter.
    const prompt = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.ok(!BAD.test(prompt), `${name}: ${(prompt.match(BAD) || [])[0]}`);
    if (!["plugin", "ui", "brainstormSrc"].includes(name)) assert.ok(!BAD_TOOLS.test(prompt), `${name}: Paseo tool name`);
  }
  assert.match(sources.shared, /`vs wait <id> --timeout <s>`/);
  assert.match(sources.brainstorm, /`vs --help`/);
  assert.match(sources.plugin, /`vs wait <id>/);
  assert.match(sources.lessons, /`vs who lead`/);
});
