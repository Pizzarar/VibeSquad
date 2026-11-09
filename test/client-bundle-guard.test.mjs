import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const BANNED = new Set(["file-lock.mjs", "teams-file.mjs", "bug-lane-backfill.mjs", "identity.mjs"]);
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|mjs|jsx?)$/.test(e.name) ? [path.join(dir, e.name)] : []);

test("src/ never imports fs/lock-touching server modules (blank-app SharedArrayBuffer regression)", () => {
  const bad = [];
  for (const f of walk(path.join(root, "src"))) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
      if (/server\//.test(m[1]) && BANNED.has(path.basename(m[1]))) bad.push(`${path.relative(root, f)} -> ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("server modules reachable from src/ stay pure (no node:/lock imports)", () => {
  const seen = new Set();
  const stack = walk(path.join(root, "src"));
  const bad = [];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of fs.readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
      if (!m[1].startsWith(".")) continue;
      const t = path.resolve(path.dirname(f), m[1]);
      if (!t.startsWith(path.join(root, "server")) || !fs.existsSync(t)) continue;
      const src = fs.readFileSync(t, "utf8");
      if (/from\s+["'](node:|fs["']|\.\/(file-lock|teams-file))/.test(src) || /SharedArrayBuffer/.test(src)) bad.push(path.relative(root, t));
      stack.push(t);
    }
  }
  assert.deepEqual(bad, []);
});

test("built bundle has no SharedArrayBuffer (when dist exists)", { skip: !fs.existsSync(path.join(root, "dist", "assets")) }, () => {
  const dir = path.join(root, "dist", "assets");
  const hits = fs.readdirSync(dir).filter((n) => n.endsWith(".js") && fs.readFileSync(path.join(dir, n), "utf8").includes("SharedArrayBuffer"));
  assert.deepEqual(hits, []);
});
