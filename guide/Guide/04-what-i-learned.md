# Step 4: What I learned

This page is Aub's. It is short on purpose.

## What did not work

> **Aub:** Telling it *how* to build a feature. I used to write: "The player walks up to the loot box, holds the key until it opens, then a sound plays and the lights flash." Now I write: "I want players drawn to the box. Opening it should feel exciting. They shouldn't click through it and keep running. They should want to look at what they got."

## Small habits that help

Plain tips. None of them need technical skill.

### Ask for the outcome, not the steps

Say what you want to be true at the end, not which tools to use. The agent often knows a cleaner way than the one you had in mind. See [Outcome, not mechanism](../Concepts/Outcome-not-Mechanism.md).

### You can send a message while it is still working

It will not always wait politely. A message sent mid-job can steer the agent off what it was doing. For a side thought, say it is a side thought ("by the way, later:"). For a real change of plan, say "stop, do this instead". See [Sending while it works](../Concepts/Sending-While-It-Works.md).

> **Aub:** In the messages I looked at, roughly 1 in 7 arrived within a minute of the one before it (measured). So this happens to me constantly, and it is fine. Just know which kind of message you are sending.

### Typos and shorthand are fine

Type fast. "sotpped", "dameon", "go for b" and "send it" are all understood. If something is truly unclear, the agent should guess from context, say what it guessed, and keep going. You do not need to proofread.

### One ask per message, or split the pile

If you dump four things in one message, they can blur together. Number them, or send them as separate asks. Then each can go to the right place and run side by side. Your Buddy can sort the pile for you if you want: "split this into separate jobs."

### Ask the Lead for status

The Buddy is for ideas and plans. The Lead is for "where are we?" It already knows, so ask it directly.

> **Aub:** I used to ask the Buddy for status. It had to dig through the logs to find out what the Lead already knew, and that burned tokens. I should have gone straight to the Lead.

### Proof, not prose

"It works" is a claim. Ask for the output: the test results, the change summary, a screenshot. If it cannot show you, it should say "unchecked" instead of guessing. See [Proof, not prose](../Concepts/Proof-not-Prose.md).

### When the chat gets long, hand off

A long chat is slower, costs more, and gets fuzzier. Do not push through it. Ask for a handoff note and start a fresh chat from it. See the next section and [Handoff](../Concepts/Handoff.md).

## Context and handoffs

Long chats cost more and get fuzzier, because every turn re-reads the whole chat. I plan a Lead handoff at about 100k tokens, hand off by 150k at the latest, and never go past 200k.

What I learned about this: [Handoff](../Concepts/Handoff.md).

## Greenfield advice

Starting from an empty folder is a different job from changing an existing project. The kit's [AGENTS.md](../Setup/templates/AGENTS.md) asks that scratch files go in a `scratch/` folder in the project.

> **Aub:**
>
> 1. **Brain dump.** I dump everything into one chat in a stream of consciousness: features, style, pitfalls, whatever I can think of. The goal is to get as much of what I'm building into plain English as possible.
> 2. **Look up what already exists.** A web-search agent explains, in plain English, the ideas and existing things I'm drawing from. For example: "Describe the post-apocalyptic worlds of Escape from Tarkov and the STALKER series: the colors, the world-building, common structures, the nature. Everything."
> 3. **Set up the lanes.** I give the Buddy what I want plus what already exists, and it sets up the lanes. Then I talk through each lane and how it connects to the others.

## Next

[Step 5: pass it on](05-pass-it-on.md). Back to [Start](../Maps/Start.md).
