# Perfection audit checklist (v1)

Source: docs/PLAN_PERFECTION_AUDIT.md "Decided". The daily audit run reads this file. Report only; never fix (fixes route via R11).
Each finding is one inbox item with evidence (file:line / commit / transcript ref). The filer dedupes against open items by `key`.

1. **UI compact by default** (judgment). Scan `src/**/*.tsx` + `src/*.css` changed in the last 24h (`git log --since=24.hours --name-only master`). Flag panels/menus that open expanded by default, huge menus, or long scrolls. Key: `ui-compact:<file>`. Evidence: file:line.
2. **R11 fix routing** (judgment). In recent runner transcripts and `vs log`, a bug or out-of-unit fix that was asked about instead of queued/done. Key: `r11:<run id>`. Evidence: transcript ref.
3. **R12 Overlord escalation** (judgment). An owner cross-lane principle handled lane-locally instead of escalated to the hub Overlord + a @bug audit item. Key: `r12:<run id>`. Evidence: transcript ref.
4. **Rubber stamps + fix offered as a question** (mechanical). From `collect`: `scripts/audit-owner-stamps.mjs` buckets 1-5 (stamps, relay, early handoffs, fixers, fix-offers). Do not reimplement.
5. **Stale usage reviews** (mechanical). From `collect`: open `usage-review:*` inbox items older than 3 days. Key: `stale-usage-review:<card id>`.

Risky or owner-only findings (a principle change, anything needing Aub's call): set `"risky": true` so the filer also runs `vs log needs-you`.
