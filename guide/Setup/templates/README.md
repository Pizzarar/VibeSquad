# Templates: when to use each

Copy these into your own project and replace the `<PLACEHOLDERS>`. Parts marked *(Level 2)* are for
the multi-agent setup; skip them with a single Claude Code session.

- `AGENTS.md`: copy to the root of every project, first. The rules file every agent reads each session.
- `LEAD_RULES.md`: *(Level 2)* copy next to `AGENTS.md`. The Lead's extra rules; only the Lead reads it, so workers don't pay for it.
- `LEAD_BRIEF.md`: at the end of a brainstorm, to hand the idea to a Lead (or a fresh session) with everything decided.
- `LEAD_HANDOFF.md`: when a Lead's context nears 100k tokens, to pass the work to a successor session.
- `WORK_ORDER.md`: when a strong model plans a multi-file task for a cheaper model to execute exactly.
- `REPORT_FORMAT.md`: the block every worker ends with, so the Lead can check proof, not prose.
- `agent-profiles.md`: *(Level 2)* role notes to paste into saved agent profiles.
- `hooks/`: *(Level 2, also useful at Level 1)* the context guard (Claude Code only) that warns at the handoff marks; see `hooks/README.md` for install and the test command.
