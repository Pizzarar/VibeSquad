/** The plugin's before("agent.create") sees only { config, env }, never labels: carry role and profile in env. */
export function spawnEnvFor(labels: Record<string, string> | undefined): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  const role = (labels?.role ?? "").trim();
  if (role === "lead" || role === "brainstorm" || role === "worker") env.VS_ROLE = role;
  const profile = (labels?.profile ?? "").trim();
  if (profile) env.VS_PROFILE = profile;
  return Object.keys(env).length ? env : undefined;
}
