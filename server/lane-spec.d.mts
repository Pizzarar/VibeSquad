export type LaneUnitStatus = "todo" | "running" | "done" | "blocked";

export interface LaneUnit {
  id: string;
  title?: string;
  goal: string;
  files: string[];
  doneCheck: string;
  dependsOn?: string[];
  status: LaneUnitStatus;
  branch?: string;
  worktreePath?: string;
  commit?: string;
  agentId?: string;
}

export function laneArtifactDir(teamId: string, laneId: string, rootDir?: string): string;

export function readLaneSpec(
  teamId: string,
  laneId: string,
  rootDir?: string,
): { laneId: string; path: string; fullPath: string; exists: boolean; content: string };

export function writeLaneSpec(
  teamId: string,
  laneId: string,
  content: string,
  rootDir?: string,
): { laneId: string; path: string; fullPath: string; bytes: number };

export function readLaneTasks(
  teamId: string,
  laneId: string,
  rootDir?: string,
): { laneId: string; path: string; fullPath: string; exists: boolean; units: LaneUnit[]; updatedAt: string; unreadable: boolean };

export function upsertLaneTask(
  teamId: string,
  laneId: string,
  unitPatch: Partial<LaneUnit> & { id: string },
  rootDir?: string,
): { unit: LaneUnit; units: LaneUnit[] };

export function renderLaneArtifactBlock(teamId: string, laneId: string, rootDir?: string): string;
