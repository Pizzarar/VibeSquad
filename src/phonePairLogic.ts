// E4b (docs/PLAN_ANDROID_END_STATE.md): pure rules behind the phone `⋯` "Pair another device / Devices" sheet.
// Kept free of React so test/sec-phone-mint-pair.test.mjs can exercise the cascade warning and formatting directly.

export type PhoneDevice = {
  id: string;
  name: string;
  createdAt?: string;
  lastSeenAt?: string;
  /** The paired device that minted this one's code (E4b), or null for PC / CLI-minted devices. */
  mintedByDeviceId: string | null;
  current?: boolean;
};

export type PendingPair = { pendingId: string; name: string; ip: string; createdAt: string; expiresInMs: number };

/** Every device whose minting chain leads back to `id` (not `id` itself). Cycle-safe; order = list order. */
export function descendantsOf(devices: PhoneDevice[], id: string): PhoneDevice[] {
  const inTree = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of devices) {
      if (!inTree.has(d.id) && d.mintedByDeviceId && inTree.has(d.mintedByDeviceId)) {
        inTree.add(d.id);
        grew = true;
      }
    }
  }
  return devices.filter((d) => d.id !== id && inTree.has(d.id));
}

/** The second-tap warning for a revoke that cascades, or null when nothing else goes. */
export function cascadeWarning(devices: PhoneDevice[], id: string): string | null {
  const kids = descendantsOf(devices, id);
  if (!kids.length) return null;
  const names = kids.map((d) => d.name).slice(0, 4).join(", ");
  const more = kids.length > 4 ? ` +${kids.length - 4} more` : "";
  return `Also revokes ${kids.length} device${kids.length === 1 ? "" : "s"} it paired: ${names}${more}.`;
}

/** "123456" -> "123 456" (anything else is returned as typed). */
export const formatPairCode = (code: string): string => (/^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** Whole seconds until `expiresAt` (epoch ms), never negative. */
export const secondsLeft = (expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / 1000));

/** Short relative time for the device list ("just now", "5m ago", "3h ago", "2d ago", "never"). */
export function agoLabel(iso: string | undefined, now: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Name of the device that minted `d`, for the "via <name>" chip. */
export function mintedByLabel(devices: PhoneDevice[], d: PhoneDevice): string | null {
  if (!d.mintedByDeviceId) return null;
  return devices.find((x) => x.id === d.mintedByDeviceId)?.name ?? "a revoked device";
}
