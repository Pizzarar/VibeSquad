// Studio-wide Shared Entity Registry (F1). One schema every lane codes against; Storybook (server/storybook/schema.mjs)
// is its first consumer and re-exports the SB1 surface from here unchanged.
//
//   kinds/<kind>.mjs  one file per kind (KindDef, see kind-table.mjs); a new kind = one new file, nothing else
//   kind-table.mjs    loader: reads kinds/ and builds the frozen kind table
//   schema.mjs        entity / finding / snapshot validators bound to a table, makeRegistry, entity(), production slots
//   ids.mjs           stable studio IDs  <project>:<kind>:<id>
import { loadKindTable } from "./kind-table.mjs";
import { makeSchema } from "./schema.mjs";

export { DEFAULT_KINDS_DIR, buildKindTable, loadKindTable } from "./kind-table.mjs";
export { SCHEMA_VERSION, PRODUCTION_STATES, SEVERITIES, CHECK_IDS, entityKey, makeRegistry, makeSnapshot, entity, makeSchema } from "./schema.mjs";
export { PROJECT_RE, studioId, parseStudioId, isStudioId, entityStudioId, linkStudioId } from "./ids.mjs";

/** The default kind table (server/registry/kinds/). */
export const KIND_TABLE = await loadKindTable();
const schema = makeSchema(KIND_TABLE);

/** v1 kinds, each with the data keys it must carry (the adapter fills them; [] means "free-form"). */
export const KINDS = schema.KINDS;
/** Reserved kinds: schema only. An entity of these kinds is valid but must carry no data (later lanes fill them). */
export const RESERVED_KINDS = schema.RESERVED_KINDS;
export const ALL_KINDS = schema.ALL_KINDS;
export const { validateEntity, validateFinding, validateSnapshot, productionOf, crossLaneLinks } = schema;
