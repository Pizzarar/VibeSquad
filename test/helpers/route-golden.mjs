// Shared golden fixtures for the P5 role/tier routing tests (docs/PLAN_PROFILES_ROLE_ONLY.md, idea-77): the 12 profiles
// in ~/.vibesquad/profiles.json on 2026-11-17, every cap set, and the `today()` oracle (today's failover walk + the old
// stakes ladder, pinned as literal data from b634cc9a). Used by test/role-route.test.mjs (resolver) and test/spawn-route-hook.test.mjs (spawn hook e2e).
import { readFileSync } from "node:fs";

export const C = "claude";
export const A = "antigravity-cli";
export const O = "opencode";

// Golden table: the provider/model/effort/mode each profile spawns with today at normal stakes (profile fields; the
// stakes ladder does not apply at normal). 11 of them are also shipped in DEFAULT_PACK_PROFILES; "Implement - Gemini
// (trial)" exists only in the user file.
export const GOLDEN = [
  ["Lead - Claude", "lead", C, "claude-opus-5-5", "medium", "auto"],
  ["Lead - Gemini", "lead", A, "gemini-4-argon", "medium", "accept-edits"],
  ["Brainstorm - Claude", "brainstorm", C, "claude-opus-5-5", "medium", "auto"],
  ["Brainstorm - Gemini", "brainstorm", A, "gemini-4-argon", "medium", "accept-edits"],
  ["Implement - Sonnet", "worker", C, "claude-sonnet-5-5", "medium", "auto"],
  ["Work Order - DSP", "worker", O, "deepseek/deepseek-v4-pro", "high", "build"],
  ["Review - Gemini", "worker", A, "gemini-4-argon", "medium", "default"],
  ["Review - Sonnet", "worker", C, "claude-sonnet-5-5", "medium", "auto"],
  ["Pre-check - Flash", "worker", A, "gemini-3.8-flash", "low", "default"],
  ["Art Director - Gemini", "worker", A, "gemini-4-argon", "medium", "accept-edits"],
  ["Art Painter - Opus", "worker", C, "claude-opus-5-5", "medium", "auto"],
  ["Implement - Gemini (trial)", "worker", A, "gemini-4-argon", "medium", "accept-edits"],
].map(([name, role, provider, model, effort, modeId]) => ({ name, role, provider, model, effort, modeId }));

// Today's stored profile list (the effective list resolveProfileWithFailover walks; hop profiles outside it come from
// the registered DEFAULT_PACK_PROFILES, as in the server).
export const USER_PROFILES = GOLDEN.map((g) => ({ name: g.name, role: g.role, provider: g.provider, model: g.model, modeId: g.modeId, thinkingOptionId: g.effort }));

export const row = (provider, model, effort, modeId) => ({ provider, model, effort, modeId });
export const pick = (r) => r && { provider: r.provider, model: r.model, effort: r.effort, modeId: r.modeId };

/** All 8 subsets of the three provider families. */
export const CAP_SETS = [[]];
for (const f of [C, A, O]) for (const s of [...CAP_SETS]) CAP_SETS.push([...s, f]);

// Today's routes pinned as literal data (Sonnet L3): generated once from the b634cc9a tree (resolveProfileWithFailover
// over USER_PROFILES + DEFAULT_STAKES_LADDER) for every old name + alias x every cap set x every stakes value, so a change
// in provider-failover.mjs / stakes-ladder.mjs cannot move the oracle together with the code under test.
export const TODAY_FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/route-golden-today-b634cc9a.json", import.meta.url), "utf8"));

/** Today's route for a profile name (b634cc9a, pinned): the failover walk, then the old stakes ladder on the landed profile. */
export function today(name, caps, stakes) {
  const byCaps = TODAY_FIXTURE.index[name];
  if (!byCaps) throw new Error(`no pinned golden row for ${name}`);
  const capKey = [C, A, O].filter((f) => caps.includes(f)).join(",");
  const i = byCaps[capKey]?.[stakes === undefined ? "(none)" : stakes];
  if (i === undefined) throw new Error(`no pinned golden row for ${name} caps=[${caps}] stakes=${stakes}`);
  const [provider, model, effort, modeId] = TODAY_FIXTURE.rows[i];
  return { provider, model, effort, modeId };
}
