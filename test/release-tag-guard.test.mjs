import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildLatestJson, publishRelease } from "../server/release.mjs";

function createMockExec({ existingReleases = new Set(), headSha = "3d68b1f", tagShas = {} } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      const tag = args[2];
      if (!existingReleases.has(tag)) {
        throw new Error(`release ${tag} not found`);
      }
      return "";
    }
    if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      return `${headSha}\n`;
    }
    if (cmd === "git" && args[0] === "ls-remote" && args[1] === "--tags") {
      for (const ref of args.slice(3)) {
        const cleanTag = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
        if (tagShas[cleanTag]) {
          return `${tagShas[cleanTag]}\trefs/tags/${cleanTag}\n`;
        }
      }
      return "";
    }
    if (cmd === "git" && args[0] === "rev-parse" && args[1]?.startsWith("refs/tags/")) {
      const cleanTag = args[1].replace(/^refs\/tags\//, "").replace(/\^\{commit\}$/, "");
      if (tagShas[cleanTag]) {
        return `${tagShas[cleanTag]}\n`;
      }
      throw new Error(`unknown revision ${args[1]}`);
    }
    return "";
  };
  return { exec, calls };
}

describe("publishRelease tag guard and rolling beta sync", () => {
  const dummyAssets = ["dist-desktop/VibeSquad-setup.exe", "dist-desktop/VibeSquad-setup.exe.sig", "dist-desktop/latest.json"];

  test("throws when existing versioned tag (v0.2.0) points at a stale commit (!== HEAD) and never edits or uploads", () => {
    const { exec, calls } = createMockExec({
      existingReleases: new Set(["v0.2.0"]),
      headSha: "3d68b1f",
      tagShas: { "v0.2.0": "4c4bd22" },
    });

    assert.throws(
      () =>
        publishRelease({
          channel: "stable",
          targetVersion: "0.2.0",
          assets: dummyAssets,
          latestJsonPath: "dist-desktop/latest.json",
          latestManifest: buildLatestJson({ version: "0.2.0", channel: "stable", signature: "SIG" }),
          signature: "SIG",
          exec,
          writeManifest: () => {},
        }),
      (err) => {
        assert.match(err.message, /v0\.2\.0/);
        assert.match(err.message, /4c4bd22/);
        assert.match(err.message, /3d68b1f/);
        return true;
      },
    );

    const ghEditOrUpload = calls.filter(
      (c) => c[0] === "gh" && c[1] === "release" && (c[2] === "edit" || c[2] === "upload"),
    );
    assert.equal(ghEditOrUpload.length, 0, "Should not call gh release edit or gh release upload on stale versioned tag");
  });

  test("succeeds when existing versioned tag (v0.2.0) points at HEAD, edits & uploads, and re-points rolling beta tag to HEAD", () => {
    const { exec, calls } = createMockExec({
      existingReleases: new Set(["v0.2.0", "beta"]),
      headSha: "3d68b1f",
      tagShas: { "v0.2.0": "3d68b1f", beta: "4c4bd22" },
    });
    const writtenManifests = [];

    publishRelease({
      channel: "stable",
      targetVersion: "0.2.0",
      assets: dummyAssets,
      latestJsonPath: "dist-desktop/latest.json",
      latestManifest: buildLatestJson({ version: "0.2.0", channel: "stable", signature: "SIG" }),
      signature: "SIG",
      exec,
      writeManifest: (path, manifest) => writtenManifests.push({ path, channelUrl: manifest.platforms["windows-x86_64"].url }),
    });

    assert.ok(
      calls.some((c) => c[0] === "gh" && c[1] === "release" && c[2] === "edit" && c[3] === "v0.2.0"),
      "Should edit existing v0.2.0 release",
    );
    assert.ok(
      calls.some((c) => c[0] === "gh" && c[1] === "release" && c[2] === "upload" && c[3] === "v0.2.0"),
      "Should upload assets to v0.2.0 release",
    );

    const betaRetagIdx = calls.findIndex((c) => c[0] === "git" && c[1] === "tag" && c[2] === "-f" && c[3] === "beta" && c[4] === "HEAD");
    const betaPushIdx = calls.findIndex((c) => c[0] === "git" && c[1] === "push" && c[2] === "-f" && c[3] === "origin" && c[4] === "refs/tags/beta");
    const betaUploadIdx = calls.findIndex((c) => c[0] === "gh" && c[1] === "release" && c[2] === "upload" && c[3] === "beta");

    assert.ok(betaRetagIdx !== -1, "Should force-update local beta tag to HEAD");
    assert.ok(betaPushIdx > betaRetagIdx, "Should force-push refs/tags/beta to origin");
    assert.ok(betaUploadIdx > betaPushIdx, "Should upload beta assets after re-pointing beta tag to HEAD");
    assert.equal(writtenManifests.length, 2, "Should write beta manifest and restore stable manifest");
  });

  test("re-points existing beta release tag to HEAD in --channel beta mode before editing and uploading", () => {
    const { exec, calls } = createMockExec({
      existingReleases: new Set(["beta"]),
      headSha: "3d68b1f",
      tagShas: { beta: "4c4bd22" },
    });

    publishRelease({
      channel: "beta",
      targetVersion: "0.2.0-beta.2",
      assets: dummyAssets,
      latestJsonPath: "dist-desktop/latest.json",
      latestManifest: buildLatestJson({ version: "0.2.0-beta.2", channel: "beta", signature: "SIG" }),
      signature: "SIG",
      exec,
      writeManifest: () => {},
    });

    const betaRetagIdx = calls.findIndex((c) => c[0] === "git" && c[1] === "tag" && c[2] === "-f" && c[3] === "beta" && c[4] === "HEAD");
    const betaPushIdx = calls.findIndex((c) => c[0] === "git" && c[1] === "push" && c[2] === "-f" && c[3] === "origin" && c[4] === "refs/tags/beta");
    const betaEditIdx = calls.findIndex((c) => c[0] === "gh" && c[1] === "release" && c[2] === "edit" && c[3] === "beta");
    const betaUploadIdx = calls.findIndex((c) => c[0] === "gh" && c[1] === "release" && c[2] === "upload" && c[3] === "beta");

    assert.ok(betaRetagIdx !== -1, "Should re-point local beta tag to HEAD");
    assert.ok(betaPushIdx > betaRetagIdx, "Should force-push beta tag to origin");
    assert.ok(betaEditIdx > betaPushIdx, "Should edit beta release after re-pointing beta tag");
    assert.ok(betaUploadIdx > betaEditIdx, "Should upload beta assets after editing beta release");
  });

  test("creates a brand-new release and uploads when gh release view throws", () => {
    const { exec, calls } = createMockExec({
      existingReleases: new Set(),
      headSha: "3d68b1f",
    });

    publishRelease({
      channel: "beta",
      targetVersion: "0.2.0-beta.1",
      assets: dummyAssets,
      latestJsonPath: "dist-desktop/latest.json",
      latestManifest: buildLatestJson({ version: "0.2.0-beta.1", channel: "beta", signature: "SIG" }),
      signature: "SIG",
      exec,
      writeManifest: () => {},
    });

    assert.ok(
      calls.some((c) => c[0] === "gh" && c[1] === "release" && c[2] === "create" && c[3] === "beta" && c.includes("--prerelease")),
      "Should call gh release create beta --prerelease",
    );
    assert.ok(
      calls.some((c) => c[0] === "gh" && c[1] === "release" && c[2] === "upload" && c[3] === "beta" && c.includes("--clobber")),
      "Should call gh release upload beta --clobber",
    );
    assert.ok(
      !calls.some((c) => c[0] === "gh" && c[1] === "release" && c[2] === "edit"),
      "Should not call gh release edit when creating a brand-new release",
    );
  });
});
