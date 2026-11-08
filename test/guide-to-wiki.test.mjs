import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import test from "node:test";
import { LINK_RE, WIKI_RE, collectGuide, resolveWikilink, slugHeading, toPosix } from "../scripts/guide-to-wiki.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GUIDE_DIR = join(REPO_ROOT, "guide");

function parseMarkdownFile(absPath) {
  const text = readFileSync(absPath, "utf8").replace(/\r\n/g, "\n");
  const slugs = new Map(); // slug -> lineNo
  const baseCounts = new Map(); // baseSlug -> count
  const ambiguousSlugs = new Set(); // baseSlugs that appeared >1 time
  const nonCodeLines = [];
  let fence = null;
  const addSlug = (base, lineNo) => {
    if (!base) return;
    const n = baseCounts.get(base) ?? 0;
    baseCounts.set(base, n + 1);
    if (n === 0) slugs.set(base, lineNo);
    else {
      ambiguousSlugs.add(base);
      slugs.set(`${base}-${n}`, lineNo);
    }
  };
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
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
      addSlug(slugHeading(hm[1]), lineNo);
    } else if (/^\s*(=+|-+)\s*$/.test(line) && nonCodeLines.length > 0 && nonCodeLines.at(-1).lineNo === lineNo - 1) {
      const prev = nonCodeLines.at(-1).stripped.trim();
      if (prev && !/^([-*+]|\d+\.|>|#|\|)/.test(prev)) addSlug(slugHeading(prev), lineNo - 1);
    }
    const stripped = line
      .split(/(`+[^`]*`+)/)
      .map((seg, i) => (i % 2 ? "" : seg))
      .join("");
    for (const tag of stripped.matchAll(/<[a-z][^>]*>/gi)) {
      for (const attr of tag[0].matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
        slugs.set(attr[1].trim().toLowerCase(), lineNo);
      }
    }
    nonCodeLines.push({ lineNo, stripped });
  });
  return { slugs, ambiguousSlugs, nonCodeLines };
}

function auditGuideTree(srcDir, repoRoot = resolve(srcDir, "..")) {
  const { pages, images, allMd, byBase, collisions, ambiguousBases } = collectGuide(srcDir);
  for (const [key, rels] of ambiguousBases) {
    collisions.push(`wikilink basename collision: ${rels.join(" and ")} both match [[${key}]]`);
  }
  const parsedByRel = new Map(allMd.map((rel) => [rel, parseMarkdownFile(join(srcDir, rel))]));
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
    if (!repoPath.startsWith("..") && existsSync(resolve(repoRoot, repoPath))) {
      return { kind: "repo", rel: repoPath };
    }
    return null;
  }

  const checkAnchor = (fromRel, lineNo, rawRef, targetRel, rawAnchor) => {
    let slug = rawAnchor.toLowerCase();
    try {
      slug = decodeURIComponent(rawAnchor).toLowerCase();
    } catch {}
    const targetParsed = parsedByRel.get(targetRel);
    if (!slug || !targetParsed || !targetParsed.slugs.has(slug)) {
      brokenAnchors.push(`${fromRel}:${lineNo} -> ${rawRef} (missing #${rawAnchor} in ${targetRel})`);
    } else if (targetParsed.ambiguousSlugs.has(slug)) {
      collisions.push(`${fromRel}:${lineNo} ambiguous heading slug #${slug} in ${targetRel}`);
    }
  };

  for (const [rel, parsed] of parsedByRel) {
    const fileLinks = [];
    linksByFile.set(rel, fileLinks);
    for (const { lineNo, stripped } of parsed.nonCodeLines) {
      for (const m of stripped.matchAll(LINK_RE)) {
        const rawTarget = m[3];
        const t = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
        if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(t)) continue;
        const hash = t.indexOf("#");
        const pathPart = hash >= 0 ? t.slice(0, hash) : t;
        const hasAnchor = hash >= 0;
        const anchor = hasAnchor ? t.slice(hash + 1) : "";
        fileLinks.push({ lineNo, target: t, pathPart, anchor });

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
        if (hasAnchor) checkAnchor(rel, lineNo, t, targetRel, anchor);
      }

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
          const slugRe = new RegExp(`^${wantedSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d+)?$`);
          if (![...targetParsed.slugs.keys()].some((s) => slugRe.test(s))) {
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
          const hit = resolveWikilink(name, pages, images, byBase, ambiguousBases);
          if (hit?.kind === "image" && !hasAnchor) continue;
          if (hit?.kind !== "page") {
            unresolved.push(`${rel}:${lineNo} -> ${full}`);
            continue;
          }
          targetRel = hit.rel;
        }
        if (hasAnchor) checkAnchor(rel, lineNo, full, targetRel, slugHeading(heading));
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
        "# Home ##",
        "## [Intro](https://example.com) _one_",
        "## Intro _one_",
        "Setext Heading",
        "--------------",
        '<a id="custom-html-anchor"></a>',
        "Good [sub](Sub/Page.md#valid-section), [dedup](#intro-_one_-1), [setext](#setext-heading), [html](#custom-html-anchor) and [ambig](#intro-_one_).",
        "Broken [target](Sub/Missing.md), [same](#no-such-anchor), [cross](Sub/Page.md#wrong-anchor), [[Page#Missing wiki heading]].",
        'Cross-doc text: Details: [Page](Sub/Page.md), "Valid".',
      ].join("\n"),
    );
    writeFileSync(join(tmp, "Sub", "Page.md"), "# Page\n## Valid section\n");
    writeFileSync(join(tmp, "Sub-Page.md"), "# Colliding page\n");

    const report = auditGuideTree(tmp, tmp);
    assert.ok(report.unresolved.some((u) => u.includes("Sub/Missing.md")), `expected missing target in ${JSON.stringify(report.unresolved)}`);
    assert.ok(report.brokenAnchors.some((a) => a.includes("#no-such-anchor")), `expected same-page anchor failure in ${JSON.stringify(report.brokenAnchors)}`);
    assert.ok(report.brokenAnchors.some((a) => a.includes("Sub/Page.md#wrong-anchor")), `expected cross-page anchor failure in ${JSON.stringify(report.brokenAnchors)}`);
    assert.ok(report.brokenAnchors.some((a) => a.includes("[[Page#Missing wiki heading]]")), `expected wikilink anchor failure in ${JSON.stringify(report.brokenAnchors)}`);
    assert.ok(report.brokenAnchors.some((a) => a.includes('"Valid"')), `expected prefix-only cross-doc heading failure in ${JSON.stringify(report.brokenAnchors)}`);
    assert.ok(!report.brokenAnchors.some((a) => a.includes("#intro-_one_-1") || a.includes("#setext-heading") || a.includes("#custom-html-anchor")));
    assert.ok(report.collisions.some((c) => c.includes("page name collision") && c.includes("Sub-Page")), `expected page slug collision in ${JSON.stringify(report.collisions)}`);
    assert.ok(report.collisions.some((c) => c.includes("ambiguous heading slug #intro-_one_")), `expected ambiguous heading collision in ${JSON.stringify(report.collisions)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("guide-to-wiki refuses an --out that contains the source", () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "guide-to-wiki.mjs"), "--src", GUIDE_DIR, "--out", REPO_ROOT], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.ok(existsSync(join(GUIDE_DIR, "README.md")));
});

test("guide-to-wiki refuses an --out inside the source", () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "guide-to-wiki.mjs"), "--src", GUIDE_DIR, "--out", join(GUIDE_DIR, "wiki-out")], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.ok(!existsSync(join(GUIDE_DIR, "wiki-out")));
});
