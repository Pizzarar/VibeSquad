// Pure helpers for MCP server management (.mcp.json parse / validate / edit / diff). No imports.

export const MCP_FILE = ".mcp.json";
export const MASKED = "••• hidden";

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerView {
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  /** `.mcp.json` has no per-server disabled flag; honoured when a `disabled: true` key is present. */
  enabled: boolean;
}

export interface McpDraft {
  name: string;
  transport: McpTransport;
  command: string;
  args: string; // one per line
  env: { key: string; value: string }[];
  url: string;
  headers: { key: string; value: string }[];
}

export interface ParsedMcpFile {
  doc: Record<string, unknown>;
  servers: McpServerView[];
  error: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) out[k] = typeof x === "string" ? x : String(x);
  return out;
};

export function toView(name: string, raw: unknown): McpServerView {
  const r = isObj(raw) ? raw : {};
  const t = typeof r.type === "string" ? r.type.toLowerCase() : "";
  const transport: McpTransport =
    t === "sse" ? "sse" : t === "http" || t === "streamable-http" || (!t && typeof r.url === "string" && !r.command) ? "http" : "stdio";
  return {
    name,
    transport,
    command: typeof r.command === "string" ? r.command : "",
    args: Array.isArray(r.args) ? r.args.map(String) : [],
    env: strMap(r.env),
    url: typeof r.url === "string" ? r.url : "",
    headers: strMap(r.headers),
    enabled: r.disabled !== true,
  };
}

/** Parses the text of a `.mcp.json`. Empty text is a valid empty file. */
export function parseMcpFile(text: string): ParsedMcpFile {
  const t = text.replace(/^﻿/, "").trim();
  if (!t) return { doc: {}, servers: [], error: null };
  let doc: unknown;
  try {
    doc = JSON.parse(t);
  } catch (e) {
    return { doc: {}, servers: [], error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObj(doc)) return { doc: {}, servers: [], error: "Top level must be a JSON object" };
  const m = doc.mcpServers;
  if (m !== undefined && !isObj(m)) return { doc, servers: [], error: '"mcpServers" must be an object' };
  const servers = Object.entries(m ?? {}).map(([n, v]) => toView(n, v));
  return { doc, servers, error: null };
}

export function emptyDraft(): McpDraft {
  return { name: "", transport: "stdio", command: "", args: "", env: [], url: "", headers: [] };
}

export function draftFromView(v: McpServerView): McpDraft {
  return {
    name: v.name,
    transport: v.transport,
    command: v.command,
    args: v.args.join("\n"),
    env: Object.entries(v.env).map(([key, value]) => ({ key, value })),
    url: v.url,
    headers: Object.entries(v.headers).map(([key, value]) => ({ key, value })),
  };
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function validateDraft(d: McpDraft, existing: string[], editing: string | null): string[] {
  const errs: string[] = [];
  const name = d.name.trim();
  if (!NAME_RE.test(name)) errs.push("Name: 1–64 letters, digits, _ . -");
  else if (name !== editing && existing.includes(name)) errs.push(`A server named "${name}" already exists`);
  if (d.transport === "stdio") {
    if (!d.command.trim()) errs.push("Command is required");
  } else {
    const u = d.url.trim();
    if (!u) errs.push("URL is required");
    else if (!/^https?:\/\/\S+$/i.test(u)) errs.push("URL must start with http:// or https://");
  }
  const pairs = d.transport === "stdio" ? d.env : d.headers;
  const keys = new Set<string>();
  for (const p of pairs) {
    const k = p.key.trim();
    if (!k) {
      if (p.value) errs.push("Every value needs a key");
      continue;
    }
    if (keys.has(k)) errs.push(`Duplicate key "${k}"`);
    keys.add(k);
  }
  return errs;
}

function pairsToMap(p: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of p) if (key.trim()) out[key.trim()] = value;
  return out;
}

/** The `.mcp.json` entry for a draft, merged over the old entry so unknown keys survive an edit. */
export function draftToConfig(d: McpDraft, previous?: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = isObj(previous) ? { ...previous } : {};
  for (const k of ["type", "command", "args", "env", "url", "headers"]) delete base[k];
  if (d.transport === "stdio") {
    const args = d.args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean);
    const env = pairsToMap(d.env);
    return { type: "stdio", command: d.command.trim(), ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}), ...base };
  }
  const headers = pairsToMap(d.headers);
  return { type: d.transport, url: d.url.trim(), ...(Object.keys(headers).length ? { headers } : {}), ...base };
}

export type McpOp =
  | { kind: "upsert"; name: string; config: Record<string, unknown>; renameFrom?: string }
  | { kind: "remove"; name: string };

/** New file text after the op. Keeps other top-level keys and the other servers' order. */
export function applyOp(doc: Record<string, unknown>, op: McpOp): string {
  const old = isObj(doc.mcpServers) ? (doc.mcpServers as Record<string, unknown>) : {};
  const servers: Record<string, unknown> = {};
  if (op.kind === "remove") {
    for (const [k, v] of Object.entries(old)) if (k !== op.name) servers[k] = v;
  } else {
    const from = op.renameFrom ?? op.name;
    let placed = false;
    for (const [k, v] of Object.entries(old)) {
      if (k === from) {
        servers[op.name] = op.config;
        placed = true;
      } else if (k !== op.name) servers[k] = v;
    }
    if (!placed) servers[op.name] = op.config;
  }
  return JSON.stringify({ ...doc, mcpServers: servers }, null, 2) + "\n";
}

/** Same document with every env / headers value masked (for display and diff previews). */
export function maskDoc(doc: unknown): unknown {
  if (Array.isArray(doc)) return doc.map(maskDoc);
  if (!isObj(doc)) return doc;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if ((k === "env" || k === "headers") && isObj(v)) out[k] = Object.fromEntries(Object.keys(v).map((x) => [x, MASKED]));
    else out[k] = maskDoc(v);
  }
  return out;
}

export function maskedJson(doc: unknown): string {
  return JSON.stringify(maskDoc(doc), null, 2) + "\n";
}

export interface DiffLine {
  sign: " " | "+" | "-";
  text: string;
}

/** Line diff (LCS) with unchanged context trimmed to `ctx` lines around changes. */
export function diffLines(before: string, after: string, ctx = 2): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      all.push({ sign: " ", text: a[i] });
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) all.push({ sign: "-", text: a[i++] });
    else all.push({ sign: "+", text: b[j++] });
  }
  while (i < n) all.push({ sign: "-", text: a[i++] });
  while (j < m) all.push({ sign: "+", text: b[j++] });
  const keep = new Array(all.length).fill(false);
  all.forEach((l, x) => {
    if (l.sign !== " ") for (let y = Math.max(0, x - ctx); y <= Math.min(all.length - 1, x + ctx); y++) keep[y] = true;
  });
  return all.filter((_, x) => keep[x]);
}

export const hasChanges = (d: DiffLine[]) => d.some((l) => l.sign !== " ");
