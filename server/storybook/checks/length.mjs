// Storybook check #18 (V11): fits on screen. Report-only. Flags player-facing text longer than its budget:
//  - pinned: the row's `length_budget` (EFI text_review.csv) when it states a number ("1-3 sentences", "40 chars");
//    prose such as "none pinned (labels wrap)" is NOT a budget and falls through;
//  - default: per-group caps from ../length-config.mjs (toast, button, card title, bio, ...), chosen from the row's
//    data_path field key, a `Data:` group / data/<name>.json stem, then (fallback) the where_seen prose. No matching group =
//    no cap = never flagged.
// Findings carry `category: "too-long"` so a UI can filter "Too long". Pinned breach = warn, default-cap breach = info.
import { clean, norm } from "./text.mjs";
import { lengthGroupsFor } from "../length-config.mjs";

const ref = (e) => ({ kind: e.kind, id: e.id });
const sentences = (s) => (String(s).replace(/(\d)\.(\d)/g, "$1$2").replace(/\.{2,}/g, "…").match(/[^.!?]+(?:[.!?]+|$)/g) ?? []).filter((x) => /\w/.test(x)).length;

/** "1-3 sentences" -> {unit:'sentences',max:3}; "<= 40 chars" -> {unit:'chars',max:40}; else null. */
export function parseBudget(s) {
  const t = String(s ?? "");
  let m = t.match(/(?:(\d+)\s*(?:-|–|to)\s*)?(\d+)\s*sentences?\b/i);
  if (m) return { unit: "sentences", max: Number(m[2]) };
  m = t.match(/(?:max(?:imum)?|<=|≤|up to|under)?\s*(\d+)\s*(?:chars?|characters)\b/i);
  if (m) return { unit: "chars", max: Number(m[1]) };
  return null;
}

const tokens = (...parts) => parts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ");

/** Last field key of data_path: a JSON-array string (real EFI) or a dotted path (`a.b[0].story`). */
function fieldKey(dp) {
  if (!dp) return "";
  try { const p = JSON.parse(dp); if (Array.isArray(p)) return String(p.at(-1)); } catch { /* dotted */ }
  return String(dp).split(".").at(-1).replace(/\[\d+\]$/, "");
}

/**
 * Pick the cap group. Pass 1: field key, origin/field, plus the owning data file (a `Data:` group or data/<name>.json stem;
 * `Screen:` groups and scenes/ paths name a screen, not a field type, so they are ignored). Pass 2 (only if pass 1 found
 * nothing): where_seen prose with its leading "<screen> page >" breadcrumb stripped (see length-config.mjs).
 */
export function pickGroup(e, groups) {
  const d = e.data;
  const dataScope = /^\s*data\s*:/i.test(d.group ?? "") ? d.group : "";
  const stem = /^data\/([^/]+)\.json$/.exec(d.file ?? "")?.[1] ?? "";
  const primary = tokens(fieldKey(d.data_path), d.origin, d.field, d.kind, dataScope, stem);
  const hit = groups.find((g) => g.match.test(primary));
  if (hit) return hit;
  const fb = tokens(String(d.where_seen ?? "").replace(/^[^>]*\bpage\s*>\s*/i, "").split(">").map((x) => x.trim()).filter((x) => !/^(?:[a-z0-9]*_[a-z0-9_]*(?:\(\))?|[a-z0-9_]+\(\))$/i.test(x)).join(" ")); // also drops bare code identifiers (title_screen, _build()) // not d.file: file names like title_screen.gd say nothing about the field type
  return groups.filter((g) => g.fallback != null).sort((a, b) => a.fallback - b.fallback).find((g) => g.match.test(fb)) ?? null;
}

function run(ctx) {
  const lines = ctx.registry.byKind("line");
  const groups = lengthGroupsFor(ctx.snapshot.project, ctx.adapter);
  const flat = (v) => clean(v).replace(/\s+/g, " ");
  const csvTexts = new Set(lines.filter((e) => e.data.origin === "csv").map((e) => norm(e.data.text)));
  const out = [];
  for (const e of lines) {
    const text = flat(e.data.text);
    if (e.data.origin !== "csv" && csvTexts.has(norm(e.data.text))) continue; // the csv row owns it
    const rewrite = e.data.origin === "csv" ? flat(e.data.owner_rewrite) : "";
    const budget = parseBudget(e.data.length_budget);
    const hit = budget ? null : pickGroup(e, groups);
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
