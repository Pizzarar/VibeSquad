// Storybook V10 glossary loader (read-only).
// Reads EFI docs/narrative/GLOSSARY.md if present via the pinned-sha reader, else seeds from VOICE_BIBLE
// voice_card entities (globalBans + default player word "runner") plus core canonical terms & name-style rules.
// Glossary writes are out of scope this wave (will go through the V6 EFI-branch writer later).

export const GLOSSARY_PATH = "docs/narrative/GLOSSARY.md";

/** Default canonical terms seeded when no GLOSSARY.md exists in the repo. */
const DEFAULT_CANONICAL = [
  {
    id: "runner",
    term: "runner",
    variants: ["Runner", "runners", "Runners"],
    caseSensitive: true,
    allowSentenceStart: true,
    allowPlural: true,
    note: 'Default player word (from VOICE_BIBLE). Keep lowercase "runner" mid-sentence; avoid "Runner" or non-canonical substitutes.',
  },
  {
    id: "scav",
    term: "Scav",
    variants: ["scav", "scavs", "Scavs", "scavenger", "scavengers", "Scavenger", "Scavengers"],
    caseSensitive: true,
    allowSentenceStart: true,
    allowPlural: true,
    note: 'Canonical faction/enemy term is "Scav" (Title Case, plural "Scavs"). Avoid lowercase "scav" or "scavenger" in faction/enemy references.',
  },
  {
    id: "pmc",
    term: "PMC",
    variants: ["pmc", "pmcs", "Pmc", "Pmcs"],
    caseSensitive: true,
    allowSentenceStart: false,
    allowPlural: true,
    note: 'Acronym is always uppercase "PMC" (plural "PMCs").',
  },
  {
    id: "hideout",
    term: "Hideout",
    variants: ["hideout", "HIDEOUT"],
    caseSensitive: true,
    allowSentenceStart: true,
    allowPlural: false,
    note: 'Home base name is "Hideout" (Title Case in prose; ALL-CAPS UI headers are ignored).',
  },
  {
    id: "credits",
    term: "credits",
    variants: ["Credits", "CREDITS", "creds", "Creds"],
    caseSensitive: true,
    allowSentenceStart: true,
    allowPlural: true,
    note: 'Currency in prose is lowercase "credits" (or "c" in compact UI). Avoid "creds" or mid-sentence "Credits".',
  },
];

/** Default name-style rules shown in the Glossary tab and checked by #17. */
export const DEFAULT_NAME_STYLE_RULES = Object.freeze([
  {
    id: "cross-kind-id",
    title: "No cross-kind ID collisions",
    description: "An entity id should not be reused across different registries (except recipe/item pairs), e.g. squad id `doc` (Saint) colliding with trader `doc` (Doc).",
  },
  {
    id: "id-display-drift",
    title: "ID matches display name",
    description: "Entity ids and display names should stay aligned (ignoring structural prefixes like `boss_` and leading `The`), so writers and code refer to the same thing.",
  },
  {
    id: "naming-style",
    title: "Consistent display casing & formatting",
    description: "Display names should not leak raw `snake_case`, all-lowercase names, or stray whitespace.",
  },
]);

const FALLBACK_BANS = [
  "paranormal", "supernatural", "ghost", "magic", "spell", "wizard",
  "adventurer", "adventurers", "lol", "lmao", "yeet", "no cap",
];

function slugify(s) {
  return String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "term";
}

/**
 * Parse a markdown GLOSSARY.md file into { canonical[], banned[], nameStyleRules[] }.
 * Supports `## Canonical terms` / `## Banned terms` / `## Name-style rules` with bullet items:
 *   - **Term** — variants: a, b; note text
 *   - **term**: note text
 *   - `term` — note text
 */
