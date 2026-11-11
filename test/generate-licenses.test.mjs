import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "..", "server", "generate-licenses.mjs");
const run = (out, env = {}) => {
  execFileSync(process.execPath, [script], { env: { ...process.env, VIBESQUAD_LICENSES_OUT: out, ...env }, stdio: "pipe" });
  return readFileSync(out, "utf8");
};

test("generate-licenses is deterministic across runs and independent of ~/.cargo sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "licenses-"));
  try {
    const out = join(dir, "a.txt");
    const first = run(out);
    assert.equal(run(out), first, "second run differs");
    const emptyCargo = join(dir, "cargo");
    mkdirSync(emptyCargo);
    assert.equal(run(out, { CARGO_HOME: emptyCargo }), first, "output depends on local cargo registry");
    const names = first.slice(first.indexOf("Production npm packages")).split("\n").slice(2).filter((l) => /^\S+@\S+  /.test(l)).map((l) => l.split("@").slice(0, l.startsWith("@") ? 2 : 1).join("@"));
    const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(names.slice(0, 5), sorted.slice(0, 5));
    assert.ok(!/[A-Z]:\|\/Users\//.test(first), "absolute path leaked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
