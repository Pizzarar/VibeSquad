// Forge audit R9: the vs.cmd / vs.ps1 launchers are Windows-only; off win32 only the POSIX `vs` script is written.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";

import { installVsShim } from "../cli/vs.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "vs-shim-plat-"));
  dirs.push(d);
  return d;
};

describe("installVsShim platform gating (R9)", () => {
  it("linux/darwin: writes only the POSIX shim, no .cmd/.ps1", () => {
    for (const platform of ["linux", "darwin"]) {
      const bin = tmp();
      const res = installVsShim({ binDirs: [bin], baseHome: tmp(), force: true, platform });
      assert.deepEqual(res.files.map((f) => basename(f)), ["vs"]);
      assert.ok(existsSync(join(bin, "vs")));
      assert.equal(existsSync(join(bin, "vs.cmd")), false);
      assert.equal(existsSync(join(bin, "vs.ps1")), false);
    }
  });

  it("win32: still writes vs, vs.cmd and vs.ps1", () => {
    const bin = tmp();
    const res = installVsShim({ binDirs: [bin], baseHome: tmp(), force: true, platform: "win32" });
    assert.deepEqual(res.files.map((f) => basename(f)), ["vs", "vs.cmd", "vs.ps1"]);
    for (const f of res.files) assert.ok(existsSync(f));
  });
});
