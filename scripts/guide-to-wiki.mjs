// Mirror guide/ into a flat GitHub-wiki tree. guide/ stays the single source; the wiki is a read-only copy.
// Usage: node scripts/guide-to-wiki.mjs --src guide --out <dir> [--tag <tag>] [--repo owner/name]
// - guide/README.md -> Home.md; other pages are flat: Concepts/Buddy.md -> Concepts-Buddy.md, Notebook/README.md -> Notebook-README.md.
// - Rewrites relative md links, #anchors, Obsidian [[wikilinks]] (|alias, #heading) and images (copied to assets/).
// - Links to skipped files or files outside guide/ become absolute GitHub URLs at the tag (or master).
// - Exits 1 and lists every link that points at nothing (the done-check).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";

// Root-only skips (matched on the path relative to guide/, so Setup/templates/AGENTS.md stays mirrored).
const SKIP_ROOT = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "LEAD_BRIEF.md"]);
const SKIP_DIRS = new Set(["source", "node_modules"]);
const SKIP_EXT = new Set([".py", ".json"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const srcDir = resolve(opt("src", "guide"));
const outDir = resolve(opt("out", ""));
if (!argv.includes("--out")) {
  console.error("usage: node scripts/guide-to-wiki.mjs --src guide --out <dir> [--tag <tag>] [--repo owner/name]");
  process.exit(2);
}
// Safety: this script only ever writes into --out; refuse anything that is cwd, the source, the repo, or an ancestor of them.
const isAncestorOrSame = (a, b) => {
  const r = relative(a, b);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
if (isAncestorOrSame(srcDir, outDir)) {
  console.error(`refusing --out ${outDir}: it is inside the source ${srcDir}`);
  process.exit(2);
}
for (const keep of [process.cwd(), srcDir, resolve(srcDir, "..")]) {
  if (isAncestorOrSame(outDir, keep)) {
    console.error(`refusing --out ${outDir}: it is or contains ${keep}`);
    process.exit(2);
  }
}
const tag = opt("tag", "");
const ref = tag || "master";
const repo = opt("repo", process.env.GITHUB_REPOSITORY || "Pizzarar/VibeSquad");
const repoRoot = resolve(srcDir, "..");
const srcRel = relative(repoRoot, srcDir).split("\\").join("/") || "guide";
const ghBase = `https://github.com/${repo}`;

// ---- collect ----
const toPosix = (p) => p.split("\\").join("/");
const pages = new Map(); // rel path (posix, from srcDir) -> page name
const images = new Map(); // rel path -> asset file name
const skipped = new Set(); // rel paths that exist but are not mirrored

function skipDir(name) {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const rel = toPosix(relative(srcDir, full));
    if (entry.isDirectory()) {
      if (!skipDir(entry.name)) walk(full);
      continue;
    }
    const ext = extname(entry.name).toLowerCase();
    // Notebook/ is private; only its README is shared (matches guide/.gitignore).
    const privateNote = rel.startsWith("Notebook/") && rel !== "Notebook/README.md";
    if (entry.name.startsWith(".") || SKIP_ROOT.has(rel) || SKIP_EXT.has(ext) || privateNote) {
      skipped.add(rel);
    } else if (ext === ".md") {
      pages.set(rel, pageName(rel));
    } else if (IMAGE_EXT.has(ext)) {
      images.set(rel, rel.replace(/\//g, "-").replace(/\s+/g, "-"));
    } else {
      skipped.add(rel);
    }
  }
}
function pageName(rel) {
  if (rel === "README.md") return "Home";
  return rel.replace(/\.md$/i, "").replace(/\//g, "-").replace(/\s+/g, "-");
}
walk(srcDir);

const seen = new Map();
for (const [rel, name] of pages) {
  const key = name.toLowerCase();
  if (seen.has(key)) {
    console.error(`page name collision: ${rel} and ${seen.get(key)} both map to ${name}`);
    process.exit(1);
  }
  seen.set(key, rel);
}
const byBase = new Map(); // Obsidian wikilink lookup: lowercase basename -> rel
for (const rel of pages.keys()) {
  const key = basename(rel, ".md").toLowerCase();
  if (!byBase.has(key) || rel.split("/").length < byBase.get(key).split("/").length) byBase.set(key, rel);
}

// ---- link rewriting ----
const unresolved = [];
const stats = { pages: 0, links: 0, wikilinks: 0, images: 0, external: 0, github: 0 };

const slugHeading = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

function ghUrl(repoPath, isDir) {
  return `${ghBase}/${isDir ? "tree" : "blob"}/${ref}/${repoPath.split("/").map(encodeURIComponent).join("/")}`;
}

function resolveTarget(fromRel, rawPath, anchor, isImage, where) {
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {}
  const fromDir = posix.dirname(fromRel);
  const guideRel = posix.normalize(posix.join(fromDir, decoded)); // relative to guide/, may start with ../
  const repoPath = posix.normalize(posix.join(srcRel, guideRel));
  const candidates = [guideRel, `${guideRel}.md`];
  for (const c of candidates) {
    if (pages.has(c)) return pageName(c) + anchor;
    if (images.has(c)) return `assets/${images.get(c)}`;
  }
  // exists but not mirrored (skipped file, outside guide/, or a directory) -> GitHub URL
  const abs = resolve(repoRoot, repoPath);
  if (!repoPath.startsWith("..") && existsSync(abs)) {
    stats.github++;
    return ghUrl(repoPath, statSync(abs).isDirectory()) + anchor;
  }
  unresolved.push(`${fromRel}: ${where} -> ${rawPath}`);
  return null;
}

const LINK_RE = /(!?)\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?)\s*\)/g;
const WIKI_RE = /(!?)\[\[([^\]\n]+)\]\]/g;

function rewriteSegment(seg, fromRel) {
  seg = seg.replace(LINK_RE, (m, bang, text, target, title) => {
    const t = target.startsWith("<") ? target.slice(1, -1) : target;
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(t)) {
      stats.external++;
      return m;
    }
    const hash = t.indexOf("#");
    const path = hash >= 0 ? t.slice(0, hash) : t;
    const anchor = hash >= 0 ? t.slice(hash) : "";
    if (!path) return m; // same-page anchor
    const out = resolveTarget(fromRel, path, anchor, bang === "!", m);
    if (out === null) return m;
    stats[bang ? "images" : "links"]++;
    return `${bang}[${text}](${out}${title})`;
  });
  return seg.replace(WIKI_RE, (m, bang, inner) => {
    const [targetPart, ...aliasParts] = inner.split("|");
    const alias = aliasParts.join("|").trim();
    const hash = targetPart.indexOf("#");
    const name = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const heading = hash >= 0 ? targetPart.slice(hash + 1).trim() : "";
    let rel;
    if (!name) {
      return `[${alias || heading}](#${slugHeading(heading)})`;
    }
    const lower = name.toLowerCase().replace(/\.md$/, "");
    rel = byBase.get(lower);
    if (!rel) {
      const img = [...images.keys()].find((k) => basename(k).toLowerCase() === name.toLowerCase());
      if (img) {
        stats.images++;
        return `![${alias || name}](assets/${images.get(img)})`;
      }
      const pathHit = [...pages.keys()].find((k) => k.toLowerCase().replace(/\.md$/, "") === lower);
      rel = pathHit;
    }
    if (!rel) {
      unresolved.push(`${fromRel}: wikilink -> ${m}`);
      return m;
    }
    stats.wikilinks++;
    const label = alias || (heading ? `${name} > ${heading}` : name);
    return `${bang ? "" : ""}[${label}](${pages.get(rel)}${heading ? `#${slugHeading(heading)}` : ""})`;
  });
}

function rewriteMarkdown(text, fromRel) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        return line;
      }
      if (fence) return line;
      // leave inline code spans alone
      return line
        .split(/(`+[^`]*`+)/)
        .map((seg, i) => (i % 2 ? seg : rewriteSegment(seg, fromRel)))
        .join("");
    })
    .join("\n");
}

// ---- emit ----
const titleOf = (rel) => {
  const h1 = readFileSync(join(srcDir, rel), "utf8").match(/^#\s+(.+?)\s*$/m);
  return (h1 ? h1[1] : basename(rel, ".md")).replace(/[\[\]]/g, "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
};

mkdirSync(outDir, { recursive: true });
const footer =
  `\n\n---\n_Mirrored from [${srcRel}/](${ghBase}/tree/${ref}/${srcRel}) at ${tag || "master"}; edit there, not here._\n`;
for (const [rel, name] of pages) {
  const body = rewriteMarkdown(readFileSync(join(srcDir, rel), "utf8").replace(/\r\n/g, "\n"), rel);
  const dest = join(outDir, `${name}.md`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body.replace(/\s+$/, "") + footer);
  stats.pages++;
}
if (images.size) mkdirSync(join(outDir, "assets"), { recursive: true });
for (const [rel, name] of images) copyFileSync(join(srcDir, rel), join(outDir, "assets", name));

// _Sidebar.md: Home, then one section per top-level folder (nested folders indent).
const tree = new Map(); // folder path -> [page rels]
for (const rel of pages.keys()) {
  if (rel === "README.md") continue;
  const dir = posix.dirname(rel);
  if (!tree.has(dir)) tree.set(dir, []);
  tree.get(dir).push(rel);
}
const sidebar = ["**[Home](Home)**", ""];
const rootPages = tree.get(".") || [];
for (const rel of rootPages) sidebar.push(`- [${titleOf(rel)}](${pages.get(rel)})`);
if (rootPages.length) sidebar.push("");
const folders = [...tree.keys()].filter((d) => d !== ".").sort();
let lastTop = "";
for (const dir of folders) {
  const parts = dir.split("/");
  if (parts[0] !== lastTop) {
    if (lastTop) sidebar.push("");
    sidebar.push(`**${parts[0]}**`, "");
    lastTop = parts[0];
  }
  const indent = "  ".repeat(Math.max(0, parts.length - 1));
  if (parts.length > 1) sidebar.push(`${indent.slice(2)}- ${parts.slice(1).join("/")}`);
  for (const rel of tree.get(dir).sort((a, b) => {
    const ra = /README\.md$/i.test(a) ? 0 : 1;
    const rb = /README\.md$/i.test(b) ? 0 : 1;
    return ra - rb || a.localeCompare(b);
  })) {
    sidebar.push(`${indent}- [${titleOf(rel)}](${pages.get(rel)})`);
  }
}
sidebar.push("", `_Mirrored from [${srcRel}/](${ghBase}/tree/${ref}/${srcRel}) at ${tag || "master"}._`);
writeFileSync(join(outDir, "_Sidebar.md"), sidebar.join("\n") + "\n");

console.log(
  `guide-to-wiki: ${stats.pages} pages, ${stats.links} links + ${stats.wikilinks} wikilinks rewritten, ` +
    `${stats.images} image refs (${images.size} images copied), ${stats.github} GitHub URLs, ` +
    `${skipped.size} files skipped, unresolved=${unresolved.length}`,
);
if (unresolved.length) {
  console.error(`\n${unresolved.length} unresolved link(s):`);
  for (const u of unresolved) console.error(`  ${u}`);
  process.exit(1);
}
