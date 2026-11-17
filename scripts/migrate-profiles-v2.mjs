#!/usr/bin/env node
// Migrate ~/.vibesquad/profiles.json to schema v2 (roles), docs/PLAN_PROFILES_ROLE_ONLY.md P5b, idea-77.
//
// RUN ONLY AFTER P5b IS LIVE AND THE SERVER HAS RESTARTED: a pre-P5b server rewrites profiles.json on save and drops
// `roles` / `schemaVersion`, silently undoing this migration. HOLD until P5d's role editor ships (P5b review M: stored
// roles go stale when a legacy profile is edited; the spawn hook builds roles live from v1 until then).
//
// Save race: a profiles save (Settings UI / server) that lands between this script's read and its atomic rename is
// overwritten (it is in the backup, not the file). Run it with the UI closed, then VERIFY: rerun it (it must print
// "no change (already-v2)") and check the profile you last edited. If the rerun migrates again, a v1 save won: rerun.
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
  let res;
  try {
    res = migrateProfilesFile(args.path, { dryRun: args.dryRun });
  } catch (err) {
    // Never a raw stack: name the reason and the backup to restore from (it exists once the copy step ran).
    res = { ok: false, changed: false, path: args.path ?? "profiles.json", error: String(err?.message ?? err), backupPath: err?.backupPath ?? null };
  }
  if (args.json) {
    log(JSON.stringify(res, null, 2));
  } else if (!res.ok) {
    log(`migrate-profiles-v2: FAIL ${res.error} path=${res.path} backup=${res.backupPath || "none"}`);
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
