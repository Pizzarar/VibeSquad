#!/usr/bin/env node
// Windows Authenticode signing through Azure Artifact Signing. Used as the Tauri signCommand
// (src-tauri/tauri.release-sign.conf.json): `node scripts/sign-windows.mjs <file>`.
//   node scripts/sign-windows.mjs --check   -> no signing; reports which Azure checklist steps 6-9 are missing.
//
// Config (nothing here is secret except the client secret):
//   - credential `vibesquad/artifact-signing` (generic; env AZURE_CLIENT_SECRET wins): the CLIENT SECRET only.
//     server/secrets.mjs reads the password blob, not the username, so the client id is kept non-secret in azure.json.
//   - ~/.vibesquad/signing/metadata.json : Endpoint, CodeSigningAccountName, CertificateProfileName, ExcludeCredentials
//     (this exact file is handed to signtool as /dmdf).
//   - ~/.vibesquad/signing/azure.json    : { "tenantId": "...", "clientId": "..." } (non-secret; env AZURE_TENANT_ID /
//     AZURE_CLIENT_ID win). Tenant id lives here, not in metadata.json, so /dmdf stays exactly what the dlib expects.
// AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET are set ONLY in the signtool child env: never argv, never
// logged, never in this process's own process.env.
// Env overrides: VS_SIGNTOOL, VS_SIGN_DLIB, VS_SIGN_DIR (replaces ~/.vibesquad/signing).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSecret } from "../server/secrets.mjs";

export const CREDENTIAL_TARGET = "vibesquad/artifact-signing";
export const TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";
const METADATA_FIELDS = ["Endpoint", "CodeSigningAccountName", "CertificateProfileName"];

const defaults = () => ({
  env: process.env,
  exec: execFileSync,
  exists: existsSync,
  readFile: (p) => readFileSync(p, "utf8"),
  readdir: (p) => readdirSync(p),
  read: undefined, // credential reader override (tests)
  home: homedir(),
  log: console.log,
});

const signingDir = (d) => d.env.VS_SIGN_DIR || join(d.home, ".vibesquad", "signing");
const metadataPath = (d) => join(signingDir(d), "metadata.json");

function readJson(d, path) {
  try {
    return JSON.parse(d.readFile(path));
  } catch {
    return null;
  }
}

/** Candidate dirs for signtool.exe / Azure.CodeSigning.Dlib.dll (winget ArtifactSigningClientTools, Windows Kits). */
function toolDirs(d) {
  const local = d.env.LOCALAPPDATA || join(d.home, "AppData", "Local");
  const pf86 = d.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const dirs = [];
  for (const name of ["MicrosoftArtifactSigningClientTools", "MicrosoftTrustedSigningClientTools"]) {
    dirs.push(join(local, name), join(local, "Microsoft", name));
  }
  const kits = join(pf86, "Windows Kits", "10", "bin");
  let versions = [];
  try {
    versions = d.readdir(kits).sort().reverse();
  } catch {
    // no Windows Kits
  }
  for (const v of versions) dirs.push(join(kits, v, "x64"));
  return dirs;
}

export function findSigntool(d) {
  if (d.env.VS_SIGNTOOL) return d.exists(d.env.VS_SIGNTOOL) ? d.env.VS_SIGNTOOL : null;
  return toolDirs(d).map((dir) => join(dir, "signtool.exe")).find((p) => d.exists(p)) ?? null;
}

export function findDlib(d) {
  if (d.env.VS_SIGN_DLIB) return d.exists(d.env.VS_SIGN_DLIB) ? d.env.VS_SIGN_DLIB : null;
  return toolDirs(d).map((dir) => join(dir, "Azure.CodeSigning.Dlib.dll")).find((p) => d.exists(p)) ?? null;
}

