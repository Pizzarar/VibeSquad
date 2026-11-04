# Naming

Once you have more than two or three agents, names matter. A good name tells you who it is and what it does without opening it.

## The general form

- **Squad:** one project, such as "Lemonade Game".
- **Lane:** one feature inside the project, such as "Weather". Each lane has one [Buddy](Buddy.md), one [Lead](Lead.md) and its [workers](Worker.md).
- **Buddy:** `BRAINSTORM · <lane>`
- **Lead:** `★ LEAD · <LANE> ord1`, then `ord2` for the next one after a [handoff](Handoff.md)
- **Retired Lead:** `(old) ★ LEAD · <LANE> ord1`
- **Worker:** `<LANE> · <job>`

Rules:

- Put the lane first, so a sorted list groups by feature.
- Do not put the model name in the title. It changes, and the tool already shows it.
- Only one live Lead and one live main Buddy per lane. A project can run many lanes at once.
- Rename a retired agent to `(old)` so you never talk to the wrong one.

**VibeSquad:** it sets titles from labels (squad, lane, role) and flags titles that do not match. Its naming standard is [NAMING.md](https://github.com/Pizzarar/VibeSquad/blob/HEAD/docs/NAMING.md).

In any other agent, rename each chat by hand. Use the same pattern.

> **Aub:** I kept replying in lanes I shouldn't have been in, like talking straight to a DeepSeek auditor or an art lead. Naming helped, but what actually fixed it was VibeSquad.
