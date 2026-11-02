// Lean per-spawn tool set for Claude agents (block 7). Deny rules drop tool schemas from the prompt.
// MCP servers (Godot, Playwright, paseo) and skills stay on for everyone: no --strict-mcp-config, no
// --disable-slash-commands, and Skill is never denied. Buddies (role=brainstorm) keep AskUserQuestion.
// Do not use `--tools`: it makes the paseo MCP schemas load eagerly.
export const LEAN_DENY = [
  "Workflow",
  "PowerShell",
  "Agent",
  "ScheduleWakeup",
  "ReportFindings",
  "AskUserQuestion",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Monitor",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "SendMessage",
  "TaskStop",
  "RemoteTrigger",
  "PushNotification",
  "DesignSync",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
];

export const LEAN_ARGS = {};

/** True unless the spawn opts out (env VS_LEAN=off) or is not a Claude spawn. */
export function leanApplies(provider, env) {
  if (String(provider || "").split("/")[0].trim().toLowerCase() !== "claude") return false;
  return String(env?.VS_LEAN || "").trim().toLowerCase() !== "off";
}

/** Merge the lean set into the caller's providerOptions (union of deny lists, caller extraArgs win). */
export function leanProviderOptions(existing, role) {
  const base = existing && typeof existing === "object" ? existing : {};
  const deny = [...new Set([...(Array.isArray(base.disallowedTools) ? base.disallowedTools : []), ...LEAN_DENY.filter((t) => !(role === "brainstorm" && t === "AskUserQuestion"))])];
  const out = { ...base, disallowedTools: deny };
  if (base.extraArgs) out.extraArgs = { ...LEAN_ARGS, ...base.extraArgs };
  return out;
}
