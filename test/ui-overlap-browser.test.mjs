// Forge audit R8: Linux browser candidates for the overlap harness, and a loud reason when none is found.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { browserSkipReason, findBrowser } from "../scripts/ui-overlap/env.mjs";

const existing = (...paths) => (p) => paths.includes(p);

describe("findBrowser on Linux (R8)", () => {
  it("finds chromium / chrome / edge in the standard dirs", () => {
    for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/microsoft-edge"]) {
      assert.equal(findBrowser({ platform: "linux", env: { PATH: "" }, exists: existing(p) }), p);
    }
  });

  it("finds a browser on PATH outside the standard dirs", () => {
    assert.equal(findBrowser({ platform: "linux", env: { PATH: "/opt/x/bin:/usr/sbin" }, exists: existing("/opt/x/bin/google-chrome") }), "/opt/x/bin/google-chrome");
  });

  it("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH wins when it exists", () => {
    const env = { PATH: "", PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/custom/chrome" };
    assert.equal(findBrowser({ platform: "linux", env, exists: existing("/custom/chrome", "/usr/bin/chromium") }), "/custom/chrome");
  });

  it("returns null when nothing exists", () => {
    assert.equal(findBrowser({ platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false }), null);
  });

  it("win32 still uses only the Edge/Chrome Windows candidates", () => {
    const edge = "C:/Program Files/Microsoft/Edge/Application/msedge.exe";
    assert.equal(findBrowser({ platform: "win32", env: {}, exists: existing(edge, "/usr/bin/chromium") }), edge);
    assert.equal(findBrowser({ platform: "win32", env: {}, exists: existing("/usr/bin/chromium") }), null);
  });
});

describe("browserSkipReason (R8: skips are loud, with a reason)", () => {
  it("is false when both are present and names what is missing otherwise", () => {
    assert.equal(browserSkipReason({ pw: {}, exe: "/usr/bin/chromium" }), false);
    assert.match(browserSkipReason({ pw: null, exe: "/x" }), /no Playwright found.*npm i --prefix .*playwright-core/);
    assert.match(browserSkipReason({ pw: {}, exe: null }), /no Chromium\/Chrome\/Edge found/);
    assert.match(browserSkipReason({ pw: null, exe: null }), /no Playwright found.*; no Chromium\/Chrome\/Edge found/);
  });
});
