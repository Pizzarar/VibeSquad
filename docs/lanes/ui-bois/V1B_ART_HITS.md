# V1b: @art-owned hits for Art9 (colour / contrast / skin line art)

Source: `npm run ui:overlap` full matrix (4k@1.2, 1080, 1280x800, 390x844, dark + light) on branch `unit-ui-overlap-v1b`, after the V1b layout fixes. Our hits are 0. These 16 fail the guard and are colour/skin, so they are not ours to change. 17 more are warn-only `decor-suspect` (listed at the bottom). Re-run: `UI_OVERLAP=1 node scripts/ui-overlap.mjs --no-fail` and read `scratch/ui-overlap/report.md` for crops.

Line refs are `src/styles.css` on this branch. The shared tool-surface rules are at 5661-5678 and the `:root:root .sidebar` quiet-tool rules at 5717-5724.

## Contrast < 3:1 (13)
| Selector (testid) | Text on bg | Ratio | Sizes | Theme | Rule |
|---|---|---|---|---|---|
| `button[data-testid^="new-squad-profile-"]` (selected "Brainstorm - Claude") | #f6eef8 on #9a7fe0 | 2.85 | all 4 | light | `.sidebar :is(.tchip…)` 5717-5720 / `.tchip.on` ink |
| `button.tchip.on` in `.inbox-filters` ("All teams (0)") | #f6eef8 on #9a7fe0 | 2.85 | 4k 1080 800 | light | same |
| `main.team-page .toolbar .seg button.on` ("SQUADS") | #f6eef8 on #9a7fe0 | 2.85 | all 4 | light | `.seg button.on` 5661, 5724 |
| `button[data-testid="pin-needs-vibesquad"]`, `span[data-testid="pin-needs-vibesquad"]` ("3") | #e0d1dc on #d63f88 | 2.91 | all 4 | light | `.badge.alert / .sidebar-inbox-badge` 5673-5678 |
| `button[data-testid="squad-home-needs-vibesquad"]` ("3 need you") | #e0d1dc on #d63f88 | 2.91 | all 4 | light | same |
| `button[data-testid="sq-deny"]` ("Deny", hub queue strip) | #f6eef8 on #e0d1dc | 1.29 | 4k 1080 800 | light | 5662-5664 ghost button |
| `button[data-testid="ui-scale-preset-100"]` ("100%", Settings) | #4fd6cf on #4fd6cf | 1.00 | 4k 1080 800 | dark + light | `.seg button.on` on the primary-teal fill, label = fill |
| `.brainstorm-ctx-actions button.btn.small` ("⇄ Handoff") | #ffc46c on #4fd6cf | 1.13 | 4k 1080 800 | dark + light | `.btn-brainstorm-restart` (this is Aub's R1 "blank yellow button", known `r1-summary-blank-btn`) |
| `.drawer-actions button.btn.confirm` ("Archive") | #160b24 on #33255c | 1.41 | 4k 1080 800 | dark | 5662-5664 |
| `.hard-bar.hot button.btn.warn` ("Cancel & Resume") | #160b24 on #5b326b | 1.91 | 4k 1080 800 | dark | warn button on the pink hard bar |
| `.drawer-labels-list span.chip` ("team=vibesquad") | #f7f0ff on #4fd6cf | 1.59 | 4k 1080 | dark | chip teal fill 5674-5676 |
| `.successor-bar button.btn.hot` ("Initiate Handoff / Spawn…") | #f6eef8 on #dec2b5 | 1.48 | 4k 1080 800 | light | hot button on the peach lint bar |

## Lines drawn through text (3)
| Selector | What runs through it | Sizes | Theme |
|---|---|---|---|
| `button[data-testid="sky-start-overlord"]` ("Spin Up Overlord") and `.sky-static-text` ("no Overlord on duty") | `repeating-linear-gradient` scanline of `div[data-testid="sky-static-overlord"]` covers the label (106x14, 144x14) | 4k 1080 800 | dark + light | 
| `span.sq-floor-tv-count` ("01", floor TV) | `.sq-floor-tv::after` scanline (7x8) over the counter (src/styles.css:4944; the count itself moved inside the glass by V1b) | 800 | dark + light |

The sky static label belongs to the sky-zones CSS that RS-b is editing, so we have not touched it. Fix by lifting the label above the scanline (z-order) or masking the scanline behind the text box.

## Warn-only `decor-suspect` (17, pixel step through text; no action unless you want to look)
Needs-you pips and badges (`pin-needs-*`, `squad-home-needs-*`), `pin-menu-*` "⋯", `pin-rail-mark-read`, role-tag "BRAINSTORM", `.drawer-labels-list .chip`, `.sidebar-teams-divider i`, the command-palette item (`b`, `.cmd-kind`, `.muted.small`, 800 only), `.tl-user` text on light, timeline sub-agent row on mobile, and the subagent chip name on mobile (1px skin border row). All are bar/bevel edges of the 9-slice art that land inside the text box.

## Provider badge (Aub R1.3, known `r1-provider-badge-over-avatar`)
Fixed in layout: the avatar now keeps a 12px gutter (`AVATAR_BADGE_GUTTER`, `src/pixel.tsx`) and the badge sits beside the sprite, not over it. If you redraw the badge or the cast frame, keep the badge inside that 12px gutter (about 10x12 px).

## V1b-2 (re-run on master 7bc5b8b + new surfaces; branch `unit-ui-overlap-v1b2`)

Matrix: 4k@1.2 (3200x1800 css, dpr 1.2), 1920x1080, 1280x720, dark + light. New surfaces: `sky-idle`, `sky-rest`, `sky-riff-open`, `sky-riff-landed` (demo `?riff=1` gives the hub a live RiffBot + Overlord), `hub-tower`, `hub-tabs`, `rail-squads-icon`, `pin-grid-teams-toggle`. Result: 40 failing @art rows (37 contrast, 3 decor-line) + 37 warn-only decor-suspect. Re-run: `node scripts/ui-overlap.mjs --sizes 4k,1080,720 --no-fail`, crops in `scratch/shots/v1a-*`.

The earlier 13 V1b contrast rows are fixed on master except the ones below that still reproduce. Almost all new rows are the FULL plumbing view (TEAMS toggle, `squad-full-toggle` -> `main.team-page`), which no earlier surface rendered:

| Group | Selectors | Worst ratio | Theme |
|---|---|---|---|
| Teal / pink fill chips with pale text | `span.lane-tag`, `.unit-tag`, `.badge`, `.warn-badge`, `.pill.error/.needs-you/.permission`, `.alert-pill` (`.alert-owner/.alert-type/.alert-who`), `.drawer-labels-list .chip`, `.role-tag`, `talk-here-badge`, `runs-the-work-badge` | 1.0-2.5 | light + dark |
| Muted text on card fills | `.card-lead .card-body .muted.small span`, `.card.sel .muted.small`, `.card-title` on pink | 1.2-2.6 | light |
| Provider inline label | `span.prov-inline` (cyan/orange on pale row) | 1.0-2.0 | light |
| Ghost confirm button | `.row-actions button.btn.confirm` (Running row) | 1.13 | light |
| Meter readout | `lead-token-meter .meter-readout` | 1.66 | light |

Lines through text (3): `button[data-testid="sky-start-overlord"]` and `.sky-static-text` (`sky-static-overlord` repeating-gradient scanline, unchanged since V1b, see above), plus one `focus-lead` decor-line. The Squads rail icon (`rail-squads-icon`) and the hub page switcher (`hub-tabs`) are clean at all sizes and themes.
