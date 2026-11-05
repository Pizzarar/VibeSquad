# Working with Squads

A Squad is one product. A lane is one feature inside it. This note is how to run several lanes at once without losing track of any of them.

## One Squad per product

Make one Squad for each thing you are building: a game, a site, a tool. Everything for that product lives in its Squad, and every lane in it shares one log.

## One lane per feature

Each feature gets its own lane. A lane has:

- one [Buddy](Buddy.md), the chat where you think the feature through
- one [Lead](Lead.md), the chat that runs the work
- the Lead's [workers](Worker.md)

Lanes run in parallel. While one Lead is building the weather screen, another lane can be planning sounds. Names are in [Naming](Naming.md).

## The flow in one lane

1. Riff with the Buddy. Say what you want, answer its questions.
2. When the idea is clear, tell it to "send it". The Buddy writes the [plain plan](Plain-Plan.md).
3. The plan goes to a Lead.
4. The Lead splits it into jobs for workers.
5. Each worker ends with PASS or FAIL. The Lead reads those and reports to you.

## Checking in across lanes

You do not have to open every chat. Ask any Buddy or Lead to run:

```
vs log --since-me
```

It shows what changed since you last looked, across every lane in the Squad: decisions, things you said, and `needs-you` flags.

A `needs-you` flag means an agent is stuck on something only you can decide. Answer it in that agent's chat and the lane moves again. Do this first when you sit down.

## One Buddy per topic

Keep each Buddy to one topic. A Buddy that has been riffing on one thing for hours gets slow, expensive and vague.

When a new topic comes up, do not squeeze it into the same chat. Say "spin up a buddy for X". It checks whether X overlaps a lane you already have. If it does, it points you there. If not, you get a new lane and a fresh Buddy.

## Split the plan up front

Cut the plan into pieces small enough that one Lead can finish a piece in about 100k tokens of context. Several small plans beat one huge one. If you can't tell whether a piece fits, split it again.

## The handoff ladder

This is for Leads and Buddies.

- **Aim for 100k.** Plan the piece so you are done around here.
- **Be out by 150k.** Past this, hand off. A fresh Lead or Buddy starts from a short note.
- **Never past 200k.** This is the hard ceiling.

Split up front, and hand off anyway if a chat runs long. The full steps are in [Handoff](Handoff.md).

> **Aub:** Hand off by 150, no more than 200k, but really shoot for 100k. Split and hand off often. And separate topics so you don't over-riff with a brainstorm on one topic.

Used in [Step 2](../Guide/02-lead-and-workers.md).
