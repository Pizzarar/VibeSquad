import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

describe("src case clash guard", () => {
  it("fails if any two files share full path case-insensitively", () => {
    const files = walk(srcDir);
    const byLower = new Map();
    for (const file of files) {
      const rel = relative(srcDir, file).replace(/\\/g, "/");
      const lower = rel.toLowerCase();
      if (!byLower.has(lower)) byLower.set(lower, []);
      byLower.get(lower).push(rel);
    }

    const clashes = [];
    for (const [lower, list] of byLower) {
      if (list.length > 1) {
        clashes.push(`${lower}: [${list.join(", ")}]`);
      }
    }
    assert.deepEqual(clashes, [], `Found files with full paths equal case-insensitively:\n${clashes.join("\n")}`);
  });

  it("fails if two code files share a path case-insensitively once extension is stripped", () => {
    const files = walk(srcDir);
    const byStrippedLower = new Map();
    for (const file of files) {
      const rel = relative(srcDir, file).replace(/\\/g, "/");
      const ext = extname(rel);
      if (!CODE_EXTS.has(ext)) continue; // .css and non-code files are exempt from the stripped-extension rule

      const stripped = rel.slice(0, -ext.length).toLowerCase();
      if (!byStrippedLower.has(stripped)) byStrippedLower.set(stripped, []);
      byStrippedLower.get(stripped).push(rel);
    }

    const clashes = [];
    for (const [stripped, list] of byStrippedLower) {
      if (list.length > 1) {
        clashes.push(`${stripped}: [${list.join(", ")}]`);
      }
    }
    assert.deepEqual(clashes, [], `Found code files sharing case-insensitive path without extension:\n${clashes.join("\n")}`);
  });
});
