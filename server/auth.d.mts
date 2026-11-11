import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export const DEVICE_COOKIE: string;
export const UNPAIRED_MESSAGE: string;

export function tlsDir(): string;
export function detectLanIp(): string | null;
export function detectMeshnetIp(): string | null;
export function netConfig(): {
  port: number;
  meshnetIp: string | null;
  meshnetHost: string;
  lanIp: string | null;
};
export function hasDistIndex(rootDir?: string): boolean;
export function getAuthStatus(rootDir?: string): {
  ok: boolean;
  port: number;
  meshnetIp: string | null;
  meshnetHost: string;
  lanIp: string | null;
  detectLanIp: string | null;
  distReady: boolean;
  caFingerprint: { full: string | null; short: string | null };
  lanHttpsUrl: string | null;
  lanCaUrl: string | null;
  lanDesktopInstallerUrl: string | null;
  meshnetHttpsUrl: string;
  caHttpUrl: string | null;
  desktopSetupHttpUrl: string | null;
};
export function openssl(args: string[], cwd?: string): string;
export function ensureTls(cfg?: {
  meshnetIp?: string | null;
  meshnetHost?: string;
  lanIp?: string | null;
}): {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
};
export function getTls(): { key: Buffer; cert: Buffer; ca: Buffer };
export function caCrtPem(): Buffer | null;
export function caFingerprint(): { full: string | null; short: string | null };
export function parseCookies(header?: string): Record<string, string>;
export function authenticate(req: IncomingMessage): {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  tokenHash: string;
} | null;
export function isLocal(req: IncomingMessage): boolean;
export const LOCAL_COOKIE: string;
export const READ_ONLY_ERROR: string;
export function getLocalToken(): string;
export function hasLocalTokenHeader(req: IncomingMessage): boolean;
export function mintLocalLoginNonce(ttlMs?: number): string;
export function resetLocalLoginNoncesForTest(): void;
export function handleLocalLoginNonce(req: IncomingMessage, res: ServerResponse): void;
export function lockDownVibesquadHome(deps?: Record<string, unknown>): void;
export function resetLocalTokenForTest(): void;
export function hasLocalToken(req: IncomingMessage): boolean;
export function isLocalOwner(req: IncomingMessage): boolean;
export function handleLocalLogin(req: IncomingMessage, res: ServerResponse): void;
export function trackSocket(deviceId: string, socket: Duplex): void;
export function revokeDevice(id: string): boolean;
export function htmlPage(title: string, message: string): string;
export function sendUnpaired(req: IncomingMessage, res: ServerResponse): void;
export const CROSS_SITE_ERROR: string;
export function ownOrigin(req: IncomingMessage): string | null;
export function cookieWriteRefusal(req: IncomingMessage): string | null;
export function originRefusal(req: IncomingMessage): string | null;
export function sendCrossSiteRefused(req: IncomingMessage, res: ServerResponse): void;
export function handleCaCrt(req: IncomingMessage, res: ServerResponse): void;
export function handlePairStart(req: IncomingMessage, res: ServerResponse): Promise<void>;
export function handlePairRedeem(req: IncomingMessage, res: ServerResponse): void;
export function handleDevices(req: IncomingMessage, res: ServerResponse): void;
export function handleRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  readBody: (req: IncomingMessage) => Promise<any>,
): Promise<void>;
