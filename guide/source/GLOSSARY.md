# Glossary

Plain-word meanings of the terms in [WORKING_WITH_A_TEAM.md](../source/WORKING_WITH_A_TEAM.md).

## The team

**Agent.** An AI session that can read files, run commands and change code on your behalf.
Not the same as a chat: it acts.

**Brainstorm (chat).** A session just for thinking out loud. No code. It interviews you and
ends by writing a brief.

**Lead.** The agent that plans, dispatches work to workers, checks results and merges. It
never writes code itself.

**Worker.** An agent that does one small job on its own branch and reports back with proof.

**Reviewer.** A fresh agent that checks a change it didn't write, ideally from a different
model family.

**Pre-check.** A cheap model's quick pass over a worker's report, before the Lead reads it.
It checks the evidence is there (raw output, matching diff, real commit, counts) and bounces
anything missing.

**Owner.** You, the human. The owner keeps the calls about taste, rules and money.

**Owner decision.** A choice that's yours: options plus one marked recommendation, answered
by number and logged.

**Level 1 / Level 2.** Level 1 is plain Claude Code and your own copy and paste. Level 2
adds tooling to run a team (a session manager, a second provider, hooks).

## Models

**Model.** The AI engine behind an agent. Bigger models cost more and plan better; smaller
ones are cheap and fast.

**Model family.** A set of models from the same maker. Models in a family tend to share
blind spots, which is why a review from another family is worth more.

**Strong / mid / cheap model.** Roles, not products. Strong decides and handles hard work.
Mid does routine building. Cheap does mechanical or read-only work from a work order.

**Effort.** How hard the model thinks before answering. Higher is slower and costlier.
Medium is my default.

**Provider.** The company you get a model from, with its own login and usage limit.

**Quota (usage limit).** How much you can use a provider before it pauses you.

**Profile.** A saved set of role instructions, model and effort for an agent, so it behaves
the same way each time.

## Files and templates

**AGENTS.md (rules file).** The file at the top of a project that every agent reads first.
`CLAUDE.md` can simply import it.

**LEAD_RULES.md.** *(Level 2)* The Lead's extra rules, kept out of `AGENTS.md` so workers don't load them.

**Brief.** A one-page summary of an idea: what it is, what's decided, what's out of scope,
what "done" means. The output of a brainstorm.

**Work order.** Instructions so exact that a cheap model can follow them: goal, files, steps,
tests, expected output, stop conditions.

**Handoff.** A file that lets a fresh session pick up where an old one left off: what's in
flight, open PRs, the queue, loose notes.

**Report (report format).** The block a worker sends back: what changed, raw proof, anything
unexpected.

**Manifest.** A list that records where each piece of generated art came from: tool, prompt,
date.

**Out of scope.** The section that says what the job must *not* do. It keeps work from
growing.

## Rules of thumb

**Raw output.** The real, unedited result of a command, pasted. The opposite of a summary.

**Proof.** Evidence you can check: a count line, a diff stat, a captured log, a render.

**STEP 0 (precondition check).** What a worker checks before starting: right branch, expected
last commit, clean tree. Any mismatch means stop and report.

**Stop rather than work around.** If something's unexpected, a worker halts and says so,
instead of quietly fixing it.

**Planted-bug check.** A deliberate break you add to a test to make sure the test can
actually fail. If it can't fail, it proves nothing.

**Cross-family review.** Review by a model from a different family than the one that wrote
the change.

**Tree wins.** If a doc disagrees with the code and git history, the code is right.

**Test count floor.** The minimum number of tests that must run. A drop below it is a
failure even if nothing is red.

## Git and GitHub

**Repo (repository).** A project folder tracked by git.

**Commit.** A saved snapshot of changes with a message.

**Branch.** A separate line of work, so changes don't touch the main one until you merge.

**Worktree.** A second checked-out copy of the same repo in its own folder, on its own
branch. It lets several agents work at once without editing the same files.

**Lane.** One stream of parallel work: a branch, a worktree and a worker.

**File-overlap check.** Before dispatching a job, compare its file list to every running
job's. If any file appears twice, the job waits.

**Pull request (PR).** A request to merge a branch into main. The place where checks and
review happen.

**CI (continuous integration).** An automatic job that runs your tests when you open a PR.

**Required check.** A CI job that GitHub insists must pass before a merge is allowed.

**Auto-merge.** A GitHub setting that merges a PR by itself once the required checks pass.
Turn on the required check first, or it merges immediately.

**Runner.** The machine that runs CI jobs. Hosted runners are GitHub's; self-hosted ones are
your own.

## Context and tools

**Context.** Everything an agent has read in the current session. The model re-reads all of
it each turn, so long sessions cost more and get fuzzy.

**Token.** A chunk of text, roughly a word fragment. Usage and context are counted in tokens.

**Hook.** A small script a tool runs automatically on an event, such as a warning when
context gets large.

**MCP (Model Context Protocol).** A standard way to give an agent extra abilities, such as
driving a pixel-art tool. Every MCP server adds its tool descriptions to the context, so
install them per project.

**Runner.** The built-in part of VibeSquad that runs and manages many agent sessions in one place. It
automates the carrying of briefs and reports. (VibeSquad was originally built on Paseo by getpaseo; v0.2.8 no longer needs it.)

**Claude Code.** The command-line agent you start with. It reads `CLAUDE.md`.

**Headless.** Running without a visible window. A headless pixel engine draws and exports
files without opening an app.

## Other

**Placeholder.** A stand-in asset (a gray box, a flat color) used until the real one exists.

**Concept art.** Early images used to explore an idea, never shipped.

**Quarantine folder.** A separate folder for AI-generated images, excluded from the build.

**Disclosed AI art.** Generated art that's clearly labelled as such to the people who see it.

## Setup words

**PATH.** The list of folders Windows looks in when you type a command. A tool installed a minute ago may not be on
your session's list until it is refreshed.

**UAC.** The "Do you want to allow this app to make changes?" pop-up. Only you can click Yes.

**Elevated.** A window running as administrator, with extra power. Setup works without it.

**winget.** Windows' built-in app installer. The setup uses it to install tools by their exact names.

**Verify.** The small check at the end of each tool's page, such as printing its version, that proves it installed.