function azureIds(d) {
  const file = readJson(d, join(signingDir(d), "azure.json")) || {};
  return {
    tenantId: d.env.AZURE_TENANT_ID || file.tenantId || "",
    clientId: d.env.AZURE_CLIENT_ID || file.clientId || "",
  };
}

function clientSecret(d) {
  return resolveSecret({ envVar: "AZURE_CLIENT_SECRET", target: CREDENTIAL_TARGET }, { env: d.env, ...(d.read ? { read: d.read } : {}) });
}

/** Missing pieces, keyed by Azure checklist step (6-9). Never touches secret values beyond presence. */
export function checkSetup(deps = {}) {
  const d = { ...defaults(), ...deps };
  const missing = [];
  const metaFile = metadataPath(d);
  const meta = d.exists(metaFile) ? readJson(d, metaFile) : null;
  if (!d.exists(metaFile)) {
    missing.push({ step: 8, message: `missing ${metaFile}` });
  } else if (!meta) {
    missing.push({ step: 8, message: `${metaFile} is not valid JSON` });
  } else {
    const absent = METADATA_FIELDS.filter((f) => !meta[f]);
    if (absent.length) missing.push({ step: 6, message: `metadata.json is missing certificate profile fields: ${absent.join(", ")}` });
  }
  if (!clientSecret(d)) missing.push({ step: 7, message: `missing ${CREDENTIAL_TARGET} credential` });
  const ids = azureIds(d);
  if (!ids.tenantId || !ids.clientId) missing.push({ step: 8, message: "missing tenantId/clientId (azure.json next to metadata.json, or AZURE_TENANT_ID/AZURE_CLIENT_ID)" });
  if (!findSigntool(d)) missing.push({ step: 9, message: "signtool not found (set VS_SIGNTOOL or install the Windows SDK)" });
  if (!findDlib(d)) missing.push({ step: 9, message: "dlib not found: Azure.CodeSigning.Dlib.dll (winget install ArtifactSigningClientTools, or set VS_SIGN_DLIB)" });
  missing.sort((a, b) => a.step - b.step);
  return missing;
}

/** Prints the --check report; returns the process exit code. */
export function runCheck(deps = {}) {
  const d = { ...defaults(), ...deps };
  const missing = checkSetup(d);
  if (!missing.length) {
    d.log("sign-windows --check: OK (checklist steps 6-9 all present)");
    return 0;
  }
  d.log("sign-windows --check: NOT READY");
  for (const m of missing) d.log(`  step ${m.step}: ${m.message}`);
  return 1;
}

/** Sign then verify one file. Throws on any failure; the secret only reaches the signtool child env. */
export function signFile(file, deps = {}) {
  const d = { ...defaults(), ...deps };
  if (!file) throw new Error("usage: sign-windows.mjs <file> | --check");
  const missing = checkSetup(d);
  if (missing.length) throw new Error(`Windows signing is not set up:\n${missing.map((m) => `  step ${m.step}: ${m.message}`).join("\n")}`);
  const signtool = findSigntool(d);
  const dlib = findDlib(d);
  const ids = azureIds(d);
  const env = { ...d.env, AZURE_TENANT_ID: ids.tenantId, AZURE_CLIENT_ID: ids.clientId, AZURE_CLIENT_SECRET: clientSecret(d) };
  const opts = { env, stdio: "inherit", windowsHide: true };
  d.log(`[sign-windows] signing ${file}`);
  d.exec(signtool, ["sign", "/v", "/fd", "SHA256", "/tr", TIMESTAMP_URL, "/td", "SHA256", "/dlib", dlib, "/dmdf", metadataPath(d), file], opts);
  d.exec(signtool, ["verify", "/pa", "/v", file], opts);
  d.log(`[sign-windows] signed and verified ${file}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const arg = process.argv[2];
  try {
    if (arg === "--check") process.exitCode = runCheck();
    else signFile(arg);
  } catch (err) {
    console.error(`[sign-windows] ${err.message}`);
    process.exitCode = 1;
  }
}
