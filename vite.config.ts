import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createVibesquadMiddleware, readPaseo } from "./server/vibesquad-api.mjs";
import "./server/brainstorm.mjs";
import "./server/inbox.mjs";
import { getLocalToken, lockDownVibesquadHome } from "./server/auth.mjs";
import "./server/qr.mjs";
import "./server/push.mjs";

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
  const paseo = isRemoteBuild ? { listen: "127.0.0.1:6767", serverId: "" } : readPaseo();

  return {
    base: isRemoteBuild ? process.env.VITE_BASE_PATH || "./" : "/",
    plugins: isRemoteBuild ? [react()] : [react(), vibesquadApi()],
    define: {
      // Never bake the build machine's ~/.paseo/server-id into dist/: a bundle built on Main PC and run on
      // Project PC would otherwise make Project PC think target.serverId === BUILD_SERVER_ID and drop it into
      // local mode (stripping ?remote=1#offer=…). The runtime check in remoteBoot.ts asks the local server instead.
      __PASEO_SERVER_ID__: JSON.stringify(""),
      ...(isRemoteBuild ? { "import.meta.env.VITE_VS_REMOTE": JSON.stringify("1") } : {}),
    },
    build: {
      outDir: isRemoteBuild ? "dist-remote" : "dist",
      emptyOutDir: true,
    },
    server: {
      port: 5180,
      proxy: {
        // The daemon only accepts browser origins listed in cors.allowedOrigins.
        "/ws": {
          target: `ws://${paseo.listen}`,
          ws: true,
          configure: (proxy: any) => {
            // Typed loosely: Vite 8's ProxyServer type omits the http-proxy event API.
            // Origin is forwarded untouched so Paseo's cors.allowedOrigins validates it.
            void proxy;
          },
        },
      },
    },
  };
});
