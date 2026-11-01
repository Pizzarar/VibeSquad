import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = join(fileURLToPath(import.meta.url), "../../");
const vsMjs = readFileSync(join(ROOT, "cli/vs.mjs"), "utf8");

describe("installVsShim UTF-8 encoding", () => {
  it("vs.cmd shim source contains chcp 65001", () => {
    assert.ok(
      vsMjs.includes("chcp 65001"),
      "cli/vs.mjs shim content missing chcp 65001",
    );
  });

  it("vs.ps1 shim source sets Console OutputEncoding to UTF-8", () => {
    assert.ok(
      vsMjs.includes("[Console]::OutputEncoding") && vsMjs.includes("UTF8"),
      "cli/vs.mjs shim content missing [Console]::OutputEncoding = UTF8",
    );
  });

  it("vs.ps1 shim source sets $OutputEncoding to UTF-8", () => {
    assert.ok(
      vsMjs.includes("$OutputEncoding") && vsMjs.includes("UTF8"),
      "cli/vs.mjs shim content missing $OutputEncoding = UTF8",
    );
  });
});
