// The Squad the app is showing, for surfaces that have no prop path to it (Ctrl+K Crunch command, Settings search target).
let current: string | null = null;
export const setCurrentSquadId = (id: string | null | undefined): void => { current = id ?? null; };
export const getCurrentSquadId = (): string | null => current;
