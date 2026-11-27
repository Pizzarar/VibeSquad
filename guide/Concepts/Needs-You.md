# Needs You

When agents run in [Normal mode](Modes.md), they work on their own and only interrupt you when they hit something they cannot resolve themselves. The top of the left sidebar is the **Needs you** attention spine. It tells you at a glance who is waiting, why, and what has finished.

## The Needs you list

The **Needs you** list sits at the top of the sidebar. You can also press **Ctrl+J** from anywhere in the app to jump directly to the top agent that needs you. When nothing is waiting, it displays "All clear. Nobody needs you."

### What lands here

Agents appear in the list in order of urgency:

1. **Permissions waiting for your OK:** When an agent needs to run a command or access a tool requiring approval (such as a terminal command). Quick permissions show **Allow** and **Deny** buttons directly on the row.
2. **Questions and choices:** When a [Lead](Lead.md) or [Buddy](Buddy.md) flags a decision for you (`needs-you`) or asks a question that stops its work.
3. **Errors:** When an agent encounters an error and stops.
4. **Quiet or stalled agents:** When a running agent stops reporting progress.

### When quiet or stalled agents show up

An agent working normally reports progress regularly. VibeSquad marks an agent as stalled in the **Needs you** list in two situations:

- **Quiet:** The agent has been running for 10 minutes without any update and has no tool call in flight.
- **Hung tool:** An open tool call has exceeded its timeout ceiling (the tool's own timeout plus a 60-second grace period, or 60 minutes if no timeout was specified).

### Row layout and actions

Each item in the list shows:
- A colored status dot (amber for attention, pink for errors, amber ring for stalled).
- The agent's role (such as **Lead 1** or **Brainstorm**).
- The project and lane location (for example, `weather · Main Game`).
- How long ago the agent flagged the request.
- The reason it needs you (such as `Bash: npm test` for a tool permission, or the question text).

The list shows up to 5 visible items. When more are waiting, a toggle at the bottom shows `▸ N more` (which expands to `▾ Show fewer`).

Hovering over any row (or focusing it with the keyboard) reveals a **⋯** (More actions) menu:
- **Snooze 2h:** Temporarily snoozes the alert for two hours so you can focus on other tasks.
- **Dismiss:** Clears the attention item from the list. Tool permissions cannot be dismissed; they must be answered with Allow or Deny.

## Done recently

Directly below the Needs you list is **Done recently**, folded behind `▸ Done recently · N`.

Clicking it expands to show up to 8 recent completions:
- Workers and agents that finished their tasks and are waiting for you to review their results.
- The newest completion log entries across your projects.

Finished agents show a blue status dot, the completion summary, where it happened, how long ago, and the same **⋯** menu to dismiss or snooze. When no completed tasks are logged, it reads "No finished work logged yet."

## The Desk row

In the sidebar under each project, the **Desk** row sits above your feature lanes. The Desk is home to your project-level agents:
- **Overlord:** The project's hub Lead, responsible for overall coordination and cross-lane handoffs.
- **RiffBot:** The project's hub Buddy, used for general product brainstorming.
- **Bugs:** The project-wide issue triage desk.

If an Overlord is not yet active on the project, the Desk card provides a button to **Start Overlord**.

## Folded worker lines

When a lane or Desk has several [workers](Worker.md) running, the sidebar keeps things clean by showing only the currently selected, on-screen worker. All other workers fold into a single compact line showing running, quiet, and idle counts:

`▸ N running · M quiet · K idle`

For example, `▸ 2 running · 3 idle` or `▸ 1 running · 1 quiet · 2 idle` (omitting any count that is zero). Clicking this line leaves the split view and opens the **Workers** tab in the right panel, where you can see every running, quiet, and idle worker in detail.

## Decision cards

When agents need you to choose between paths, they present a decision card. Decision cards collect choices so you do not have to dig through timelines to unblock work.

Each decision card includes:
- **Header:** The lane tag (such as `@art` or `Desk`), the asking agent, how long ago it was asked, and an `inferred` badge if structured fields were parsed from free text.
- **Ask and Decides:** The question being asked, along with a **Decides:** summary explaining what your answer will change.
- **Options and Leans:** Available choices displayed as lettered buttons. When an agent recommends a path, that option is marked with a **Lean** badge (which becomes **✓ Lean** when selected).
- **None of these:** If none of the offered choices fit, choose **None of these** (or **Not that** if only one option was offered).
- **Reply and Dismiss:** An input field to "Add a note or reply…" (or "One-line answer…") for custom instructions, along with a **Dismiss** button.
- **Off-screen items:** Tasks requiring hands-on action (such as manual device testing, paying for a service, or deploying a release) appear in an **Off-screen · Test, money & release** section with **Mark done** (`✓ Done`) and **Dismiss**.

### Batch actions and sent answers

At the bottom of the Decision Desk, a persistent action bar lets you handle multiple decisions together:
- **Use all leans (N):** Accepts all recommended agent leans with one click.
- **N need a look:** Highlights cards that do not have a suggested lean and need your review.
- **Send N answers:** Sends all your staged decisions at once. A 5-second undo timer appears with **Undo** and **Send now** options before the answers are finalized.
- **Sent answers summary:** An expandable summary banner at the bottom ("Sent answers") shows recent answers, with a **Details ▾** toggle to see which decisions were delivered to which lanes.

---
Used in: [Working with Squads](Squads.md), [Step 2](../Guide/02-lead-and-workers.md), [Normal and Psycho](Modes.md).
