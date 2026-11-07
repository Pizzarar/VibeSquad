// Live provider-feature changes for a running agent: no runner route exists, so a live change always fails.
// Pure logic lives in paseoFeaturesLogic.ts. The drawer re-reads the agent snapshot after each change.
import type { PaseoAgent } from "./agentTypes";
import { upsertLocalAgent } from "./paseo";
import { DEMO } from "./demoFlag";

export { describeError, featureChange, featureRows, turnNote } from "./paseoFeaturesLogic";
export type { FeatureRow } from "./paseoFeaturesLogic";

export async function setFeature(agent: PaseoAgent, featureId: string, value: boolean | string): Promise<void> {
  if (DEMO) {
    const features = (agent.features ?? []).map((f: any) => (f.id === featureId ? { ...f, value } : f));
    upsertLocalAgent({ ...agent, features } as PaseoAgent);
    return;
  }
  throw new Error("Live feature changes are not supported on runner agents yet.");
}
