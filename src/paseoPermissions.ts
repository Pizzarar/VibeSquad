// Daemon wrappers for the saved allow-rules view (parity block H). Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";
import { addRule, parseRules, removeRule, SETTINGS_FILES, type RuleList, type Rules } from "./paseoPermissionsLogic";

export type RuleFile = { path: string; exists: boolean; rules: Rules; error: string | null; modifiedAt: string | null };

export async function agentCwd(agentId: string): Promise<string> {
  const r = await daemonClient.fetchAgent(agentId);
  const cwd = r?.agent?.cwd;
  if (!cwd) throw new Error("Agent working directory unknown");
  return cwd;
}

async function readText(cwd: string, path: string): Promise<{ text: string; modifiedAt: string } | null> {
  try {
    const r = await daemonClient.readFile(cwd, path, undefined, 512 * 1024);
    return { text: new TextDecoder().decode(r.bytes), modifiedAt: r.modifiedAt };
  } catch {
    return null; // a missing settings file is normal
  }
}

export async function loadRuleFiles(cwd: string): Promise<RuleFile[]> {
  return Promise.all(
    SETTINGS_FILES.map(async (path) => {
      const f = await readText(cwd, path);
      if (!f) return { path, exists: false, rules: { allow: [], deny: [], ask: [] }, error: null, modifiedAt: null };
      try {
        return { path, exists: true, rules: parseRules(f.text), error: null, modifiedAt: f.modifiedAt };
      } catch (e) {
        return { path, exists: true, rules: { allow: [], deny: [], ask: [] }, error: e instanceof Error ? e.message : String(e), modifiedAt: f.modifiedAt };
      }
    }),
  );
}

async function save(cwd: string, path: string, next: (text: string) => string): Promise<void> {
  const f = await readText(cwd, path);
  const content = next(f?.text ?? "");
  const res = (await daemonClient.writeFile({ cwd, path, content, expectedModifiedAt: f?.modifiedAt ?? "" })) as { status?: string; error?: string };
  if (res?.status === "conflict") throw new Error("The settings file changed on disk. Reload and try again.");
  if (res?.status === "error") throw new Error(res.error ?? "write failed");
}

export const removeSavedRule = (cwd: string, path: string, list: RuleList, rule: string) =>
  save(cwd, path, (t) => removeRule(t, list, rule));

export const addSavedRule = (cwd: string, path: string, list: RuleList, rule: string) =>
  save(cwd, path, (t) => addRule(t, list, rule));
