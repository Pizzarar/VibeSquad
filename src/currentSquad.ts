// The Squad the app is showing, for surfaces that have no prop path to it (Ctrl+K Crunch command, Settings search target).
let current: string | null = null;
export const setCurrentSquadId = (id: string | null | undefined): void => { current = id ?? null; };
export const getCurrentSquadId = (): string | null => current;

/** The Squad Crunch commands target: the Storybook project while Storybook is on screen (it replaces the cockpit, except on a bug-tester device), else the cockpit's Squad. */
export function resolveCurrentSquad(viewTeamId: string | null | undefined, sbProjectId: string | null | undefined, deviceRole: string | null | undefined): string | null | undefined {
  return sbProjectId && deviceRole !== "bug-tester" ? sbProjectId : viewTeamId;
}
