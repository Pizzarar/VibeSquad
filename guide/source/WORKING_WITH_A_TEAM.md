# Working with an AI agent team

This is how I work with AI agents. It's not the only way. It's the way I landed on after a
lot of mistakes, and I'd rather you skip the mistakes.

You don't need any of the team setup on day one. Everything in this guide has a **Try this**
box you can do with plain Claude Code (Level 1). The team tooling (Level 2) comes at the end,
when you've felt the problems it solves.

Words in **bold** the first time I use them are in [GLOSSARY.md](GLOSSARY.md).

## How to read this

- Read one section, do its Try this, then stop. Come back tomorrow.
- Each **I used to / Now / Because** box is a real lesson. I made the mistake first.
- Examples lean on your world: a laser-cut coaster, a sprite, a CNC sign.
- You'll see the same pattern over and over: write it down, make the agent prove it, let
  something else check it.


## 0. Why I work this way

An AI agent is not autocomplete. It's closer to a small team of very fast, very literal
junior people who forget everything when you close the window.

That one sentence explains most of this guide:

- They're fast, so you can run several at once.
- They're literal, so you have to write down what you want.
- They forget, so anything important has to live in a file, not in chat.
- They're confident, so you need proof before you believe them.
- They're cheap per task but not free, so you route work to the right one.

I don't write most of the code or scripts myself anymore. My job is deciding what to build,
judging whether it looks right, and keeping the system from drifting. That's the part that's
actually mine.

If you come from art, you already have the key skill: you know when something looks wrong.
Agents don't. Your eye is the final gate on everything visual, and I'll keep coming back to
that.

> **Try this (5 min).** Open Claude Code in any folder with a few files in it. Ask: "Explain
> this folder back to me like I'm new. What's here, what runs, what's missing?" Then correct
> one thing it got wrong. Notice how fast it reads versus how sure it sounds.

---

## 1. Give the agent a rules file first

Before I ask an agent to do anything real, there's a rules file at the top of the project.
Mine is called `AGENTS.md`. Claude Code reads `CLAUDE.md`, so my `CLAUDE.md` is one line that
imports `AGENTS.md`. Other tools read `AGENTS.md` directly. One file, every tool.

What goes in it:

- What the project is, in a few lines.
- How to run the tests or the build.
- What the agent must not touch.
- How to report back (see section 4).
- What to do first and last in every session.

The best part: every rule can carry the reason it exists. "Don't skip the test run, because
once a suite silently failed to load and reported zero failures." An agent that knows the
reason makes better calls at the edges.

> **I used to** paste a fresh block of instructions into each chat: what to change, what not
> to touch, how to report.
> **Now** those rules live in one file in the repo that every agent reads at the start.
> Only I approve edits to it.
> **Because** chat rules evaporate between sessions. And I use more than one tool, so I
> wanted one set of rules they all share, with the incident behind each rule written next to
> it so new agents don't repeat old mistakes.

Start small. Five rules is plenty. Add a rule when something goes wrong, not before.

See [Setup/templates/AGENTS.md](../Setup/templates/AGENTS.md) for a starter with the placeholders marked.
At Level 2 the Lead's own rules go in a second file,
[Setup/templates/LEAD_RULES.md](../Setup/templates/LEAD_RULES.md), that only the Lead reads. Every worker
loads `AGENTS.md`, so rules only the Lead needs would cost each worker context for nothing.

> **Try this (10 min).** Make a folder called `hello-agent`, run `git init`, and create an
> `AGENTS.md` with five rules. Suggested: (1) say what you'll change before changing it,
> (2) change one thing at a time, (3) show raw output when you run anything, (4) never delete
> files without asking, (5) if something surprises you, stop and tell me. Start a new Claude
> Code session and ask it to make a laser-cut coaster script (a Python file that writes an SVG
> circle with a hairline stroke). Watch it follow your rules without being told.

---

## 2. Brainstorm before building

Most of my bad outcomes started with me describing half an idea and an agent running with it.

