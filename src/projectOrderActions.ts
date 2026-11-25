// PLAN_PROJECT_ORDER O1: the live instance of the order writer (saveTeams + rollback to disk). Kept apart from projectOrder.ts so the pure logic stays testable.
import { createOrderOps } from "./projectOrder";
import { resetTeamsToDisk, saveTeams, type TeamDef } from "./teams";

export const projectOrder = createOrderOps({
  save: (update) => saveTeams((cur) => update(cur) as TeamDef[]),
  rollback: resetTeamsToDisk,
});
export const knownFolderNames = (folders: { name: string }[]): ReadonlySet<string> => new Set(folders.map((f) => f.name));
