export function getVapidPath(): string;
export function getPushSubsPath(): string;
export function toBase64Url(input: Buffer | Uint8Array | string): string;
export function fromBase64Url(str: string): Buffer;
export function getOrCreateVapidKeys(): {
  publicKey: string;
  privateKey: string;
  jwk: { kty: string; crv: string; x: string; y: string; d: string };
  subject: string;
  createdAt: string;
};
export function buildVapidHeaders(
  endpoint: string,
  vapid?: ReturnType<typeof getOrCreateVapidKeys>,
  expSeconds?: number,
): { token: string; authorization: string };
export function encryptWebPushPayload(
  payload: string | Buffer,
  subscriptionKeys: { p256dh: string; auth: string },
  options?: { salt?: Buffer; asPrivateKey?: Buffer; recordSize?: number },
): { body: Buffer; salt: Buffer; asPublic: Buffer; cek: Buffer; nonce: Buffer };
export function decryptWebPushPayload(
  encryptedBody: Buffer,
  uaEcdh: import("node:crypto").ECDH,
  authSecretInput: string | Buffer,
): string;
export function readPushSubscriptions(): Array<{
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  createdAt: string;
  updatedAt: string;
}>;
export function writePushSubscriptions(subs: any[]): any[];
export function savePushSubscription(input: any): { ok: boolean; subCount: number; subscription: any };
export function removePushSubscription(endpointInput: any): { ok: boolean; removed: number; subCount: number };
export function sendWebPushToSubscription(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payloadObj: any,
  vapid?: ReturnType<typeof getOrCreateVapidKeys>,
): Promise<{ status: number }>;
export function broadcastWebPush(payloadObj: any): Promise<{
  ok: boolean;
  sent: number;
  failed: number;
  subCount: number;
  payload: any;
  errors?: string[];
}>;
export function sendTestPush(overrides?: Record<string, any>): Promise<{
  ok: boolean;
  sent: number;
  failed: number;
  subCount: number;
  payload: any;
  errors?: string[];
}>;
export function evaluateAgentTransition(prev: any, next: any, dedupeSet: Set<string>): Array<{
  title: string;
  body: string;
  url: string;
  tag: string;
  agentId: string;
  kind: string;
}>;
export function startPushWatcher(rootDir?: string, opts?: { runner?: unknown }): { stop(): Promise<void> };
export function watchRunnerTransitions(runner: { subscribeEvents(l: (ev: any) => void): () => void }, opts?: { dedupeSet?: Set<string>; notify?: (note: any) => void }): () => void;
export function syncRunnerPushWatch(rootDir?: string): Promise<unknown>;
export function pushKindEnabled(kind: string, pushEvents?: Partial<Record<"permission" | "needsYou" | "finished" | "errored", boolean>>): boolean;
