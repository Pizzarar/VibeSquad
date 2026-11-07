# Sending while it works

You can type to an agent while it is still in the middle of a job. That is normal. Ideas show up at the wrong time.

The catch: a message sent mid-job can *steer* the agent. It stops what it was doing and bends toward your new message. Sometimes that is what you want. Often it is not, because you only meant "oh, and also...".

## What to do

- **A side thought** ("also", "by the way", "on another note"): send it as its own message and make clear it is separate. Where the app lets you queue it, queue it, so it waits its turn.
- **A real change of direction:** say so plainly ("stop, do this instead"). Use the explicit send-now option if the app has one.
- **Not sure what the agent is doing right now?** Glance at it first. Interrupting a nearly finished job wastes it.

## How VibeSquad queues your messages (v0.2.8)

- **Your messages go first.** A message you type in the app (or send with `vs send` from your own terminal) is an owner message. If the agent is waiting in line behind background work, your message jumps ahead of the queued background turns for the same provider. It can even start a little over the busy limit (up to 2 extra at once), so a message to a busy Buddy starts within seconds instead of waiting behind the workers (`runner/runner.mjs:51-55`, `:259-263`).
- **Rapid follow-ups merge.** If you send two or three lines in a row while the first is still waiting to start, they join into one turn, in order, with a blank line between them. If any of them is yours, the merged turn counts as yours (`runner/runner.mjs:529-553`). So there is no harm in splitting a thought over a few quick messages.
- **Messages from other agents wait their turn.** Only a human send gets the priority; a Lead or worker messaging an agent goes in the normal line (`server/mcp/tools.mjs:244-246`).
- **A running turn.** By default your message steers the turn that is already running; an interrupt cancels it first (`runner/runner.mjs:521-522`, `:540`, `:563`).
- **Waiting is shown.** A queued agent shows a "queued" label with how many are ahead (`server/backend/runner-backend.mjs:89`).

Typos and shorthand are fine here. Agents read "gold for a second" as "hold for a second". Do not stop to fix your spelling.

Used in [What I learned](../Guide/04-what-i-learned.md).

> **Aub:** I interrupt mid-turn a lot, because things pop into my head. I'd rather everything queue by default, with a small "send this now" button for when I really mean to steer.
