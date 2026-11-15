# Art Director Review — `@desk` Unit `unit-desk-d3a-header` (HEAD `7c87bd3`)

**Verdict:** **FAIL**

Reviewed at 3200×1800 (4K @ 120% zoom), Dark and Light themes:
- `docs/shots/desk-d3/d3a-dark-header.png`
- `docs/shots/desk-d3/d3a-light-header.png`
- `docs/shots/desk-d3/d3a-dark-menu.png`
- `docs/shots/desk-d3/d3a-light-menu.png`
- `docs/shots/desk-d3/d3a-dark-strip.png`
- `docs/shots/desk-d3/d3a-light-strip.png`
- Baseline comparison: `docs/shots/desk-d2/d2-dark-chat.png`, `docs/shots/desk-d2/d2-light-chat.png`

---

## Rubric Check

| Gate | Verdict | Notes |
|---|---|---|
| **1. One line, calm, no competing accents** (only `[Allow]` and `[Send]`/`[Queue]` filled) | **FAIL** | Header row itself is a calm 48px single line (`[Interrupt]`, `[Stop]`, `[Dock ◀]`, `[⋯]` are all outline/ghost). However, in `d3a-{dark,light}-strip.png`, the stall bar renders a bright **filled amber CTA** (`[Cancel & Resume]`), competing directly with `[Allow]` and `[Send]`/`[Queue]`. In `d3a-*-header.png`, the header state glyph is also a muted grey square `■` instead of the semantic state dot (`○` idle / `●` `--st-run` running). |
| **2. `[Stop]` reads as dangerous but not shouting** | **PASS** | Outlined button with `--st-err` (`#ff6b8a` dark / `#c22a52` light) text and subtle danger border (`1px solid color-mix(in srgb, var(--st-err) 40%, transparent)`). Clear hierarchy beside neutral `[Interrupt]`. |
| **3. `⋯` menu organised into scannable groups; selects usable** | **PASS (with polish)** | The 4 selects (`Provider`, `Model`, `Mode`, `Thinking`) are cleanly aligned in a 2-column label/select grid and read well in both dark and light. Needs a hairline divider inside the 6-item top action list, sentence-case section heading (`Model & mode` instead of tracked `MODEL & MODE`), and `--st-err` (or muted secondary) on `[Archive]` instead of amber. |
| **4. Status strip urgency colour, height, and wording** | **FAIL** | Spec requires **one conditional 32px status strip** (`UX_REVIEW.md` S6, §3, §4.2). `d3a-{dark,light}-strip.png` renders **two stacked bars** (~72px total height): a legacy 40px inset rounded pink error-tinted stall banner (`Tool "Agent" running for 1260s` in raw seconds instead of `21m`) stacked above a full-bleed 32px amber context bar (`Context 89% full` with no `Hand off ▸` action). |
| **5. Alignment with breadcrumb/tabs row and 880px column** | **PARTIAL** | Header left/right edges (`16px` padding) align cleanly with the D2 breadcrumb and `Details` button. However, the two stacked status strips have mismatched horizontal geometry (one inset with `8px` margin + border-radius, one full-bleed `0px`), and neither aligns its content to the `880px` centred conversation column. |
| **6. Contrast (dark & light)** | **PASS** | Surface and text contrast pass AA across both themes (`#1a1624`/`#14111c` dark, `#ffffff`/`#f6f4f9` light, with approved `#ece8f2`/`#e6e1ef` light tints). |

---

## Required Fixes (MUST)

1. **MUST-1 · Consolidate status strip into a single 32px bar, remove filled `[Cancel & Resume]` CTA, and fix urgency colour/copy** (`src/BoringAgentHeader.tsx`, `src/AgentDrawer.tsx`, `src/boring.css`):
   - Hide the legacy drawer stall banner (`Tool "Agent" running for 1260s`) in Normal mode (`html[data-vibe="boring"] .stall-banner { display: none; }` or omit in `AgentDrawer.tsx` when `BoringAgentHeader` is active) and merge stall + handoff/context ≥72% into the single `.boring-status-strip` (`height: 32px`).
   - Format stall duration in human units (`Stalled · Tool "Agent" running 21m` instead of `1260s`, per `UX_REVIEW.md` C10).
   - When multiple conditions hold, join with `·` on one line: e.g. `◌ Tool "Agent" running 21m · Context 89% full` with inline ghost/text actions `Cancel & resume` and `Hand off ▸` (`background: transparent; border: 1px solid var(--border-strong); color: var(--text-1); height: 24px; padding: 0 8px; font: 500 12px/16px var(--font-sans)` — **never filled amber**).
   - Use `--st-attn-bg` (`color-mix(in srgb, var(--st-attn) 10%, var(--surface-1))`) and `1px solid color-mix(in srgb, var(--st-attn) 30%, transparent)` bottom border with `--st-attn` glyph (`#ffc46c` dark / `#a86a00` light) and `--text-1` copy — never the pink permission/error banner tint for stalls.

2. **MUST-2 · Use the unified semantic state glyph in `.boring-agent-header` instead of a grey square `■`** (`src/BoringAgentHeader.tsx`, `src/boring.css`):
   - Replace the static grey square glyph (`■`) before the agent title with the §4.3/§4.5 state glyph matching the member tab above it: `●` (`color: var(--st-run)` `#4fd6cf` dark / `#16857f` light) when running, `○` (`color: var(--text-3)`) when idle, `!` (`color: var(--st-attn)`) when needs-you/permission, `◌` (`color: var(--st-attn)`) when stalled, `✕` (`color: var(--st-err)`) on error.

---

## Polish Fixes (NICE)

1. **NICE-1 · Header role/lane subtitle case and format** (`src/BoringAgentHeader.tsx`, `src/boring.css`):
   - Change the all-caps `.boring-agent-role` (`BRAINSTORM`, `LEAD`) to sentence-case `role · lane` (e.g. `Brainstorm · VibeSquad`, `Lead · VibeSquad`) using `--t-small` (`font-size: 12px; line-height: 16px; font-weight: 500; color: var(--text-3); text-transform: none; letter-spacing: 0`), matching `UX_REVIEW.md` §2.6 (`state glyph · name · role/lane`) and C6.

2. **NICE-2 · Align `.boring-status-strip` inner layout with header/column** (`src/boring.css`):
   - Remove the inset margin/border-radius mismatch so `.boring-status-strip` sits flush under `.boring-agent-header` (`margin: 0; border-radius: 0; padding: 0 16px; height: 32px`), or cap its inner container to `max-width: 880px; margin: 0 auto` to align with the timeline column.

3. **NICE-3 · `⋯` menu scannability & token cleanup** (`src/BoringAgentHeader.tsx`, `src/boring.css`):
   - Add a `1px solid var(--border)` divider (`margin: 4px 0`) in `.boring-agent-menu` separating inspection/state actions (`Mark unread`, `Search transcript`, `Summary`, `Park in Inbox`) from lifecycle actions (`Handoff to fresh Buddy`, `Reload session`).
   - Change `MODEL & MODE` heading to sentence-case `Model & mode` (`text-transform: none; letter-spacing: 0; font: 500 11px/16px var(--font-sans); color: var(--text-3)`).
   - Style `[Archive]` at the bottom of the menu with `color: var(--st-err)` (`#ff6b8a` dark / `#c22a52` light) instead of amber `--st-attn`.
