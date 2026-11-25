// usa-57: phone Usage view open/close store. Same shape as the Storybook store (StorybookView.tsx): module state mirrored in
// the URL (?usage=1) with one pushed history entry, so Back / browser Back / Esc close it and a reload keeps it.
import { useSyncExternalStore } from "react";

let open = false;
let pushed = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const urlOpen = (): boolean => typeof location !== "undefined" && new URLSearchParams(location.search).get("usage") === "1";
const withUsage = (on: boolean): string => {
  const p = new URLSearchParams(location.search);
  if (on) p.set("usage", "1"); else p.delete("usage");
  const q = p.toString();
  return `${location.pathname}${q ? `?${q}` : ""}${location.hash}`;
};

export function openPhoneUsage(): void {
  if (open) return;
  open = true;
  history.pushState({ usage: 1 }, "", withUsage(true));
  pushed = true;
  emit();
}
/** User Back/Esc/close button: undo our own pushed entry while it is still current; otherwise strip ?usage= in place. */
export function closePhoneUsage(): void {
  if (!open) return;
  const mine = pushed && urlOpen() && history.state?.usage === 1;
  open = false;
  pushed = false;
  if (mine) history.back(); // popstate finds no ?usage= and open is already false: nothing more to do
  else if (urlOpen() || history.state?.usage) history.replaceState(null, "", withUsage(false));
  emit();
}
export const isPhoneUsageOpen = (): boolean => open;
if (typeof window !== "undefined") {
  open = urlOpen(); // reload / shared link
  window.addEventListener("popstate", () => {
    const now = urlOpen();
    if (now !== open) { open = now; if (!now) pushed = false; emit(); }
  });
}
export function usePhoneUsageOpen(): boolean {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => open, () => false);
}
