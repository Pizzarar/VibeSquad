import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, posix, relative, resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GUIDE_DIR = join(REPO_ROOT, "guide");

const SKIP_ROOT = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "LEAD_BRIEF.md"]);
const SKIP_DIRS = new Set(["source", "node_modules"]);
const SKIP_EXT = new Set([".py", ".json"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const LINK_RE = /(!?)\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?)\s*\)/g;
const WIKI_RE = /(!?)\[\[([^\]\n]+)\]\]/g;

const toPosix = (p) => p.split("\\").join("/");
const pageName = (rel) => (rel === "README.md" ? "Home" : rel.replace(/\.md$/i, "").replace(/\//g, "-").replace(/\s+/g, "-"));
const slugHeading = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

function parseMarkdownFile(absPath) {
  const text = readFileSync(absPath, "utf8").replace(/\r\n/g, "\n");
  const slugs = new Map(); // slug -> first lineNo
  const duplicateSlugs = [];
  const nonCodeLines = [];
  let fence = null;
  text.split("\n").forEach((line, idx) => {
    const lineNo = idx + 1;
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const hm = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (hm) {
      const slug = slugHeading(hm[1]);
      if (slugs.has(slug)) {
        duplicateSlugs.push({ slug, lineNo, firstLine: slugs.get(slug) });
      } else {
        slugs.set(slug, lineNo);
      }
    }
    const stripped = line
      .split(/(`+[^`]*`+)/)
      .map((seg, i) => (i % 2 ? "" : seg))
      .join("");
    nonCodeLines.push({ lineNo, stripped });
  });
  return { slugs, duplicateSlugs, nonCodeLines };
}

function auditGuideTree(srcDir, repoRoot = resolve(srcDir, "..")) {
  const pages = new Map();
  const images = new Map();
  const allMd = [];

  function walk(dir, inSkippedDir = false) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = toPosix(relative(srcDir, full));
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full, inSkippedDir || SKIP_DIRS.has(entry.name));
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".md") allMd.push(rel);
      if (inSkippedDir) continue;
      const privateNote = rel.startsWith("Notebook/") && rel !== "Notebook/README.md";
      if (SKIP_ROOT.has(rel) || SKIP_EXT.has(ext) || privateNote) continue;
      if (ext === ".md") {
        pages.set(rel, pageName(rel));
      } else if (IMAGE_EXT.has(ext)) {
        images.set(rel, rel.replace(/\//g, "-").replace(/\s+/g, "-"));
      }
    }
  }
  walk(srcDir);

  const collisions = [];
  const seenPages = new Map();
  for (const [rel, name] of pages) {
    const key = name.toLowerCase();
    if (seenPages.has(key)) {
      collisions.push(`page slug collision: ${rel} and ${seenPages.get(key)} both map to ${name}`);
    } else {
      seenPages.set(key, rel);
    }
  }
  const seenAssets = new Map();
  for (const [rel, name] of images) {
    const key = name.toLowerCase();
    if (seenAssets.has(key)) {
      collisions.push(`asset slug collision: ${rel} and ${seenAssets.get(key)} both map to ${name}`);
    } else {
      seenAssets.set(key, rel);
    }
  }
  const byBase = new Map();
  const baseDepth = new Map();
  for (const rel of pages.keys()) {
    const key = basename(rel, ".md").toLowerCase();
    const depth = rel.split("/").length;
    if (!byBase.has(key) || depth < baseDepth.get(key)) {
      byBase.set(key, rel);
      baseDepth.set(key, depth);
    } else if (depth === baseDepth.get(key) && key !== "readme") {
      collisions.push(`wikilink basename collision: ${rel} and ${byBase.get(key)} both match [[${key}]]`);
    }
  }

  const parsedByRel = new Map();
  for (const rel of allMd) {
    const parsed = parseMarkdownFile(join(srcDir, rel));
    parsedByRel.set(rel, parsed);
    for (const dup of parsed.duplicateSlugs) {
      collisions.push(`${rel}:${dup.lineNo} duplicate heading slug #${dup.slug} (first at line ${dup.firstLine})`);
    }
  }

  const unresolved = [];
  const brokenAnchors = [];
  const linksByFile = new Map();

  function resolveMdPath(fromRel, rawPath) {
    let decoded = rawPath;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {}
    const guideRel = posix.normalize(posix.join(posix.dirname(fromRel), decoded));
    for (const c of [guideRel, `${guideRel}.md`]) {
      if (parsedByRel.has(c)) return { kind: "md", rel: c };
      if (images.has(c) || existsSync(join(srcDir, c))) return { kind: "file", rel: c };
    }
    const srcRel = toPosix(relative(repoRoot, srcDir)) || "guide";
    const repoPath = posix.normalize(posix.join(srcRel, guideRel));
    if (!repoPath.startsWith("..") && existsSync( resolve(repoRoot, repoPath) )) {
      return { kind: "repo", rel: repoPath };
    }
    return null;
  }

  for (const [rel, parsed] of parsedByRel) {
    const fileLinks = [];
    linksByFile.set(rel, fileLinks);
    for (const { lineNo, stripped } of parsed.nonCodeLines) {
      for (const m of stripped.matchAll(LINK_RE)) {
        const [, bang, , rawTarget] = m;
        const t = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
        if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(t)) continue;
        const hash = t.indexOf("#");
        const pathPart = hash >= 0 ? t.slice(0, hash) : t;
        const hasAnchor = hash >= 0;
        const anchor = hasAnchor ? t.slice(hash + 1) : "";
        fileLinks.push({ lineNo, target: t, pathPart, anchor, isImage: bang === "!" });

        let targetRel = rel;
        if (pathPart) {
          const resolved = resolveMdPath(rel, pathPart);
          if (!resolved) {
            unresolved.push(`${rel}:${lineNo} -> ${t}`);
            continue;
          }
          if (hasAnchor && resolved.kind !== "md") {
            brokenAnchors.push(`${rel}:${lineNo} -> ${t} (anchor on non-markdown target ${resolved.rel})`);
            continue;
          }
          targetRel = resolved.rel;
        }
        if (hasAnchor) {
          let decodedAnchor = anchor.toLowerCase();
          try {
            decodedAnchor = decodeURIComponent(anchor).toLowerCase();
          } catch {}
          const targetParsed = parsedByRel.get(targetRel);
          if (!decodedAnchor || !targetParsed || !targetParsed.slugs.has(decodedAnchor)) {
            brokenAnchors.push(`${rel}:${lineNo} -> ${t} (missing #${anchor} in ${targetRel})`);
          }
        }
      }

      // Check cross-doc quoted heading references paired with a markdown link:
      // e.g. `Details: [Settings](../../../Reference/Settings.md), "Update channel"`
      // or `See "Try with your agent" in [inkscape-laser](inkscape-laser.md)`
      const crossHeadingPatterns = [
        /\[[^\]]+\]\(\s*([^)\s#]+)\s*\)\s*,\s*"([^"]+)"/g,
        /\b[Ss]ee\s+"([^"]+)"\s+in\s+\[[^\]]+\]\(\s*([^)\s#]+)\s*\)/g,
      ];
      for (const [patIdx, pat] of crossHeadingPatterns.entries()) {
        for (const cm of stripped.matchAll(pat)) {
          const rawPath = patIdx === 0 ? cm[1] : cm[2];
          const headingText = patIdx === 0 ? cm[2] : cm[1];
          if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(rawPath)) continue;
          const resolved = resolveMdPath(rel, rawPath);
          if (!resolved || resolved.kind !== "md") continue;
          const targetParsed = parsedByRel.get(resolved.rel);
          const wantedSlug = slugHeading(headingText);
          const matches = [...targetParsed.slugs.keys()].some((s) => s === wantedSlug || s.startsWith(`${wantedSlug}-`));
          if (!matches) {
            brokenAnchors.push(`${rel}:${lineNo} -> "${headingText}" in ${resolved.rel} (missing heading #${wantedSlug})`);
          }
        }
      }

      for (const m of stripped.matchAll(WIKI_RE)) {
        const [full, , inner] = m;
        const [targetPart] = inner.split("|");
        const hash = targetPart.indexOf("#");
        const name = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
        const hasAnchor = hash >= 0;
        const heading = hasAnchor ? targetPart.slice(hash + 1).trim() : "";
        fileLinks.push({ lineNo, target: full, pathPart: name, anchor: heading, wikilink: true });

        let targetRel = rel;
        if (name) {
          const lower = name.toLowerCase().replace(/\.md$/, "");
          targetRel =
            byBase.get(lower) ||
            [...pages.keys()].find((k) => k.toLowerCase().replace(/\.md$/, "") === lower);
          if (!targetRel) {
            const img = [...images.keys()].find((k) => basename(k).toLowerCase() === name.toLowerCase());
            if (img && !hasAnchor) continue;
            unresolved.push(`${rel}:${lineNo} -> ${full}`);
            continue;
          }
        }
        if (hasAnchor) {
          const slug = slugHeading(heading);
          const targetParsed = parsedByRel.get(targetRel);
          if (!slug || !targetParsed || !targetParsed.slugs.has(slug)) {
            brokenAnchors.push(`${rel}:${lineNo} -> ${full} (missing #${slug} in ${targetRel})`);
          }
        }
      }
    }
  }

  return { pages, images, unresolved, brokenAnchors, collisions, linksByFile, parsedByRel };
}