So now there's a rule: **no code while we're still talking.** I open a separate chat just
for thinking out loud. It asks me questions. I ramble. It pushes back. When I'm done, it
writes a **brief**: one page that says what the idea is, what's decided, what's out of scope,
and what "done" looks like.

The brief is the product of the chat. The chat itself is disposable.

A good brainstorm chat:

- Interviews me instead of waiting for a perfect prompt.
- Lists what's decided and what's still open.
- Has an **Out of scope** section. This one matters. It stops the project from growing
  while nobody's looking.
- Marks owner decisions (see section 6).

I run this on a mid-level model at medium effort. Thinking out loud doesn't need the
strongest model, and it's cheaper.

> **I used to** talk straight to whichever agent was doing the work, and I got lost: lots of
> agents, no idea who to talk to.
> **Now** I talk to one brainstorm chat. It turns my rambling into a brief and hands it to
> whoever builds. The builder reviews the brief and fixes it before starting.
> **Because** I needed one place to think, and a strong model was overkill for it. The
> builder's review catches the brainstorm's mistakes.

The brief template is [Setup/templates/LEAD_BRIEF.md](../Setup/templates/LEAD_BRIEF.md). Its headings:
Idea, Decided, Sources, Plan, Done, Out of scope.

> **Try this (15 min).** Pick one real idea, for example a CNC-carved house-number sign.
> Open a Claude Code session and say: "Don't write any code. Interview me about this idea,
> one or two questions at a time. When I say 'brief', fill in the LEAD_BRIEF template."
> Answer honestly, including "I don't know". Say "brief" and save the result as
> `BRIEF.md`. Keep that file. You'll use it in section 3.

---

## 3. Dispatching a Lead

The first section where it starts to feel like a team.

The **Lead** is an agent whose job is to plan and dispatch. It reads the brief, splits the
work into small pieces, hands each piece to a **worker**, checks what comes back, and
merges. That's all.

The rule I repeat the most: **the Lead never writes code. Not even one line.**

> **I used to** let the coordinator "just fix the one line" itself.
> **Now** it always dispatches, even for a one-line fix.
> **Because** a coordinator that starts doing the work skips the independent review, fills
> up its own memory, and loses track of the queue. I had to remind it again after almost
> every handoff, so now the instruction is in the rules file and repeated in the handoff.

In my day-to-day, I don't talk to the Lead much at all. The brainstorm chat hands it the
brief. The Lead asks me only for real decisions.

### Level 1 version: two sessions and a piece of paper

You don't need special software for this. You need two Claude Code sessions and a file.

1. **Session A (the Lead).** Give it your brief. Tell it: "You are the Lead. Don't write
   code. Split this into 2-3 small tasks. For each one, write instructions a stranger could
   follow: files to touch, steps, how to prove it worked."
2. **Session B (the worker).** Open it in the same project, in a second terminal. Paste in
   one task. Let it work.
3. Carry the worker's report back to Session A by hand: copy, paste. The Lead checks it
   against the task.

That hand-carrying is the whole trick. Level 2 (Paseo, see section 12) just automates the
copy and paste. The thinking is the same.

At Level 2, one reporting rule matters once your team mixes providers (say a Claude Lead and
a Gemini worker): **a worker's final message is its report.** The Lead reads it when the
worker finishes. Workers never use Claude's `SendMessage` or `ListAgents` tools to report;
an agent from another provider never sees those. If a worker needs the Lead mid-task, it uses
`paseo send`. The rule is in the Worker hard rules of
[Setup/templates/AGENTS.md](../Setup/templates/AGENTS.md).

> **Try this (15 min).** Take the `BRIEF.md` from section 2. Open two terminals. In the
> first, say "you are the Lead" and ask for tasks. In the second, paste task 1. When the
> worker finishes, paste its report into the Lead and ask: "Does this match the task?
> What's missing?" Count how many times the Lead wants to write code itself and tell it
> no.

---

## 4. Proof, not prose

This is the section I'd tattoo on a monitor.

