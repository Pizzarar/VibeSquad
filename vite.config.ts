import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createVibesquadMiddleware, readPaseo } from "./server/vibesquad-api.mjs";
import "./server/brainstorm.mjs";
import "./server/inbox.mjs";
import "./server/auth.mjs";
import "./server/qr.mjs";
import "./server/push.mjs";

const paseo = readPaseo();

// Dev server mounts the same middleware the production server (server/serve.mjs) uses
// (/__vibesquad/inbox, /__vibesquad/brainstorm-summary, /__vibesquad/vs-log, /__vibesquad/brainstorm-restart, /api/teams, etc.).
function vibesquadApi() {
  return {
    name: "vibesquad-api",
    configureServer(server: any) {
      server.middlewares.use(createVibesquadMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [react(), vibesquadApi()],
  define: {
    __PASEO_SERVER_ID__: JSON.stringify(paseo.serverId),
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
});
