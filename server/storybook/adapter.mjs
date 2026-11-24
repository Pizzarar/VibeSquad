// Storybook adapter interface (SB1). One adapter per project; the engine (schema + generic checks) never knows project paths.

/**
 * @typedef {import('./schema.mjs').Entity} Entity
 *
 * @typedef {Object} Reader   Pinned-sha reader (git-read.mjs makeReader). Never touches a working tree.
 * @property {string} repo
 * @property {string} sha
 * @property {(path:string)=>Promise<string|null>} readFile   null when absent at that sha
 * @property {(path:string)=>Promise<boolean>} exists
 * @property {(dir:string, o?:{recursive?:boolean})=>Promise<Array<{path:string,type:string,mode:string}>>} listTree
 *
 * @typedef {Object} AdapterHooks   Project-semantic helpers later checks call; computed from data, never hard-coded.
 * @property {(registry:object, locationId:string, enemyId:string)=>{min:number,max:number,tier:number,weight:number,defaultRaidSeconds:number|null}|null} spawnWindow
 *   Where/when `enemyId` can spawn at `locationId` (enemy_pool row incl. boss row), or null when it does not spawn there. Check #2/#5.
 * @property {(registry:object, enemyId:string)=>string[]} killTargetLocations
 *   Location ids whose pool (or boss slot) contains `enemyId`. Check #2.
 *
 * @typedef {Object} Adapter
 * @property {string} id                   project key, e.g. 'efi'
 * @property {string|null} defaultRepoPath  optional default repo location; null = the caller supplies the path (EFI: always null, no hardcoded paths)
 * @property {(reader:Reader, sha:string)=>Promise<{entities:Entity[], warnings:string[]}>} load
 *   Read-only ingest at one pinned sha. Put anything odd (missing file, unparsable block) in warnings, never throw for content.
 * @property {AdapterHooks} hooks
 */

/** Throw a clear error when an adapter object does not meet the interface. */
export function assertAdapter(a) {
  const bad = (m) => { throw new Error(`storybook adapter: ${m}`); };
  if (!a || typeof a !== "object") bad("not an object");
  if (typeof a.id !== "string" || !a.id) bad("id missing");
  if (a.defaultRepoPath !== null && typeof a.defaultRepoPath !== "string") bad("defaultRepoPath missing");
  if (typeof a.load !== "function") bad("load() missing");
  if (!a.hooks || typeof a.hooks.spawnWindow !== "function" || typeof a.hooks.killTargetLocations !== "function") bad("hooks.spawnWindow/killTargetLocations missing");
  return a;
}

/** Run an adapter and wrap the result into a snapshot. */
export async function loadSnapshot(adapter, reader, { ref = "", generatedAt } = {}) {
  assertAdapter(adapter);
  const { makeSnapshot } = await import("./schema.mjs");
  const { entities, warnings } = await adapter.load(reader, reader.sha);
  return makeSnapshot({ project: adapter.id, ref, sha: reader.sha, entities, warnings, generatedAt });
}
