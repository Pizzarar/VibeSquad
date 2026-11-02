// Skills / custom commands / subagents / hooks wrappers (parity block J). Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";

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

/** Markdown files in `<cwd>/<dir>`; a missing directory is an empty list, not an error. */
export async function listConfigFiles(cwd: string, dir: string): Promise<ConfigFile[]> {
  let d;
  try {
    d = await daemonClient.listDirectory(cwd, dir);
  } catch {
    return [];
  }
  return (d.entries ?? [])
    .filter((e) => e.kind === "file" && e.name.toLowerCase().endsWith(".md"))
    .map((e) => ({ name: e.name, path: e.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readConfigDoc(cwd: string, path: string): Promise<ConfigDoc> {
  const r = await daemonClient.readFile(cwd, path, undefined, 512 * 1024);
  return { text: dec.decode(r.bytes), modifiedAt: r.modifiedAt, revision: r.revision };
}

/** Like readConfigDoc but null when the file does not exist. */
export async function tryReadConfigDoc(cwd: string, path: string): Promise<ConfigDoc | null> {
  try {
    return await readConfigDoc(cwd, path);
  } catch {
    return null;
  }
}

/** Create `<dir>/<file>` (creating the .claude dirs as needed) with `content`. */
export async function createConfigDoc(cwd: string, dir: string, file: string, content: string): Promise<string> {
  let parent = ".";
  for (const seg of dir.split("/")) {
    // Already-exists is fine; a real failure surfaces when the file create below fails.
    await daemonClient.createFileEntry({ cwd, parentPath: parent, name: seg, kind: "directory" }).catch(() => null);
    parent = parent === "." ? seg : `${parent}/${seg}`;
  }
  const c = await daemonClient.createFileEntry({ cwd, parentPath: dir, name: file, kind: "file" });
  if (!c.success || !c.path) throw new Error(c.error || "Could not create file");
  const doc = await readConfigDoc(cwd, c.path);
  await saveConfigDoc(cwd, c.path, content, doc);
  return c.path;
}

export async function saveConfigDoc(cwd: string, path: string, content: string, base: { modifiedAt: string; revision?: string }): Promise<ConfigDoc> {
  const r = await daemonClient.writeFile({ cwd, path, content, expectedModifiedAt: base.modifiedAt, expectedRevision: base.revision });
  if (r.status === "conflict") throw new Error("The file changed on disk since you opened it. Reopen it and retry.");
  if (r.status !== "written") throw new Error("Write failed");
  return { text: content, modifiedAt: r.modifiedAt, revision: r.revision };
}

export async function deleteConfigDoc(cwd: string, path: string): Promise<void> {
  const r = await daemonClient.deleteFileEntry({ cwd, path });
  if (!r.success) throw new Error(r.error || "Delete failed");
}
