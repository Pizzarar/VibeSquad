# <PROJECT>: Lead Rules

Copy this file to the root of your project as `LEAD_RULES.md`, next to `AGENTS.md`. Level 2 only.
Only the Lead reads it: its brief or profile says "Read AGENTS.md, then LEAD_RULES.md". Workers
never load it. Replace every `<PLACEHOLDER>` the same way as in `AGENTS.md`.

> **Why a separate file:** every worker loads `AGENTS.md` at the start of every task. Rules only
> the Lead needs would cost every worker that context for nothing.

All of `AGENTS.md` still applies to the Lead. These rules only add to it.

## Lead rules

1. **Never write source.** If a fix is one line, dispatch it anyway. *Why: a Lead that "just fixes
   it" loses the big picture and skips review.*
2. **Design decisions need the owner.** Do not dispatch a task that embeds an unconfirmed design
   decision. Present options with a recommendation and wait.
3. **Every task names its role:** `TASK: <ID>  ROLE: <role>`. The Lead mints task IDs; an ID exists
   once it is written into `<DECISION_LOG>`.
4. **Cross-family review.** A reviewer is never the author's model family. *Why: a model shares its
   own blind spots.* Keep a short pairing list in this file, for example: `<strong>`/`<cheap>` work is
   reviewed by `<other family>`; if only one family is available, use a fresh session of the other
   tier and say so in the log. Route work by type, and put the strongest model only where the
   decision is hard:

   | Work | Role |
   |---|---|
   | New system or design question | Spec (owner signs off), then review |
   | Hard, invariant-heavy, multi-system | Implement with the strongest model |
   | Multi-file block with a clear scope | Planner writes a work order, `<cheap>` executes it |
   | Rename, data, tests to an existing spec | Mechanical |
   | "Where is X used?" | Scout (instead of the Lead reading code) |
   | Census, usage map, dead code | Audit (read-only) |

   Effort lives in the role profile; the Lead does not raise a worker's thinking level ad hoc.
   Never put the strongest model on read-only or mechanical work. *Why: that was burning the budget.*
5. **Audit before accepting.** A worker report without raw terminal output, `git diff --stat`, and test
   output is rejected and re-dispatched, never "accepted with caveats". Spot-check at least one claim
   against the real tree. *Why: most rejects were missing proof, not bad code.*
   **Pre-check first (Level 2, optional).** A cheap read-only checker reads the report before the Lead
   does: raw output present, `git diff --stat` files match the scope, the commit exists on the branch,
   test counts present. On FAIL the Lead bounces it without reading it in full.
6. **No overlapping workers.** Never run two workers on overlapping files at once. Each gets its own
   branch/worktree. Before each dispatch, list the block's files and check them against every running
   block. Start with 1-2 parallel workers and add more only when the file check keeps conflicts at zero.
   *Why: conflicts came from overlap, not from parallelism.*
7. **Merge gate.** The Lead merges to `main` through a pull request, never a direct push, when all hold:
   the review required by rule 4 returned PASS with findings resolved or accepted as low; CI on the PR
   is green; the Lead spot-checked at least one claim; the PR embeds no unconfirmed design decision.
   Run `gh pr merge --auto` only if the repo has a required CI status check: without one, `--auto` merges
   right away. Check with `gh api repos/{owner}/{repo}/rules/branches/main --jq '.[] | select(.type=="required_status_checks")'`
   (rulesets) and `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks` (classic branch
   protection). Either must print a check list; empty output or a 404 means none. With a required check, GitHub
   enforces the gate rather than anyone's attention. With none, open the PR and stop for the owner to merge.
   Never bypass the check as admin.
   **The Lead runs autonomously until it needs the owner.** It stops only for: (a) a design decision;
   (b) edits to `AGENTS.md` or this file; (c) overriding a failed review. A failed review is not an owner stop:
   re-dispatch the fix and re-review.
8. **Docs.** The Lead owns write-backs to `<DECISION_LOG>`, `<ROADMAP>` and `<STATE_DOC>`, in their own
   commits. `AGENTS.md` and this file change only with explicit owner approval.
9. **State answers come from the tree.** Before answering a project-state question, run the
   first-action git commands in `AGENTS.md` (and `<TEST_COMMAND>` if relevant) and answer from that output. If a doc disagrees,
   the tree wins; say so.
10. **`## NEXT` is the definition of done.** Update it before the commit that closes a block.
11. **Session hygiene and handoff.** Long contexts are re-read on every turn, so cost and fuzziness
    grow with them. **At about 100k tokens of context: start planning the handoff (no new dispatches). By 150k:
    the successor has taken over, and never past 200k.** The context guard hook
    (`Setup/templates/hooks/context_guard.py` in the kit) warns at both marks. Steps (details in `LEAD_HANDOFF.md`):
    - The outgoing Lead writes `LEAD_HANDOFF.md`: every in-flight worker, open PRs, the queue, and
      unfiled write-backs.
    - It starts the successor from that file. After the handoff it does no more work.
    - The new Lead checks each in-flight worker itself rather than waiting for notifications.
    - *(Level 2)* Name the active Lead with a ★ and mark the old one `(old)`: one ★ Lead per area.
      Archive the old Lead once none of its workers are still running.
12. **Housekeeping.** Close out a worker when its report is accepted and its PR is merged: check that
    nothing is running, `git status` is clean and nothing is unpushed, then archive it.
    *Why: old agents kept waking up and costing tokens.*
