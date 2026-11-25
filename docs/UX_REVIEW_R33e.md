PASS 0/0/0 8d9d7948

# UX review R33e: PLAN_PROJECT_ORDER O1+O2 fix round 4 (Normal sidebar), narrow re-check

**Build:** `unit-ui-project-order` @ `8d9d7948`. It changes only src/boring.css and test/project-order.test.mjs vs 6fbcf4f7. The boring.css diff is exactly the three rules from /tmp/ui3-po-fix4.txt:
- `:1477` adds the selector `.boring-main-line.boring-project-line` to the sticky rule.
- `:1475` sets the tree to `flex-basis: 0; min-height: 120px`.
- `:1471` raises the pin floor to `min-height: 60px`.

The app ran on vite dev :5442. **Baseline:** the merge-base checkout /tmp/ux-po/master on :5443.

**Setup:** the R33d drivers, unchanged except for their output paths (`m.mjs`, `mchev.mjs`, `chev2.mjs`, `r4.mjs`, and `crops5.mjs` = `crops.mjs` with the injected fix removed). They are in /tmp/ux-po5/drv/, with the raw JSON next to them. The setup was Playwright + Chromium with `?demo`, and non-GET `/api/teams` was stubbed, so 0 writes reached the registry. There were 0 page errors in any driver. Viewports: 3200×1800@1.2, 1920×1080 and 1280×720, each in dark and light.

**Naming:** "the hub project" is the project Ctrl+J lands in, and "the second project" is the other one used as Main. Crops mask project names as "Project X".

**Not re-flagged (lead decisions):** the m4 bust, no reorder on phone, the sidebar scrolling at 720, and the 120px tree floor.

## Status vs R33d
| R33d | Now | Evidence (`r4.json`, `m.json`; dark and light are identical at every size) |
|---|---|---|
| M1: the Main header scrolls out of the pin | **Fixed** | **At 720, after Ctrl+J:**<ul><li>The pin is at 501–721 with scrollTop 99.</li><li>The header line is at **502–560, inside the pin**, so `headerVisible` is true.</li><li>The selected worker row is at 688–720 and visible.</li><li>The URL has `agent=demo-aud`.</li></ul>**With the pin scrolled to the bottom:** the header stays at 502–560 (scrollTop 615) at 720 and at 573–631 (scrollTop 557) at 1080.<br>Crops: `720d-ctrlj-pin.png` and `720l-ctrlj-pin.png` show the name, Open and ⋯ over the scrolled cards. `1080d-pin-scrolled.png` and `1080l-pin-scrolled.png` show the header above the scrolled lanes. |
| M2: at 4K, Main's lanes scroll inside the pin | **Fixed** | **At 3200×1800, second project as Main and expanded, hub project open in the tree:**<ul><li>The pin is 572–1244, **670/670 (no inner scroll)**.</li><li>The tree is 1252–1698 (967/446).</li><li>The footer is at 1706.</li><li>Collapsing the tree's open project leaves the pin at 670/670.</li></ul>**Hub project as Main (Ctrl+J or Open):** 835px, 833/833.<br>Crop: `4kd-main-expanded.png`. |
| m1: the collapsed pin clips at 720 | **Fixed** | The active Main is collapsed after Open: the pin is 588–648 (h 60), scrollHeight 58 = clientHeight 58, and `scrollTop=10` gives 0. The same holds at 1080 and 4K. Crop: `zoom-720d-main-active-collapsed.png`. |
| 1080 footer 986 with Main expanded | **Pass** | **Second project as Main, expanded:**<ul><li>The pin is 572+278 (276 of 670 visible).</li><li>The tree is 858+120, about 3 rows on screen: `1080l-pin-scrolled.png` shows three other projects below the pin.</li><li>**The footer is at 986.**</li></ul>**Hub as Main after Ctrl+J or Open:** the pin is 278 (276 of 833 visible), the tree 120, and **the footer is at 986**.<br>The sidebar is 1080/1080 in both cases. Master: 986. |
| 4K footer 1706 | **Pass** | The footer is at 1706 in every state (Main collapsed or expanded, Ctrl+J, Open, re-expand), the same as master. |
| The Main header doesn't jump on expand | **Pass** | The Main chevron stays at y 584 → 584 at 4K and 1080, and 600 → 600 at 720. 9/9 real clicks toggle at each size, and there is no grip on the Main row (`mchev.json`). |
| Grip vs chevron | **Pass** | The grip is at x 13 (7px wide) and the chevron at x 21 (16px wide), with 0 overlap at every size. The 21-point real-click sweep (`chev2.json`) gives non-Main rows **the same result as master, point for point**, at all three sizes. Every key is byte-identical to R33d's run, and the grip never appears in a miss. |
| Rows with no Main = master | **Pass** | `rowsEq true` at every size in both themes. The footer with no Main is 1706, 986 and 716, the same as master. |
| Invariants | **Pass** | Every state has exactly one `.on` row. The breadcrumb matches the open agent: Open gives second project › Desk › RiffBot, and Ctrl+J gives hub › Desk › Worker. |
| 720 | **Pass (as decided)** | **Collapsed Main:** the header is at 589–647. **Expanded:** a 220px pin with its lanes scrolling inside. The sidebar scrolls 1038/720, as decided under the 120px floor. |
| Dark / light | **Pass** | The light numbers are identical to dark. The header, accent frame and Open button are legible in both (`720l-ctrlj-pin.png`, `1080l-pin-scrolled.png`, `4kl-main-expanded.png`). |
| ui:clicks | **Pass** | 0 unique hits (see Guards). |

## Findings
None. No critical, major or minor finding is open in the area under review.

Observation, not a finding: when the pin is scrolled, cards and lanes slide under the sticky header. A sliver of the card tops shows just below the Open/⋯ line at 720 (`720d-ctrlj-pin.png`). That is normal sticky behaviour, and nothing that explains *why* is cut off.

## Guards
- **`npm run ui:clicks -- --vibe boring --surfaces boring-home,boring-lead,boring-brainstorm,boring-overview,boring-settings`** (foreground, R33d's environment: TMPDIR under $HOME, PLAYWRIGHT_DIR=/tmp/pwtool/node_modules, system Chromium): **PASS, 0 unique hits**. The run did 2002 hit-tests across 40 popovers and 120 triggers, with 0 skipped, in 290s.
  - 1080, 4K and 1280 have 0 mismatches and 0 clipped in both themes.
  - mobile/boring has 0 controls, the same as R33d.
  - Copy: /tmp/ux-po5/guards/ui-clicks-unit.md (log: ui-clicks.log).
- **Cleanup:**
  - Removed the worktree's `scratch/ui-clicks` and the temp profile dirs. The pre-existing `scratch/{h1c-v4,h1e,overlord-v4,shots}` were left alone.
  - Both vite servers are stopped (0 listeners on :5442/:5443).
  - `git status` in the worktree is clean at 8d9d7948. Nothing was written to the repo.

## Owner decisions
None.

## Not done
- Phone and touch drag weren't re-measured. They're out of scope for a CSS-only round, and the r4 diff touches neither the grip nor the phone picker.
- Ctrl+J into a worker deep in a *scrolling* pin at 4K wasn't exercised, because the hub-as-Main pin doesn't scroll at 4K (833/833). The 720 and 1080 cases cover that path.
