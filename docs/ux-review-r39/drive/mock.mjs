// R37 UX driver: mock backend copied verbatim from test/desk-d4-decision-desk-e2e.test.mjs (12-item, 3-Squad demo).
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
export let server;
// Mutable per-run backend state for the 12-item 3-Squad demo (zero personal identifiers).
export let state;
function resetBackend() {
  const now = Date.now();
  const m = (mins) => now - mins * 60_000;
  const iso = (mins) => new Date(m(mins)).toISOString();
  state = {
    deliveredPrompts: [],
    items: [
      { id: "ny-00000000000000000001", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "ui-bois", askerId: "demo-ub-ld", asker: { id: "demo-ub-ld", title: "UI Bois · Lead 2", live: true }, ask: "Make Decision Desk the default Normal landing page?", decides: "Sets whether opening the app lands on Decision Desk or Project Overview", lean: "Yes, default landing + sidebar entry", alts: ["Sidebar entry only"], kind: "yesno", structured: true, ts: m(95) },
      { id: "ny-00000000000000000002", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "plugins", askerId: "demo-pl-ld", asker: { id: "demo-pl-ld", title: "Plugins · Lead 1", live: true }, ask: "Merge URL history cleanup into master now?", decides: "Ships U1+U2 Back/Forward fixes ahead of the next beta cut", lean: "Merge after green suite", alts: ["Hold for D4 bundle"], kind: "yesno", structured: true, ts: m(82) },
      { id: "ny-00000000000000000003", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "runner-pilot", askerId: "demo-rp-ld", asker: { id: "demo-rp-ld", title: "Runner Pilot · Lead 1", live: true }, ask: "Which default timeout (ms) should idle worker health checks use?", decides: "Controls when quiet workers flip to stalled in the sidebar", lean: "", alts: [], kind: "answer", structured: true, ts: m(74) },
      { id: "ny-00000000000000000004", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "art-direction", askerId: "demo-ad-ld", asker: { id: "demo-ad-ld", title: "Art Direction · Lead 1", live: true }, ask: "Sign and publish v1.14.2 beta to the desktop updater", decides: "Pushes the signed installer to beta testers", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(66) },
      { id: "ny-00000000000000000005", source: "log", squad: "efi", squadName: "Main Game Project", lane: "main-game", askerId: "demo-mg-ld", asker: { id: "demo-mg-ld", title: "Main Game · Lead 3", live: true }, ask: "Keep daily bounty resets at 00:00 UTC or align to server midnight?", decides: "Changes quest rollover timing for all players", lean: "Keep 00:00 UTC", alts: ["Align to server local midnight", "Rolling 24h per player"], kind: "yesno", structured: true, ts: m(58) },
      { id: "ny-00000000000000000006", source: "log", squad: "efi", squadName: "Main Game Project", lane: "ui-lab", askerId: "demo-ul-ld", asker: { id: "demo-ul-ld", title: "UI Lab · Lead 1", live: true }, ask: "Drop legacy parry buffer window from 180ms to 120ms?", decides: "Tightens parry timing across melee weapons", lean: "Drop to 120ms", alts: ["Try 150ms first"], kind: "yesno", structured: true, inferred: true, ts: m(49) },
      { id: "ny-00000000000000000007", source: "log", squad: "efi", squadName: "Main Game Project", lane: "main-game", askerId: "demo-w-ld", asker: { id: "demo-w-ld", title: "Main Game · Lead 2", live: true }, ask: "What max player cap should the harbor zone use for stress tests?", decides: "Sets the bot spawn count in the harbor benchmark", lean: "", alts: [], kind: "answer", structured: true, ts: m(41) },
      { id: "ny-00000000000000000008", source: "log", squad: "efi", squadName: "Main Game Project", lane: "ui-lab", askerId: "demo-a-ld", asker: { id: "demo-a-ld", title: "UI Lab · Lead 1", live: true }, ask: "Playtest the rain reverb mix on studio headphones", decides: "Unblocks final mastering of ambient weather stems", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(34) },
      { id: "ny-00000000000000000009", source: "log", squad: "site", squadName: "Site", lane: "site-polish", askerId: "demo-sp-ld", asker: { id: "demo-sp-ld", title: "Site Polish · Lead 1", live: true }, ask: "Switch sprite atlas packing from shelf to maxrects?", decides: "Cuts atlas VRAM by ~18% and regenerates sprite manifests", lean: "Switch to maxrects", alts: ["Keep shelf packer"], kind: "yesno", structured: true, sourceIds: ["ny-00000000000000000009", "ny-00000000000000000019"], groupSize: 2, ts: m(27) },
      { id: "ny-00000000000000000010", source: "log", squad: "site", squadName: "Site", lane: "site-polish", askerId: "demo-sp-ld2", asker: { id: "demo-sp-ld2", title: "Site Polish · Lead 2", live: true }, ask: "Allow non-power-of-two textures in dev builds?", decides: "Relaxes asset import validation outside release builds", lean: "Warn in dev, error in release", alts: ["Error everywhere"], kind: "yesno", structured: true, ts: m(19) },
      { id: "ny-00000000000000000011", source: "log", squad: "site", squadName: "Site", lane: "site-polish", askerId: "demo-ci-ld", asker: { id: "demo-ci-ld", title: "Site Polish · Lead 1", live: true }, ask: "Which artifact retention window (days) do we want for nightly builds?", decides: "Sets storage cleanup policy on the build bucket", lean: "", alts: [], kind: "answer", structured: true, ts: m(12) },
      { id: "ny-00000000000000000012", source: "log", squad: "site", squadName: "Site", lane: "site-polish", askerId: "demo-bi-ld", asker: { id: "demo-bi-ld", title: "Site Polish · Lead 1", live: true }, ask: "Approve the $20/mo build-cache storage upgrade", decides: "Increases remote cache quota for CI runners", lean: "", alts: [], kind: "offscreen", structured: true, ts: m(6) },
    ],
    logs: {
      vibesquad: [
        { ts: iso(25), lane: "vibesquad", agent: "Overlord", type: "decision", text: "Decision Desk approved for Normal default landing", refs: [] },
        { ts: iso(18), lane: "plugins", agent: "Plugins · Lead 1", type: "done", text: "Merged U1+U2 URL history cleanup", refs: [] },
        { ts: iso(11), lane: "ui-bois", agent: "UI Bois · Lead 2", type: "done", text: "Shipped D2 owner-only decisions API", refs: [] },
      ],
      efi: [
        { ts: iso(30), lane: "efi", agent: "Overlord", type: "done", text: "Nightly build green on all zones", refs: [] },
        { ts: iso(14), lane: "main-game", agent: "Main Game · Lead 3", type: "done", text: "Bounty tracker refactor landed", refs: [] },
      ],
      site: [
        { ts: iso(22), lane: "site-polish", agent: "Site Polish · Lead 1", type: "decision", text: "Standardized PNG compression at level 6", refs: [] },
      ],
    },
  };
}


