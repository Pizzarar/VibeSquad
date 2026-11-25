// Hermetic-import guard (idea-667): workers run one file with `node --test test/<file>.test.mjs`, which bypasses
// scripts/run-tests.mjs and its `--import ./test/setup/hermetic.mjs` preload, so the shell's live VS_*/VIBESQUAD_*/PASEO_*
// env (agent identity, meshnet host/IP, live runtime dir) leaked into the test and made results depend on who ran it.
// A test that INHERITS that env must preload hermetic itself; then a direct run matches `npm test` (where the preload is
// already loaded, so the import is a no-op). Three signals count as inheriting it:
//   1. it reads a VS_*/VIBESQUAD_*/PASEO_* var it never assigns or deletes itself (the shell value is the input),
//   2. it spawns the vs CLI / bin/vs, which inherits the whole ambient env,
//   3. its header advertises `node --test --import ./test/setup/hermetic.mjs ...`, i.e. it already claims to be direct-run safe.
// A plain assignment (`process.env.VIBESQUAD_HOME = tmp`) or `delete process.env.X` REPLACES/clears the inherited value,
// so those are not flagged. The opt-in knobs scripts/test-child-env.mjs keeps on purpose (VS_TEST_*, VS_BENCH, VS_SMOKE,
// VS_ALLOW_REAL_HOME) are not flagged either.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const TEST_DIR = import.meta.dirname;
const GUARD_FILE = "hermetic-import-guard.test.mjs";
const PRELOAD = 'import "./setup/hermetic.mjs";';

// Files that must see the raw environment. One line of reason each; do not add a file just to silence a real leak.
const ALLOWLIST = new Map([
  [
    "runtime-dir.test.mjs",
    "tests runtimeDir()/VIBESQUAD_RUNTIME_DIR precedence and hermeticizeEnv itself; the preload sets VIBESQUAD_RUNTIME_DIR and would mask the case under test",
  ],
]);

// scripts/test-child-env.mjs LIVE_ENV / KEEP_ENV (case-insensitive there too): opt-in knobs a developer passes on purpose.
const LIVE_ENV = /^(VS_|VIBESQUAD_|PASEO_)/i;
const KEEP_ENV = /^(VS_TEST_|VS_BENCH$|VS_SMOKE$|VS_ALLOW_REAL_HOME$)/i;

