#!/usr/bin/env node
// Dev smoke for the SB3 text/cohesion checks (#3 #4 #6 #9 #10 #11). Read-only; never fetches.
// usage: node scripts/storybook-text-smoke.mjs <repoPath> [ref=origin/<default>]   (repoPath is required; nothing is hardcoded)
import path from "node:path";
import { openReader } from "../server/storybook/git-read.mjs";
import { efiAdapter } from "../server/storybook/adapters/efi.mjs";
import { loadSnapshot } from "../server/storybook/adapter.mjs";
import { makeRegistry, validateFinding } from "../server/storybook/schema.mjs";
import { checks, scanTone } from "../server/storybook/checks/text.mjs";

if (!process.argv[2]) { console.error("usage: node scripts/storybook-text-smoke.mjs <repoPath> [ref]"); process.exit(2); }
const repo = path.resolve(process.argv[2]);
const ref = process.argv[3] ?? "";
const reader = await openReader(repo, ref || undefined);
const snapshot = await loadSnapshot(efiAdapter, reader, { ref: ref || "origin/HEAD" });
const registry = makeRegistry(snapshot.entities);
const ctx = { snapshot, registry, adapter: efiAdapter, hooks: efiAdapter.hooks };
const results = [];
for (const c of checks) {
  const fs = await c.run(ctx);
  const bad = fs.filter((f) => !validateFinding(f).ok || f.check !== c.id);
  if (bad.length) console.log(`[STORYBOOK] INVALID ${c.id} findings: ${bad.length}`);
  results.push([c, fs]);
}
console.log(`[STORYBOOK] sha=${snapshot.sha.slice(0, 8)} ${results.map(([c, f]) => `${c.id}=${f.length}`).join(" ")}`);
const sev = (fs) => ["error", "warn", "info"].map((s) => `${s}=${fs.filter((f) => f.severity === s).length}`).join(" ");
for (const [c, fs] of results) {
  console.log(`[STORYBOOK] ${c.id} ${c.title}: ${fs.length} (${sev(fs)})`);
  for (const f of fs.slice(0, 10)) console.log(`  ${f.severity} ${f.entityRef ? `${f.entityRef.kind}:${f.entityRef.id}` : "-"} ${f.source ? `${f.source.path}:${f.source.line ?? ""}` : ""} ${f.msg}`);
}
const tone = scanTone(registry);
console.log(`[STORYBOOK] #10 allowlisted=${tone.allowed.length} ${tone.allowed.slice(0, 5).map((a) => `${a.match}@${a.entity.kind}:${a.entity.id}(${a.allow.id})`).join(" ")}`);