export function startServer(dist, port) {
  resetBackend();
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(u.pathname);
    if (pathname === "/__vibesquad/decisions" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, items: state.items, count: state.items.length, agentsOk: true, generatedAt: new Date().toISOString() }));
      return;
    }
    if (pathname === "/__vibesquad/decisions/answer" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const answers = Array.isArray(body.answers) ? body.answers : [];
        const results = [];
        for (const a of answers) {
          const item = state.items.find((i) => i.id === a.id);
          if (!item) { results.push({ id: a.id, choice: a.choice, status: "rejected", error: "unknown" }); continue; }
          state.deliveredPrompts.push({ id: a.id, askerId: item.askerId, squad: item.squad, lane: item.lane, choice: a.choice, text: a.text ?? "" });
          state.items = state.items.filter((i) => i.id !== a.id);
          (state.logs[item.squad] ??= []).push({
            ts: new Date().toISOString(),
            lane: item.lane,
            agent: item.asker?.title || "Lead",
            type: "done",
            text: `Answered: ${a.choice}${a.text ? ` (${a.text})` : ""}`,
            refs: [`decision:${a.id}`],
          });
          results.push({ id: a.id, choice: a.choice, status: a.choice === "dismiss" ? "dismissed" : "delivered", target: item.askerId, via: "asker", logged: true });
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, results }));
      });
      return;
    }
    if (pathname === "/__vibesquad/log" && req.method === "GET") {
      const team = u.searchParams.get("team") || "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state.logs[team] ?? []));
      return;
    }
    let fp = path.join(dist, pathname === "/" ? "index.html" : pathname);
    if (!existsSync(fp) || statSync(fp).isDirectory()) { res.statusCode = 404; res.end("nf"); return; }
    res.setHeader("content-type", MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream");
    createReadStream(fp).on("error", () => { res.statusCode = 404; res.end(); }).pipe(res);
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", r));
}
export { resetBackend };
