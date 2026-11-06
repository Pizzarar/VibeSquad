// The VS MCP server every runner agent gets. Resolved relative to this file so the repo and the runtime/ copy both work.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_SERVER_NAME = 'vibesquad';
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const mcpServerPath = () => path.resolve(HERE, '..', '..', 'server', 'mcp', 'server.mjs');

// Identity + storage env is passed explicitly: an MCP host may hand stdio servers only a minimal env.
const PASS = ['VS_AGENT_ID', 'PASEO_AGENT_ID', 'VS_TEAM', 'VS_LANE', 'VS_ROLE', 'VS_ORD', 'VIBESQUAD_HOME', 'PASEO_HOME', 'VS_RUNNER_LANES', 'VIBESQUAD_ROOT'];

export function mcpServerSpec({ env = process.env, path: serverPath = mcpServerPath() } = {}) {
  const out = {};
  for (const k of PASS) if (env?.[k]) out[k] = String(env[k]);
  return { name: MCP_SERVER_NAME, command: process.execPath, args: [serverPath], env: out };
}
