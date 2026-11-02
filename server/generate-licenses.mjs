// Generates public/THIRD-PARTY-LICENSES.txt from the production npm dependency closure and src-tauri/Cargo.lock.
// Fails if a production npm package has a license outside the permissive allowlist.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");

const ALLOWED = new Set([
  "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "CC0-1.0",
  "Unlicense", "MPL-2.0", "Unicode-3.0", "Unicode-DFS-2016", "Zlib", "CC-BY-4.0", "OFL-1.1", "Python-2.0",
]);

// Packages that ship no license metadata of their own but are Apache-2.0 upstream (Paseo).
const EXPLICIT = {
  "@getpaseo/client": { license: "Apache-2.0", copyright: "Copyright (c) 2025-present Mohamed Boudra" },
  "@getpaseo/protocol": { license: "Apache-2.0", copyright: "Copyright (c) 2025-present Mohamed Boudra" },
};

const readText = (file) =>
  readFileSync(file, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\s*<[^<>\s]+@[^<>\s]+>/g, "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "")
    .trim();
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "";
}

function isAllowed(expr) {
  const clean = expr.replace(/[()]/g, " ").trim();
  if (!clean) return false;
  if (/\bOR\b/.test(clean)) return clean.split(/\s+OR\s+/).some((p) => isAllowed(p));
  return clean.split(/\s+AND\s+/).every((p) => ALLOWED.has(p.trim()));
}

/** Node-style lookup: nearest node_modules/<name> walking up from `fromDir`. */
function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectNpm() {
  const root = readJson(join(rootDir, "package.json"));
  const seen = new Map(); // dir -> info
  const queue = Object.keys(root.dependencies ?? {}).map((n) => ({ name: n, from: rootDir, optional: false }));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const dir = findPackageDir(name, from);
    if (!dir) {
      if (optional) continue;
      throw new Error(`generate-licenses: ${name} is not installed (run npm install)`);
    }
    if (seen.has(dir)) continue;
    const pkg = readJson(join(dir, "package.json"));
    seen.set(dir, { dir, pkg });
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
  }
  const out = [];
  for (const { dir, pkg } of seen.values()) {
    const explicit = EXPLICIT[pkg.name] ?? (pkg.name.startsWith("@getpaseo/") ? EXPLICIT["@getpaseo/client"] : undefined);
    const license = explicit?.license ?? licenseOf(pkg);
    if (!isAllowed(license)) throw new Error(`generate-licenses: ${pkg.name}@${pkg.version} has unapproved license "${license || "none"}"`);
    const files = readdirSync(dir);
    const licenseFile = files.find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
    const noticeFile = files.find((f) => /^notice(\.|$)/i.test(f));
    out.push({
      name: pkg.name,
      version: pkg.version,
      license,
      copyright: explicit?.copyright ?? "",
      licenseText: licenseFile ? readText(join(dir, licenseFile)) : "",
      notice: noticeFile ? readText(join(dir, noticeFile)) : "",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function findCargoLicense(name, version, srcRoots) {
  for (const root of srcRoots) {
    const tomlPath = join(root, `${name}-${version}`, "Cargo.toml");
    if (existsSync(tomlPath)) {
      const m = readFileSync(tomlPath, "utf8").match(/^license\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
    }
  }
  return "";
}

function collectCargo() {
  const lock = join(rootDir, "src-tauri", "Cargo.lock");
  if (!existsSync(lock)) return [];
  const cargoSrcBase = join(process.env.CARGO_HOME || join(homedir(), ".cargo"), "registry", "src");
  const srcRoots = existsSync(cargoSrcBase)
    ? readdirSync(cargoSrcBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(cargoSrcBase, d.name))
    : [];
  const crates = [];
  for (const block of readFileSync(lock, "utf8").replace(/\r\n/g, "\n").split(/\n\[\[package\]\]\n/).slice(1)) {
    const name = block.match(/^name = "(.+)"/m)?.[1];
    const version = block.match(/^version = "(.+)"/m)?.[1];
    if (name && version && name !== "vibesquad-desktop") {
      const lic = findCargoLicense(name, version, srcRoots);
      crates.push(lic ? `${name}@${version}  ${lic}` : `${name}@${version}`);
    }
  }
  return crates.sort();
}

function build() {
  const apache = readText(join(import.meta.dirname, "licenses", "Apache-2.0.txt"));
  const mit = readText(join(import.meta.dirname, "licenses", "MIT.txt"));
  const npm = collectNpm();
  const cargo = collectCargo();
  const bar = "=".repeat(78);
  const lines = [
    "VibeSquad - Third-Party Licenses",
    "",
    "VibeSquad works with Paseo. VibeSquad is licensed under the MIT License.",
    "This file lists the open-source software bundled with or required by VibeSquad.",
    "",
    bar,
    "Paseo (@getpaseo/client, @getpaseo/protocol) - Apache-2.0",
    "Copyright (c) 2025-present Mohamed Boudra",
    bar,
    "",
    bar,
    "Node.js LTS runtime (node.exe and npm) - MIT",
    "Copyright Node.js contributors. All rights reserved.",
    "Bundled in the VibeSquad desktop installer (runtime/). npm and its dependencies carry their own permissive licenses.",
    bar,
    "",
    bar,
    "Paseo CLI (@getpaseo/cli@0.14.0) - Apache-2.0",
    "Copyright (c) 2025-present Mohamed Boudra",
    "Not bundled: reused if already installed, otherwise downloaded from npm on first launch into a VibeSquad-managed folder.",
    bar,
    "",
    "Production npm packages",
    "-----------------------",
  ];
  for (const p of npm) lines.push(`${p.name}@${p.version}  ${p.license}${p.copyright ? `  ${p.copyright}` : ""}`);
  lines.push("", "Rust crates (src-tauri/Cargo.lock, desktop app only)", "----------------------------------------------------");
  lines.push(cargo.length ? cargo.join("\n") : "(none)");
  const notices = npm.filter((p) => p.notice);
  if (notices.length) {
    lines.push("", bar, "NOTICE files", bar);
    for (const p of notices) lines.push("", `--- ${p.name}@${p.version} ---`, p.notice);
  }
  lines.push("", bar, "Package license files", bar);
  for (const p of npm) if (p.licenseText) lines.push("", `--- ${p.name}@${p.version} (${p.license}) ---`, p.licenseText);
  lines.push("", bar, "Apache License 2.0 (full text)", bar, "", apache);
  lines.push("", bar, "MIT License (template text)", bar, "", mit, "");
  return lines.join("\n");
}

const text = build();
const targets = [join(rootDir, "public", "THIRD-PARTY-LICENSES.txt")];
mkdirSync(join(rootDir, "public"), { recursive: true });
writeFileSync(targets[0], text);
if (existsSync(join(rootDir, "dist"))) {
  copyFileSync(targets[0], join(rootDir, "dist", "THIRD-PARTY-LICENSES.txt"));
}
console.log(`[licenses] wrote ${targets[0]} (${text.length} bytes)`);
