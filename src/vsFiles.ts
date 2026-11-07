// Files dock reads/lists via the VS server (GET /__vibesquad/fs/list|read), never the Paseo daemon:
// under the runner the daemon is not running, and a dead daemon must not look like "File not found".

export type VsEntry = { name: string; path: string; kind: "file" | "directory"; size?: number };
export type VsRead = { bytes: Uint8Array; mime: string; size: number; modifiedAt: string };

/** A real failure (backend down, 403, 500). `notFound` is only true for a genuine 404. */
export class VsFilesError extends Error {
  notFound: boolean;
  tooLarge: boolean;
  size?: number; // real byte size, carried on a 413
  constructor(message: string, notFound = false, tooLarge = false, size?: number) {
    super(message);
    this.notFound = notFound;
    this.tooLarge = tooLarge;
    this.size = size;
  }
}

async function call(kind: "list" | "read", cwd: string, path: string, extra = ""): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(`/__vibesquad/fs/${kind}?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}${extra}`);
  } catch (e) {
    throw new VsFilesError(`Can't read files: ${e instanceof Error ? e.message : String(e)} (is the VibeSquad server running?)`);
  }
  if (r.ok) return r;
  const j = await r.json().catch(() => ({}) as { error?: string; size?: number });
  const why = j.error || `HTTP ${r.status}`;
  if (r.status === 404 && j.error === "not found") throw new VsFilesError(`File not found: ${path}`, true);
  throw new VsFilesError(r.status === 413 ? why : `Can't read files: ${why}`, false, r.status === 413, typeof j.size === "number" ? j.size : undefined);
}

export async function vsListDirectory(cwd: string, path: string): Promise<{ entries: VsEntry[] }> {
  const r = await call("list", cwd, path);
  const j = await r.json();
  return { entries: j.entries ?? [] };
}

export async function vsReadFile(cwd: string, path: string, maxBytes?: number): Promise<VsRead> {
  const r = await call("read", cwd, path, maxBytes ? `&max=${maxBytes}` : "");
  const bytes = new Uint8Array(await r.arrayBuffer());
  return {
    bytes,
    mime: (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0],
    size: Number(r.headers.get("x-vs-size")) || bytes.length,
    modifiedAt: r.headers.get("x-vs-modified") ?? new Date().toISOString(),
  };
}

// ---- writes + watch (N2): owner-only POST /__vibesquad/fs/{write,create,rename,delete,duplicate}, GET fs/watch ----

export type VsWrite = { status: "ok" | "conflict" | "error"; modifiedAt?: string; error?: string };

async function post(op: "write" | "create" | "rename" | "delete" | "duplicate", body: Record<string, unknown>): Promise<{ status: number; json: { ok?: boolean; error?: string; conflict?: boolean; entryPath?: string; modifiedAt?: string } }> {
  let r: Response;
  try {
    r = await fetch(`/__vibesquad/fs/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new VsFilesError(`Can't change files: ${e instanceof Error ? e.message : String(e)} (is the VibeSquad server running?)`);
  }
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/** Overwrites an existing file. Resolves (never throws) on a conflict or a failed write, like the daemon call it replaces. */
export async function vsWriteFile(cwd: string, path: string, content: string, expectedModifiedAt?: string): Promise<VsWrite> {
  try {
    const { status, json } = await post("write", { cwd, path, content, ...(expectedModifiedAt ? { expectedModifiedAt } : {}) });
    if (json.ok) return { status: "ok", modifiedAt: json.modifiedAt };
    if (json.conflict) return { status: "conflict", error: json.error };
    return { status: "error", error: json.error || `HTTP ${status}` };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

async function entryOp(op: "create" | "rename" | "delete" | "duplicate", body: Record<string, unknown>): Promise<string> {
  const { status, json } = await post(op, body);
  if (!json.ok) throw new VsFilesError(json.error || `HTTP ${status}`, status === 404);
  return json.entryPath ?? "";
}
export const vsCreateEntry = (cwd: string, parentPath: string, name: string, kind: "file" | "directory") => entryOp("create", { cwd, parentPath, name, kind });
export const vsRenameEntry = (cwd: string, path: string, name: string) => entryOp("rename", { cwd, path, name });
export const vsDuplicateEntry = (cwd: string, path: string) => entryOp("duplicate", { cwd, path });
export const vsDeleteEntry = async (cwd: string, path: string) => { await entryOp("delete", { cwd, path }); };

const WATCH_RETRY_MS = 3000;

/**
 * Calls onChange whenever the file changes on disk (long-poll on fs/watch; one request at a time, aborted by the
 * returned stop()). Failures back off and retry, so a restarting server just resumes; the first poll is a baseline.
 */
export function vsWatchFile(cwd: string, path: string, onChange: () => void): () => void {
  const ac = new AbortController();
  const url = (since?: string) => `/__vibesquad/fs/watch?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
  void (async () => {
    let since: string | undefined;
    while (!ac.signal.aborted) {
      try {
        const r = await fetch(url(since), { signal: ac.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { seq?: string; changed?: boolean };
        if (ac.signal.aborted) return;
        const first = since === undefined;
        since = j.seq;
        if (j.changed && !first) onChange();
      } catch {
        if (ac.signal.aborted) return;
        await new Promise((res) => setTimeout(res, WATCH_RETRY_MS));
      }
    }
  })();
  return () => ac.abort();
}
