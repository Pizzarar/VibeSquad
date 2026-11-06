import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  BRAINSTORM_PACK,
  EVERYONE_LAYER,
  LEAD_FALLBACK_PACK,
} from "../plugin/index.server.ts";
import {
  BRAINSTORM_NOTE_BODY,
  DEFAULT_PROFILES,
  LEAD_NOTE_BODY,
  PRIOR_ART_CHECK_RULE,
} from "../server/profiles.mjs";
import {
  COMMUNITY_ACCOLADES_020,
  buildLatestJson,
  defaultReleaseNotes,
} from "../server/release.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ATTRIBUTION_TEMPLATE = "Implemented <feature> — Thanks to <Plugin/Project> by <Author>";

const REQUIRED_AUTHORS = [
  "dutchakdev",
  "gil-pingping",
  "bendavid",
  "nkwib",
  "zedobaia",
  "zhjiang22",
  "Chechulin Serhii",
  "anh-chu",
  "babo-jeonguk",
  "Kapybara",
  "getpaseo",
  "sm1ee",
  "Hicham Boushaba",
  "neunzig-zehn",
  "xzthemeofsss",
  "Kingsley",
];

test("1) CREDITS.md exists at repo root and includes all 11 community accolades and 16 authors", () => {
  const creditsPath = join(REPO_ROOT, "CREDITS.md");
  assert.equal(existsSync(creditsPath), true, "Expected CREDITS.md at repo root");
  const credits = readFileSync(creditsPath, "utf8");
  assert.match(credits, /^# VibeSquad — Community Accolades & Credits/m);
  assert.equal(credits.includes(ATTRIBUTION_TEMPLATE), true);

  for (const author of REQUIRED_AUTHORS) {
    assert.equal(credits.includes(author), true, `CREDITS.md missing author ${author}`);
  }

  const bullets = credits
    .split(/\r?\n/)
    .filter((l) => l.startsWith("- Implemented ") || l.startsWith("- Built on the Paseo Daemon"));
  // 11 v0.2.0 accolades + 2 runner entries (VS agent runner adapters, ACP adapters) added with Own Daemon B2.
  assert.equal(bullets.length, 14, "Expected 11 community accolades + 3 runner credits (incl. VS MCP aliases) in CREDITS.md");
});

test("2) server/profiles.mjs and plugin/index.server.ts require attribution format in plans, commits, CREDITS.md, and release notes", () => {
  for (const [label, text] of [
    ["PRIOR_ART_CHECK_RULE", PRIOR_ART_CHECK_RULE],
    ["BRAINSTORM_NOTE_BODY", BRAINSTORM_NOTE_BODY],
    ["LEAD_NOTE_BODY", LEAD_NOTE_BODY],
    ["EVERYONE_LAYER", EVERYONE_LAYER],
    ["BRAINSTORM_PACK", BRAINSTORM_PACK],
    ["LEAD_FALLBACK_PACK", LEAD_FALLBACK_PACK],
  ]) {
    assert.equal(
      text.includes(ATTRIBUTION_TEMPLATE),
      true,
      `${label} must include "${ATTRIBUTION_TEMPLATE}"`,
    );
    assert.equal(
      text.includes("CREDITS.md"),
      true,
      `${label} must reference CREDITS.md`,
    );
  }

  for (const profileName of ["Lead - Claude", "Lead - Gemini", "Brainstorm - Claude", "Brainstorm - Gemini"]) {
    const prof = DEFAULT_PROFILES.find((p) => p.name === profileName);
    assert.ok(prof, `Expected default profile ${profileName}`);
    assert.equal(
      prof.notes.includes(ATTRIBUTION_TEMPLATE),
      true,
      `Profile ${profileName} notes missing attribution format`,
    );
  }
});

test("3) public/THIRD-PARTY-LICENSES.txt includes the Community Accolades section from CREDITS.md", () => {
  const licensesPath = join(REPO_ROOT, "public", "THIRD-PARTY-LICENSES.txt");
  assert.equal(existsSync(licensesPath), true, "Expected public/THIRD-PARTY-LICENSES.txt");
  const licenses = readFileSync(licensesPath, "utf8");
  assert.equal(
    licenses.includes("Community Accolades & Plugin Credits (CREDITS.md)"),
    true,
    "THIRD-PARTY-LICENSES.txt missing Community Accolades header",
  );
  for (const author of REQUIRED_AUTHORS) {
    assert.equal(
      licenses.includes(author),
      true,
      `THIRD-PARTY-LICENSES.txt missing accolade author ${author}`,
    );
  }
});

test("4) buildLatestJson includes the formatted community accolades in release notes by default", () => {
  assert.equal(COMMUNITY_ACCOLADES_020.length, 11);
  const manifest = buildLatestJson({ version: "0.2.0", channel: "stable", signature: "SIG" });
  assert.match(manifest.notes, /^VibeSquad v0\.2\.0 \(stable\)/);
  assert.equal(manifest.notes, defaultReleaseNotes("0.2.0", "stable"));
  for (const accolade of COMMUNITY_ACCOLADES_020) {
    assert.equal(
      manifest.notes.includes(accolade),
      true,
      `Release notes missing accolade: ${accolade}`,
    );
  }
  for (const author of REQUIRED_AUTHORS) {
    assert.equal(
      manifest.notes.includes(author),
      true,
      `Release notes missing author: ${author}`,
    );
  }
});
