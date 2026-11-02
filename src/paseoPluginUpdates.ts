// Plugin update preview/apply wrappers (parity block P5). Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";

export type PluginUpdatePreviewRow = Awaited<ReturnType<typeof daemonClient.previewPluginUpdates>>[number];
export type PluginUpdateProposalRow = NonNullable<PluginUpdatePreviewRow["proposal"]>;
export type PluginUpdateResultRow = Awaited<ReturnType<typeof daemonClient.applyPluginUpdates>>[number];

export const previewPluginUpdates = () => daemonClient.previewPluginUpdates();
export const applyPluginUpdates = (proposals: PluginUpdateProposalRow[]) => daemonClient.applyPluginUpdates(proposals);
