/** The plugin's before("agent.create") sees only { config, env }, never labels: carry role and profile in env. */
export function spawnEnvFor(
  labels: Record<string, string> | undefined,
  provider?: string,
): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  const role = (labels?.role ?? "").trim();
  if (role === "lead" || role === "brainstorm" || role === "worker") env.VS_ROLE = role;
  const profile = (labels?.profile ?? "").trim();
  if (profile) env.VS_PROFILE = profile;
  const rawProvider = (provider ?? labels?.provider ?? "").trim().toLowerCase();
  if (rawProvider.startsWith("claude")) {
    env.CLAUDE_CODE_ENTRYPOINT = "Paseo";
  }
  return Object.keys(env).length ? env : undefined;
}