export function parseGlossaryMarkdown(text, filePath = GLOSSARY_PATH) {
  const canonical = [];
  const banned = [];
  const nameStyleRules = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let section = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const h = /^##\s+(.+)$/.exec(raw.trim());
    if (h) {
      const title = h[1].trim().toLowerCase();
      if (/ban|forbid|avoid|never/.test(title)) section = "banned";
      else if (/name|style|naming/.test(title)) section = "rules";
      else if (/canon|term|vocab/.test(title)) section = "canonical";
      else section = null;
      continue;
    }
    const item = /^\s*[-*]\s+(.+)$/.exec(raw);
    if (!item || !section) continue;
    const body = item[1].trim();
    const head = /^(?:\*\*([^*]+)\*\*|`([^`]+)`|"([^"]+)"|([^:—–-]+?))(?:\s*(?:—|–|:|-)\s*(.*))?$/.exec(body);
    if (!head) continue;
    const label = (head[1] ?? head[2] ?? head[3] ?? head[4] ?? "").trim();
    const rest = (head[5] ?? "").trim();
    if (!label) continue;

    if (section === "canonical") {
      const vm = /variants?\s*:\s*([^;.\n]+)/i.exec(rest);
      const variants = vm ? vm[1].split(/[,/]/).map((s) => s.trim().replace(/^["'`]|["'`]$/g, "")).filter(Boolean) : [];
      const note = vm ? rest.replace(vm[0], "").replace(/^[\s;—–:-]+/, "").trim() : rest;
      canonical.push({
        id: slugify(label),
        term: label,
        variants,
        caseSensitive: true,
        allowSentenceStart: true,
        allowPlural: true,
        note,
        source: { path: filePath, line: i + 1 },
      });
    } else if (section === "banned") {
      banned.push({
        id: slugify(label),
        term: label.toLowerCase(),
        display: label,
        note: rest || "Banned by GLOSSARY.md",
        source: { path: filePath, line: i + 1 },
      });
    } else if (section === "rules") {
      nameStyleRules.push({
        id: slugify(label),
        title: label,
        description: rest || label,
        source: { path: filePath, line: i + 1 },
      });
    }
  }

  return {
    source: { path: filePath, seeded: false },
    playerWord: canonical.find((c) => /player/i.test(c.note))?.term ?? "runner",
    canonical,
    banned,
    nameStyleRules: nameStyleRules.length ? nameStyleRules : [...DEFAULT_NAME_STYLE_RULES],
  };
}

/**
 * Seed a read-only glossary from VOICE_BIBLE voice_card entities (globalBans + default player word "runner").
 */
export function seedGlossaryFromEntities(entities = []) {
  const cards = (entities ?? []).filter((e) => e.kind === "voice_card");
  const first = cards[0] ?? null;
  const playerWord = String(first?.data?.playerWord ?? "runner").trim() || "runner";
  const rawBans = Array.isArray(first?.data?.globalBans) && first.data.globalBans.length
    ? first.data.globalBans
    : FALLBACK_BANS;
  const prose = String(first?.data?.globalBansProse ?? "").trim();
  const voicePath = first?.source?.path ?? "docs/narrative/VOICE_BIBLE.md";

  const canonical = DEFAULT_CANONICAL.map((c) => {
    if (c.id !== "runner") return { ...c, variants: [...c.variants] };
    const cap = playerWord.charAt(0).toUpperCase() + playerWord.slice(1);
    const variants = [...new Set([cap, `${playerWord}s`, `${cap}s`].filter((v) => v !== playerWord))];
    return { ...c, term: playerWord, variants };
  });

  const banned = [...new Set(rawBans.map((b) => String(b).trim().toLowerCase()).filter(Boolean))].map((term) => ({
    id: slugify(term),
    term,
    display: term,
    note: prose ? `VOICE_BIBLE global ban (${prose})` : "VOICE_BIBLE global ban",
    source: first?.source ? { path: voicePath, line: first.source.line } : null,
  }));

  return {
    source: { path: voicePath, seeded: true },
    playerWord,
    canonical,
    banned,
    nameStyleRules: DEFAULT_NAME_STYLE_RULES.map((r) => ({ ...r })),
  };
}

/**
 * Load the project glossary: reads docs/narrative/GLOSSARY.md if present, else seeds from VOICE_BIBLE + "runner".
 */
export async function buildGlossary(entities = [], reader = null) {
  if (reader && typeof reader.readFile === "function") {
    try {
      const md = await reader.readFile(GLOSSARY_PATH);
      if (typeof md === "string" && md.trim()) return parseGlossaryMarkdown(md, GLOSSARY_PATH);
    } catch { /* fall back to VOICE_BIBLE seed */ }
  }
  return seedGlossaryFromEntities(entities);
}
