# VibeSquad UX review, round 20: Storybook view (SB5) re-review

Date: 2026-11-24 · Build: `sb5-storybook-view` @ `a97af01c`. This is the branch rebased on master (SB3+SB4). The R19 fixes are `23f7c3e4` + `a97af01c`, on top of R19 `9969498d`. Same method as R19: `npx vite build` into a scratch dir outside the repo, served statically. `/api/storybook/**` was mocked with Playwright `route()` using `efi-mini.json` and the R18/R19 stress copy (16-step chain, 18 findings). Other projects returned 404. The probe check used a synthetic ~3948-entity snapshot (1.8 MB) behind a 1.5 s delay.

Matrix:
- Navigation: Normal and Psycho, dark and light, 1920×1080 and 3200×1800 @ 1.2, all with `?demo=1`.
- Regression spot check: C1 and the jump, at 1920 dark (Normal) and 3200 light (Psycho).

There were 0 page errors in every pass. Screenshots are in `docs/lanes/storybook/ux-r20/`. No source edits.

**Verdict at `a97af01c`: PASS 0/0/1 (critical/major/minor), plus 1 nit (pre-existing).** Every R19 navigation finding is fixed in the browser. The startup probe causes no visible jank, but it downloads every adapter project's full snapshot on each page load (minor P1).

## Status vs R19

| R19 | Status | Evidence (browser-driven, all 4 runs unless noted) |
|---|---|---|
| **M1** Normal: Ctrl+K pick swallowed | **Fixed** | Ctrl+K "Audit – token scout" from Storybook → `?team=efi&agent=demo-aud`, cockpit shown. This holds in all 4 runs. In Psycho the URL is `team=vibesquad&agent=demo-aud` (`m1-normal-dark-1920-palette-agent.png`, `m1-psycho-light-1920-palette-agent.png`). Ctrl+K squad pick "Site" → `?team=site`, cockpit "Site › Overview", in both Normal and Psycho (`m1-normal-palette-squad-site.png`). Ctrl+J and the `need you` pill still leave Storybook. |
| **M3** Esc changes hidden state, Back needs 3 clicks | **Fixed** | Esc in Storybook → `?team=efi`, cockpit, with no `view=squads` (`m3-normal-light-3200-esc.png`, `m3-psycho-dark-3200-esc.png`). With a card open, the first Esc closes only the card (Storybook stays) and the second Esc leaves. Esc with Ctrl+K open closes only the palette. Storybook Back and Browser Back each leave in one press after a menu open. |
| **m6** 404 project offers "Open Storybook" on first menu open | **Fixed** | The Site ⋯ menu doesn't offer the item the very first time it opens (`m6-site-menu-first-open.png`). Main Game (200) still offers it. |
| **N1** raw id after reload / deep link | **Fixed** | `?sb=efi` reload/deep link → "Storybook · Main Game Project" in Normal and Psycho (`n1-normal-light-3200-deeplink-header.png`, `n1-psycho-dark-3200-deeplink-header.png`). |
| Nit: stray hover card after a finding jump | **Fixed** | After the jump, "2. Dock Runs" is focused, centered and flashing. No card opens for the entity under the pointer (`nit-jump-no-stray-card.png`). |
| Nit: probe is a full GET | Not fixed (SB4 route returns 405 for HEAD) | See P1, which this round promotes to minor because the probe now runs at startup. |
| Nit: TD edge-label overlap | Not fixed, queued by lead | Still "targets ener│at location" (`reg-psycho-light-3200-popper.png`). |
| Nit: MermaidView dark canvas in light theme | Not fixed, out of SB5 scope, queued by lead | — |
| Regression check: C1, M2, m9 | Still fixed after rebase | `.sb-tabs` is 54 px and sticky at top 0 on scrolled Characters/Findings. The 16-step chain is top-down and legible. |

## Startup probe (`src/App.tsx:1852`)

What I measured (Normal dark 1920, 3 demo projects):
- **Requests:** exactly one `GET /api/storybook/<id>` per project, all fired about 210 ms after navigation, after the cockpit was already usable (UI ready at 246 ms with the probe vs 228 ms with only cheap 404s).
- **Repeats:** opening a menu adds no requests. A reload repeats one request per project, because the `missing` map lives in the page.
- **Duplicates:** the effect's `views.length` dependency re-runs on project add/remove, but `probeStorybook` dedups per id, so it can't flood. Request count grows linearly with projects, once per page load.
- **Jank:** none visible. The probe never reads the body. One 51 ms long task appeared in the 1.8 MB run, versus none in the 404-only run.

### Minor

- **P1 · Every page load downloads each adapter project's full snapshot just to learn "exists: yes".**
  - **Job hurt:** none on screen. It's a cost the owner pays on every reload, phone included.
  - **Evidence:** `GET /storybook/efi` +212 ms at startup with the 1.8 MB body, repeated on reload.
  - **Why it costs:** on the real server, a cold cache means `buildSnapshotDetailed` runs a pinned-sha git read plus checks for EFI's ~3948 entities (`server/storybook/api.mjs:79-135`), and the route sends `cache-control: no-store` (`:161`). Every cockpit start therefore builds EFI's Storybook even if it's never opened. With several adapter projects, their slow first builds take up the browser's per-host connection slots alongside the cockpit's own `/api` calls at startup.
  - **Fix:** an SB4-side `GET /api/storybook` that returns the ids that have an adapter (one cheap call, no build), and point `probeStorybook` at it. The lead has already queued HEAD; this replaces that. Alternative: a lazy probe on ⋯ hover/pointerdown.
  - **Files:** `server/storybook/api.mjs`, `src/StorybookView.tsx:61-67`, `src/App.tsx:1852` · **Effort:** S

### Nit (pre-existing, not SB5)

- **A deep link or reload into Storybook needs two Browser Back presses.** On load, App's URL sync pushes a re-ordered copy of the URL (`?sb=efi&team=efi` → `?team=efi&sb=efi`), so the first Back lands on the same Storybook URL. The same extra entry appears with no `sb` at all (`?team=efi&demo=1` → Back → `?team=efi&demo=1`), so the cause is the generic push-on-load in the URL-sync effect (`src/App.tsx:1846-1849`), not this unit. Storybook's own Back leaves in one press. **Fix (App owner):** `replaceState` on the first sync after load. Queue for @bug.

## App.tsx hunk (freeze exception: additive only)

`git diff 9969498d a97af01c -- src/App.tsx`:
- `closeStorybook()` at the top of `onTeam` / `onAgent`. It does nothing when Storybook is closed (`src/StorybookView.tsx:36-37`).
- A `projectName` prop on `<StorybookHost/>`, which is used only inside the Storybook branch.
- The startup probe effect.

The first two are additive and confined to Storybook. **The probe effect is additive** (no UI change outside the ⋯ menu item), **but it runs in every session whether or not Storybook is ever opened.** That's the one App behaviour outside the view. See Owner decision 1.

## Invariants

The counts, one-selected, contrast, 44 px and truncation checks match R19 and pass. Header = what's shown now passes after Ctrl+K, Ctrl+J, the pill, Esc, Back and deep link, in both vibes.

## Owner decisions

1. **Keep the startup probe under the App.tsx freeze exception?** Recommendation: accept it for now, since there's no visible cost and it fixes m6. Make the cheap adapter-list endpoint (P1) the follow-up, so cockpit start doesn't build snapshots.

## Inbox cards

- @storybook: P1 (adapter-list endpoint + probe switch, S). This replaces the queued HEAD item.
- @bug: the pre-existing deep-link double Back (URL sync should `replaceState` on the first sync).