An agent saying "done, all tests pass" tells you almost nothing. It tells you what the agent
believes. What you want is the raw evidence:

- The actual command output, pasted, not summarized.
- The test count line: how many ran, how many passed.
- `git diff --stat`, so you see exactly which files changed.
- For anything that should have run: a marker, like a printed line that only appears if the
  new code path executed.
- For visuals: the agent looks at the result (a render, a screenshot) *before* telling you
  it's good.

And two rules that sound odd:

- **A test count that went down is a failure**, even if zero tests failed.
- **"I can't do that" is a valid answer.** I'd rather hear it than get a made-up result.

> **I used to** accept "done, all tests pass."
> **Now** I only accept captured raw output: the real count line, the diff stat, and proof
> the new code actually ran.
> **Because** it burned me three different ways. A test suite that never loaded reported
> zero failures for a whole cycle. A setting was missing and nobody noticed. And an agent
> quoted a log line that didn't exist.

There's a visual version too. I once got a character animation with perfect numbers, and it
looked goofy the moment I watched it. Metrics can't see goofy. Your eye can.

> **I used to** trust the numbers on visual work.
> **Now** the agent has to look at it first, and then I do.
> **Because** "technically correct" and "looks right" are different things, and only one of
> them is in the report.

### Stop, don't work around

Related rule for workers: **if something surprises you, stop and say so.**

Every worker starts with a precondition check, which I call STEP 0: right branch? Expected
last commit? Clean tree? If anything's off, or the job needs a file outside its list, it
stops and reports.

> **I used to** get workers that "fixed" surprises on the way, on top of a broken base.
> **Now** a mismatch means stop and report. Stopping gets praised.
> **Because** a workaround on a broken foundation hides the real problem and sneaks in
> changes nobody reviewed. A worker should never make a failing check pass by moving the
> check.

### Where am I? Ask the code, not the docs

> **I used to** ask an agent "where are we?" and believe the notes file.
> **Now** the answer comes from the code and the git history. If a doc disagrees, the code
> wins and the agent says so.
> **Because** docs drift. I had a "next steps" block that pointed at a commit and a test
> count that were both long gone.

The order I trust, best to worst: test output, the diff, the source, a summary, the docs.

The report format I ask workers to use is in
[Setup/templates/REPORT_FORMAT.md](../Setup/templates/REPORT_FORMAT.md).

> **Try this (10 min).** In `hello-agent`, ask Claude to add a `--radius` option to the
> coaster script. Then say: "Show me the raw proof it works: the exact command you ran,
> its full output, and `git diff --stat`. No summary." Then ask it to open the SVG and
> describe what it sees. If it can't, ask it to tell you that instead of guessing.

---

## 5. Review by a different model family

Models from the same family tend to share blind spots. If the same one writes the code and
checks it, you get a very confident second opinion that agrees with the first.

So: **reviews come from a model from another family**, a fresh session that never saw the
author's reasoning. Reviewers also re-run the tests themselves. They don't trust the
author's numbers.

> **I used to** let the model that made the change check its own work.
> **Now** a fresh agent from a different family reviews every change, and I get a plan first
> and have a stronger model review that too, before any code is written.
> **Because** a model shares its own blind spots. A stronger model reviewing a cheaper
> model's plan caught a real math error in a formula. Reviewers also found "proofs" that
> didn't test what they claimed to.

A nuance: I don't run every tiny change through the heaviest review. High-risk work always
gets a different-family review. Routine work gets the cheapest other-family reviewer. You
decide risk by asking "what breaks if this is wrong?" A typo in a README: low. A change to
the file that your laser job reads: high.

If you only have one provider on day one, a fresh session of a stronger model is still
better than self-review. It's not as good as a different family, and I'd say so out loud in
the notes. I tried same-family fallback for a while and dropped it. See "Things I tried that
didn't work."

