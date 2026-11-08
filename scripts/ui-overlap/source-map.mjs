// Maps a hit's class names / data-testid back to source: CSS rules (file:line) and TSX usage (file:line).
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./env.mjs";

const SRC = path.join(REPO_ROOT, "src");

/** Tiny CSS scanner: returns [{ selector, file, line }] for every style rule (recurses into @media/@supports). */
function scanCss(file) {
  const text = fs.readFileSync(file, "utf8");
  const rules = [];
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  let line = 1, preludeStart = -1, preludeLine = 1;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line++;
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (let k = i; k < stop; k++) if (text[k] === "\n") line++;
      i = stop - 1;
      continue;
    }
    if (c === "{") {
      const prelude = preludeStart >= 0 ? text.slice(preludeStart, i).trim() : "";
      if (prelude.startsWith("@")) stack.push({ at: true });
      else {
        stack.push({ at: false });
        if (prelude) rules.push({ selector: prelude.replace(/\s+/g, " "), file: rel, line: preludeLine });
      }
      preludeStart = -1;
      continue;
    }
    if (c === "}") { stack.pop(); preludeStart = -1; continue; }
    if (c === ";" && stack.length && !stack[stack.length - 1].at) continue;
    if (preludeStart < 0 && !/\s/.test(c) && (stack.length === 0 || stack[stack.length - 1].at)) { preludeStart = i; preludeLine = line; }
  }
  return rules;
}

let cssRules = null;
function loadCss() {
  if (cssRules) return cssRules;
  cssRules = [];
  for (const f of fs.readdirSync(SRC)) if (f.endsWith(".css")) cssRules.push(...scanCss(path.join(SRC, f)));
  return cssRules;
}

let tsx = null;
function loadTsx() {
  if (tsx) return tsx;
  tsx = [];
  for (const f of fs.readdirSync(SRC)) {
    if (!/\.tsx$/.test(f)) continue;
    tsx.push({ file: `src/${f}`, lines: fs.readFileSync(path.join(SRC, f), "utf8").split("\n") });
  }
  return tsx;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Last (cascade-winning) rules whose selector mentions `.cls`, up to `per` per class. */
export function cssRefs(classes, per = 2, maxClasses = 3) {
  const refs = [];
  for (const cls of classes.slice(0, maxClasses)) {
    const re = new RegExp(`\\.${esc(cls)}(?![\\w-])`);
    const m = loadCss().filter((r) => re.test(r.selector));
    for (const r of m.slice(-per)) refs.push(`${r.file}:${r.line} ${r.selector.slice(0, 80)}`);
  }
  return [...new Set(refs)];
}

/** First TSX line mentioning the data-testid or className token. */
export function tsxRefs(selector, classes) {
  const out = [];
  const tid = /data-testid="([^"]+)"/.exec(selector)?.[1];
  const needles = [];
  if (tid) needles.push(`data-testid="${tid}"`, `data-testid={\`${tid.replace(/-[a-z0-9]+$/, "-")}`);
  for (const c of classes.slice(0, 2)) needles.push(new RegExp(`className=[{"\`'][^]*?\\b${esc(c)}\\b`));
  for (const n of needles) {
    for (const f of loadTsx()) {
      const i = f.lines.findIndex((l) => (typeof n === "string" ? l.includes(n) : n.test(l)));
      if (i >= 0) { out.push(`${f.file}:${i + 1}`); break; }
    }
    if (out.length >= 2) break;
  }
  return [...new Set(out)];
}
