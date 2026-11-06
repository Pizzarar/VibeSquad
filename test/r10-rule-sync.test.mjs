import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const R10 =
  "Never run release, publish, tag or signing scripts yourself. When the owner asks for a release, send `vs log handoff \"release <project> <stable|beta> <commit|branch>\" -> Release Desk` plus a Paseo message to the Release Desk Buddy (`vs who brainstorm --lane release-desk`) with the change list and credits, then go back to your work. The desk versions, audits, signs, publishes and reports back.";

test("R10 (Releases) rule text is identical in all four rule sources", () => {
  const sources = {
    "plugin/index.server.ts": `  ${JSON.stringify("- R10 (Releases): " + R10)},`,
    "server/profiles.mjs": `  ${JSON.stringify("- R10 (Releases): " + R10)},`,
    "src/profiles.ts": `  ${JSON.stringify("- R10 (Releases): " + R10)},`,
    "docs/profiles/DEFAULT_PACK.md": `- **R10 (Releases):** ${R10}`,
  };
  for (const [file, line] of Object.entries(sources)) {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split(/\r?\n/);
    const r9 = lines.findIndex((l) => l.includes("R9 (Owner"));
    assert.ok(r9 >= 0, `${file} has R9`);
    assert.equal(lines[r9 + 1], line, `${file} R10 follows R9 verbatim`);
  }
});
