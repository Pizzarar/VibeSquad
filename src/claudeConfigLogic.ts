// Pure helpers for the Skills panel (custom slash commands, subagents, hooks view). No imports.
// Claude Code formats: .claude/commands/<name>.md and .claude/agents/<name>.md are markdown files
// with optional YAML frontmatter. Only flat `key: value` lines are handled; unknown keys are kept
// verbatim so editing a hand-written file never drops fields.

export type ConfigKind = "command" | "agent";
export const DIRS: Record<ConfigKind, string> = { command: ".claude/commands", agent: ".claude/agents" };
export const SUBAGENT_MODELS = ["", "inherit", "sonnet", "opus", "haiku"] as const;

export interface Parsed {
  fields: Record<string, string>;
  order: string[];
  body: string;
}

export function parseFrontmatter(text: string): Parsed {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(src);
  if (!m) return { fields: {}, order: [], body: src };
  const fields: Record<string, string> = {};
  const order: string[] = [];
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v[0] === '"' ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : v.slice(1, -1).replace(/''/g, "'");
    }
    if (!(kv[1] in fields)) order.push(kv[1]);
    fields[kv[1]] = v;
  }
  return { fields, order, body: m[2] };
}

function needsQuote(v: string): boolean {
  return /^[\s'"[\]{}>|*&!%@`#-]/.test(v) || /:\s|\s#|\s$/.test(v) || /^(true|false|null|yes|no|~)$/i.test(v) || /^[\d.+-]+$/.test(v);
}
function yamlValue(v: string): string {
  return needsQuote(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

/** Empty values are omitted. Known keys first (in `known` order), then the rest in original order. */
export function serializeFrontmatter(fields: Record<string, string>, body: string, known: string[], order: string[] = []): string {
  const keys = [...known, ...order.filter((k) => !known.includes(k)), ...Object.keys(fields).filter((k) => !known.includes(k) && !order.includes(k))];
  const lines = keys.filter((k) => (fields[k] ?? "").trim() !== "").map((k) => `${k}: ${yamlValue(fields[k].replace(/\r?\n/g, " ").trim())}`);
  const head = lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
  return `${head}${body.replace(/^\n+/, "").replace(/\s+$/, "")}\n`;
}

export const COMMAND_KEYS = ["description", "argument-hint", "allowed-tools", "model"];
export const AGENT_KEYS = ["name", "description", "tools", "model"];

/** File stem rules: lowercase letters, digits, hyphens. */
export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.md$/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
export function validName(n: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n) && n.length <= 64;
}
export const fileNameFor = (name: string) => `${name}.md`;
export const stemOf = (file: string) => file.replace(/\.md$/, "");

export function validateCommand(name: string, fields: Record<string, string>, body: string, existing: string[], editing: string | null): string | null {
  if (!validName(name)) return "Name: lowercase letters, digits and hyphens only (max 64).";
  if (name !== editing && existing.includes(name)) return `A command named /${name} already exists.`;
  if (!body.trim() && !(fields.description ?? "").trim()) return "Add a prompt body (or at least a description).";
  return null;
}

export function validateAgent(name: string, fields: Record<string, string>, body: string, existing: string[], editing: string | null): string | null {
  if (!validName(name)) return "Name: lowercase letters, digits and hyphens only (max 64).";
  if (name !== editing && existing.includes(name)) return `A subagent named ${name} already exists.`;
  if (!(fields.description ?? "").trim()) return "Description is required: it tells Claude when to delegate to this subagent.";
  if (!body.trim()) return "Add the subagent's system prompt.";
  return null;
}

export function commandTemplate(name: string): { fields: Record<string, string>; body: string } {
  return {
    fields: { description: `Describe what /${name} does`, "argument-hint": "[optional arguments]" },
    body: "Do the task described below. Anything the user typed after the command is in $ARGUMENTS.\n\n$ARGUMENTS",
  };
}
export function agentTemplate(name: string): { fields: Record<string, string>; body: string } {
  return {
    fields: { name, description: "Use this agent when ... (say when Claude should delegate to it)", tools: "Read, Grep, Glob" },
    body: "You are a specialist in ...\n\nWhen invoked:\n1. ...\n2. ...",
  };
}

export interface HookRow { event: string; matcher: string; type: string; command: string; source: string }

/** Flatten a parsed settings.json `hooks` block into display rows. Tolerates malformed shapes. */
export function hookRows(settings: unknown, source: string): HookRow[] {
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const rows: HookRow[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const grp = g as { matcher?: unknown; hooks?: unknown } | null;
      const matcher = typeof grp?.matcher === "string" ? grp.matcher : "";
      if (!Array.isArray(grp?.hooks)) continue;
      for (const h of grp.hooks as Record<string, unknown>[]) {
        const type = typeof h?.type === "string" ? h.type : "command";
        const command = typeof h?.command === "string" ? h.command : typeof h?.prompt === "string" ? h.prompt : typeof h?.url === "string" ? h.url : "";
        rows.push({ event, matcher, type, command, source });
      }
    }
  }
  return rows;
}

export function parseSettingsJson(text: string): { value: unknown; error: string | null } {
  try {
    return { value: JSON.parse(text.replace(/^﻿/, "")), error: null };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) };
  }
}
