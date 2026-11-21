import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createVibesquadMiddleware } from "./server/vibesquad-api.mjs";
import { viteFsAllow } from "./server/vite-fs-allow.mjs";
import "./server/brainstorm.mjs";
import "./server/inbox.mjs";
import { getLocalToken, lockDownVibesquadHome } from "./server/auth.mjs";
import "./server/qr.mjs";
import "./server/push.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The config dir is the workspace root. In a linked git worktree (vs worktree create)
// node_modules is a junction to the main checkout's, so Vite's default fs.allow (the
// workspace root alone) would 403 every `/@fs/` asset that realpaths through the link.
const rootDir = realpathSync(fileURLToPath(new URL(".", import.meta.url)));

// Dev server mounts the same middleware the production server (server/serve.mjs) uses
// (/__vibesquad/inbox, /__vibesquad/brainstorm-summary, /__vibesquad/vs-log, /__vibesquad/brainstorm-restart, /api/teams, etc.).
function vibesquadApi() {
  return {
    name: "vibesquad-api",
    configureServer(server: any) {
      // Same order as serve.mjs: lock ~/.vibesquad, then create the local token the middleware checks.
      lockDownVibesquadHome();
      getLocalToken();
      server.middlewares.use(createVibesquadMiddleware());
    },
  };
}

export default defineConfig(({ mode }) => {
  const isRemoteBuild = mode === "remote" || process.env.VITE_VS_REMOTE === "1";
  if (isRemoteBuild) process.env.VITE_VS_REMOTE = "1";

  return {
    base: isRemoteBuild ? process.env.VITE_BASE_PATH || "./" : "/",
    plugins: isRemoteBuild ? [react()] : [react(), vibesquadApi()],
    // Keep the dep-optimizer cache per checkout: the default (node_modules/.vite) is the
    // junction target in a linked worktree, so a worktree dev server would read/write the
    // main checkout's cache (re-optimizing on every checkout switch).
    cacheDir: ".vite",
    define: {
      __VS_APP_VERSION__: JSON.stringify(pkg.version || "0.2.0"),
      ...(isRemoteBuild ? { "import.meta.env.VITE_VS_REMOTE": JSON.stringify("1") } : {}),
    },
    build: {
      outDir: isRemoteBuild ? "dist-remote" : "dist",
      emptyOutDir: true,
    },
    server: {
      port: 5180,
      fs: {
        allow: viteFsAllow(rootDir),
      },
    },
  };
});
