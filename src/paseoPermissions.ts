// Reads go through the VS fs route; writes still ride the daemon until the VS server grows a file-write route (P4 blocker).
// Wrappers for the saved allow-rules view (parity block H). Kept out of paseo.ts on purpose.
import { daemonClient, getPaseoState } from "./paseo";
import { vsReadFile } from "./vsFiles";
import { createEntry } from "./paseoFiles";
import {
  addRule, DEFAULT_SETTINGS_FILE, isSettingsFile, parseRules, removeRule, SETTINGS_FILES,
  type RuleList, type Rules, type SettingsFile,
} from "./paseoPermissionsLogic";

export type RuleFile = { path: SettingsFile; exists: boolean; rules: Rules; error: string | null };

const MAX_BYTES = 512 * 1024;
const empty = (): Rules => ({ allow: [], deny: [], ask: [] });

function assertSettingsPath(path: string): asserts path is SettingsFile {
  if (!isSettingsFile(path)) throw new Error(`Refusing to access non-settings path: ${path}`);
}

export async function agentCwd(agentId: string): Promise<string> {
  const cwd = getPaseoState().agents.get(agentId)?.cwd;
  if (!cwd) throw new Error("Agent working directory unknown");
  return cwd;
}

const isMissing = (e: unknown) => /not.?found|ENOENT|no such file|does not exist/i.test(e instanceof Error ? e.message : String(e));

/** null = the file is missing. Any other failure (permissions, network, too big) throws, so callers never overwrite on it. */
async function readText(cwd: string, path: SettingsFile): Promise<{ text: string; modifiedAt: string } | null> {
  assertSettingsPath(path);
  let r;
  try {
    r = await vsReadFile(cwd, path, MAX_BYTES + 1);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  if (r.size > MAX_BYTES) throw new Error(`${path} is too large to edit here`);
  return { text: new TextDecoder().decode(r.bytes), modifiedAt: r.modifiedAt };
}

export async function loadRuleFiles(cwd: string): Promise<RuleFile[]> {
  return Promise.all(
    SETTINGS_FILES.map(async (path): Promise<RuleFile> => {
      try {
        const f = await readText(cwd, path);
        if (!f) return { path, exists: false, rules: empty(), error: null };
        try {
          return { path, exists: true, rules: parseRules(f.text), error: null };
        } catch (e) {
          return { path, exists: true, rules: empty(), error: e instanceof Error ? e.message : String(e) };
        }
      } catch (e) {
        return { path, exists: true, rules: empty(), error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

/** Creates .claude/ and the file when missing. Only reached for the two allowlisted settings paths. */
async function createMissing(cwd: string, path: SettingsFile): Promise<void> {
  try {
    await createEntry(cwd, "", ".claude", "directory");
  } catch {
    // .claude/ usually exists already; the file create below fails loudly if it really is unusable
  }
  await createEntry(cwd, ".claude", path.split("/").pop()!, "file");
}

async function save(cwd: string, path: SettingsFile, next: (text: string) => string): Promise<void> {
  assertSettingsPath(path);
  let f = await readText(cwd, path); // throws on any non-missing read error: never write on top of it
  if (!f) {
    const content = next("");
    await createMissing(cwd, path);
    f = await readText(cwd, path);
    if (!f) throw new Error(`Could not create ${path}`);
    if (f.text.trim()) throw new Error(`${path} appeared while saving. Reload and try again.`);
    return write(cwd, path, content, f.modifiedAt);
  }
  return write(cwd, path, next(f.text), f.modifiedAt);
}

async function write(cwd: string, path: SettingsFile, content: string, expectedModifiedAt: string): Promise<void> {
  const res = (await daemonClient.writeFile({ cwd, path, content, expectedModifiedAt })) as { status?: string; error?: string };
  if (res?.status === "conflict") throw new Error("The settings file changed on disk. Reload and try again.");
  if (res?.status === "error") throw new Error(res.error ?? "write failed");
}

export const removeSavedRule = (cwd: string, path: SettingsFile, list: RuleList, rule: string) =>
  save(cwd, path, (t) => removeRule(t, list, rule));

/** Adds to settings.local.json unless the caller explicitly passes the shared settings.json. */
export const addSavedRule = (cwd: string, list: RuleList, rule: string, path: SettingsFile = DEFAULT_SETTINGS_FILE) =>
  save(cwd, path, (t) => addRule(t, list, rule));