> **Try this (10 min).** Take the diff from the last section (`git diff`). Open a *new*
> session, and paste only the diff, not the reasoning. Say: "Review this change. Find
> bugs, missing edge cases, and anything that doesn't match what the code claims. Be
> blunt." If you have a second provider's tool installed, use that one. Count what the
> reviewer found that the author didn't.

---

## 6. What I keep for myself: decisions

Agents are good at options and bad at wanting things. I'm the one who wants things.

So I keep a short list that's mine:

- Design and taste calls. Does it look right? Is it fun?
- Edits to the rules file.
- Overriding a review that failed.
- Anything with a login, a payment, or an account setting.

Everything else, the Lead runs with. It doesn't wait for my approval. It stops when it needs
*me*, not when it needs a rubber stamp.

> **I used to** approve and merge every single step.
> **Now** the Lead runs until it needs a real decision from me. A failed review gets
> re-dispatched to a worker, not escalated to me.
> **Because** I was the bottleneck on things that didn't need me. I miss messages when I'm
> away from the screen. And the recommendations were good enough that reviewing all of them wasn't
> worth my time.

When it does need me, the format is always the same: a numbered question, two to four
options, and one marked **(Recommended)**. I answer by number: "1. recommended, 2. yes,
3. your call." Every answer gets logged with a date, so the same question doesn't come back
with a different answer later.

> **I used to** get open-ended questions, or find out an agent had quietly decided something
> for me.
> **Now** decisions arrive as options plus a recommendation, and I answer in seconds.
> **Because** it costs me a few seconds instead of a meeting, and it keeps a record.

Then it got too chatty:

> **I used to** answer decisions as they trickled in all day.
> **Now** they're batched into one short interview at a natural break, four questions at
> most per round, and the workers start on everything that doesn't depend on the answers
> *before* the questions are even asked.
> **Because** I kept missing the one-off questions, and my answers can take hours. Waiting
> for me shouldn't stop the work.

Small trade-offs the Lead just decides and logs somewhere I can reverse them.

> **Try this (10 min).** Ask Claude for a plan to add a second engraving design to your
> coaster script. Tell it: "End the plan with a section called Owner decisions. Each
> decision gets 2-4 options and one marked (Recommended). Don't decide anything for me."
> Answer by number. Notice how little effort it takes.

---

## 7. Running work in parallel safely

*(I merged three outline topics here: parallel work, the shared-machine rules, and working
from one machine.)*

Once you trust the loop, you want several agents at once. That works, with conditions.

### Separate lanes, no shared files

Each worker gets its own **branch** and its own **worktree**: a second checkout of the same
repo in its own folder, so two agents never edit the same working files at once.

Before the Lead hands out a job, it lists the files that job will touch and checks that list
against every job already running. If there's overlap, the job waits.

Fragile files that merge badly (big scene files, generated files, anything binary-ish) get
one agent at a time, always.

> **I used to** run one thing at a time.
> **Now** I run several lanes, with a file-overlap check before each dispatch. No two jobs
> touch the same file.
> **Because** my conflicts never came from running things in parallel. They came from two
> agents touching the same file. Remove the overlap and parallel gets safe.

Read-only jobs (searching, counting, summarizing) don't count against the limit. I run fewer
lanes while I'm away and more when I'm watching. Pick the number by trying it, not by
guessing: my limit came from a measured run.

### One shared machine has manners

> **I used to** let agents run long jobs in the background, stop programs by name, and share
> folders.
> **Now** every agent has its own branch, worktree and temp folder. Long commands run in the
> foreground and the agent doesn't end its turn until they finish. A program is only ever
> stopped by its own process ID.
> **Because** one agent once killed every instance of a program on the machine, including
> other agents' runs. And agents that ended their turn during a long run never woke up to
> read the result.

### One dev machine

> **I used to** split work across two machines, and later sent agents to run on the other one.
> **Now** one strong machine holds everything.
> **Because** splitting work across two machines caused lost uncommitted work and two
> "verified" results that contradicted each other. Remote dispatch also kept failing in
> annoying ways: broken installs, unexpected restarts, jobs stealing each other's slots.

