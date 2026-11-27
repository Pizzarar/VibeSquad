// Storybook V8: "what changed since my last session". Per text row a stable key + text hash; the owner's last-seen session is
// stored VS-side (~/.vibesquad/storybook/<project>-seen.json, never in the project repo) and compared against the pinned snapshot.
// Output: new / changed / gone rows (old+new text for changed), the sha range, and for each gone row WHY: the adapter dropped it
// (dev string / entity-csv twin; snapshot.dropped) vs EFI removed or rewrote it. Report-only; marking seen is an explicit call.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEXT_CAP = 600;
export const SEEN_VERSION = 1;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export const textHash = (s) => createHash("sha1").update(norm(s)).digest("hex").slice(0, 10);

/**
 * Stable row key. csv ids embed the csv line number (shifts on every upstream edit), so a csv row is keyed by file + data_path;
 * rows with no data_path (gd literals) by file + text hash. Native rows keep their entity id. Duplicates get `#n` in order.
 */
function baseKey(origin, id, file, dataPath, text) {
  if (origin !== "csv") return `${origin ?? "line"}|${id}`;
  return dataPath ? `csv|${file}|${dataPath}` : `csv|${file}|~${textHash(text)}`;
}

/** key -> {id (entity id), h, t, f (file), l (line), cls}. Lines only. */
export function rowIndex(snap) {
  const out = new Map();
  const seen = new Map();
  for (const e of snap?.entities ?? []) {
    if (e.kind !== "line") continue;
    const d = e.data ?? {};
    const text = String(d.text ?? e.display ?? "");
    const base = baseKey(d.origin, e.id, d.file ?? e.source?.path ?? "", d.data_path ?? "", text);
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    out.set(n === 1 ? base : `${base}#${n}`, { id: e.id, h: textHash(text), t: text, f: String(d.file ?? e.source?.path ?? ""), l: Number(e.source?.line) || 0, cls: d.rowClass ?? null });
  }
  return out;
}

