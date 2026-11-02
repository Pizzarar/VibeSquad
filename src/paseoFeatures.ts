// Live provider-feature changes for a running agent: wrappers over daemonClient.
// Pure logic lives in paseoFeaturesLogic.ts. The drawer re-reads the agent snapshot after each change.
import type { PaseoAgent } from "@getpaseo/client";
import { DEMO, daemonClient, upsertLocalAgent } from "./paseo";
import { describeError, noticeText, supportsApplyConfig } from "./paseoFeaturesLogic";

export { describeError, featureChange, featureRows, noticeText, supportsApplyConfig, turnNote } from "./paseoFeaturesLogic";
export type { FeatureRow } from "./paseoFeaturesLogic";

export async function setFeature(agent: PaseoAgent, featureId: string, value: boolean | string): Promise<void> {
  if (DEMO) {
    const features = (agent.features ?? []).map((f: any) => (f.id === featureId ? { ...f, value } : f));
    upsertLocalAgent({ ...agent, features } as PaseoAgent);
    return;
  }
  await daemonClient.setAgentFeature(agent.id, featureId, value);
}

export type ConfigBundle = { modelId?: string | null; modeId?: string; thinkingOptionId?: string | null };

/** Applies model/mode/thinking in one request when the daemon supports it; else falls back to the single setters. */
export async function applyConfig(agent: PaseoAgent, config: ConfigBundle): Promise<string> {
  if (DEMO) {
    upsertLocalAgent({
      ...agent,
      ...(config.modelId !== undefined ? { model: config.modelId } : {}),
      ...(config.modeId !== undefined ? { currentModeId: config.modeId } : {}),
      ...(config.thinkingOptionId !== undefined ? { thinkingOptionId: config.thinkingOptionId } : {}),
    } as PaseoAgent);
    return "";
  }
  if (supportsApplyConfig(daemonClient.getLastServerInfoMessage()?.features)) {
    return noticeText(await daemonClient.applyAgentConfig(agent.id, config));
  }
  const notices: string[] = [];
  const applied: string[] = [];
  try {
    if (config.modelId !== undefined) { await daemonClient.setAgentModel(agent.id, config.modelId); applied.push("model"); }
    if (config.modeId !== undefined) { notices.push(noticeText(await daemonClient.setAgentMode(agent.id, config.modeId))); applied.push("mode"); }
    if (config.thinkingOptionId !== undefined) { notices.push(noticeText(await daemonClient.setAgentThinkingOption(agent.id, config.thinkingOptionId))); applied.push("thinking"); }
  } catch (e) {
    throw new Error(`${describeError(e)}${applied.length ? ` (${applied.join(", ")} already applied)` : ""}`);
  }
  return notices.filter(Boolean).join(" ");
}
