// Files dock reads/lists via the VS server (GET /__vibesquad/fs/list|read), never the Paseo daemon:
// under the runner the daemon is not running, and a dead daemon must not look like "File not found".

export type VsEntry = { name: string; path: string; kind: "file" | "directory"; size?: number };
export type VsRead = { bytes: Uint8Array; mime: string; size: number; modifiedAt: string };

/** A real failure (backend down, 403, 500). `notFound` is only true for a genuine 404. */
export class VsFilesError extends Error {
  notFound: boolean;
  tooLarge: boolean;
  constructor(message: string, notFound = false, tooLarge = false) {
    super(message);
    this.notFound = notFound;
    this.tooLarge = tooLarge;
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
  const j = await r.json().catch(() => ({}) as { error?: string });
  const why = j.error || `HTTP ${r.status}`;
  if (r.status === 404 && j.error === "not found") throw new VsFilesError(`File not found: ${path}`, true);
  throw new VsFilesError(r.status === 413 ? why : `Can't read files: ${why}`, false, r.status === 413);
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