/** Why-index for adapter-dropped rows: base key -> reason ("dev-string" | "twin"). */
function droppedIndex(snap) {
  const m = new Map();
  for (const r of snap?.dropped ?? []) {
    const key = r.reason === "dev-string" ? baseKey("csv", "", r.file ?? "", r.data_path ?? "", r.text ?? "") : baseKey(r.origin, r.id, "", "", "");
    m.set(key, r.reason);
  }
  return m;
}
const stripN = (k) => k.replace(/#\d+$/, "");
const isKeylessCsvKey = (k) => /^csv\|[^|]*\|~[0-9a-f]{10}(?:#\d+)?$/.test(k);

/** The compact last-seen record stored per project (text kept so "changed" can show old -> new without the old sha). */
export function seenRecord(snap, now = Date.now()) {
  const rows = {};
  for (const [k, r] of rowIndex(snap)) rows[k] = [r.h, r.t.length > TEXT_CAP ? r.t.slice(0, TEXT_CAP) : r.t, r.f, r.l];
  return { version: SEEN_VERSION, project: snap.project, sha: snap.sha, at: new Date(now).toISOString(), total: Object.keys(rows).length, rows };
}

const GONE_WHY = Object.freeze({
  "dev-string": "VS adapter now hides it: dev/validation string, not player-facing",
  twin: "VS adapter now merges it into its text_review twin (same line, one row)",
  efi: "EFI removed it or rewrote it past recognition",
});

/**
 * Compare the owner's last-seen record with the current snapshot.
 * Returns {first:true,...} when there is no record. Otherwise {first:false, from, to, counts, new, changed, gone}:
 * new = [{id,key,text}], changed = [{id,key,old,new}], gone = [{key,text,file,why,reason}] (reason: dev-string|twin|efi).
 * A removed row whose exact text shows up unchanged in the same file under another key is a move, not gone/new.
 */
export function diffChanges(seen, snap, { cap = 500 } = {}) {
  const cur = rowIndex(snap);
  const to = { sha: snap.sha, ref: snap.ref ?? null, generatedAt: snap.generatedAt ?? null, total: cur.size };
  if (!seen || typeof seen !== "object" || !seen.rows) return { first: true, from: null, to, counts: { new: cur.size, changed: 0, gone: 0 }, new: [], changed: [], gone: [] };
  const old = seen.rows;
  const oldKeys = Object.keys(old);
  const added = [], goneKeys = [], changed = [];
  for (const [k, r] of cur) {
    const o = old[k];
    if (!o) added.push([k, r]);
    else if (o[0] !== r.h) changed.push({ id: r.id, key: k, old: o[1], new: r.t, file: r.f });
  }
  for (const k of oldKeys) if (!cur.has(k)) goneKeys.push(k);
  // moves/re-keys: same file + same text hash on both sides cancel out
  const addByFH = new Map();
  added.forEach(([k, r], i) => { const fk = `${r.f}\0${r.h}`; (addByFH.get(fk) ?? addByFH.set(fk, []).get(fk)).push(i); });
  const addedUsed = new Set(), goneUsed = new Set();
  for (const k of goneKeys) {
    const o = old[k]; const list = addByFH.get(`${o[2]}\0${o[0]}`);
    const i = list?.find((x) => !addedUsed.has(x));
    if (i != null) { addedUsed.add(i); goneUsed.add(k); }
  }
  // in-place edits of keyless gd rows: a removed + an added row at the same file:line is one changed row
  const goneAtLine = new Map();
  for (const k of goneKeys) if (!goneUsed.has(k) && isKeylessCsvKey(k) && old[k][3]) goneAtLine.set(`${old[k][2]}\0${old[k][3]}`, k);
  const paired = new Set();
  added.forEach(([k, r], i) => {
    if (addedUsed.has(i) || !isKeylessCsvKey(k) || !r.l) return;
    const gk = goneAtLine.get(`${r.f}\0${r.l}`);
    if (gk && !paired.has(gk)) { paired.add(gk); addedUsed.add(i); goneUsed.add(gk); changed.push({ id: r.id, key: k, old: old[gk][1], new: r.t, file: r.f }); }
  });
  const dropped = droppedIndex(snap);
  const newRows = added.filter((_, i) => !addedUsed.has(i)).map(([k, r]) => ({ id: r.id, key: k, text: r.t, file: r.f }));
  const goneRows = goneKeys.filter((k) => !goneUsed.has(k)).map((k) => {
    const reason = dropped.get(stripN(k)) ?? dropped.get(k) ?? "efi";
    return { key: k, text: old[k][1], file: old[k][2], reason, why: GONE_WHY[reason] };
  });
  const byReason = { "dev-string": 0, twin: 0, efi: 0 };
  for (const g of goneRows) byReason[g.reason]++;
  const lim = (a) => (a.length > cap ? a.slice(0, cap) : a);
  return {
    first: false,
    from: { sha: seen.sha, at: seen.at, total: seen.total ?? oldKeys.length },
    to,
    sameSha: seen.sha === snap.sha,
    counts: { new: newRows.length, changed: changed.length, gone: goneRows.length, goneBy: byReason },
    // Review's Changed filter needs every id, the card only a sample: ids are complete, rows are capped.
    newIds: newRows.map((r) => r.id), changedIds: changed.map((r) => r.id),
    new: lim(newRows), changed: lim(changed), gone: lim(goneRows), capped: Math.max(newRows.length, changed.length, goneRows.length) > cap ? cap : null,
  };
}

// ── store (VS-side) ──────────────────────────────────────────────────────────

export function seenPath(project, { home } = {}) {
  const h = home || process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad");
  const safe = String(project).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  return path.join(h, "storybook", `${safe}-seen.json`);
}

export function readSeen(project, opts = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(seenPath(project, opts), "utf8"));
    return j && j.version === SEEN_VERSION && j.rows ? j : null;
  } catch { return null; }
}

export function writeSeen(project, record, opts = {}) {
  const p = seenPath(project, opts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, p);
  return p;
}
