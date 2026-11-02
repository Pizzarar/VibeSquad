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

export function parseRules(text: string | null | undefined): Rules {
  const out: Rules = { allow: [], deny: [], ask: [] };
  if (!text || !text.trim()) return out;
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("settings file is not valid JSON");
  }
  const perm = j && typeof j === "object" ? j.permissions : null;
  if (perm && typeof perm === "object") {
    for (const k of RULE_LISTS) if (Array.isArray(perm[k])) out[k] = perm[k].filter((x: unknown) => typeof x === "string");
  }
  return out;
}

/** Remove one rule from a list, keeping every other key (2-space JSON layout). */
export function removeRule(text: string, list: RuleList, rule: string): string {
  const j = JSON.parse(text);
  const arr = j?.permissions?.[list];
  if (!Array.isArray(arr)) return text;
  j.permissions[list] = arr.filter((r: unknown) => r !== rule);
  return JSON.stringify(j, null, 2) + "\n";
}

/** Add a rule (no duplicates), creating permissions/list when absent. Empty text starts a fresh file. */
export function addRule(text: string | null | undefined, list: RuleList, rule: string): string {
  const j = text && text.trim() ? JSON.parse(text) : {};
  if (!j.permissions || typeof j.permissions !== "object") j.permissions = {};
  const arr: string[] = Array.isArray(j.permissions[list]) ? j.permissions[list] : [];
  if (!arr.includes(rule)) arr.push(rule);
  j.permissions[list] = arr;
  return JSON.stringify(j, null, 2) + "\n";
}

/** Split "Bash(npm run test:*)" into tool + pattern for display. */
export function splitRule(rule: string): { tool: string; pattern: string } {
  const m = /^([^(]+?)(?:\((.*)\))?$/s.exec(rule.trim());
  return { tool: m?.[1] ?? rule, pattern: m?.[2] ?? "" };
}
