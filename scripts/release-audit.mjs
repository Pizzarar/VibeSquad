#!/usr/bin/env node
// Automated part of the release security/privacy audit (B1-B8). Prints a markdown table; exits 1 on a
// Critical/High FAIL. Missing external tools are SKIP (never PASS). Matched secret/personal text is never
// printed: evidence carries file + line + pattern id only. Project-agnostic: everything comes from args.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { SECTIONS, setSection } from "../server/release.mjs";

// Built by concatenation so this file never matches its own sweep.
const SECRET_PATTERNS = [
  { id: "S1", re: new RegExp("BEGIN [A-Z ]*PRIVATE" + " KEY") },
  { id: "S2", re: new RegExp("store" + "pass", "i") },
  { id: "S3", re: new RegExp("pa" + "ss:") },
  { id: "S4", re: new RegExp("AZURE_CLIENT_" + "SECRET") },
  { id: "S5", re: new RegExp("sk" + "-[A-Za-z0-9]") },
];
const SELF_EXCLUDE = /(^|\/)(scripts\/release-audit\.mjs|test\/release-audit\.test\.mjs|package-lock\.json)$/;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const BINARY_EXT = /\.(exe|dll|node|png|jpe?g|gif|ico|woff2?|ttf|otf|mp[34]|webp|icns|pdf)$/i;
const MAX_FILE = 5 * 1024 * 1024;
const BENIGN_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org)|www\.w3\.org|json-schema\.org|schemas\.[a-z.]+)$/i;
const SEV_BLOCK = new Set(["Critical", "High"]);

export function parseArgs(argv) {
  const o = {};
  const map = { "--repo-root": "repoRoot", "--from": "from", "--commit": "commit", "--artifacts": "artifacts", "--record": "record", "--pubkey-config": "pubkeyConfig", "--personal-patterns": "personalPatterns" };
  for (let i = 0; i < argv.length; i++) {
    const key = map[argv[i]];
    if (!key) throw new Error(`Unknown argument: ${argv[i]}`);
    o[key] = argv[++i];
  }
  return o;
}

const row = (id, name, result, severity, evidence) => ({ id, name, result, severity, evidence });
const cap = (list, n = 8) => (list.length > n ? `${list.slice(0, n).join(", ")} (+${list.length - n} more)` : list.join(", "));
const fmtHits = (hits) => {
  const byId = {};
  for (const h of hits) (byId[h.id] ||= []).push(`${h.file}:${h.line}`);
  return Object.entries(byId).map(([id, locs]) => `${id}×${locs.length} [${cap(locs, 5)}]`).join("; ");
};

/** Scan text; returns hits with file/line/pattern id only (the matched value is never kept). */
export function sweepText(text, file, patterns) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].length > 4000 ? lines[i].slice(0, 4000) : lines[i];
    for (const p of patterns) if (p.re.test(line)) hits.push({ file, line: i + 1, id: p.id });
  }
  return hits;
}

/** Minimal zip reader (central directory + inflateRaw) so APKs can be swept without unzip/7z. */
export function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || usize > 20 * 1024 * 1024) continue;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
  }
  return out;
}

function loadPersonalPatterns(path, fs) {
  if (!path || !fs.existsSync(path)) return null;
  const pats = [];
  fs.readFileSync(path, "utf8").split(/\r?\n/).forEach((l) => {
    const t = l.trim();
    if (!t || t.startsWith("#")) return;
    try { pats.push({ id: `P${pats.length + 1}`, re: new RegExp(t, "i") }); } catch { /* skip bad regex, id stays stable-ish */ pats.push({ id: `P${pats.length + 1}`, re: /$^/ }); }
  });
  return pats;
}

function walk(dir, fs, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, fs, base, out);
    else if (st.size <= MAX_FILE && !BINARY_EXT.test(name)) out.push({ full, rel: relative(base, full).split(sep).join("/") });
  }
  return out;
}

function sweepDir(dir, fs, patterns, prefix = "") {
  const hits = [];
  for (const f of walk(dir, fs)) {
    if (SELF_EXCLUDE.test(f.rel)) continue;
    hits.push(...sweepText(fs.readFileSync(f.full).toString("latin1"), prefix + f.rel, patterns));
  }
  return hits;
}

/** Added lines of a unified diff: [{file, line, text}] (text is only used for heuristics, never printed raw). */
export function parseAddedLines(diff) {
  const out = [];
  let file = "";
  let ln = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
    else if (l.startsWith("@@")) ln = Number(/\+(\d+)/.exec(l)?.[1] || 0) - 1;
    else if (l.startsWith("+")) { ln++; out.push({ file, line: ln, text: l.slice(1) }); }
    else if (!l.startsWith("-")) ln++;
  }
  return out;
}

