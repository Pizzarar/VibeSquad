// Hand-drawn cast: public/cast.png is a 128x320 sheet of 32x32 cells. One row per role,
// four variant columns. The agent id picks the column so an agent always gets the same sprite.

import type { AgentType } from "./teams";

export const CAST_CELL = 32;
export const CAST_VARIANTS = 4;
// Respect the Vite base (remote builds use a relative or sub-path base); plain node has no import.meta.env.
export const CAST_URL = `${(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}cast.png`;

/** Sheet row order, top to bottom. */
export const CAST_ROWS: AgentType[] = [
  "lead",
  "retired-lead",
  "brainstorm",
  "implement",
  "mechanical",
  "review",
  "audit",
  "spec",
  "art",
  "unknown",
];

/** localStorage key for the optional neon provider ring around the sprite (default OFF). */
export const CAST_RING_KEY = "vs-cast-ring";

export function castRing(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(CAST_RING_KEY) === "1";
  } catch {
    return false;
  }
}

export function castRow(agentType: string | undefined): number {
  const i = CAST_ROWS.indexOf(agentType as AgentType);
  return i < 0 ? CAST_ROWS.indexOf("unknown") : i;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Variant column for an agent: an explicit ordinal (lead lane) wins, otherwise the id hash. */
export function castVariant(id: string, variant?: number): number {
  if (variant !== undefined && Number.isFinite(variant)) return ((Math.floor(variant) % CAST_VARIANTS) + CAST_VARIANTS) % CAST_VARIANTS;
  return hash(id) % CAST_VARIANTS;
}

/** Top-left pixel of the agent's cell in the sheet. */
export function castCell(id: string, agentType: string | undefined, variant?: number): { x: number; y: number } {
  return { x: castVariant(id, variant) * CAST_CELL, y: castRow(agentType) * CAST_CELL };
}
