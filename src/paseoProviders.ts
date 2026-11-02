// Read-only provider catalog wrappers (parity block P2). Kept out of paseo.ts on purpose.
import { daemonClient } from "./paseo";

export type ProvidersAvailable = Awaited<ReturnType<typeof daemonClient.listAvailableProviders>>;
export type ProviderModelsPayload = Awaited<ReturnType<typeof daemonClient.listProviderModels>>;
export type ProviderModesPayload = Awaited<ReturnType<typeof daemonClient.listProviderModes>>;

export const listAvailableProviders = () => daemonClient.listAvailableProviders();
export const listProviderModels = (provider: string) => daemonClient.listProviderModels(provider);
export const listProviderModes = (provider: string) => daemonClient.listProviderModes(provider);
