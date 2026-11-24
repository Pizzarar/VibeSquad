#!/usr/bin/env node
// Dev smoke: load a project through its adapter at a pinned sha and print [STORYBOOK] counts. Read-only; never fetches.
// usage: node scripts/storybook-smoke.mjs <repoPath> [ref=origin/<default>]   (repoPath is required; nothing is hardcoded)
import path from "node:path";
import { openReader } from "../server/storybook/git-read.mjs";
import { efiAdapter } from "../server/storybook/adapters/efi.mjs";
import { loadSnapshot } from "../server/storybook/adapter.mjs";
import { runChecks } from "../server/storybook/checks/index.mjs";
import { makeRegistry, validateSnapshot } from "../server/storybook/schema.mjs";

if (!process.argv[2]) { console.error("usage: node scripts/storybook-smoke.mjs <repoPath> [ref]"); process.exit(2); }
const repo = path.resolve(process.argv[2]);
const ref = process.argv[3] ?? "";
const reader = await openReader(repo, ref || undefined);
const snap = await loadSnapshot(efiAdapter, reader, { ref: ref || "origin/HEAD" });
const reg = makeRegistry(snap.entities);
const v = validateSnapshot(snap);
const counts = reg.counts();
console.log(`[STORYBOOK] sha=${snap.sha.slice(0, 8)} ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ")} total=${reg.size()} valid=${v.ok}`);
const dangling = {};
for (const e of reg.all()) for (const l of e.links) if (!reg.resolve(l)) { const k = `${e.kind}.${l.rel}->${l.kind}`; (dangling[k] ??= new Set()).add(l.id); }
for (const [k, s] of Object.entries(dangling)) console.log(`[STORYBOOK] unresolved-link ${k} n=${s.size} e.g. ${[...s].slice(0, 4).join(",")}`);
const doc = reg.sameId("doc").map((e) => e.kind).join("+");
console.log(`[STORYBOOK] id doc coexists as: ${doc}; bosses=${reg.byKind("enemy").filter((e) => e.data.boss).length}; placeholder=${snap.entities.filter((e) => e.production === "placeholder").length}`);
for (const e of v.errors.slice(0, 10)) console.log(`[STORYBOOK] invalid: ${e}`);
for (const w of snap.warnings) console.log(`[STORYBOOK] warn: ${w}`);

const findings = await runChecks(snap, efiAdapter, { reader });
const per = (c) => findings.filter((f) => f.check === c);
console.log(`[STORYBOOK] sha=${snap.sha.slice(0, 8)} ${["#1", "#2", "#5", "#7", "#8"].map((c) => `${c}=${per(c).length}`).join(" ")} total=${findings.length}`);
for (const c of [...new Set(findings.map((f) => f.check))]) {
  for (const f of per(c).slice(0, 10)) console.log(`[STORYBOOK] ${c} ${f.severity} ${f.entityRef ? `${f.entityRef.kind}:${f.entityRef.id}` : "-"} ${f.source ? `${f.source.path}:${f.source.line ?? "?"}` : ""} ${f.msg}`);
}
