import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createVibesquadMiddleware } from "./server/vibesquad-api.mjs";
import "./server/brainstorm.mjs";
import "./server/inbox.mjs";
import { getLocalToken, lockDownVibesquadHome } from "./server/auth.mjs";
import "./server/qr.mjs";
import "./server/push.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

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
    },
  };
});