The habit that came out of it: at the start of a session, state the current commit. At the
end, commit and push before you stop. If you have to move machines, push everything first
on a work-in-progress branch that never gets merged until it's checked.

> **Try this (15 min).** In `hello-agent`, make two scripts: `coaster.py` and `sprite.py`
> (a 16x16 grid of colors saved as a PNG). Use `git worktree add ../hello-a -b job-a` and
> `git worktree add ../hello-b -b job-b`. Open two sessions, one in each folder: one edits
> `coaster.py`, the other edits `sprite.py`. When both finish, merge both branches and run
> both scripts. Then try to make them collide on purpose (both edit `AGENTS.md`) so you've
> seen what a conflict looks like.

---

## 8. Spend: the right model at the right effort

Not every job needs the smartest model. The expensive one is for deciding. The cheap one is
for clear, mechanical work.

My rough routing, by kind of work:

| Work | What I use |
|---|---|
| Planning, hard changes with lots of rules | A strong model |
| Routine building | A mid-level model |
| Mechanical edits, searching, counting, read-only surveys | A cheap model |
| Review | A model from another family |

Effort is a setting on the model, and it lives in the agent's profile, not in the prompt.
Leads and brainstorm chats run at medium. High effort everywhere roughly doubled usage
for little gain.

> **I used to** run the strongest model at high effort on almost everything, Leads included.
> **Now** work is routed by type, and cheap models get a **work order** for clear jobs.
> **Because** one provider's allowance ran out while another sat idle, and one high-effort
> lane used far more than its share. Read-only and mechanical work was burning budget that
> decisions needed.

### Work orders for cheap models

A cheap model does well when nothing is left to guess. A **work order** lists:

- The goal, in one sentence.
- Every file it may touch.
- The steps, quoting the current lines it will change.
- The tests, including one deliberate "break it on purpose and see it fail" check.
- The exact verification and the expected output.
- Stop conditions, and an Out of scope list.

If a cheap model fails, that usually means the order was vague, not that the model is bad.
Template: [Setup/templates/WORK_ORDER.md](../Setup/templates/WORK_ORDER.md). Role notes you can paste
into agent profiles are in [Setup/templates/agent-profiles.md](../Setup/templates/agent-profiles.md).

I introduced the cheap work-order model as a trial with keep-or-drop criteria. Try new
things with an exit plan.

### A cheap pre-check

Reading worker reports is expensive if the reader is my strongest model.

> **I used to** have the expensive Lead read every worker report in full.
> **Now** a cheap model checks the evidence first: is the raw output there, does the diff
> match the scope, does the commit exist, are the counts up to the floor? A fail bounces
> straight back to the worker. The Lead still spot-checks passes.
> **Because** the Lead's time and memory are the costly parts, and "is the proof missing?"
> is a mechanical question.

This one is newer, so I don't have a long track record on it yet.

### A backup that runs on another provider

> **I used to** stall whenever my main provider's usage ran low.
> **Now** I keep a backup brainstorm chat and a backup Lead set up on a second provider,
> ready to take over.
> **Because** a team that runs on one provider stops when that provider's quota does.
> Waiting on caps was my most common stall.

Test the backup before you need it. I tried a non-main-provider Lead once under pressure; it
hit permission and profile problems and I handed the job back. That's a cheap lesson if you
learn it on a quiet day.

> **Try this (15 min).** Pick a small job, like "rename every file in this folder to
> lowercase with dashes". Run it twice: once on a strong model, once on a cheap model with a
> mini work order (goal, file list, steps, expected output). In Claude Code, `/model`
> switches models. Compare the time, the result, and what you'd need to add to the order for
> the cheap model to get it right first time.

---

## 9. Context and handoffs

An agent's **context** is everything it has read in the current session. Every turn, the
model re-reads all of it. The longer the session, the more each step costs, and the fuzzier
the agent gets about what mattered.

So long-running agents, especially the Lead, get replaced on a schedule.

