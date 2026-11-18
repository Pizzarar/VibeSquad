// Is a sky TV (RiffBot / Overlord) taken over right now? SkyZones keeps its open state local and mirrors it on
// [data-testid="sky-zones"][data-open]; read that attribute (same signal DrawerHeader uses) so App can keep the PinRail
// mounted while a TV chat is open: the taken-over chat's drawer controls portal into the rail's card slot (src/pinSlots.ts).
import { useEffect, useState } from "react";

const read = () => {
  if (typeof document === "undefined") return false;
  const open = document.querySelector('[data-testid="sky-zones"]')?.getAttribute("data-open");
  return !!open && open !== "none";
};

/** `recheck` changes whenever the sky may have (re)mounted; the observer covers every later open/close. */
export function useSkyTakeover(recheck: unknown): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const sync = () => setOpen(read());
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-open"], subtree: true });
    return () => mo.disconnect();
  }, [recheck]);
  return open;
}
