// Registry kind table (F1). A kind is one file in a kinds directory whose default export is a KindDef; the loader reads
// every *.mjs there and builds a frozen table. Adding a kind = dropping one file in server/registry/kinds/.
//
// KindDef = { kind, label, order, reserved, lane, required[], slots[] }
//   kind      /^[a-z][a-z0-9_]*$/, unique across the table
//   order     sort key (v1 kinds 10..130, reserved 1010..); ties break on kind name
//   reserved  schema only: entities of this kind are valid but must carry empty data
//   lane      owning lane handle (e.g. "storybook"), or null while unclaimed; drives cross-lane link detection
//   required  data keys an entity of this kind must carry ([] = free-form)
//   slots     production slots an entity of this kind can have (text, portrait, voice, ...); slots[0] is the primary
//             slot, the one the entity-level `production` field describes
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_KINDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "kinds");

const KIND_RE = /^[a-z][a-z0-9_]*$/;
const isStrArr = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s !== "");

function checkDef(d, where) {
  const bad = (m) => { throw new Error(`registry kind ${where}: ${m}`); };
  if (!d || typeof d !== "object") bad("default export must be a KindDef object");
  if (typeof d.kind !== "string" || !KIND_RE.test(d.kind)) bad(`kind must match ${KIND_RE}`);
  if (typeof d.label !== "string" || !d.label) bad("label must be a non-empty string");
  if (!Number.isFinite(d.order)) bad("order must be a number");
  if (typeof d.reserved !== "boolean") bad("reserved must be a boolean");
  if (d.lane !== null && (typeof d.lane !== "string" || !d.lane)) bad("lane must be a non-empty string or null");
  if (!isStrArr(d.required)) bad("required must be string[]");
  if (d.reserved && d.required.length) bad("a reserved kind cannot require data keys");
  if (!isStrArr(d.slots) || !d.slots.length || new Set(d.slots).size !== d.slots.length) bad("slots must be a non-empty string[] without repeats");
  return Object.freeze({ kind: d.kind, label: d.label, order: d.order, reserved: d.reserved, lane: d.lane, required: Object.freeze([...d.required]), slots: Object.freeze([...d.slots]) });
}

/**
 * Build the kind table from KindDefs. Throws on a malformed def or a duplicate kind.
 * Returns { defs[], byKind, KINDS, RESERVED_KINDS, ALL_KINDS } where KINDS is the SB1 shape {kind: {label, required}}
 * (v1 kinds only, in order), RESERVED_KINDS the reserved names, ALL_KINDS v1 then reserved.
 */
export function buildKindTable(defs) {
  const checked = defs.map((d, i) => checkDef(d, d?.kind ?? `#${i}`));
  const byKind = new Map();
  for (const d of checked) {
    if (byKind.has(d.kind)) throw new Error(`registry kind ${d.kind}: defined twice`);
    byKind.set(d.kind, d);
  }
  const sorted = [...checked].sort((a, b) => a.order - b.order || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const live = sorted.filter((d) => !d.reserved);
  const reserved = sorted.filter((d) => d.reserved);
  const KINDS = Object.freeze(Object.fromEntries(live.map((d) => [d.kind, { label: d.label, required: [...d.required] }])));
  const RESERVED_KINDS = Object.freeze(reserved.map((d) => d.kind));
  const ALL_KINDS = Object.freeze([...live.map((d) => d.kind), ...RESERVED_KINDS]);
  return Object.freeze({ defs: Object.freeze(sorted), byKind, KINDS, RESERVED_KINDS, ALL_KINDS });
}

/** Read every KindDef file (*.mjs, default export) in `dirs` (later dirs extend earlier ones) and build the table. */
export async function loadKindTable(dirs = [DEFAULT_KINDS_DIR]) {
  const defs = [];
  for (const dir of dirs) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
    for (const f of files) {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      const name = f.slice(0, -4);
      if (mod.default?.kind !== name) throw new Error(`registry kind file ${f}: default export kind must be "${name}" (one kind per file, named after it)`);
      defs.push(mod.default);
    }
  }
  return buildKindTable(defs);
}
