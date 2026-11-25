// Storybook registry schema (SB1), promoted in F1 to the studio-wide registry (server/registry/). This file re-exports the
// SB1 surface unchanged so every existing import keeps working; new code may import ../registry/index.mjs directly.
//
// Entity   = { id, kind, display, aliases[], source:{path,line}, links:[{rel,kind,id}], production, data:{} }
// Snapshot = { schemaVersion:1, project, ref, sha, generatedAt, entities[], findings[], warnings[] }
// Finding  = { check:'#1'..'#12', severity:'error'|'warn'|'info', entityRef:{kind,id}|null, msg, source:{path,line}|null }
//
// Identity is (kind,id), NOT id alone: EFI's `doc` is both a trader and a squad member.
export {
  SCHEMA_VERSION, KINDS, RESERVED_KINDS, ALL_KINDS, PRODUCTION_STATES, SEVERITIES, CHECK_IDS,
  validateEntity, validateFinding, validateSnapshot, entityKey, makeRegistry, makeSnapshot, entity,
} from "../registry/index.mjs";
