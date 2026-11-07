import fs from "node:fs";
const t = fs.readFileSync("scratch/u2-glows.txt", "utf8").split("## ").slice(1);
const by = {};
for (const b of t) {
  const [h, ...r] = b.trim().split("\n");
  by[h.split(" ")[0]] = { n: +h.split(" ")[1], lines: r.map((x) => x.split("  ")[0]) };
}
const fmt = (k) => by[k].lines.join(", ");
const glowTotal = by["colour-glow"].n + by["text-glow"].n + by["blurred-drop"].n;
const md = `# U2 audit: neon elements (before-state, master fc388c6)

Aub: "all still read neon not our hypnovaporwave theme". Line numbers are \`src/styles.css\` unless a file is named. Phase B fixes every group in place (glows, hex) and adds a tokenised U2 skin layer at the end of \`styles.css\`.

Counts: ${glowTotal} glow/blur shadows (${by["colour-glow"].n} colour, ${by["text-glow"].n} text, ${by["blurred-drop"].n} blurred black drops) + ${by["hard-inset-bar"].n} hard inset bars (kept, not glows).

## 1. Colour glows (\`box-shadow: 0 0 Npx <accent>\`): ${by["colour-glow"].n}
Fix: \`var(--bevel)\` (1px inset, light top-left / dark bottom-right); lifted cards/menus add \`var(--hard)\` (2px 2px 0, no blur). Only the needs-you badge (\`.badge.alert\` :380) keeps a glow.
${fmt("colour-glow")}

## 2. Text glows (\`text-shadow: 0 0 ...\`): ${by["text-glow"].n}
Fix: hard 2px offset text shadow in \`--shadow-hard\`, no blur.
${fmt("text-glow")}

## 3. Blurred black drop shadows (menus, drawers, modals, toasts): ${by["blurred-drop"].n}
Fix: \`var(--hard)\` 2px 2px 0 plus bevel; drawers keep a 1px edge only.
${fmt("blurred-drop")}

## 4. Hard inset accent bars (selected rows, tabs): ${by["hard-inset-bar"].n}
Not glows. Kept (pixel-crisp, already tokens).
${fmt("hard-inset-bar")}

## 5. Glowing status dots / diamonds
- \`.conn.connected/.disconnected\` :297-306 (glow + blink)
- \`.signal\` :412-451 (running :421, idle :435, error/attn :444; \`.signal.closed\` hard-coded #2b3048 :441)
- \`.sidebar-stale-dot\` :2963 (circle, #ffb000 glow), \`.rrow.open::before\` :1627-1628 (glow bar), \`.brainstorm-ctx-marker\` ~:1757
Fix: filled pastel pixel chips: pastel fill + 1px bevel + 1px ink edge, square, no glow (running = mint, idle = violet, error/needs-you = pink, closed = line). Needs-you keeps the one allowed glow. Class hooks already exist, no TSX.

## 6. Outline-only buttons (dim fill + coloured 1px border + coloured text)
- \`.btn\` :962 and variants \`.ghost\` :984, \`.ok\` :994, \`.bad\` :999, \`.warn\` :1375, \`.hot\` :1376, \`.confirm.danger/warn/cool\` :1255-1257, \`.bad-btn\` :1358, \`.btn.successor\` :1377
- \`.seg button\` :1271-1274, \`.tchip\` :1280-1281, \`.sidebar-cog-btn\` ~:2955, \`.squads-pager-btn\` ~:3858, \`.drawer-working-chip\` / \`.drawer-subagent-chip\` ~:4392-4404
Fix: bevelled pastel faces like the mock SEND/CANCEL (primary teal, ghost panel-hi, bad pink, warn amber); \`:active\` inverts the bevel.

## 7. Banners / alert bars
- Hot-pink EXPOSED/LAN banner: \`src/App.tsx:1807\` inline \`background:#ff2a85\` (override from CSS with !important)
- Amber read-only banner: \`src/App.tsx:1829\` inline \`#ffb000\` (\`.read-only-banner\` :4011)
- Config warning \`src/App.tsx:~1865\` inline \`#ffb000\`; update-available \`src/App.tsx:~1882\` inline \`#00f0ff\`
- \`.banner\` :1004, \`.stale-build-banner\` :3993 (#ffb000 + glow), \`.dup-warning\` :1424, \`.you-bar\` :1300, \`.hard-bar.hot\` :1371, \`.lint-bar\` :1305, \`.brainstorm-warn-banner\` :1829, \`.brainstorm-handoff-banner\` :1844, \`.topic-cap-banner\` :2215, \`.warning-banner\` :3390, \`.attach-bar.hot\` :1382, \`.NeedsYouHighlight\` :2278, \`.daemon-disconnect-card\` ResponsiveSmallWindow.css:3 (#ff4d6a glow)
Fix: pastel gradient bevelled bars, ink text on pastel fills (pink / amber / teal / violet), 2px hard shadow, no saturated fills.

## 8. Flat single-colour panels (no title bar, gradient or texture)
\`.modal\` :1330 (+ \`.modal-head\` :1332), \`.drawer\` / \`.drawer-head\` :918-933, \`.team-head\` :314, \`.card\` ~:3195, \`.ws-row\` :1310, \`.ts-team\` :1354, \`.handoff-panel\` :1283, \`.idea-inbox\` ~:1904, \`.pin-menu-list\` :3419, \`.ctx-menu\` ~:3701, \`.cmd-palette\` ~:3690, \`.shortcut-modal\` ~:3707, \`.drawer-features-menu\` :4244, \`.drawer-sandbox-panel\` :4296, \`.drawer-config-popover\` :4348, \`.squad-home-tile\` ~:3900, \`.sidebar\` :185
Fix: modal / menu / popover heads get the violet > pink > peach gradient title bar (\`--titlebar\`); bodies get a vertical \`--panel\` > \`--panel-hi\` gradient plus a Bayer tile (\`public/ui/bayer-*.png\`, 3% contrast).

## 9. Chips / tags / pills (dark \`--well\` or transparent fill + coloured outline)
\`.badge\` :371, \`.unit-tag\` :491, \`.prov-badge\` :478, \`.pill\` :895, \`.chip\` :1038, \`.status-pill\` :1295, \`.warn-badge\` :1288, \`.lane-tag\` :1289, \`.def-badge\` :1346, \`.label-pill\` :1352, \`.pill.diag\` :1362, \`.alert-pill\` :1512, \`.verdict\` :1314, \`.changes-file-badge\` :3363, \`.inbox-scope-badge\` :2043, \`.project-badge\` :4106, \`.brainstorm-ctx-pill\` :1690, \`.sidebar-inbox-badge\` :1886
Fix: filled pastel backgrounds (accent mixed into \`--panel-hi\`), 1px bevel, text stays in the -t tokens (>= 4.5:1).

## 10. Hard-coded neon hex (not tokens)
#00f0ff alpha tints (:367 :975 :1138 :1625 :3511 :3520 :3634 :3744 :4263 :4334 :4362 :4387 :4393 :4398 and more), #ff2a85 / #ff3d81 / #ff4d4d tints (:1403 :1424 :1624 :3249), #b86bff (:1465 :1484 :1626 :2166), #f59e0b / #ffb000 (:1316 :1363 :2970 :4004 :4031), #4dffb0 / #35e08a (:1408 :1420 :1534), blue-black hairlines #161830 #1a1c34 #2b244d #162238.
Fix: rewrite to \`color-mix(in srgb, var(--accent) N%, transparent)\`; hairlines to \`color-mix(var(--line) ...)\`.

## TSX touched
Planned: none. The four inline-styled banners (App.tsx:1807, 1829, ~1865, ~1882) are overridden from CSS with !important.
`;
fs.writeFileSync("docs/art/U2_AUDIT.md", md);
