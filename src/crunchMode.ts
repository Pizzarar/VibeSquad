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

const COMMAND_WORDS = ["turn", "crunch", "on", "off", "mode", "auto", "pilot", "auto-pilot"];
const words = (n: string) => n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * C3: "Turn Crunch on/off · <Squad>". The current Squad is always offered, first. Another Squad appears only when, after dropping
 * command words (any prefix of turn/crunch/on/off/mode/auto-pilot), a remaining token of 2+ chars is a prefix of a word in its name
 * or equals its id or initials ("efi" finds Escape From Idle). A bare "crunch" + Enter therefore never reaches another Squad.
 */
export function crunchPaletteItems(squads: { id: string; name: string; on: boolean }[], currentId: string | null, q: string): CrunchPaletteItem[] {
  const tokens = q.trim().toLowerCase().split(/\s+/).filter((t) => t && !COMMAND_WORDS.some((w) => w.startsWith(t)));
  const initials = (n: string) => words(n).map((w) => w[0]).join("");
  const hit = (s: { id: string; name: string }) =>
    tokens.some((t) => t.length >= 2 && (words(s.name).some((w) => w.startsWith(t)) || t === s.id.toLowerCase() || t === initials(s.name)));
  const cur = squads.filter((s) => s.id === currentId);
  const others = squads.filter((s) => s.id !== currentId && hit(s));
  return [...cur, ...others].map<CrunchPaletteItem>((s) => ({
    id: `action:crunch:${s.id}`,
    kind: "action",
    label: `Turn Crunch ${s.on ? "off" : "on"} · ${s.name}`,
    hint: `crunch mode on off auto-pilot ${s.id} ${initials(s.name)}`,
  }));
}
