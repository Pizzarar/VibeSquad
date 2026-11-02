// Lean per-spawn tool set for Claude agents (block 7). Measured with Paseo create_agent in a sandbox cwd:
// default claude spawn 37.3k first-turn tokens; with this set 10.8k. Deny rules drop tool schemas from the
// prompt; --strict-mcp-config drops user/project MCP servers (Paseo's own injected paseo MCP is kept and stays
// deferred); --disable-slash-commands drops the skills listing. Do not use `--tools`: it makes the paseo MCP
// schemas load eagerly (18.3k).
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

export const LEAN_ARGS = { "strict-mcp-config": null, "disable-slash-commands": null };

/** True unless the spawn opts out (env VS_LEAN=off) or is not a Claude spawn. */
export function leanApplies(provider, env) {
  if (String(provider || "").split("/")[0].trim().toLowerCase() !== "claude") return false;
  return String(env?.VS_LEAN || "").trim().toLowerCase() !== "off";
}

/** Merge the lean set into the caller's providerOptions (union of deny lists, caller extraArgs win). */
export function leanProviderOptions(existing) {
  const base = existing && typeof existing === "object" ? existing : {};
  const deny = [...new Set([...(Array.isArray(base.disallowedTools) ? base.disallowedTools : []), ...LEAN_DENY])];
  return { ...base, disallowedTools: deny, extraArgs: { ...LEAN_ARGS, ...(base.extraArgs ?? {}) } };
}
