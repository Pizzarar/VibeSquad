// R44 shared setup: run from the repo root. Output dir = $R44_OUT or docs/ux-review-r44.
import path from "node:path"; import fs from "node:fs"; import { pathToFileURL } from "node:url";
export const ROOT = process.cwd();
export const OUT = process.env.R44_OUT || path.join(ROOT, "docs/ux-review-r44"); export const LOGS = path.join(OUT, "logs");
fs.mkdirSync(LOGS, { recursive: true });
const env = await import(pathToFileURL(path.join(ROOT, "scripts/ui-overlap/env.mjs")).href);
export const pw = env.resolvePlaywright(); export const findBrowser = env.findBrowser;
export const T = (id) => `[data-testid="${id}"]`;
export const prefsInit = (theme) => `try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`;
