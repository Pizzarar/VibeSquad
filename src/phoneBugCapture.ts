// E3 (docs/PLAN_ANDROID_END_STATE.md): the pure half of the phone bug sheet. Parks a card in the Squad's bug lane,
// uploads any screenshots, then delivers it through the existing inbox send path.
export type PhoneBugContext = { squad: string; lane?: string; hostId?: string };

/** Stamp line 1 of the card: where the report came from. `hostId` appears only once E4a supplies one. */
export function phoneBugStamp(ctx: PhoneBugContext): string {
  return ["📱 Android APK", `src=${ctx.squad}`, ctx.lane ? `lane=${ctx.lane}` : "", ctx.hostId ? `host=${ctx.hostId}` : ""].filter(Boolean).join(" · ");
}

export const PHONE_BUG_MAX_SHOTS = 4;
export const PHONE_BUG_MAX_BYTES = 8 * 1024 * 1024;
export const PHONE_BUG_MIMES = ["image/png", "image/jpeg", "image/webp"];

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function postJson(f: FetchFn, url: string, body: unknown): Promise<any> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** Park + attach + deliver. Resolves with the card id; a delivery failure leaves the card parked and reports `error`. */
export async function submitPhoneBug(
  args: { text: string; teamId: string; bugLaneId: string; ctx: PhoneBugContext; shots?: Blob[] },
  f: FetchFn = (u, i) => fetch(u, i),
): Promise<{ cardId: string; delivered: boolean; error?: string }> {
  const text = args.text.trim();
  if (!text) throw new Error("Describe the bug first");
  const added = await postJson(f, "/__vibesquad/inbox", {
    text: `${phoneBugStamp(args.ctx)}\n\n${text}`,
    teamId: args.teamId,
    laneId: args.bugLaneId,
    source: "phone-apk",
  });
  const cardId: string = added.added?.[0]?.id;
  if (!cardId) throw new Error("Card was not created");
  for (const shot of (args.shots ?? []).slice(0, PHONE_BUG_MAX_SHOTS)) {
    const r = await f(`/__vibesquad/inbox/attachment?cardId=${encodeURIComponent(cardId)}`, { method: "POST", headers: { "content-type": shot.type }, body: shot });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) return { cardId, delivered: false, error: j.error || `Screenshot upload failed (HTTP ${r.status})` };
  }
  try {
    await postJson(f, "/__vibesquad/inbox/send", { cardId });
    return { cardId, delivered: true };
  } catch (e) {
    return { cardId, delivered: false, error: String((e as Error).message) };
  }
}
