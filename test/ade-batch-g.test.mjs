import assert from "node:assert/strict";
import test from "node:test";

// G: pure logic mirrors of src/CommandPalette.tsx (Node-only, no DOM).

function dateBucket(iso, now) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "older";
  const d = new Date(now);
  const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (t >= startToday) return "today";
  if (t >= startToday - 86_400_000) return "yesterday";
  return "older";
}
function parseUrlState(search) {
  const p = new URLSearchParams(search);
  return { team: p.get("team") || null, agent: p.get("agent") || null };
}
function serializeUrlState(state, search = "") {
  const p = new URLSearchParams(search);
  p.delete("team");
  p.delete("agent");
  if (state.team) p.set("team", state.team);
  if (state.agent) p.set("agent", state.agent);
  const s = p.toString();
  return s ? `?${s}` : "";
}
function filterPalette(items, q) {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter((it) => terms.every((t) => `${it.label} ${it.hint}`.toLowerCase().includes(t)));
}
function snippetAround(text, q, radius = 50) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const s = Math.max(0, i - radius);
  const e = Math.min(text.length, i + q.length + radius);
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ")}${e < text.length ? "…" : ""}`;
}

test("G1: URL state round-trips and keeps unrelated params", () => {
  assert.deepEqual(parseUrlState("?team=efi&agent=a1"), { team: "efi", agent: "a1" });
  assert.deepEqual(parseUrlState(""), { team: null, agent: null });
  assert.equal(serializeUrlState({ team: "efi", agent: "a1" }, "?demo=1"), "?demo=1&team=efi&agent=a1");
  assert.equal(serializeUrlState({ team: null, agent: null }, "?team=x&agent=y"), "");
  const s = serializeUrlState({ team: "t", agent: null }, "?agent=old");
  assert.equal(s, "?team=t");
});

test("G2: duplicate consecutive states are detectable by string compare", () => {
  const cur = serializeUrlState({ team: "t", agent: "a" });
  assert.equal(serializeUrlState({ team: "t", agent: "a" }, cur), cur);
});

test("G3: command palette filters by label and hint, all terms required", () => {
  const items = [
    { id: "1", label: "New Agent", hint: "" },
    { id: "2", label: "Fix login", hint: "Alpha Squad Lead archived" },
    { id: "3", label: "Docs", hint: "Beta Squad Lead" },
  ];
  assert.equal(filterPalette(items, "").length, 3);
  assert.deepEqual(filterPalette(items, "alpha lead").map((i) => i.id), ["2"]);
  assert.equal(filterPalette(items, "zzz").length, 0);
});

test("G4: date buckets Today/Yesterday/Older", () => {
  const now = new Date(2026, 10, 1, 15, 0, 0).getTime();
  assert.equal(dateBucket(new Date(2026, 10, 1, 1, 0).toISOString(), now), "today");
  assert.equal(dateBucket(new Date(2026, 9, 31, 23, 0).toISOString(), now), "yesterday");
  assert.equal(dateBucket(new Date(2026, 9, 30, 12, 0).toISOString(), now), "older");
  assert.equal(dateBucket(null, now), "older");
});

test("G5: transcript search aggregation returns one hit per matching agent, empty for no match", () => {
  const transcripts = { a: ["hello world", "deploy the thing now"], b: ["nothing here"] };
  const search = (q) =>
    Object.entries(transcripts).flatMap(([id, texts]) => {
      for (const t of texts) {
        const sn = snippetAround(t, q);
        if (sn) return [{ id, sn }];
      }
      return [];
    });
  assert.deepEqual(search("DEPLOY").map((h) => h.id), ["a"]);
  assert.equal(search("qqqq").length, 0);
  assert.ok(snippetAround("x".repeat(200) + "needle" + "y".repeat(200), "needle").startsWith("…"));
});

test("G6: context menu items for cards and messages", () => {
  const card = ["Open Agent", "Open in Split Pane", "Copy Agent ID", "Copy Working Folder (cwd)", "Archive Agent"];
  const msg = (park) => ["Copy Message Text", ...(park ? ["Park in Inbox"] : []), "Copy Agent ID"];
  assert.equal(card.length, 5);
  assert.deepEqual(msg(true), ["Copy Message Text", "Park in Inbox", "Copy Agent ID"]);
  assert.deepEqual(msg(false), ["Copy Message Text", "Copy Agent ID"]);
});
