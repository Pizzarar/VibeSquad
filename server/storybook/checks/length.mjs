// Storybook check #18 (V11): fits on screen. Report-only. Flags player-facing text longer than its budget:
//  - pinned: the row's `length_budget` (EFI text_review.csv) when it states a number ("1-3 sentences", "40 chars");
//    prose such as "none pinned (labels wrap)" is NOT a budget and falls through;
//  - default: per-group caps from ../length-config.mjs (toast, button, card title, bio, ...), chosen from the row's
//    group / where_seen / file / data_path. No matching group = no cap = never flagged.
// Findings carry `category: "too-long"` so a UI can filter "Too long". Pinned breach = warn, default-cap breach = info.
import { clean } from "./text.mjs";
import { lengthGroupsFor } from "../length-config.mjs";

const ref = (e) => ({ kind: e.kind, id: e.id });
const sentences = (s) => (String(s).match(/[^.!?]+(?:[.!?]+|$)/g) ?? []).filter((x) => /\w/.test(x)).length;

/** "1-3 sentences" -> {unit:'sentences',max:3}; "<= 40 chars" -> {unit:'chars',max:40}; else null. */
export function parseBudget(s) {
  const t = String(s ?? "");
  let m = t.match(/(?:(\d+)\s*(?:-|–|to)\s*)?(\d+)\s*sentences?\b/i);
  if (m) return { unit: "sentences", max: Number(m[2]) };
  m = t.match(/(?:max(?:imum)?|<=|≤|up to|under)?\s*(\d+)\s*(?:chars?|characters)\b/i);
  if (m) return { unit: "chars", max: Number(m[1]) };
  return null;
}

function haystack(e) {
  const d = e.data;
  let key = "";
  try { const p = JSON.parse(d.data_path); if (Array.isArray(p)) key = String(p.at(-1)); } catch { /* not json */ }
  return [d.group, d.where_seen, d.file, key, d.origin, d.field, d.kind].filter(Boolean).join(" | ").toLowerCase();
}

function run(ctx) {
  const lines = ctx.registry.byKind("line");
  const groups = lengthGroupsFor(ctx.snapshot.project, ctx.adapter);
  const csvTexts = new Set(lines.filter((e) => e.data.origin === "csv").map((e) => clean(e.data.text)));
  const out = [];
  for (const e of lines) {
    const text = clean(e.data.text).replace(/\s+/g, " ");
    if (!text) continue;
    if (e.data.origin !== "csv" && csvTexts.has(text)) continue; // the csv row owns it
    const rewrite = e.data.origin === "csv" ? clean(e.data.owner_rewrite).replace(/\s+/g, " ") : "";
    const budget = parseBudget(e.data.length_budget);
    const hit = groups.find((g) => g.match.test(haystack(e)));
    for (const [label, t] of [["text", text], ["owner_rewrite", rewrite]]) {
      if (!t) continue;
      let over = null;
      if (budget) {
        const n = budget.unit === "sentences" ? sentences(t) : t.length;
        if (n > budget.max) over = { sev: "warn", msg: `too long: ${label} is ${n} ${budget.unit} (pinned budget ${budget.max}): "${t.slice(0, 60)}${t.length > 60 ? "…" : ""}"`, n, max: budget.max, mode: "pinned" };
      } else if (hit && t.length > hit.max) {
        over = { sev: "info", msg: `too long: ${label} is ${t.length} chars (default ${hit.label} cap ${hit.max}): "${t.slice(0, 60)}${t.length > 60 ? "…" : ""}"`, n: t.length, max: hit.max, mode: "default" };
      }
      if (over) out.push({ check: "#18", severity: over.sev, category: "too-long", entityRef: ref(e), msg: over.msg, source: e.source ?? null, over: { n: over.n, max: over.max, mode: over.mode } });
    }
  }
  return out;
}

export const checks = [{ id: "#18", title: "Fits on screen (length budget)", run }];
