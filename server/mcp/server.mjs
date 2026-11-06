// Minimal stdio MCP server (newline-delimited JSON-RPC 2.0, zero deps) exposing the VS agent tools.
//   node server/mcp/server.mjs      identity from env: VS_AGENT_ID (or PASEO_AGENT_ID), VS_TEAM, VS_LANE, VS_ROLE
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS, callTool, createContext } from "./tools.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "vibesquad", version: "1.0.0" };

export function toolList() {
  return Object.entries(ALL_TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
}

/** Handles one JSON-RPC message; resolves to the response object, or null for notifications. */
export async function handleMessage(ctx, msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined;
  const ok = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return ok({ protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: toolList() });
    case "tools/call": {
      const name = params?.name;
      if (!ALL_TOOLS[name]) return fail(-32602, `unknown tool "${name}"`);
      try {
        const result = await callTool(ctx, name, params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (err) {
        return ok({ content: [{ type: "text", text: String(err?.message ?? err) }], isError: true });
      }
    }
    default:
      return method?.startsWith("notifications/") ? null : fail(-32601, `method not found: ${method}`);
  }
}

export function serve({ input = process.stdin, output = process.stdout, ctx = createContext() } = {}) {
  const rl = readline.createInterface({ input });
  const pending = new Set();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    const p = handleMessage(ctx, msg).then((res) => { if (res) output.write(JSON.stringify(res) + "\n"); });
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
  return new Promise((resolve) => rl.on("close", () => Promise.allSettled([...pending]).then(resolve)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve().then(() => process.exit(0));
}