> **I used to** let a Lead run until the context was a mess: hundreds of thousands of
> tokens.
> **Now** at about 100k the Lead stops dispatching and writes a handoff file. A fresh Lead
> takes over by 150k.
> **Because** each turn re-reads everything, so a fresh Lead starting around 50-80k is much
> cheaper. The cost curve is flat from 100k to 150k, so that's the window where nothing is
> lost by switching. Handoffs at that point saved around 40% of Lead tokens.

The handoff file is the key. It holds:

- Who's working on what right now.
- Open pull requests.
- The queue of what's next.
- Anything the old Lead learned but hasn't written down yet.

The new session reads the handoff and the repo, and carries on. The state of the project
lives on disk, so the session itself is replaceable.

A warning from experience: a rule written in text only gets followed some of the time. One
Lead sailed past the limit and handed off much later. Now a small **hook** (a script the
tool runs automatically) warns at both marks. It's in
[Setup/templates/hooks/](../Setup/templates/hooks/) if you want it. The exact numbers come from my
setup. Pick your own by measuring.

The template is [Setup/templates/LEAD_HANDOFF.md](../Setup/templates/LEAD_HANDOFF.md).

> **Try this (10 min).** Continue your Lead session from section 3. Say: "Write a
> LEAD_HANDOFF using the template. Include what's in flight, what's next, and anything
> you know that isn't written down yet." Save it. Close the session. Open a new one, paste
> only the handoff, and ask: "What are you about to do, and what should I check?" Did
> anything get lost?

---

## 10. Housekeeping

*(Naming, archiving and merge rules are all in this one section.)*

The boring stuff that keeps the team from turning into mush.

### One star per area, archive what's done

> **I used to** have dozens of agent sessions open and no idea which one was the live Lead.
> Old Leads kept waking up on stray notifications.
> **Now** the live Lead has a star in its name. When it hands off, the outgoing one renames
> itself to "old, see the star one." The new Lead archives it once its workers finish.
> Workers get archived as soon as their work is accepted, after I check that nothing is
> unpushed. I aim for about a dozen sessions, max.
> **Because** it's easy to lose track, and old Leads waking up at full context cost around 10% of
> all Lead spend. The agent would load everything, realize it was the old one, and go back
> to sleep.

Level 1 version: don't leave sessions lying around. Close what's finished. Keep one file
called `NOW.md` that says which session is doing what.

### Merge through a pull request, and let GitHub hold the gate

Everything goes through a branch and a **pull request** (PR). Never straight to main.

> **I used to** merge every PR by hand after watching CI. Once I merged in the wrong order
> and made conflicts for myself.
> **Now** a PR auto-merges once the required `ci` check passes. Changes to CI workflows or
> release config, and anything labelled no-automerge, stay mine to merge by hand.
> **Because** a required check is enforced every single time. My attention isn't.

Two traps I hit:

- **Set up the required check *before* turning on auto-merge.** Without a required check,
  auto-merge merges instantly. That's the opposite of what you wanted.
- **Verify on main after merging parallel branches.** Once a clean, no-conflict merge
  quietly dropped a line that registered a test. Every per-branch run was green. The count
  on main was one short. So after merging, check that the test count went up by exactly what
  you expected.

For your own personal repos, I'd have the agent open the PR and you press the button.
Auto-merge makes sense once a repo has a real required check. For hosted runners, stick to
GitHub's own free ones. Free hosted minutes can run out, so plan a fast docs-only path.

> **Try this (15 min).** Push `hello-agent` to your own GitHub account (it's fine to make
> it private). Make a branch, change the coaster script, open a PR with `gh pr create`.
> Add a tiny workflow that runs your script and fails if it exits non-zero. Mark it
> required in the repo's branch settings, then turn on auto-merge for the PR and watch it
> merge when the check goes green.

---

## 11. AI art: label it, keep it apart

If you come from art, I'll be careful here and honest.

My rule for the projects I make: **generated images are for concept and placeholder
only.** They don't go in the shipped product. The plan is always to swap in real art made by
a human.