/** Blank out // and block comments, keeping newlines so reported line numbers stay right. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function firstImport(src) {
  const m = stripComments(src).match(/^import\s+[^\n]*$/m);
  return m ? m[0] : "";
}

function preloadsHermetic(src) {
  return /^import\s+["']\.\/setup\/hermetic\.mjs["'];?/.test(firstImport(src));
}

/** Var names of the live/identity namespaces this file reads without overriding or deleting them first. */
function inheritedEnvReads(src) {
  const code = stripComments(src);
  const owned = new Set();
  const reads = [];
  const note = (name, index, len) => {
    const before = code.slice(Math.max(0, index - 12), index);
    const after = code.slice(index + len);
    // Only plain `=` / delete REPLACE the inherited value; `??=`, `||=`, `&&=` read it (and keep it when set).
    if (/^\s*=(?![=>])/.test(after) || /\bdelete\s*$/.test(before)) owned.add(name);
    else reads.push(name);
  };
  for (const m of code.matchAll(/process\.env\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) note(m[1], m.index, m[0].length);
  for (const m of code.matchAll(/process\.env\[\s*["'`]([^"'`]+)["'`]\s*\]/g)) note(m[1], m.index, m[0].length);
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(/[:=]/)[0].trim();
      if (name) reads.push(name);
    }
  }
  return [...new Set(reads)].filter((n) => LIVE_ENV.test(n) && !KEEP_ENV.test(n) && !owned.has(n));
}

/** True when the file spawns the vs CLI (bin/vs or cli/vs.mjs, joined or as separate path segments), whose child inherits process.env. */
function spawnsVsCli(src) {
  const code = stripComments(src);
  const spawns = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/.test(code);
  const vsEntry =
    /(?:cli[\\/]vs\.mjs|bin[\\/]vs\b|["'`]cli["'`]\s*,\s*["'`]vs\.mjs["'`]|["'`]bin["'`]\s*,\s*["'`]vs["'`]|["'`]vs["'`])/.test(code);
  return spawns && vsEntry;
}

/** The reasons this file must preload hermetic, or [] when it does not (or already does). */
function preloadReasons(src) {
  if (preloadsHermetic(src)) return [];
  const reasons = [];
  const reads = inheritedEnvReads(src);
  if (reads.length) reasons.push(`reads inherited ${reads.join(", ")}`);
  if (spawnsVsCli(src)) reasons.push("spawns the vs CLI (inherits the ambient env)");
  if (/Run:[^\n]*--import[^\n]*setup\/hermetic\.mjs/.test(src)) {
    reasons.push("its Run header tells you to add --import ./test/setup/hermetic.mjs");
  }
  return reasons;
}

test("every env-sensitive test file preloads the hermetic env", () => {
  const offenders = [];
  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.mjs")).sort()) {
    if (file === GUARD_FILE || ALLOWLIST.has(file)) continue;
    const reasons = preloadReasons(readFileSync(join(TEST_DIR, file), "utf8"));
    if (reasons.length) offenders.push(`test/${file}: ${reasons.join("; ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `These files depend on the live shell env but a direct \`node --test test/<file>.test.mjs\` run does not preload it.\n` +
      `Fix: make \`${PRELOAD}\` the first import in each file (see test/watch-verb.test.mjs).\n` +
      `If a file must see the raw env, add it to ALLOWLIST above with a one-line reason.\n` +
      offenders.join("\n"),
  );
});

test("guard matchers: env reads", () => {
  const reads = (c) => inheritedEnvReads(c);
  assert.deepEqual(reads("const a = process.env.VS_LANE;"), ["VS_LANE"]);
  assert.deepEqual(reads("process.env.VS_LANE = 'x'; use(process.env.VS_LANE);"), []);
  assert.deepEqual(reads("delete process.env.VS_LANE; use(process.env.VS_LANE);"), []);
  // ??= / ||= / &&= keep or read the inherited value, so they do not own the var
  for (const op of ["??=", "||=", "&&="]) assert.deepEqual(reads(`process.env.VS_LANE ${op} 'x';`), ["VS_LANE"], op);
  assert.deepEqual(reads(`const a = process.env["VS_LANE"]; const b = process.env['VIBESQUAD_HOME'];`), ["VS_LANE", "VIBESQUAD_HOME"]);
  assert.deepEqual(reads(`process.env["VS_LANE"] = "x"; use(process.env["VS_LANE"]);`), []);
  assert.deepEqual(reads(`const { VS_LANE, PASEO_X: px, VS_TEAM = "t", PATH } = process.env;`), ["VS_LANE", "PASEO_X", "VS_TEAM"]);
  assert.deepEqual(reads("const a = process.env.PATH; const b = process.env.VS_TEST_DUMP; const c = process.env.vs_smoke;"), []);
  assert.deepEqual(reads("const a = process.env.vs_lane;"), ["vs_lane"]);
  assert.deepEqual(reads("// process.env.VS_LANE\n"), []);
});

test("guard matchers: vs CLI spawns", () => {
  assert.equal(spawnsVsCli('spawnSync(process.execPath, [join(root, "cli/vs.mjs")]);'), true);
  assert.equal(spawnsVsCli('spawnSync(process.execPath, [path.join(root, "cli", "vs.mjs")]);'), true);
  assert.equal(spawnsVsCli('execFileSync(path.resolve(root, "bin", "vs"), []);'), true);
  assert.equal(spawnsVsCli('execFileSync(join(root, "bin/vs"), []);'), true);
  assert.equal(spawnsVsCli('const p = join(root, "cli", "vs.mjs");'), false, "no spawn call");
  assert.equal(spawnsVsCli('// cli/vs.mjs\nspawnSync("git", ["status"]);'), false, "comment only");
  assert.equal(spawnsVsCli('/* bin/vs */ spawn("git", []);'), false, "block comment only");
});

test("guard matchers: first import", () => {
  assert.equal(preloadsHermetic('import "./setup/hermetic.mjs";\nimport test from "node:test";'), true);
  assert.equal(preloadsHermetic("// import \"./setup/hermetic.mjs\";\nimport test from \"node:test\";"), false);
  assert.equal(preloadsHermetic('/* import "./setup/hermetic.mjs"; */\nimport test from "node:test";'), false);
  assert.equal(preloadsHermetic('import test from "node:test";\nimport "./setup/hermetic.mjs";'), false, "must be first");
});
