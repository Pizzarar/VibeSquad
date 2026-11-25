// Crunch mode writer (PLAN_CRUNCH_MODE C3, fix round r1). Pure logic, deps injected so it is unit-testable without React.
// Writes are chained per Squad: one PUT at a time, so a second click can never race a first one into a 409 whose stale
// updater would re-apply the older value (and fire an extra C2 wake wave). A failed save rolls the local copy back.
export type CrunchDeps = {
  /** Writes vibeMode=on for the team; resolves {disk:false} when the registry write did not land. */
  save: (teamId: string, on: boolean) => Promise<{ disk: boolean }>;
  /** Drops the optimistic local copy and returns to the registry file. */
  rollback: () => void;
};

export function createCrunchSetter(deps: CrunchDeps) {
  const tails = new Map<string, Promise<unknown>>();
  return function setCrunch(teamId: string, on: boolean): Promise<boolean> {
    const run = (tails.get(teamId) ?? Promise.resolve()).then(async () => {
      let ok = false;
      try {
        ok = (await deps.save(teamId, on)).disk;
      } catch {
        ok = false;
      }
      if (!ok) deps.rollback();
      return ok;
    });
    const tail = run.catch(() => undefined);
    tails.set(teamId, tail);
    void tail.then(() => { if (tails.get(teamId) === tail) tails.delete(teamId); });
    return run;
  };
}

export type CrunchPaletteItem = { id: string; kind: "action"; label: string; hint: string };

/**
 * C3: "Turn Crunch on/off · <Squad>". Only the current Squad is offered by default (a bare "crunch" + Enter must never flip another
 * Squad); other Squads appear only when the query also matches their name. No current Squad: nothing unless a name is typed.
 */
export function crunchPaletteItems(squads: { id: string; name: string; on: boolean }[], currentId: string | null, q: string): CrunchPaletteItem[] {
  const needle = q.trim().toLowerCase();
  return squads
    .filter((s) => s.id === currentId || (needle !== "" && needle.split(/\s+/).some((t) => t !== "crunch" && s.name.toLowerCase().includes(t))))
    .map<CrunchPaletteItem>((s) => ({ id: `action:crunch:${s.id}`, kind: "action", label: `Turn Crunch ${s.on ? "off" : "on"} · ${s.name}`, hint: "crunch mode auto-pilot" }));
}