How I enforce it:

- Generated images live in their own folder, excluded from the build.
- Every file name starts with a tag for the tool and the date, so a stray one is obvious.
- A manifest file records the tool, the prompt and the date for each.
- A not-for-release notice sits in the folder.
- Art that code produces (a script that draws a pattern) is fine. That's a program, not a
  generated image.
- Everything starts as a placeholder: a gray box, a flat color. Real assets come later.

> **I used to** have no rule, so generated concept images could sit right next to real
> assets.
> **Now** they live in their own folder with a manifest and a tag on every file name.
> **Because** they're only for concept and placeholder, I don't want ownership or legal
> questions, and a tag makes any strays easy to catch before something ships.

### This is still changing

I'm not going to pretend I have this figured out. Recently I tried agent-driven pixel-art
tools and the results changed my mind faster than I expected. I'm now open to *disclosed*
AI art in some places, if the quality holds up. The rules around AI art (copyright, store
policies, what clients accept, what art communities think) are still moving, and they
differ by country and platform.

What I'd suggest:

- Check the policy of anywhere you plan to publish or sell. Re-check every few months.
- Disclose it. Don't hide it.
- Keep your own hand-made work clearly separate and credited.
- If you disagree with using it at all, that's a valid position. You can use agents for code
  and scripts and never touch generated images.

You'll have better instincts here than I do. Tell me what you think.

If you want to try a pixel tool that an agent can drive, there's an optional module:
[Setup/modules/pixel/piskel-mcp.md](../Setup/modules/pixel/piskel-mcp.md). An **MCP** server is how you
give an agent new abilities; this one gives it a headless pixel-art engine that exports PNG
and GIF files you then open in your normal sprite editor. A caution: every MCP server
adds descriptions of its tools to every session's context, which costs money. Install it per
project, not globally.

> **Try this (10 min).** Make a folder `concepts-ai/` in `hello-agent`. Generate or request
> one concept image for a coaster design, and save it as `ai-<tool>-<yyyymmdd>-coaster.png`.
> Add a `MANIFEST.md` row with the tool, the prompt and the date, and a one-line notice
> file saying "not for release." Then hand-draw (or script) the real version in Inkscape or
> Piskel and compare the two.

---

## 12. Growing from Level 1 to Level 2

You've been doing everything with plain Claude Code and a lot of copy and paste. That's the
right way to start. You learn what the automation is for.

### Day 1

- A rules file.
- One brainstorm chat that ends in a brief.
- One worker session at a time. Raw proof every time.

### Week 1

- Two sessions: Lead and worker, with a hand-carried brief.
- A different-family review of anything you care about.
- A handoff file when a session gets long.
- Your first PR through a branch.

### Month 1

When the copy and paste starts to hurt, add one of these, not all of them:

- **Paseo**, a tool for running and managing many agent sessions together. It handles
  hand-carrying briefs and reports for you. See
  [Setup/modules/core/vibesquad.md](../Setup/modules/core/vibesquad.md). Same ideas, less typing.
- **A second provider** for reviews and a backup, so one quota running out doesn't stop you.
- **The context hook** so you don't have to remember the handoff mark.
- **Self-hosted CI runners**, only if free hosted minutes become a real problem. That's the
  last thing, not the first.

Add one thing, use it for a week, then decide.

> **I used to** try to set up the whole team on the first day.
> **Now** I add one piece, live with it, then add the next.
> **Because** each piece solves a specific pain. Until you've felt the pain, the tool feels
> like homework.

> **Try this (10 min).** Write down the single most annoying thing from this week's
> sessions. Look at the list above and pick the *one* item that fixes it. Set up only that.

---

## A day in my workflow

This is what a normal day looks like now. It took about two months to get here, and most of
it arrived in the last few weeks.

**Morning, on my phone.** I open the brainstorm chat and ramble. A new idea, a bug I noticed,
something that looked off. It interviews me, and anything long goes in a shared document I
answer when I have time. At the end it hands me a brief.

