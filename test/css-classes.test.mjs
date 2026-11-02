import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Every className token in src/*.tsx must have a rule in src/styles.css, unless it is
// a JS-only hook (queried or toggled from code, never styled). Keep the allowlist small.
//
// How className values are read:
//   className="a b"            -> the quoted tokens
//   className={...}            -> braces are balanced, then every "..." / '...' / `...` literal
//                                 inside is scanned, so conditionals (c ? "a" : "b"), && and
//                                 template literals are covered
//   `foo ${x} bar`             -> ${...} is dropped; whitespace-separated tokens on each side are kept
//   `foo-${x}` / `${x}-foo`    -> a token touching a ${...} is dynamic: its static parts must fit
//                                 at least one defined class (`foo-${x}` needs some `.foo-*`)
// A CSS rule is any `.name` selector token in styles.css (comments stripped, so commented-out
// rules do not count).
const JS_ONLY = new Set([
  // add a class here only if code reads it (querySelector / state flag) and it is never styled
]);

const SRC = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// Component-owned stylesheets (src/HubBar.css) count too.
const css = readdirSync(SRC).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(SRC, f), "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const defined = new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));

function literalTokens(text) {
  const out = [];
  for (const m of text.matchAll(/(["'`])((?:[\\][\s\S]|(?!\1)[^\\])*)\1/g)) {
    let body = m[2];
    if (m[1] === "`") {
      // mark dynamic gaps so adjacent partial tokens can be dropped
      body = body.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "\u0000");
    }
    for (const tok of body.split(/\s+/)) {
      if (tok) out.push(tok);
    }
  }
  return out;
}

// Does class `c` fit a glued token's static parts (`a${x}b` -> parts ["a","b"]) in order?
function matchesGlued(c, parts) {
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!c.startsWith(first) || !c.endsWith(last)) return false;
  let at = first.length;
  for (const p of parts.slice(1, -1)) {
    const i = c.indexOf(p, at);
    if (i < 0) return false;
    at = i + p.length;
  }
  return c.length - last.length >= at || parts.length === 1;
}

function classTokens(source) {
  const found = [];
  for (const m of source.matchAll(/className=/g)) {
    let i = m.index + m[0].length;
    const open = source[i];
    if (open === '"' || open === "'") {
      const end = source.indexOf(open, i + 1);
      found.push(...literalTokens(source.slice(i, end + 1)));
    } else if (open === "{") {
      let depth = 0;
      let j = i;
      for (; j < source.length; j++) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}" && --depth === 0) break;
      }
      found.push(...literalTokens(source.slice(i + 1, j)));
    }
  }
  return found;
}

// Dock tabs are held to the strict rule. Other files have older undefined classes (layout hooks and
// a few real gaps); they are frozen in test/fixtures/css-class-baseline.json so only NEW misses fail.
// Shrink the baseline as you style them; regenerate with: CSS_CLASS_BASELINE_DUMP=1 node --test test/css-classes.test.mjs
const DOCK_FILES = new Set(["RightDock.tsx", "ChangesPanel.tsx", "FilesPanel.tsx", "TerminalPanel.tsx", "ScriptsPanel.tsx"]);
const BASELINE_PATH = new URL("./fixtures/css-class-baseline.json", import.meta.url);

function findMissing() {
  const missing = {};
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".tsx")).sort()) {
    for (const tok of classTokens(readFileSync(join(SRC, f), "utf8"))) {
      if (tok.includes("\u0000")) {
        const parts = tok.split("\u0000");
        if (parts.every((p) => !p)) continue; // pure ${x}, nothing static to check
        if (![...defined].some((c) => matchesGlued(c, parts))) {
          (missing[f] ??= new Set()).add(parts.join("${…}"));
        }
        continue;
      }
      if (!/^-?[_a-zA-Z][A-Za-z0-9_-]*$/.test(tok)) continue;
      if (defined.has(tok) || JS_ONLY.has(tok)) continue;
      (missing[f] ??= new Set()).add(tok);
    }
  }
  return missing;
}

test("every className token in src/*.tsx has a CSS rule (dock tabs strict, others vs baseline)", () => {
  const missing = findMissing();
  if (process.env.CSS_CLASS_BASELINE_DUMP) {
    const dump = {};
    for (const [f, toks] of Object.entries(missing)) if (!DOCK_FILES.has(f)) dump[f] = [...toks].sort();
    writeFileSync(BASELINE_PATH, JSON.stringify(dump, null, 2) + "\n");
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const report = [];
  for (const [f, toks] of Object.entries(missing)) {
    const allowed = new Set(DOCK_FILES.has(f) ? [] : baseline[f] ?? []);
    for (const t of toks) if (!allowed.has(t)) report.push(`${f}: ${t}`);
  }
  assert.equal(report.length, 0, `className tokens with no CSS rule:\n  ${report.sort().join("\n  ")}`);
});
