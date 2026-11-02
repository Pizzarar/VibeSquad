// File-entry + terminal wrappers (parity block D1). Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";

type Result = { success: boolean; error: string | null };

function unwrap<T extends Result>(res: T): T {
  if (!res.success) throw new Error(res.error || "Request failed");
  return res;
}

export async function createEntry(cwd: string, parentPath: string, name: string, kind: "file" | "directory"): Promise<string | null> {
  const r = unwrap(await daemonClient.createFileEntry({ cwd, parentPath, name, kind }));
  return r.path;
}

export async function renameEntry(cwd: string, path: string, name: string): Promise<string | null> {
  const r = unwrap(await daemonClient.renameFileEntry({ cwd, path, name }));
  return r.renamedPath;
}

export async function duplicateEntry(cwd: string, path: string): Promise<string | null> {
  const r = unwrap(await daemonClient.duplicateFileEntry({ cwd, path }));
  return r.duplicatedPath;
}

export async function deleteEntry(cwd: string, path: string): Promise<void> {
  unwrap(await daemonClient.deleteFileEntry({ cwd, path }));
}

export async function renameTerminalTitle(terminalId: string, title: string): Promise<void> {
  unwrap(await daemonClient.renameTerminal({ terminalId, title }));
}

export async function captureTerminalLines(terminalId: string): Promise<string[]> {
  const r = await daemonClient.captureTerminal(terminalId, { stripAnsi: true });
  return r.lines;
}
