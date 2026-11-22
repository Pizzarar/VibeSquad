import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { hasDisplay, openUrlPosix, openerFor } from "../server/open-url.mjs";

const fakeSpawn = (calls, { throws = false } = {}) => (bin, args, opts) => {
  calls.push({ bin, args, opts });
  if (throws) throw new Error("ENOENT");
  const child = new EventEmitter();
  child.unref = () => {};
  calls.child = child;
  return child;
};

describe("openUrlPosix (forge audit R10)", () => {
  it("picks xdg-open on linux, open on darwin, nothing on win32", () => {
    assert.equal(openerFor("linux"), "xdg-open");
    assert.equal(openerFor("darwin"), "open");
    assert.equal(openerFor("win32"), null);
  });

  it("linux with DISPLAY or WAYLAND_DISPLAY opens via xdg-open, detached", () => {
    for (const env of [{ DISPLAY: ":0" }, { WAYLAND_DISPLAY: "wayland-0" }]) {
      const calls = [];
      assert.equal(openUrlPosix("http://x/", { platform: "linux", env, spawn: fakeSpawn(calls) }), "opened");
      assert.equal(calls[0].bin, "xdg-open");
      assert.deepEqual(calls[0].args, ["http://x/"]);
      assert.equal(calls[0].opts.detached, true);
    }
  });

  it("headless linux skips opening entirely", () => {
    const calls = [];
    assert.equal(hasDisplay("linux", {}), false);
    assert.equal(openUrlPosix("http://x/", { platform: "linux", env: {}, spawn: fakeSpawn(calls) }), "headless");
    assert.equal(calls.length, 0);
  });

  it("darwin needs no DISPLAY and uses open", () => {
    const calls = [];
    assert.equal(openUrlPosix("http://x/", { platform: "darwin", env: {}, spawn: fakeSpawn(calls) }), "opened");
    assert.equal(calls[0].bin, "open");
  });

  it("win32 is never handled here", () => {
    const calls = [];
    assert.equal(openUrlPosix("http://x/", { platform: "win32", env: {}, spawn: fakeSpawn(calls) }), "unsupported");
    assert.equal(calls.length, 0);
  });

  it("a missing opener (error event or sync throw) never crashes", () => {
    const calls = [];
    openUrlPosix("http://x/", { platform: "linux", env: { DISPLAY: ":0" }, spawn: fakeSpawn(calls) });
    assert.ok(calls.child.listenerCount("error") >= 1);
    assert.doesNotThrow(() => calls.child.emit("error", new Error("ENOENT")));
    assert.doesNotThrow(() => openUrlPosix("http://x/", { platform: "linux", env: { DISPLAY: ":0" }, spawn: fakeSpawn([], { throws: true }) }));
  });
});