**It gets handed over.** The brief goes to the Lead for that project. I don't need to talk to
the Lead. It reads the brief, corrects what's wrong with it, and splits the work into blocks
with file lists.

**Routing.** For each block the Lead picks the model by kind of work: strong for hard or
rule-heavy changes, mid for routine builds, cheap with a work order for mechanical jobs. It
checks that no two jobs touch the same file, then dispatches up to a handful of lanes.

**Workers do one thing each.** Own branch, own worktree, STEP 0 first. They report raw
output. If anything surprises them, they stop.

**The check.** A cheap pre-check reads the evidence. A reviewer from another family reviews
the change and reruns the tests. The Lead spot-checks one claim.

**The merge.** The PR goes in when the required check is green. The Lead logs it, archives
the worker's session, updates the "what's next" notes.

**Handoff.** Around 100k the Lead writes a handoff file. The successor takes the star in its
name, and the old one is archived.

**What I do all day.** Not a lot, and that's the point. I answer queued decisions. I look at
what got built, by eye. I make taste calls. I approve rule-file edits. I merge anything that
touches CI or release config. I handle logins, billing and anything that needs a browser. I
create and edit agent profiles, add permission rules (agents are blocked from doing that),
choose providers and budget, and switch to the backup chat if my main usage is low. My
typical messages: "merged", "go", "check", "still?"

---

## Things I tried that didn't work

You'll want to try some of these. Try them with an exit plan.

- **A coordinator that also codes.** It kept doing everything itself. Fixed with the Lead
  rule: no code, ever.
- **Same-family review as a fallback.** I allowed it while a provider was down. It kept
  rubber-stamping. Now the rule is never review your own family.
- **A cheap model on a sandboxed tool.** It stalled: the sandbox blocked what it needed, and
  an approval prompt never showed on screen, so it hung waiting. I brought it back after a
  config fix and dropped it again later. The lesson: if a worker is quiet, check for an
  invisible permission prompt.
- **A worker seat with no shell.** It couldn't run tests or commit. Useless for building.
- **Cloud coding agents driven through a browser agent.** Hit walls constantly. Retired the
  same day.
- **Splitting work across two machines.** Lost work, conflicting results, broken installs,
  jobs fighting over slots. Now it's one machine.
- **Background test runs and killing programs by name.** Missed results, and one agent
  stopped everything else.
- **Workers grading their own "break it on purpose" proofs.** Reviewers rerun them instead.
- **Relying on free hosted CI minutes.** They can run out. A fast docs-only path helps.
- **High effort on everything.** Roughly doubled usage. Medium is the default now.
- **An even more expensive top-tier model.** Looked at it, skipped it, not worth the cost.
- **Letting an agent design a styled page with no reference.** "Far too generic." Better
  with a different model, a written art brief, and a correction pass. Give visual work a
  reference, and judge it by eye.
- **Animation from scripts or phone motion capture.** Poor. Physics-driven motion worked.
- **A different provider's model as the Lead, in a hurry.** Permission and profile
  friction. Handed back. Test backups early.

The pattern: most failures were me skipping a rule I already had, or trying to save money in
the wrong place.

---

## As of 2026-10: who does what

Everything above uses roles. Here's the one place I name names, and it will go stale. Check
the date.

| Role | My pick right now |
|---|---|
| Strong model (planning, hard changes) | Claude Opus or the larger Claude model available |
| Mid model (routine building, brainstorm chat) | Claude Sonnet |
| Cheap model (work orders, pre-check, read-only surveys) | Claude Haiku |
| Different-family reviewer | OpenAI's Codex CLI or Google's Gemini CLI, whichever has quota |
| Backup brainstorm / Lead | The same CLI as the reviewer, on its own login |

Don't treat this as advice about what's best. It's what I happen to use this month. In six
months it'll be different. The roles won't.

---

Terms are in [GLOSSARY.md](GLOSSARY.md). Tell me what is confusing; this is a draft of a draft.
