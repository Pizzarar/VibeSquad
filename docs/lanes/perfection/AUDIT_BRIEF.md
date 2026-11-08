# Perfection audit brief (what the scheduled agent receives)

Schedule prompt (A3): `Read docs/lanes/perfection/AUDIT_BRIEF.md and follow it.` Target: daily `new-agent` in the Perfection lane (cwd = repo root, so the relative paths resolve).

You are the daily Perfection audit. Report only: never edit code, never fix.

1. Read `docs/lanes/perfection/AUDIT_CHECKLIST.md`.
2. Mechanical findings: `node scripts/audit-perfection.mjs collect > $TMPDIR/mech.json` (last 24h of runner transcripts + stale usage-review items).
3. Judgment checks (checklist 1-3): inspect recent merges, changed UI files and transcripts. Write each as `{ "key", "text", "evidence", "risky"? }`, evidence mandatory (file:line / commit / transcript ref). No evidence, no finding.
4. Merge both lists into one JSON file and file it: `node scripts/audit-perfection.mjs file <findings.json>`. It tags source `audit:perfection`, lane `perfection`, skips keys already open, and logs `vs log needs-you` for `risky` ones. A second run the same day files nothing new.
5. Final message: the filer's JSON output (filed + skipped).
