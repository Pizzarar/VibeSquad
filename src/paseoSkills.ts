// Skills / custom commands / subagents / hooks wrappers (parity block J). Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";
import { DIRS, confineConfigPath, confineSettingsPath, validScopeCwd, type ConfigKind } from "./claudeConfigLogic";

const dec = new TextDecoder();

export type SkillsStatus = Awaited<ReturnType<typeof daemonClient.getAgentSkillsStatus>>;
export type SkillSelection = Parameters<typeof daemonClient.saveAgentSkillsSelection>[0];
export type SkillsSaveResult = Awaited<ReturnType<typeof daemonClient.saveAgentSkillsSelection>>;

export const getSkillsStatus = () => daemonClient.getAgentSkillsStatus();
export const reconcileSkills = () => daemonClient.reconcileAgentSkills();
export const uninstallSkills = () => daemonClient.uninstallAgentSkills();
export const saveSkillsSelection = (sel: SkillSelection, confirmedRemovals?: string[]) => daemonClient.saveAgentSkillsSelection(sel, confirmedRemovals);

export interface ConfigFile { name: string; path: string }
export interface ConfigDoc { text: string; modifiedAt: string; revision?: string }

// Every file operation below funnels through confineConfigPath / confineSettingsPath / validScopeCwd
// (pure, unit-tested): this UI is reachable from a phone, so names, paths and cwd are untrusted.
function scope(cwd: string): string {
  if (!validScopeCwd(cwd)) throw new Error("Refusing folder: must be a normalized absolute path");
  return cwd;
}

/** Markdown files in `<cwd>/.claude/<commands|agents>`. Entries with unsafe names are skipped; a missing dir is empty. */
export async function listConfigFiles(cwd: string, kind: ConfigKind): Promise<ConfigFile[]> {
  scope(cwd);
  let d;
  try {
    d = await daemonClient.listDirectory(cwd, DIRS[kind]);
  } catch {
    return [];
  }
  const out: ConfigFile[] = [];
  for (const e of d.entries ?? []) {
    if (e.kind !== "file") continue;
    try {
      // Re-derive from the file name, never from the daemon-reported path.
      out.push({ name: e.name, path: confineConfigPath(kind, e.name) });
    } catch {
      /* not a name this panel will touch */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readAt(cwd: string, path: string): Promise<ConfigDoc> {
  const r = await daemonClient.readFile(cwd, path, undefined, 512 * 1024);
  return { text: dec.decode(r.bytes), modifiedAt: r.modifiedAt, revision: r.revision };
}

export const readConfigDoc = (cwd: string, kind: ConfigKind, nameOrPath: string) => readAt(scope(cwd), confineConfigPath(kind, nameOrPath));

/** Read-only hook source; null when missing. */
export async function readSettingsDoc(cwd: string, name: string): Promise<ConfigDoc | null> {
  const path = confineSettingsPath(name);
  try {
    return await readAt(scope(cwd), path);
  } catch {
    return null;
  }
}

/** Create `<name>.md` (creating the .claude dirs as needed) with `content`. */
export async function createConfigDoc(cwd: string, kind: ConfigKind, name: string, content: string): Promise<string> {
  scope(cwd);
  const path = confineConfigPath(kind, name);
  const file = path.slice(DIRS[kind].length + 1);
  let parent = ".";
  for (const seg of DIRS[kind].split("/")) {
    // Already-exists is fine; a real failure surfaces when the file create below fails.
    await daemonClient.createFileEntry({ cwd, parentPath: parent, name: seg, kind: "directory" }).catch(() => null);
    parent = parent === "." ? seg : `${parent}/${seg}`;
  }
  const c = await daemonClient.createFileEntry({ cwd, parentPath: DIRS[kind], name: file, kind: "file" });
  if (!c.success) throw new Error(c.error || "Could not create file");
  const doc = await readAt(cwd, path);
  await saveAt(cwd, path, content, doc);
  return path;
}

async function saveAt(cwd: string, path: string, content: string, base: { modifiedAt: string; revision?: string }): Promise<ConfigDoc> {
  const r = await daemonClient.writeFile({ cwd, path, content, expectedModifiedAt: base.modifiedAt, expectedRevision: base.revision });
  if (r.status === "conflict") throw new Error("The file changed on disk since you opened it. Reopen it and retry.");
  if (r.status !== "written") throw new Error("Write failed");
  return { text: content, modifiedAt: r.modifiedAt, revision: r.revision };
}

export const saveConfigDoc = (cwd: string, kind: ConfigKind, nameOrPath: string, content: string, base: { modifiedAt: string; revision?: string }) =>
  saveAt(scope(cwd), confineConfigPath(kind, nameOrPath), content, base);

export async function deleteConfigDoc(cwd: string, kind: ConfigKind, nameOrPath: string): Promise<void> {
  const path = confineConfigPath(kind, nameOrPath);
  const r = await daemonClient.deleteFileEntry({ cwd: scope(cwd), path });
  if (!r.success) throw new Error(r.error || "Delete failed");
}
