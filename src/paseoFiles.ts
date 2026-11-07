// File-entry wrappers (parity block D1) over the VS server's fs routes (N2); the Paseo daemon is not involved.
import { vsCreateEntry, vsDeleteEntry, vsDuplicateEntry, vsRenameEntry } from "./vsFiles";

export async function createEntry(cwd: string, parentPath: string, name: string, kind: "file" | "directory"): Promise<string | null> {
  return vsCreateEntry(cwd, parentPath, name, kind);
}

export async function renameEntry(cwd: string, path: string, name: string): Promise<string | null> {
  return vsRenameEntry(cwd, path, name);
}

export async function duplicateEntry(cwd: string, path: string): Promise<string | null> {
  return vsDuplicateEntry(cwd, path);
}

export async function deleteEntry(cwd: string, path: string): Promise<void> {
  await vsDeleteEntry(cwd, path);
}
