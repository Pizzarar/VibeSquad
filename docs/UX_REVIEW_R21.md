# VibeSquad UX review, round 21: Storybook view (SB5), targeted re-drive of fix round 3

Date: 2026-11-24 · Build: `sb5-storybook-view` @ `d3716c20` (history races + HEAD probe).

**Setup: the branch's own server route, not the live server.** The scratch harness lives outside the repo. It serves the `npx vite build` output and passes `/api/storybook/*` to the branch's `handleStorybookRoute` (`server/storybook/api.mjs` @ `d3716c20`), with injected teams `efi` → the local EFI checkout, plus `site` and `vibesquad` (no adapter). All git access was read-only: I never pressed Refresh, so nothing was fetched. Other `/api` calls return 404, and `?demo=1` supplies the views. The real server's auth guard sits in front of the route, and the harness bypasses it.

Browser: Normal and Psycho, dark, 1920×1080. There were 0 page errors. Every Storybook-path sequence was also run with no Storybook involved (BASE), so pre-existing cockpit history behaviour isn't charged to SB5. Screenshots are in `docs/lanes/storybook/ux-r21/`. No source edits.

**Verdict at `d3716c20`: PASS 0/0/1 (critical/major/minor), plus 1 nit.**

## Results

| Check | Normal | Psycho | Evidence |
|---|---|---|---|
| Boot probe uses HEAD, no full GET | **Pass** | **Pass** | Boot fires `HEAD efi 200`, `HEAD site 404`, `HEAD vibesquad 404` and no GET. Over the whole run the server log shows 181 HEAD and 17 GET, and every GET matches an actual Storybook open (5 per vibe, plus my curl and the first partial run). HEAD efi takes 19 ms with no body; the full GET is 663 ms cold and 2.78 MB. Closes R20 P1. |
| First ⋯ menu open | **Pass** | **Pass** | On the very first open after boot, Main Game offers "Open Storybook" and Site doesn't (`menu-main-first.png`, `menu-site-first.png`). |
| Rapid double-click Storybook Back | **Pass** | **Pass** | Site → Main Game → Storybook, then a double-click on Back lands on `?team=efi`. That's exactly one step, with no skip to Site (`boring-dblclick-back.png`). |
| Rapid double Esc | **Pass** (see nit) | **Pass** (see nit) | History goes back exactly one step to `?team=efi`, never to Site. In Psycho, and once in Normal, the 2nd Esc reaches the cockpit and does the cockpit's own Esc (`view=squads`), the same as BASE Esc in the cockpit (`psycho-double-esc.png` vs `boring-double-esc.png`). |
| Ctrl+K agent pick, then Browser Back ×3 | **Pass** (see m1) | **Pass** (see m1) | The pick leaves Storybook → `?team=vibesquad&agent=demo-aud` (`boring-palette-agent.png`). The Backs go `?team=efi&agent=demo-aud` → `?team=efi` → `?team=efi`. They never bounce into Storybook and never skip past the page before Storybook. The screen staying on the agent during Back is BASE behaviour (BASE agent Back ×3 never changes the screen either). |
| Ctrl+K squad pick ("Site"), then Browser Back ×3 | **Pass** (see m1) | **Pass** (see m1) | `?team=site` → Back `?team=efi` (Main Game) → `?team=efi` (**dead press**) → `?team=vibesquad`. BASE gives `?team=site` → `?team=efi` → `?team=vibesquad` with no dead press. |
| "need you" pill, then Browser Back ×3 | **Pass** (see m1) | **Pass** (see m1) | The pill (5) → `?team=vibesquad&agent=demo-aud` (`boring-pill.png`). The Backs match the Ctrl+K agent row: no bounce into Storybook, and one duplicate `?team=efi`. |

## Findings

### Minor

- **m1 · Leaving Storybook by a forward pick (Ctrl+K, the pill, Ctrl+J) leaves one dead Browser Back press.**
  - **Job hurt:** retracing steps after a detour.
  - **What happens:** `closeStorybook("replace")` (`src/StorybookView.tsx:42-50`) strips `?sb=` from Storybook's own entry, which then reads exactly like the entry before it (`?team=efi`). App's URL sync then pushes the destination (`src/App.tsx:1849`). One Back press therefore lands on an identical URL and nothing changes on screen.
  - **Evidence:** the squad row above (BASE has no dead press), and the third Back in the agent and pill rows.
  - **Fix:** in `"replace"` mode, set a one-shot flag so App's next URL sync uses `replaceState` instead of `pushState`. The destination then takes over Storybook's entry: one entry per page, and Back from the destination goes straight to the page before Storybook.
  - **Files:** `src/StorybookView.tsx`, `src/App.tsx` · **Effort:** S

### Nit

- **A rapid double Esc can also trigger the cockpit's Esc (Squads Home, `view=squads`)** once the first Esc has closed Storybook. History is correct (one step), and the second key does what Esc does in the cockpit, so this is arguably expected. If the owner finds it surprising, swallow Esc for about 300 ms after Storybook closes via Esc.

### Pre-existing, not charged to SB5

- Browser Back after an agent pick changes the URL but not the screen, and BASE shows a mixed `?team=<prev>&agent=<new>` entry. This happens identically with no Storybook (BASE agent rows), and was already noted in R19/R20 as a cockpit URL-sync issue for @bug.

## Inbox

@storybook: m1 (one-shot replace for the next URL sync, S). Nit optional.
