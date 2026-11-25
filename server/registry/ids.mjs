// Stable studio IDs (F1).
//
//   <project>:<kind>:<id>      e.g.  efi:trader:doc   efi:squad:doc   efi:line:rel:doc:friendly
//
//   project  the studio project key (the team id, e.g. "efi"): /^[a-z0-9][a-z0-9_-]*$/, no colon
//   kind     a registry kind name: /^[a-z][a-z0-9_]*$/, no colon
//   id       the entity's existing in-project id, verbatim and non-empty; it MAY contain colons (`rel:doc:friendly`),
//            so parsing splits on the first two colons only
//
// A studio ID is derived from (project, kind, id), never stored on the entity: storybook ids and (kind,id) identity keep
// working unchanged, and snapshots stay byte-identical. Identity is (project, kind, id), not id alone (EFI's `doc` is both a
// trader and a squad member).

export const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;
const KIND_RE = /^[a-z][a-z0-9_]*$/;

/** Build a studio ID. Throws TypeError on a malformed project/kind or an empty id. */
export function studioId(project, kind, id) {
  if (typeof project !== "string" || !PROJECT_RE.test(project)) throw new TypeError(`studioId: bad project ${JSON.stringify(project)}`);
  if (typeof kind !== "string" || !KIND_RE.test(kind)) throw new TypeError(`studioId: bad kind ${JSON.stringify(kind)}`);
  if (typeof id !== "string" || id === "") throw new TypeError("studioId: id must be a non-empty string");
  return `${project}:${kind}:${id}`;
}

/** Parse a studio ID to {project, kind, id}, or null when malformed. `kinds` (optional) restricts kind to a known list. */
export function parseStudioId(sid, kinds = null) {
  if (typeof sid !== "string") return null;
  const a = sid.indexOf(":");
  const b = a < 0 ? -1 : sid.indexOf(":", a + 1);
  if (b < 0) return null;
  const project = sid.slice(0, a), kind = sid.slice(a + 1, b), id = sid.slice(b + 1);
  if (!PROJECT_RE.test(project) || !KIND_RE.test(kind) || id === "") return null;
  if (kinds && !kinds.includes(kind)) return null;
  return { project, kind, id };
}

export const isStudioId = (sid, kinds = null) => parseStudioId(sid, kinds) !== null;

/** Studio ID of an entity in `project`. */
export const entityStudioId = (project, e) => studioId(project, e.kind, e.id);

/**
 * Studio ID a link points at. A link is {rel, kind, id} (same project as its entity) or {rel, kind, id, project} for a
 * cross-project link.
 */
export const linkStudioId = (fromProject, link) => studioId(link.project ?? fromProject, link.kind, link.id);
