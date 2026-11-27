// Storybook V10 checks: #16 term consistency & banned terms, #17 id<->display drift + naming-style outliers +
// cross-kind id collisions (Doc/Saint folded out of #7), #19 lore/roster consistency (map vibe/lore vs roster/boss).
// All checks are report-only and deterministic.

import { buildGlossary } from "../glossary.mjs";

const ref = (e) => ({ kind: e.kind, id: e.id });
const F = (check, severity, e, msg, source = e?.source ?? null) => ({ check, severity, entityRef: e ? ref(e) : null, msg, source });
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byRef = (a, b) => cmpStr(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`);
const clip = (s, n = 72) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const stripTodo = (s) => String(s ?? "").replace(/^STORY-TODO:\s*/i, "").trim();

const isAllCapsHeader = (text) => {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length >= 2 && letters === letters.toUpperCase() && text.length <= 40;
};

const isSentenceStart = (text, idx) => {
  if (idx <= 0) return true;
  const before = text.slice(0, idx);
  return /(?:^|[.!?:\n\u2014\u2013—–"'\(\[]\s*)$/.test(before);
};

// Context allowlist for idioms that match a global ban word (mirrors text.mjs #10 allowlist philosophy).
const BAN_ALLOWLIST = new Map([
  ["ghost", [/\bghost[- ]town\b/i, /\bghosting\b/i]],
  ["magic", [/\bmagic[- ]bullet\b/i]],
  ["spell", [/\bspell(?:ed|ing)?\s+(?:out|trouble|disaster|doom)\b/i, /\bdry\s+spell\b/i, /\bcold\s+spell\b/i, /\bhot\s+spell\b/i]],
]);

function isAllowedBanContext(term, text) {
  const res = BAN_ALLOWLIST.get(term.toLowerCase());
  return Boolean(res && res.some((re) => re.test(text)));
}

// ---------------------------------------------------------------------------------------------------------------------
// #16 Term consistency & banned terms
// ---------------------------------------------------------------------------------------------------------------------
export async function runTerms(ctx) {
  const { registry, snapshot, reader } = ctx;
  const glossary = snapshot?.glossary ?? await buildGlossary(snapshot?.entities ?? registry.all(), reader);
  const out = [];

  const bannedMatchers = (glossary.banned ?? []).map((b) => ({
    ...b,
    re: new RegExp(`(?<![\\w'])${esc(b.term)}(?![\\w'])`, "i"),
  }));

  const canonMatchers = (glossary.canonical ?? []).map((c) => {
    const canonLower = c.term.toLowerCase();
    const pluralExact = c.allowPlural ? `${c.term}s` : null;
    const variantList = (c.variants ?? []).filter((v) => v !== c.term && v !== pluralExact);
    return {
      ...c,
      canonLower,
      pluralExact,
      variantMatchers: variantList.map((v) => ({
        v,
        caseOnly: v.toLowerCase() === canonLower || (c.allowPlural && v.toLowerCase() === `${canonLower}s`),
        re: new RegExp(`(?<![\\w'])${esc(v)}(?![\\w'])`, "g"),
      })),
    };
  });

  // Multi-word entity display names containing a canonical term (e.g. enemy "Shaft Runner") are proper nouns, not casing drift.
  const properNames = new Set(
    registry.all()
      .filter((e) => e.kind !== "line" && e.kind !== "lore" && e.display && e.display.trim().includes(" "))
      .map((e) => e.display.trim()),
  );

  // Scan player-facing text lines (sorted deterministically by id)
  const lines = registry.byKind("line").sort((a, b) => cmpStr(a.id, b.id));
  for (const e of lines) {
    const raw = stripTodo(e.data?.text ?? "");
    if (!raw) continue;

    // 1. Banned terms
    for (const b of bannedMatchers) {
      if (!b.re.test(raw)) continue;
      if (isAllowedBanContext(b.term, raw)) continue;
      out.push(F("#16", "warn", e, `banned term "${b.term}": "${clip(raw)}"`));
    }

    // 2. Canonical term variants
    const allCaps = isAllCapsHeader(raw);
    const isProperEntityName = properNames.has(raw);
    for (const c of canonMatchers) {
      const seenVariants = new Set();
      for (const vm of c.variantMatchers) {
        if (vm.caseOnly && (allCaps || isProperEntityName)) continue; // UI ALL-CAPS headers or proper entity names like "Shaft Runner"
        vm.re.lastIndex = 0;
        let m;
        while ((m = vm.re.exec(raw)) !== null) {
          const hit = m[0];
          // If canonical is lowercase (e.g. "runner", "credits") and the variant is capitalized only because it starts a sentence, allow it.
          if (vm.caseOnly && c.allowSentenceStart && c.term === c.term.toLowerCase() && hit === hit.charAt(0).toUpperCase() + hit.slice(1) && isSentenceStart(raw, m.index)) {
            continue;
          }
          if (seenVariants.has(hit)) continue;
          seenVariants.add(hit);
          out.push(F("#16", "info", e, `term "${c.term}" written as "${hit}": "${clip(raw)}"`));
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// #17 Id <-> display drift + naming-style outliers + cross-kind id collisions (Doc/Saint folded out of #7)
// ---------------------------------------------------------------------------------------------------------------------
const ID_COLLISION_KINDS = ["trader", "squad", "enemy", "location", "room", "item", "skill", "contract", "recipe", "quest_step"];
const STRICT_DRIFT_KINDS = ["trader", "squad", "enemy", "location", "room"];
const STYLE_KINDS = ["trader", "squad", "enemy", "location", "room", "item", "skill"];

const ITEM_PREFIX_RE = /^(?:item|tool|ammo|mag|med|food|key|quest|mat|part|armor|rig|bag|helm|wpn|gun|mod|misc|junk|val|elec|chem|cloth|metal|wood|craft|gear|supply|wp|eq|raw|cooked)_/;
const BOSS_PREFIX_RE = /^boss_/;

function idTokens(kind, id) {
  let s = String(id ?? "").toLowerCase();
  if (kind === "enemy") s = s.replace(BOSS_PREFIX_RE, "");
  if (kind === "item") s = s.replace(ITEM_PREFIX_RE, "");
  return s.split(/[^a-z0-9]+/).filter(Boolean);
}

function displayTokens(display) {
  return String(display ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // ignore parenthetical suffixes like "(15)"
    .replace(/(?:^|\s)\.(\d+)/g, " $1") // ".45" -> "45", ".308" -> "308"
    .replace(/(\d+)\.(\d+)/g, "$1$2") // "5.56" -> "556", "7.62" -> "762"
    .replace(/^(?:the|a|an)\s+/, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function sameTokenBag(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

const sameJoined = (a, b) => a.join("") === b.join("");

export function runNaming({ registry }) {
  const out = [];

  // 1. Cross-kind id collisions (folded out of #7 so Story issues no longer opens on squad:doc / trader:doc)
  const byId = new Map();
  for (const e of registry.all()) {
    if (!ID_COLLISION_KINDS.includes(e.kind)) continue;
    (byId.get(e.id) ?? byId.set(e.id, []).get(e.id)).push(e);
  }
  for (const [id, es] of [...byId.entries()].sort(([a], [b]) => cmpStr(a, b))) {
    const kinds = [...new Set(es.map((e) => e.kind))];
    if (kinds.length < 2 || kinds.every((k) => k === "recipe" || k === "item")) continue;
    es.sort(byRef);
    out.push(F("#17", "warn", es[0], `cross-kind id "${id}" is used by ${es.map((e) => `${e.kind} (${e.display})`).join(" + ")}`));
  }

  // 2. Id <-> display drift
  for (const kind of STRICT_DRIFT_KINDS) {
    for (const e of registry.byKind(kind).sort(byRef)) {
      const it = idTokens(kind, e.id);
      const dt = displayTokens(e.display);
      if (!it.length || !dt.length) continue;
      if (sameTokenBag(it, dt) || sameJoined(it, dt)) continue;
      out.push(F("#17", "info", e, `id↔display drift: ${kind} id "${e.id}" displays as "${e.display}"`));
    }
  }
  // Items: flag only total renames (zero token overlap between id and display) to avoid noisy ammo/size orderings.
  for (const e of registry.byKind("item").sort(byRef)) {
    const rawIt = String(e.id ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const it = [...new Set([...rawIt, ...idTokens("item", e.id)])];
    const dt = displayTokens(e.display);
    if (!it.length || !dt.length) continue;
    const dtSet = new Set(dt);
    const overlap = it.some((t) => {
      if (dtSet.has(t)) return true;
      const numBase = /^(\d{3,})[a-z]*$/.exec(t)?.[1];
      return dt.some((d) => (t.length >= 3 && d.length >= 3 && (d.startsWith(t) || t.startsWith(d))) || (numBase && d.startsWith(numBase)));
    });
    if (!overlap) {
      out.push(F("#17", "info", e, `id↔display drift: item id "${e.id}" displays as "${e.display}"`));
    }
  }

  // 3. Naming-style outliers
  for (const kind of STYLE_KINDS) {
    for (const e of registry.byKind(kind).sort(byRef)) {
      const d = String(e.display ?? "");
      if (!d) continue;
      if (/_/.test(d)) {
        out.push(F("#17", "warn", e, `naming style: ${kind} "${e.id}" display "${d}" contains raw underscore`));
      } else if (d !== d.trim() || /\s{2,}/.test(d)) {
        out.push(F("#17", "info", e, `naming style: ${kind} "${e.id}" display "${d}" has stray whitespace`));
      } else if (/^[a-z][a-z\s-]+$/.test(d) && d.length > 2) {
        out.push(F("#17", "info", e, `naming style: ${kind} "${e.id}" display "${d}" is all lowercase`));
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// #19 Lore / roster consistency (DOGFOOD_W2 friction 6): enemies/bosses named in location vibe/lore must match data
// ---------------------------------------------------------------------------------------------------------------------
const BOSS_RE = /\*\*Boss\*\*\s*`([a-z0-9_]+)`/g;
const BACKTICK_ID_RE = /`([a-z0-9_]+)`/g;

function locRosterSet(loc) {
  const set = new Set();
  for (const p of Array.isArray(loc?.data?.enemy_pool) ? loc.data.enemy_pool : []) {
    if (p?.id) set.add(String(p.id));
  }
  if (loc?.data?.boss?.enemy_id) set.add(String(loc.data.boss.enemy_id));
  return set;
}

export function runLoreRoster({ registry }) {
  const out = [];
  const enemies = registry.byKind("enemy");
  const enemyById = new Map(enemies.map((e) => [e.id, e]));
  // Multi-word enemy display names (unambiguous in prose) for catching display-name mentions in vibe/lore text
  const displayMatchers = enemies
    .filter((e) => e.display && e.display.trim().split(/\s+/).length >= 2)
    .map((e) => ({
      enemy: e,
      re: new RegExp(`(?<![\\w'])${esc(e.display.trim())}(?![\\w'])`, "i"),
    }));

  const seen = new Set(); // dedupe per (locId, enemyId, kind)
  const emit = (loc, severity, msg, source, dedupeKey) => {
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push(F("#19", severity, loc, msg, source ?? loc.source));
  };

  for (const lore of registry.byKind("lore").sort(byRef)) {
    const lk = lore.data?.lore_kind;
    if (lk !== "map_vibe" && lk !== "band_vibe") continue;
    const locIds = (lore.links ?? [])
      .filter((l) => l.rel === "describes" && l.kind === "location")
      .map((l) => l.id)
      .filter((id) => registry.has("location", id));
    if (!locIds.length) continue;

    const locs = locIds.map((id) => registry.get("location", id)).filter(Boolean);
    const rosterField = lk === "map_vibe" ? String(lore.data?.fields?.roster ?? "") : String(lore.data?.fields?.signature_enemy ?? "");
    const fullText = String(lore.data?.text ?? "");

    // Backticked enemy ids mentioned in the roster/signature field (or vibe text)
    const backtickIds = [...new Set([...rosterField.matchAll(BACKTICK_ID_RE)].map((m) => m[1]))]
      .filter((id) => enemyById.has(id));

    if (lk === "map_vibe") {
      for (const loc of locs) {
        const actual = locRosterSet(loc);
        const actualList = [...actual].sort().join(", ") || "none";

        // 1. Backticked enemy ids in vibe roster not present in location's roster/boss
        for (const eid of backtickIds) {
          if (actual.has(eid)) continue;
          const en = enemyById.get(eid);
          emit(
            loc,
            "warn",
            `${loc.display}: vibe text names \`${eid}\` (${en.display}), but roster is [${actualList}]`,
            lore.source,
            `${loc.id}|enemy|${eid}`,
          );
        }

        // 2. Boss claimed in vibe text vs location's boss data
        BOSS_RE.lastIndex = 0;
        let bm;
        while ((bm = BOSS_RE.exec(rosterField)) !== null) {
          const bid = bm[1];
          if (!enemyById.has(bid)) continue;
          const dataBoss = loc.data?.boss?.enemy_id ?? null;
          if (dataBoss !== bid) {
            emit(
              loc,
              "warn",
              `${loc.display}: vibe text names boss \`${bid}\`, but location boss is ${dataBoss ? `\`${dataBoss}\`` : "none"}`,
              lore.source,
              `${loc.id}|boss|${bid}`,
            );
          }
        }

        // 3. Multi-word enemy display names in vibe roster field not in location's roster/boss
        for (const dm of displayMatchers) {
          if (actual.has(dm.enemy.id)) continue;
          if (backtickIds.includes(dm.enemy.id)) continue; // already reported via backtick id
          if (!dm.re.test(rosterField)) continue;
          emit(
            loc,
            "warn",
            `${loc.display}: vibe text mentions "${dm.enemy.display}" (\`${dm.enemy.id}\`), which is not in its roster [${actualList}]`,
            lore.source,
            `${loc.id}|enemy|${dm.enemy.id}`,
          );
        }
      }
    } else if (lk === "band_vibe") {
      // Band spans multiple floors: an enemy named in signature_enemy must spawn on at least one floor in the band.
      const bandRoster = new Set();
      const bandBosses = new Set();
      for (const loc of locs) {
        for (const eid of locRosterSet(loc)) bandRoster.add(eid);
        if (loc.data?.boss?.enemy_id) bandBosses.add(String(loc.data.boss.enemy_id));
      }
      for (const eid of backtickIds) {
        if (bandRoster.has(eid)) continue;
        const en = enemyById.get(eid);
        emit(
          locs[0],
          "warn",
          `${lore.display}: vibe names \`${eid}\` (${en.display}), but it spawns on none of ${locIds.join(", ")}`,
          lore.source,
          `${lore.id}|enemy|${eid}`,
        );
      }
      BOSS_RE.lastIndex = 0;
      let bm;
      while ((bm = BOSS_RE.exec(rosterField || fullText)) !== null) {
        const bid = bm[1];
        if (!enemyById.has(bid) || bandBosses.has(bid)) continue;
        emit(
          locs[0],
          "warn",
          `${lore.display}: vibe names boss \`${bid}\`, but no floor in ${locIds.join(", ")} has that boss`,
          lore.source,
          `${lore.id}|boss|${bid}`,
        );
      }
    }
  }

  // Also check location.data.description if present
  for (const loc of registry.byKind("location").sort(byRef)) {
    const desc = String(loc.data?.description ?? "").trim();
    if (!desc) continue;
    const actual = locRosterSet(loc);
    const actualList = [...actual].sort().join(", ") || "none";
    for (const dm of displayMatchers) {
      if (actual.has(dm.enemy.id)) continue;
      if (!dm.re.test(desc)) continue;
      emit(
        loc,
        "warn",
        `${loc.display}: description mentions "${dm.enemy.display}" (\`${dm.enemy.id}\`), which is not in its roster [${actualList}]`,
        loc.source,
        `${loc.id}|desc|${dm.enemy.id}`,
      );
    }
  }

  return out;
}

export const checks = [
  { id: "#16", title: "Term consistency & banned terms", run: runTerms },
  { id: "#17", title: "Id↔display drift & naming style", run: runNaming },
  { id: "#19", title: "Lore vs roster consistency", run: runLoreRoster },
];
export default checks;
