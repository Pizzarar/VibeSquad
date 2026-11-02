// Live provider-feature changes for a running agent: wrappers over daemonClient.
// Pure logic lives in paseoFeaturesLogic.ts. The drawer re-reads the agent snapshot after each change.
import type { PaseoAgent } from "@getpaseo/client";
import { DEMO, daemonClient, upsertLocalAgent } from "./paseo";
import { supportsApplyConfig } from "./paseoFeaturesLogic.ts";

export { describeError, featureChange, featureRows, noticeText, supportsApplyConfig, turnNote } from "./paseoFeaturesLogic.ts";
export type { FeatureRow } from "./paseoFeaturesLogic.ts";

export async function setFeature(agent: PaseoAgent, featureId: string, value: boolean | string): Promise<void> {
  if (DEMO) {
    const features = ((agent as any).features ?? []).map((f: any) => (f.id === featureId ? { ...f, value } : f));
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
  let notice: { type: string; message: string } | null = null;
  if (supportsApplyConfig(daemonClient.getLastServerInfoMessage()?.features)) {
    notice = await daemonClient.applyAgentConfig(agent.id, config);
  } else {
    if (config.modelId !== undefined) await daemonClient.setAgentModel(agent.id, config.modelId);
    if (config.modeId !== undefined) notice = await daemonClient.setAgentMode(agent.id, config.modeId);
    if (config.thinkingOptionId !== undefined) notice = (await daemonClient.setAgentThinkingOption(agent.id, config.thinkingOptionId)) ?? notice;
  }
  return notice?.message ? `${notice.type}: ${notice.message}` : "";
}