test("guide-to-wiki mirrors guide/ with 0 unresolved links", () => {
  const out = mkdtempSync(join(tmpdir(), "vs-wiki-"));
  try {
    const r = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "guide-to-wiki.mjs"), "--src", GUIDE_DIR, "--out", out, "--tag", "v0.0.0-test"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /unresolved=0/);
    assert.ok(existsSync(join(out, "Home.md")));
    assert.ok(existsSync(join(out, "_Sidebar.md")));
    assert.ok(readdirSync(join(out, "assets")).some((f) => f.endsWith(".png")));

    const wikiFiles = readdirSync(out).filter((f) => f.endsWith(".md"));
    const wikiParsed = new Map(wikiFiles.map((f) => [f.replace(/\.md$/, ""), parseMarkdownFile(join(out, f))]));
    for (const [page, parsed] of wikiParsed) {
      for (const { lineNo, stripped } of parsed.nonCodeLines) {
        assert.equal([...stripped.matchAll(WIKI_RE)].length, 0, `${page}.md:${lineNo} has unrewritten wikilink`);
        for (const m of stripped.matchAll(LINK_RE)) {
          const [, bang, , rawTarget] = m;
          const t = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
          if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(t)) continue;
          const hash = t.indexOf("#");
          const pathPart = hash >= 0 ? t.slice(0, hash) : t;
          const anchor = hash >= 0 ? t.slice(hash + 1).toLowerCase() : "";
          if (bang === "!") {
            assert.ok(existsSync(join(out, pathPart)), `${page}.md:${lineNo} missing image ${pathPart}`);
            continue;
          }
          const targetPage = pathPart || page;
          assert.ok(wikiParsed.has(targetPage), `${page}.md:${lineNo} missing wiki page ${targetPage}`);
          if (hash >= 0) {
            assert.ok(
              anchor && wikiParsed.get(targetPage).slugs.has(anchor),
              `${page}.md:${lineNo} missing anchor #${anchor} in ${targetPage}.md`,
            );
          }
        }
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("guide/ link targets, #anchors and slug collisions pass (including Reference/Settings.md)", () => {
  const report = auditGuideTree(GUIDE_DIR, REPO_ROOT);
  assert.deepEqual(report.unresolved, []);
  assert.deepEqual(report.brokenAnchors, []);
  assert.deepEqual(report.collisions, []);

  const settingsLinks = report.linksByFile.get("Reference/Settings.md") ?? [];
  assert.ok(settingsLinks.length >= 4, "expected internal links in guide/Reference/Settings.md");
  const settingsSlugs = report.parsedByRel.get("Reference/Settings.md")?.slugs;
  assert.ok(settingsSlugs?.has("update-channel"));
  assert.ok(settingsSlugs?.has("unstick-vibesquad-and-restart-runner"));
  assert.ok(settingsSlugs?.has("runner--providers"));
  assert.ok(settingsSlugs?.has("remote-control"));
});

test("guide audit catches broken link targets, bad #anchors and slug collisions", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vs-wiki-audit-"));
  try {
    mkdirSync(join(tmp, "Sub"), { recursive: true });
    writeFileSync(
      join(tmp, "README.md"),
      [
        "# Home",
        "## Intro",
        "## Intro",
        "Good [sub](Sub/Page.md#valid-section) and [self](#intro).",
        "Broken [target](Sub/Missing.md), [same](#no-such-anchor), [cross](Sub/Page.md#wrong-anchor), [[Page#Missing wiki heading]].",
        'Cross-doc text: Details: [Page](Sub/Page.md), "Removed section".',
      ].join("\n"),
    );
    writeFileSync(join(tmp, "Sub", "Page.md"), "# Page\n## Valid section\n");
    writeFileSync(join(tmp, "Sub-Page.md"), "# Colliding page\n");

    const report = auditGuideTree(tmp, tmp);
    assert.ok(report.unresolved.some((u) => u.includes("Sub/Missing.md")), `expected missing target in ${JSON.stringify(report.unresolved)}`);
    assert.ok(report.brokenAnchors.some((a) => a.includes("#no-such-anchor")), `expected same-page anchor failure in ${JSON.stringify(report.brokenAnchors)}`);
    assert.ok(report.brokenAnchors.some((a) => a.includes("Sub/Page.md#wrong-anchor")), `expected cross-page anchor failure in ${JSON.stringify(report.brokenAnchors)}`);
    assert.ok(report.brokenAnchors.some((a) => a.includes("[[Page#Missing wiki heading]]")), `expected wikilink anchor failure in ${JSON.stringify(report.brokenAnchors)}`);
    assert.ok(report.brokenAnchors.some((a) => a.includes('"Removed section"')), `expected cross-doc heading failure in ${JSON.stringify(report.brokenAnchors)}`);
    assert.ok(report.collisions.some((c) => c.includes("page slug collision") && c.includes("Sub-Page")), `expected page slug collision in ${JSON.stringify(report.collisions)}`);
    assert.ok(report.collisions.some((c) => c.includes("duplicate heading slug #intro")), `expected duplicate heading collision in ${JSON.stringify(report.collisions)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("guide-to-wiki refuses an --out that contains the source", () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "guide-to-wiki.mjs"), "--src", join(REPO_ROOT, "guide"), "--out", REPO_ROOT], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.ok(existsSync(join(REPO_ROOT, "guide", "README.md")));
});

test("guide-to-wiki refuses an --out inside the source", () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "guide-to-wiki.mjs"), "--src", join(REPO_ROOT, "guide"), "--out", join(REPO_ROOT, "guide", "wiki-out")], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.ok(!existsSync(join(REPO_ROOT, "guide", "wiki-out")));
});
