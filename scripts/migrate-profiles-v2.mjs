#!/usr/bin/env node
// Migrate ~/.vibesquad/profiles.json to schema v2 (roles), docs/PLAN_PROFILES_ROLE_ONLY.md P5b, idea-77.
//
// RUN ONLY AFTER P5b IS LIVE AND THE SERVER HAS RESTARTED: a pre-P5b server rewrites profiles.json on save and drops
// `roles` / `schemaVersion`, silently undoing this migration.
//
//   node scripts/migrate-profiles-v2.mjs [--path <profiles.json>] [--dry-run] [--json]
//
// Default path: VIBESQUAD_PROFILES_PATH, else $VIBESQUAD_HOME/profiles.json, else ~/.vibesquad/profiles.json.
// Idempotent (an already-v2 file is left alone), node-written (utf8, no BOM, atomic rename), original backed up to
// <file>.bak-p5 first. The v1 `profiles` list is kept as-is, so v1 readers keep working. Logic: server/profiles-v2.mjs.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateProfilesFile } from "../server/profiles-v2.mjs";

export function parseArgs(argv) {
  const out = { path: undefined, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--path") {
      out.path = argv[++i];
      if (!out.path || out.path.startsWith("--")) throw new Error("--path needs a value");
    }
    else if (a.startsWith("--path=")) out.path = a.slice("--path=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.path !== undefined && !out.path) throw new Error("--path needs a value");
  return out;
}

export function main(argv = process.argv.slice(2), log = console.log) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    log(`migrate-profiles-v2: ${err.message}`);
    return 2;
  }
  if (args.help) {
    log("usage: node scripts/migrate-profiles-v2.mjs [--path <profiles.json>] [--dry-run] [--json]");
    return 0;
  }
  const res = migrateProfilesFile(args.path, { dryRun: args.dryRun });
  if (args.json) {
    log(JSON.stringify(res, null, 2));
  } else if (!res.ok) {
    log(`migrate-profiles-v2: FAIL ${res.path}: ${res.error}`);
  } else if (!res.changed) {
    log(`migrate-profiles-v2: no change (${res.reason}) ${res.path}`);
  } else {
    const verb = res.dryRun ? "would migrate" : "migrated";
    log(`migrate-profiles-v2: ${verb} ${res.path} v${res.fromVersion} -> v2: ${res.roleCount} roles${res.backupPath ? `, backup ${res.backupPath}` : ""}`);
    if (res.unmapped?.length) log(`  kept as profiles only (no role): ${res.unmapped.join(", ")}`);
  }
  return res.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}
