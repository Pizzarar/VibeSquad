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
