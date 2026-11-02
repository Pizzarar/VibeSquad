import { daemonClient, DEMO } from "./paseo";
import { MCP_FILE } from "./paseoMcpLogic";

export interface McpFileState {
  /** Raw file text; "" when the file doesn't exist yet. */
  text: string;
  exists: boolean;
  modifiedAt: string;
}

export interface DaemonMcpSection {
  enabled: boolean | undefined;
  injectIntoAgents: boolean;
  extraKeys: string[];
}

const demoFiles = new Map<string, string>();

/** Reads `<cwd>/.mcp.json` through the daemon file API. A missing file is an empty, creatable file. */
export async function readMcpFile(cwd: string): Promise<McpFileState> {
  if (DEMO) {
    const t = demoFiles.get(cwd) ?? '{\n  "mcpServers": {\n    "docs": { "type": "http", "url": "https://docs.example/mcp", "headers": { "Authorization": "Bearer demo-secret-token" } },\n    "files": { "type": "stdio", "command": "npx", "args": ["-y", "@demo/files"], "env": { "ROOT": "/work" } }\n  }\n}\n';
    return { text: t, exists: true, modifiedAt: "demo" };
  }
  try {
    const r = await daemonClient.readFile(cwd, MCP_FILE);
    return { text: new TextDecoder().decode(r.bytes), exists: true, modifiedAt: r.modifiedAt };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not.?found|no such file|ENOENT|missing|does not exist/i.test(msg)) return { text: "", exists: false, modifiedAt: "" };
    throw e;
  }
}

/** Writes `.mcp.json` (creating it first when absent). Throws on conflict / error so callers never think a write landed. */
export async function writeMcpFile(cwd: string, text: string, prev: McpFileState): Promise<void> {
  if (DEMO) {
    demoFiles.set(cwd, text);
    return;
  }
  let modifiedAt = prev.modifiedAt;
  if (!prev.exists) {
    // A retry after a failed first write finds the file already there: reuse it instead of creating again.
    const now = await readMcpFile(cwd);
    if (now.exists) modifiedAt = now.modifiedAt;
    else {
      const made = (await daemonClient.createFileEntry({ cwd, parentPath: "", name: MCP_FILE, kind: "file" })) as { success?: boolean; error?: string | null };
      if (made.success === false || made.error) throw new Error(made.error || "create failed");
      modifiedAt = (await daemonClient.readFile(cwd, MCP_FILE)).modifiedAt;
    }
  }
  const res = (await daemonClient.writeFile({ cwd, path: MCP_FILE, content: text, expectedModifiedAt: modifiedAt })) as { status?: string; error?: string };
  if (res.status === "conflict") throw new Error(".mcp.json changed on disk since it was loaded. Reload and redo the change.");
  if (res.status === "error") throw new Error(res.error || "write failed");
}

export async function readDaemonMcp(): Promise<DaemonMcpSection> {
  if (DEMO) return { enabled: true, injectIntoAgents: true, extraKeys: [] };
  const mcp = ((await daemonClient.getDaemonConfig()).config as { mcp?: Record<string, unknown> }).mcp ?? {};
  return {
    enabled: typeof mcp.enabled === "boolean" ? mcp.enabled : undefined,
    injectIntoAgents: mcp.injectIntoAgents === true,
    extraKeys: Object.keys(mcp).filter((k) => k !== "enabled" && k !== "injectIntoAgents"),
  };
}

/** Patches only the two known `mcp` toggles, then reloads the daemon config so agents spawned next see it. */
export async function patchDaemonMcp(patch: { enabled?: boolean; injectIntoAgents?: boolean }): Promise<string[]> {
  if (DEMO) return ["mcp"];
  await daemonClient.patchDaemonConfig({ mcp: patch });
  const r = await daemonClient.reloadDaemonConfig();
  return r.restartRequiredPaths.filter((p) => p === "mcp" || p.startsWith("mcp."));
}

/** Asks the daemon to re-read config.json; returns paths that need a full restart. */
export async function reloadDaemonMcp(): Promise<string[]> {
  if (DEMO) return [];
  return (await daemonClient.reloadDaemonConfig()).restartRequiredPaths.filter((p) => p === "mcp" || p.startsWith("mcp."));
}
