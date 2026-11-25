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
  // R1 fix r2b: the env twins of labels.stakes / labels["vs.route-override"] (server/route-override.mjs ROUTE_OVERRIDE_ENV); the hook reads the label first, then these.
  const stakes = (labels?.stakes ?? "").trim();
  if (stakes) env.VS_STAKES = stakes;
  const override = (labels?.["vs.route-override"] ?? "").trim();
  if (override) env.VS_ROUTE_OVERRIDE = override;
  const rawProvider = (provider ?? labels?.provider ?? "").trim().toLowerCase();
  if (rawProvider.startsWith("claude")) {
    env.CLAUDE_CODE_ENTRYPOINT = "Paseo";
  }
  return Object.keys(env).length ? env : undefined;
}
