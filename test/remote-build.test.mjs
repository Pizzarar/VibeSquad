// Block R2-3: hosted static remote build mode (`vite build --mode remote` -> `dist-remote`) + GitHub Pages deploy workflow.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_REMOTE = join(ROOT, "dist-remote");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

describe("R2-3 static remote build and Pages workflow", () => {
  after(() => {
    rmSync(DIST_REMOTE, { recursive: true, force: true });
  });

  test("package.json defines build:remote script", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.scripts?.["build:remote"], "vite build --mode remote");
  });

  test("vite.config.ts configures remote mode (VITE_VS_REMOTE, dist-remote, relative base, no dev middleware)", () => {
    const cfg = read("vite.config.ts");
    assert.match(cfg, /defineConfig\(\(\{\s*mode\s*\}\)\s*=>/);
    assert.match(cfg, /mode === "remote"\s*\|\|\s*process\.env\.VITE_VS_REMOTE === "1"/);
    assert.match(cfg, /process\.env\.VITE_BASE_PATH \|\| "\.\/"/);
    assert.match(cfg, /"import\.meta\.env\.VITE_VS_REMOTE":\s*JSON\.stringify\("1"\)/);
    assert.match(cfg, /outDir:\s*isRemoteBuild \? "dist-remote" : "dist"/);
    assert.match(cfg, /plugins:\s*isRemoteBuild \? \[react\(\)\] : \[react\(\), vibesquadApi\(\)\]/);
  });

  test("npm run build:remote produces dist-remote bundle with pairing UI and no host secrets or paths", () => {
    rmSync(DIST_REMOTE, { recursive: true, force: true });
    execSync("npm run build:remote", { cwd: ROOT, stdio: "pipe" });

    const indexPath = join(DIST_REMOTE, "index.html");
    assert.equal(existsSync(indexPath), true, "dist-remote/index.html must exist");
    const html = readFileSync(indexPath, "utf8");
    assert.match(html, /src="\.\/assets\/index-[^"]+\.js"/, "index.html uses relative ./assets/ script path");
    assert.match(html, /href="\.\/assets\/index-[^"]+\.css"/, "index.html uses relative ./assets/ stylesheet path");

    const assetsDir = join(DIST_REMOTE, "assets");
    const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
    assert.ok(jsFiles.length >= 1, "at least one JS bundle in dist-remote/assets/");

    const bundle = jsFiles.map((f) => readFileSync(join(assetsDir, f), "utf8")).join("\n");
    assert.match(bundle, /vs\.remote`,[A-Za-z0-9_$]+=\(\(\)=>\{try\{return!0\}/, "BUILD_REMOTE is baked in as true");

    for (const forbidden of ["C:\\Users\\", "/home/", "local-token", "daemon-password", homedir()]) {
      if (!forbidden) continue;
      assert.equal(
        bundle.includes(forbidden),
        false,
        `bundle must not leak host secret or personal path: ${forbidden}`,
      );
    }
  });

  test(".github/workflows/pages.yml builds build:remote and deploys dist-remote to GitHub Pages", () => {
    const workflowPath = join(ROOT, ".github", "workflows", "pages.yml");
    assert.equal(existsSync(workflowPath), true, ".github/workflows/pages.yml must exist");
    const wf = read(".github/workflows/pages.yml");
    assert.match(wf, /name:\s*Deploy Remote UI to Pages/);
    assert.match(wf, /branches:\s*\["master"\]/);
    assert.match(wf, /workflow_dispatch:/);
    assert.match(wf, /pages:\s*write/);
    assert.match(wf, /id-token:\s*write/);
    assert.match(wf, /run:\s*npm ci/);
    assert.match(wf, /run:\s*npm run build:remote/);
    assert.match(wf, /uses:\s*actions\/upload-pages-artifact@v3/);
    assert.match(wf, /path:\s*dist-remote/);
    assert.match(wf, /uses:\s*actions\/deploy-pages@v4/);
  });
});