export function runAudit(opts, deps = {}) {
  const fs = { existsSync, readFileSync, readdirSync, statSync, ...deps.fs };
  const execRaw = deps.exec || ((cmd, args, o) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], shell: cmd === "npm" && process.platform === "win32", ...o }));
  const env = deps.env || process.env;
  const repoRoot = resolve(opts.repoRoot || ".");
  const { from } = opts;
  const commit = opts.commit || "HEAD";
  const artDir = opts.artifacts ? resolve(opts.artifacts) : null;
  const run = (cmd, args) => String(execRaw(cmd, args, { cwd: repoRoot }));
  const git = (...args) => run("git", args);
  const hasTool = (cmd, args = ["--version"]) => { try { execRaw(cmd, args, { cwd: repoRoot }); return true; } catch { return false; } };
  const checks = [];
  const range = from ? `${from}..${commit}` : null;
  const noFrom = (id, name) => row(id, name, "SKIP", "-", "no --from tag given, nothing to diff against");
  const diffAdded = () => parseAddedLines(git("diff", "-U0", "--no-color", range));
  const defaultPersonal = join(env.USERPROFILE || homedir(), ".vibesquad", "audit-personal.txt");
  const personal = loadPersonalPatterns(opts.personalPatterns || defaultPersonal, fs);
  const personalMissing = `personal sweep skipped: no pattern file (${opts.personalPatterns || "%USERPROFILE%/.vibesquad/audit-personal.txt"}; one regex per line)`;
  const allPatterns = [...SECRET_PATTERNS, ...(personal || [])];

  // B1
  try {
    const skipped = [];
    const hits = [];
    const files = git("ls-files", "-z").split("\0").filter(Boolean);
    for (const rel of files) {
      if (SELF_EXCLUDE.test(rel) || BINARY_EXT.test(rel) || /(^|\/)node_modules\//.test(rel)) continue;
      const full = join(repoRoot, rel);
      if (!fs.existsSync(full) || fs.statSync(full).size > MAX_FILE) continue;
      hits.push(...sweepText(fs.readFileSync(full).toString("latin1"), rel, SECRET_PATTERNS));
    }
    let diffHits = [];
    if (range) diffHits = parseAddedLines(git("diff", "-U0", "--no-color", range)).filter((a) => !SELF_EXCLUDE.test(a.file)).flatMap((a) => sweepText(a.text, a.file, SECRET_PATTERNS).map((h) => ({ ...h, line: a.line })));
    else skipped.push("diff sweep (no --from)");
    if (hasTool("gitleaks", ["version"])) {
      try { run("gitleaks", ["detect", "--no-banner", "--redact", ...(range ? [`--log-opts=${range}`] : [])]); } catch (e) { hits.push({ id: "GL", file: "gitleaks", line: 0, note: String(e.status ?? "") }); }
    } else skipped.push("gitleaks not installed (https://github.com/gitleaks/gitleaks#installing)");
    const all = [...hits, ...diffHits];
    if (all.length) checks.push(row("B1", "Secrets in diff + tree", "FAIL", "High", `${all.length} hit(s): ${fmtHits(all)}${skipped.length ? `; skipped: ${skipped.join("; ")}` : ""}`));
    else if (skipped.length) checks.push(row("B1", "Secrets in diff + tree", "SKIP", "-", `grep sweep clean over ${files.length} tracked files; partial, ${skipped.join("; ")}`));
    else checks.push(row("B1", "Secrets in diff + tree", "PASS", "-", `clean over ${files.length} tracked files`));
  } catch (e) { checks.push(row("B1", "Secrets in diff + tree", "SKIP", "-", `could not run: ${e.message}`)); }

  // B2
  if (!artDir || !fs.existsSync(artDir)) checks.push(row("B2", "Secrets/personal data in artifacts", "SKIP", "-", "no --artifacts dir"));
  else {
    const skipped = [];
    const hits = [];
    let scanned = 0;
    if (!personal) skipped.push(personalMissing);
    hits.push(...sweepDir(artDir, fs, allPatterns, "artifacts/"));
    const runtime = join(repoRoot, "src-tauri", "runtime");
    if (fs.existsSync(runtime)) hits.push(...sweepDir(runtime, fs, allPatterns, "runtime/"));
    else skipped.push("src-tauri/runtime not found");
    for (const name of fs.readdirSync(artDir)) {
      const full = join(artDir, name);
      if (/\.apk$/i.test(name)) {
        try {
          for (const ent of readZipEntries(fs.readFileSync(full))) { scanned++; hits.push(...sweepText(ent.data.toString("latin1"), `${name}!/${ent.name}`, allPatterns)); }
        } catch (e) { skipped.push(`${name}: ${e.message}`); }
      } else if (/\.(exe|msi)$/i.test(name)) {
        if (hasTool("7z", ["i"])) skipped.push(`${name}: 7z present but extraction not wired; sweep manually`);
        else skipped.push(`${name} contents not swept: 7z not installed (https://www.7-zip.org)`);
      }
    }
    const sec = hits.some((h) => h.id.startsWith("S"));
    const tail = skipped.length ? `; skipped: ${skipped.join("; ")}` : "";
    if (hits.length) checks.push(row("B2", "Secrets/personal data in artifacts", "FAIL", sec ? "High" : "Medium", `${hits.length} hit(s): ${fmtHits(hits)}${tail}`));
    else if (skipped.length) checks.push(row("B2", "Secrets/personal data in artifacts", "SKIP", "-", `no hits in what was swept (${scanned} APK entries + loose files + runtime); partial${tail}`));
    else checks.push(row("B2", "Secrets/personal data in artifacts", "PASS", "-", `clean (${scanned} APK entries + loose files + runtime)`));
  }

  // B3
  if (!range) checks.push(noFrom("B3", "Telemetry / PII"));
  else {
    try {
      const added = diffAdded().filter((a) => !SELF_EXCLUDE.test(a.file));
      let known = new Set();
      try { known = new Set(git("grep", "-hoE", "https?://[A-Za-z0-9.-]+", from).split("\n").map((u) => u.replace(/^https?:\/\//, "").toLowerCase())); } catch { /* no prior hosts */ }
      const fresh = new Map();
      for (const a of added) for (const m of a.text.matchAll(/https?:\/\/(?:[^\s/@"']*@)?([A-Za-z0-9.-]+)/g)) {
        const h = m[1].toLowerCase();
        if (!known.has(h) && !BENIGN_HOSTS.test(h)) (fresh.get(h) || fresh.set(h, []).get(h)).push(`${a.file}:${a.line}`);
      }
      const list = [...fresh].map(([h, locs]) => `${h} (${cap(locs, 2)})`);
      checks.push(fresh.size ? row("B3", "Telemetry / PII", "REVIEW", "Medium", `${fresh.size} new outbound host(s): ${cap(list, 6)}; push payload + vs log metrics need manual review`) : row("B3", "Telemetry / PII", "PASS", "-", "no new outbound hosts in diff; push payloads and vs log metrics are a manual check"));
    } catch (e) { checks.push(row("B3", "Telemetry / PII", "SKIP", "-", `could not diff: ${e.message}`)); }
  }

  // B4
  if (!range) checks.push(noFrom("B4", "Network exposure"));
  else {
    try {
      const added = diffAdded().filter((a) => /^(server|src|runner|cli)\//.test(a.file) && !SELF_EXCLUDE.test(a.file) && !/\.test\./.test(a.file));
      const wide = added.filter((a) => /(listen\(|host|bind|HOST).*0\.0\.0\.0/.test(a.text) || /0\.0\.0\.0.*(listen|host|bind)/i.test(a.text)).map((a) => `${a.file}:${a.line}`);
      const routes = added.filter((a) => /pathname\s*(===|!==|\.startsWith|\.match)|\.on\(\s*["']upgrade["']|\.(get|post|put|delete|patch)\(\s*["'`]\//.test(a.text)).map((a) => `${a.file}:${a.line}`);
      if (wide.length) checks.push(row("B4", "Network exposure", "FAIL", "High", `new 0.0.0.0 bind at ${cap(wide)}`));
      else if (routes.length) checks.push(row("B4", "Network exposure", "REVIEW", "Medium", `${routes.length} added route/upgrade line(s) to confirm go through authenticate + Origin check: ${cap(routes)}`));
      else checks.push(row("B4", "Network exposure", "PASS", "-", "no new 0.0.0.0 binds or route/upgrade handlers in diff"));
    } catch (e) { checks.push(row("B4", "Network exposure", "SKIP", "-", `could not diff: ${e.message}`)); }
  }

  // B5
  {
    const notes = [];
    let result = "PASS";
    let sev = "-";
    try {
      let out;
      try { out = run("npm", ["audit", "--omit=dev", "--json"]); } catch (e) { out = e?.stdout ? String(e.stdout) : ""; if (!out) throw e; }
      const v = JSON.parse(out).metadata?.vulnerabilities || {};
      const { critical = 0, high = 0, moderate = 0, low = 0 } = v;
      notes.push(`npm audit: critical ${critical}, high ${high}, moderate ${moderate}, low ${low}`);
      if (critical || high) { result = "FAIL"; sev = critical ? "Critical" : "High"; }
    } catch (e) { result = "SKIP"; notes.push(`npm audit unavailable (${String(e.message).split("\n")[0].slice(0, 80)}; offline?)`); }
    if (!hasTool("cargo", ["audit", "--version"])) { if (result === "PASS") result = "SKIP"; notes.push("cargo audit not installed (cargo install cargo-audit)"); }
    else { try { run("cargo", ["audit", "--file", "src-tauri/Cargo.lock"]); notes.push("cargo audit clean"); } catch { result = "FAIL"; sev = "High"; notes.push("cargo audit reported advisories"); } }
    notes.push("Gradle deps + license allowlist: manual");
    checks.push(row("B5", "Dependencies", result, sev, notes.join("; ")));
  }

  // B6
  if (!range) checks.push(noFrom("B6", "Permissions/capabilities"));
  else {
    try {
      const names = git("diff", "--name-only", range).split("\n").map((s) => s.trim()).filter(Boolean);
      const caps = names.filter((n) => /(^|\/)capabilities\/[^/]+\.json$/.test(n));
      const manifests = names.filter((n) => /AndroidManifest\.xml$/.test(n));
      const conf = names.filter((n) => /tauri\.conf\.json$/.test(n));
      const added = diffAdded();
      const bad = added.filter((a) => caps.includes(a.file) && (/"shell:(allow-)?(execute|spawn|open)"/.test(a.text) || /"\*"|\*\*/.test(a.text))).map((a) => `${a.file}:${a.line}`);
      const perms = added.filter((a) => manifests.includes(a.file) && /uses-permission/.test(a.text)).map((a) => /android:name="([^"]+)"/.exec(a.text)?.[1] || `${a.file}:${a.line}`);
      const csp = added.filter((a) => conf.includes(a.file) && /csp/i.test(a.text)).map((a) => `${a.file}:${a.line}`);
      if (bad.length) checks.push(row("B6", "Permissions/capabilities", "FAIL", "High", `shell/wildcard grant added at ${cap(bad)}`));
      else if (caps.length || perms.length || csp.length) checks.push(row("B6", "Permissions/capabilities", "REVIEW", "Medium", `changed: capabilities [${cap(caps)}]; new Android permissions [${cap(perms)}]; CSP lines [${cap(csp)}]`));
      else checks.push(row("B6", "Permissions/capabilities", "PASS", "-", "no capability, manifest permission or CSP changes in diff"));
    } catch (e) { checks.push(row("B6", "Permissions/capabilities", "SKIP", "-", `could not diff: ${e.message}`)); }
  }

  // B7
  {
    const notes = [];
    let fail = null;
    let skip = false;
    let review = false;
    const confPath = opts.pubkeyConfig ? resolve(repoRoot, opts.pubkeyConfig) : null;
    if (!confPath || !fs.existsSync(confPath)) { checks.push(row("B7", "Update + signing integrity", "SKIP", "-", "no --pubkey-config (tauri.conf.json)")); }
    else {
      const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
      const upd = conf.plugins?.updater || {};
      if (from) {
        try {
          const old = JSON.parse(git("show", `${from}:${relative(repoRoot, confPath).split(sep).join("/")}`));
          if ((old.plugins?.updater?.pubkey) === upd.pubkey) notes.push(`pubkey unchanged vs ${from}`);
          else fail = `updater pubkey differs from ${from}`;
        } catch (e) { skip = true; notes.push(`pubkey comparison skipped: ${String(e.message).split("\n")[0]}`); }
      } else { skip = true; notes.push("pubkey comparison skipped: no --from"); }
      const eps = upd.endpoints || [];
      const slugs = new Set();
      for (const ep of eps) { const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(ep); if (m) slugs.add(m[1]); else fail ||= "updater endpoint is not https://github.com/<owner>/<repo>/"; }
      if (slugs.size > 1) fail ||= "updater endpoints span several repos";
      if (!eps.length) { skip = true; notes.push("no endpoints configured"); } else notes.push(`${eps.length} endpoint(s) https/github.com`);
      const latest = artDir && fs.existsSync(join(artDir, "latest.json")) ? JSON.parse(fs.readFileSync(join(artDir, "latest.json"), "utf8")) : null;
      if (!latest) { skip = true; notes.push("latest.json not found in --artifacts"); }
      else {
        const sigs = fs.readdirSync(artDir).filter((n) => n.endsWith(".sig")).map((n) => fs.readFileSync(join(artDir, n), "utf8").trim());
        for (const [plat, p] of Object.entries(latest.platforms || {})) {
          if (!p.signature) { review = true; notes.push(`latest.json ${plat} has no signature field (not verifiable by the updater)`); }
          else if (!sigs.includes(String(p.signature).trim())) fail ||= `latest.json ${plat} signature does not equal any .sig file`;
          const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(p.url || "");
          if (!m || (slugs.size && !slugs.has(m[1]))) fail ||= `latest.json ${plat} url is not https on the updater repo`;
        }
        if (!fail) notes.push("latest.json signature(s) equal .sig; urls https on updater repo");
      }
      notes.push("minisign verify not implemented (manual: tauri signer / minisign -V)");
      checks.push(fail ? row("B7", "Update + signing integrity", "FAIL", "Critical", `${fail}; ${notes.join("; ")}`) : row("B7", "Update + signing integrity", skip ? "SKIP" : review ? "REVIEW" : "PASS", review ? "Medium" : "-", `${notes.join("; ")}${skip ? "; partial" : ""}`));
    }
  }

  // B8
  {
    const notes = [];
    let fail = null;
    let skip = false;
    const stampPath = join(repoRoot, "src-tauri", "runtime", "build-stamp.json");
    if (fs.existsSync(stampPath) && opts.commit) {
      const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8")).commit || "";
      if (stamp && (stamp.startsWith(opts.commit) || opts.commit.startsWith(stamp))) notes.push(`build-stamp ${stamp.slice(0, 10)} == commit`);
      else fail = `build-stamp commit ${stamp.slice(0, 10) || "(empty)"} != ${opts.commit.slice(0, 10)}`;
    } else { skip = true; notes.push("build-stamp or --commit missing"); }
    try {
      const dirty = git("status", "--porcelain").trim();
      if (dirty) fail ||= `tree not clean (${dirty.split("\n").length} entries)`; else notes.push("tree clean");
    } catch (e) { skip = true; notes.push(`git status failed: ${String(e.message).split("\n")[0]}`); }
    const versions = {};
    const readVer = (p, label) => { try { if (fs.existsSync(p)) versions[label] = JSON.parse(fs.readFileSync(p, "utf8")).version; } catch { /* ignore */ } };
    readVer(join(repoRoot, "package.json"), "package.json");
    if (opts.pubkeyConfig) readVer(resolve(repoRoot, opts.pubkeyConfig), "tauri.conf");
    if (artDir) readVer(join(artDir, "latest.json"), "latest.json");
    const distinct = new Set(Object.values(versions));
    if (distinct.size > 1) fail ||= `version mismatch ${JSON.stringify(versions)}`;
    else if (distinct.size === 1) notes.push(`version ${[...distinct][0]} in ${Object.keys(versions).join("/")}`);
    else { skip = true; notes.push("no versions found"); }
    if (artDir && fs.existsSync(artDir)) {
      const sums = fs.readdirSync(artDir).filter((n) => fs.statSync(join(artDir, n)).isFile()).map((n) => `${n}=${createHash("sha256").update(fs.readFileSync(join(artDir, n))).digest("hex")}`);
      notes.push(`SHA-256: ${sums.join(", ")}`);
    }
    checks.push(fail ? row("B8", "Provenance", "FAIL", "High", `${fail}; ${notes.join("; ")}`) : row("B8", "Provenance", skip ? "SKIP" : "PASS", "-", notes.join("; ")));
  }

  const exitCode = checks.some((c) => c.result === "FAIL" && SEV_BLOCK.has(c.severity)) ? 1 : 0;
  return { checks, table: formatTable(checks), exitCode };
}

export function formatTable(checks) {
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return ["| # | Check | Result | Severity | Evidence |", "| --- | --- | --- | --- | --- |", ...checks.map((c) => `| ${c.id} | ${esc(c.name)} | ${c.result} | ${c.severity} | ${esc(c.evidence)} |`)].join("\n");
}

/** Write the table into the `## Audit` section of a release record, leaving the rest untouched. */
export function recordAudit(recordPath, table, fs = { existsSync, readFileSync, writeFileSync }) {
  const text = fs.readFileSync(recordPath, "utf8");
  const next = text.includes(`${SECTIONS.audit}\n`) ? setSection(text, SECTIONS.audit, table) : `${text.replace(/\s*$/, "\n")}\n${SECTIONS.audit}\n\n${table}\n`;
  fs.writeFileSync(recordPath, next);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { table, exitCode } = runAudit(opts);
    console.log(table);
    if (opts.record) recordAudit(resolve(opts.record), table);
    process.exit(exitCode);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
