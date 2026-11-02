// Pure logic for plan approvals, "always allow" scope and .claude settings allow rules (parity block H).
// Dependency-free so node --test can import it.

export type Scope = "session" | "local" | "project" | "user";

const DEST_SCOPE: Record<string, Scope> = {
  session: "session",
  localSettings: "local",
  projectSettings: "project",
  userSettings: "user",
};

export const SCOPE_LABEL: Record<Scope, string> = {
  session: "this session",
  local: "this project (private)",
  project: "this project (shared)",
  user: "all projects",
};

export function suggestionScope(s: any): Scope {
  const d = typeof s?.destination === "string" ? s.destination : "session";
  return DEST_SCOPE[d] ?? "session";
}

function ruleText(r: any): string {
  const tool = String(r?.toolName ?? r?.tool ?? "");
  if (!tool) return "";
  return r?.ruleContent ? `${tool}(${r.ruleContent})` : tool;
}

/** Label for an "always allow" suggestion that names both the rule and where it is saved. */
export function suggestionLabel(s: any): string {
  const scope = SCOPE_LABEL[suggestionScope(s)];
  if (s?.type === "setMode") return `Switch mode to ${s.mode} · ${scope}`;
  const rules: string[] = Array.isArray(s?.rules) ? s.rules.map(ruleText).filter(Boolean) : [];
  const verb = s?.behavior === "deny" ? "Always deny" : "Always allow";
  if (rules.length) return `${verb} ${rules.join(", ")} · ${scope}`;
  const base = s?.label ?? s?.description;
  return base ? `${base} · ${scope}` : `${verb} · ${scope}`;
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

export type PlanAction = { id: string; label: string; behavior: "allow" | "deny"; variant?: string; intent?: string };

/** Approving actions first, deny-ish ones last. Keeps server order within each group. */
export function orderPlanActions(actions: PlanAction[]): PlanAction[] {
  return [...actions.filter((a) => a.behavior === "allow"), ...actions.filter((a) => a.behavior !== "allow")];
}

export function buildPlanApprove(action?: PlanAction, editedPlan?: string, input?: Record<string, unknown>) {
  const r: Record<string, unknown> = { behavior: "allow" };
  if (action) r.selectedActionId = action.id;
  if (editedPlan !== undefined) r.updatedInput = { ...(input ?? {}), plan: editedPlan };
  return r;
}

/** "Keep planning": a deny carrying the user's feedback; interrupt=false so the agent keeps going and revises. */
export function buildKeepPlanning(feedback: string, action?: PlanAction) {
  const msg = feedback.trim();
  const r: Record<string, unknown> = { behavior: "deny", interrupt: false };
  if (action) r.selectedActionId = action.id;
  r.message = msg || "Keep planning. Revise the plan before implementing.";
  return r;
}

/** Edited text only counts as an edit when it differs from the original. */
export function planWasEdited(original: string, edited: string): boolean {
  return edited.trim().length > 0 && edited !== original;
}

// ─── .claude settings allow rules ─────────────────────────────────────────────

export type RuleList = "allow" | "deny" | "ask";
export type Rules = Record<RuleList, string[]>;
export const RULE_LISTS: RuleList[] = ["allow", "deny", "ask"];
export const SETTINGS_FILES = [".claude/settings.local.json", ".claude/settings.json"] as const;
export type SettingsFile = (typeof SETTINGS_FILES)[number];
export const DEFAULT_SETTINGS_FILE: SettingsFile = SETTINGS_FILES[0];

export function isSettingsFile(path: string): path is SettingsFile {
  return (SETTINGS_FILES as readonly string[]).includes(path);
}

/** Parse a settings file into its root object. Refuses anything that is not a plain JSON object so we never overwrite it. */
export function parseSettingsObject(text: string | null | undefined): Record<string, any> {
  if (!text || !text.trim()) return {};
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("settings file is not valid JSON");
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) throw new Error("settings file is not a JSON object");
  const p = j.permissions;
  if (p !== undefined && (p === null || typeof p !== "object" || Array.isArray(p))) {
    throw new Error("settings file has a permissions value that is not an object");
  }
  return j;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const RULE_SHAPE = /^([A-Za-z0-9_*.-]+)(?:\(([\s\S]+)\))?$/;

/**
 * Check a rule against Claude Code permission syntax: ToolName or ToolName(pattern), e.g. Bash(npm run test:*),
 * Read(./src/**), WebFetch(domain:x), mcp__server__tool. Returns an error message, or null when valid.
 */
export function validateRule(rule: string, list: RuleList = "allow"): string | null {
  const r = rule.trim();
  if (!r) return "Rule cannot be empty";
  if (CONTROL_CHARS.test(r)) return "Rule cannot contain newlines or control characters";
  const m = RULE_SHAPE.exec(r);
  if (!m) return "Rule must be ToolName or ToolName(pattern)";
  const tool = m[1];
  const pattern = m[2];
  let depth = 0;
  for (const ch of pattern ?? "") {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return "Rule has unbalanced parentheses";
  }
  if (depth !== 0) return "Rule has unbalanced parentheses";
  if (pattern !== undefined && tool.startsWith("mcp__")) return "mcp__ rules cannot have a (pattern)";
  if (list === "allow" && tool.includes("*") && !/^mcp__[^*]+__/.test(tool)) {
    return "Allow rules may only use * in the tool name after mcp__<server>__";
  }
  return null;
}

export function parseRules(text: string | null | undefined): Rules {
  const out: Rules = { allow: [], deny: [], ask: [] };
  const perm = parseSettingsObject(text).permissions;
  if (perm) for (const k of RULE_LISTS) if (Array.isArray(perm[k])) out[k] = perm[k].filter((x: unknown) => typeof x === "string");
  return out;
}

/** Remove one rule from a list, keeping every other key (2-space JSON layout). */
export function removeRule(text: string, list: RuleList, rule: string): string {
  const j = parseSettingsObject(text);
  const arr = j.permissions?.[list];
  if (!Array.isArray(arr)) return text;
  j.permissions[list] = arr.filter((r: unknown) => r !== rule);
  return JSON.stringify(j, null, 2) + "\n";
}

/** Add a validated rule (no duplicates), creating permissions/list when absent. Empty text starts a fresh file. */
export function addRule(text: string | null | undefined, list: RuleList, rule: string): string {
  const bad = validateRule(rule, list);
  if (bad) throw new Error(bad);
  const j = parseSettingsObject(text);
  if (!j.permissions) j.permissions = {};
  const arr: string[] = Array.isArray(j.permissions[list]) ? j.permissions[list] : [];
  const r = rule.trim();
  if (!arr.includes(r)) arr.push(r);
  j.permissions[list] = arr;
  return JSON.stringify(j, null, 2) + "\n";
}

/** Split "Bash(npm run test:*)" into tool + pattern for display. */
export function splitRule(rule: string): { tool: string; pattern: string } {
  const m = RULE_SHAPE.exec(rule.trim());
  return { tool: m?.[1] ?? rule, pattern: m?.[2] ?? "" };
}
