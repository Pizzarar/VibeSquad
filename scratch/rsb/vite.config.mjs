import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
export default defineConfig({
  root: here,
  publicDir: path.join(repo, "public"),
  plugins: [react()],
  resolve: { alias: [{ find: /^\.\/AgentPanes$/, replacement: path.join(here, "AgentPanesStub.tsx") }] },
  server: { port: 5199, strictPort: true, fs: { strict: false } },
});
