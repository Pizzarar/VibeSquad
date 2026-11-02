// Live provider-feature changes for a running agent: wrappers over daemonClient.
// Pure logic lives in paseoFeaturesLogic.ts. The drawer re-reads the agent snapshot after each change.
import type { PaseoAgent } from "@getpaseo/client";
import { DEMO, daemonClient, upsertLocalAgent } from "./paseo";

export { describeError, featureChange, featureRows, turnNote } from "./paseoFeaturesLogic";
export type { FeatureRow } from "./paseoFeaturesLogic";

export async function setFeature(agent: PaseoAgent, featureId: string, value: boolean | string): Promise<void> {
  if (DEMO) {
    const features = (agent.features ?? []).map((f: any) => (f.id === featureId ? { ...f, value } : f));
    upsertLocalAgent({ ...agent, features } as PaseoAgent);
    return;
  }
  await daemonClient.setAgentFeature(agent.id, featureId, value);
}
