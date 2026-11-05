# Owner ↔ Agent Communication & Interrupt Audit

**Lane:** `bug-chaser` · **Unit:** `unit-owner-turn-audit` · **Date:** 2026-11-03
**Auditor:** worker (DeepSeek) · **Branch:** `unit-owner-turn-audit`

**Sources:**
- `C:\Users\Fugma\.gemini\antigravity-cli\brain\0ccd7488-77d7-47f1-b289-b4f514805305\scratch\owner-turns-extracted.json` (176 extracted owner turns: 82 Gemini / 94 Claude, plus interrupt/steer telemetry).
- Verbatim owner quotes in `docs/PLAN_*.md` ("## Aub's words", "## Owner's words (verbatim)").
- Live send-path confirmation in `src/paseo.ts` (`sendMessage` defaults `activeTurnBehavior: "steer"`).

---

## 1. Executive summary

Aub (the owner) drives VibeSquad by **talking**, and the telemetry shows his messages are
**fast, terse, typo-heavy, and frequently arrive while an agent is already mid-turn.** The
single sharpest finding: the default send path in the product **steers** the running turn
(`src/paseo.ts:164` → `activeTurnBehavior: "steer"`), so every rapid "oh and by the way" that
lands during an active turn **interrupts and rewrites the in-flight turn** instead of queueing
behind it.

Three numbers tell the story: ~1 in 7 of Aub's turns arrive within **60 seconds** of the
previous one, ~1 in 8 substantive turns is a **"by the way" side-thought**, and ~1 in 5 is a
**short approval** ("send it", "go for b", "a + a"). Aub already knows this — his own words:

> "I know i intterupt mid turn alot, thing pop in my head, so i gotta dilieant though guiding
> sends and more 'oh and by the way'. I think you have a /btw command?"
> — `owner-turns-extracted.json`, 2026-11-04T03:45:08Z

> "i like suupporting commands and queuing by default with a little 'send this now' promt/thing
> to click on if you want to steer insteaad."
> — `owner-turns-extracted.json`, 2026-11-04T03:48:42Z

Aub has already specified the fix. This audit documents the evidence behind it and turns it
into a playbook.

---

## 2. Data-quality note (what "176 turns" really contains)

The extractor (`extract_owner_turns.mjs`) swept Gemini `USER_INPUT` entries and Claude `user`
messages and kept 176. **57 of them are not owner turns** — they are system relays and markers
that the extractor did not filter:

| Category | Count | Examples |
|---|---|---|
| `New team log event in lane …` relays | 15 | auto relayed `[done]` / `[decision]` digests |
| `[Request interrupted by user …]` markers | 10 | Escape/stop signals, no content |
| system-injected guards | 10 | `<system_instructions> Environment rules (Gemini Guard)…`, `<plan_mode>`, `<task-notification>` |
| image-only entries | 9 | `[Image: source: …]`, `[image attached: …]`, `(image)` |
| `Lead "★ LEAD … needs a decision on:` relays | 7 | auto decision prompts |
| auto-steering prompts | 4 | `WAKEUP: …`, `Context is >= 100k …`, `Wrap up: …`, `NEW BLOCK R5 added …` |
| `Check-in reply from lead …` digests | 2 | auto check-in relays |
| **Total non-owner** | **57** | |

That leaves **~119 genuine owner-authored turns** (the population the percentages below are
computed against). Where a metric is computed over all 176, it says so.

---

## 3. Quantitative breakdown

### 3.1 Rapid-fire / mid-turn follow-ups (how often turns collide)

Two independent timing signals, both consistent: a meaningful fraction of Aub's turns land
within a minute of the previous one — the window where a running turn is still active.

| Signal | n | < 30 s | < 60 s |
|---|---|---|---|
| Claude `deltaSecFromPrevUserTurn` | 77 | 10 (13.0%) | 16 (20.8%) |
| Gemini consecutive-turn delta | 79 | 5 (6.3%) | 8 (10.1%) |
| Combined (all turns, ts-sorted) | 172 | 17 (9.9%) | 26 (15.1%) |

Sub-10-second re-sends are visible in the raw data (`d=0s`, `d=9s` entries), e.g.
`[Request interrupted by user]` immediately followed by a fresh decision relay at
`2026-11-03T19:23:53.232Z` → `…19:23:53.246Z` (`d=0s`).

### 3.2 Interrupt telemetry

- **`interruptedMidTurn === true`** (Gemini telemetry: previous step was a `PLANNER_RESPONSE`
  with active `tool_calls`): **3 of 82 Gemini turns (3.7%)**.
- **Claude `prevEntryType === "assistant"`** (turn arrived while the assistant was actively
  working): **10 of 94 (10.6%)**.
- **Explicit `[Request interrupted by user …]` markers:** **10** across the corpus.

So ~13 turns are directly flagged as arriving mid-turn, and 10 more are hard interrupts —
the direct telemetry undercounts the true collision rate because a steer that rewrites a turn
does not always leave a `prevEntryType` trace in the extract.

### 3.3 Message length

- Average **228.7 chars**, median **141**, range **4–1142**; average **35.8 words**.
- Short turns (< 40 chars) — the "send it / go for b" family — are **32 of 176 (18.2%)**.

### 3.4 Composition (what kind of turn it is)

Heuristic keyword classification of the 119 substantive turns (primary label per turn;
a turn can carry more than one signal — the `also`/`1. … 2. …` ones show up in the
side-thought and multi-item sections too):

| Class | Count | Share | Signal |
|---|---|---|---|
| Guiding steer (run / dispatch / spin / make / push / merge / create) | 40 | 33.6% | imperative direction |
| Short approval (send it / go for b / do it / a + a / yes) | 26 | 21.8% | terminal go-signal |
| Mechanism-suggestion (run X / N profiles / make a worktree) | 22 | 18.5% | names a means, not an end |
| "By the way" side-thought (also / on a nother note / btw / I also need) | 15 | 12.6% | new thread appended mid-conversation |
| Question / decision | 10 | 8.4% | `?` or `is there / how / should …` |
| Multi-item dump (numbered `1. … 2. … 3. …`) | 6 | 5.0% | 3–4 requests in one message |

**Read as a ratio:** roughly **1/3 steer : 1/5 approval : 1/8 side-thought**, with the
mechanism-suggestions (the "obey literally vs propose the primitive" trap) another ~1/5.

---

## 4. Pattern evidence (verbatim)

### (a) Mid-turn "by the way" / rapid-fire follow-ups that collide

These arrived while the agent was mid-turn. Because plain Enter **steers** (rewrites the
active turn) instead of queueing, the "oh and by the way" displaced whatever was running.

- `2026-11-02T23:41:04Z` — **"proceed, also, crate a prompt only … to have gemini scrape the
  paseo plugin page …"** — the `proceed` continues the active work, then `also` injects a brand
  new scrape task into the same turn.
- `2026-11-03T00:07:55Z` — **"sweet on a nother note im thinking we need to update agent
  instruction profiles rules …"** — `on a nother note` pivots to an unrelated accreditation
  policy while the prior thread is still warm.
- `2026-11-03T02:56:31Z` — **"Bro I cant wait for this to be done i keep losing my brainstorms.
  i accidently sent the below bug to a lead (Rel1) … They dispatched and it seems handled BUT i
  wanted to follow up with you because it seems i have isssues every time …"** — a bug report,
  a status note, and a follow-up question in one 775-char message.
- `2026-11-03T02:58:15Z` (`interruptedMidTurn: true`) — **"does vibe squad automatically look
  for a paseo install and import profiles/instryctions and if not can it?"** — a new question
  that hard-interrupted an active turn.
- `2026-11-04T01:00:17Z` (`interruptedMidTurn: true`) — **"I'm just confusued how this got so
  complicated. If we're building on paseo how are we not jsut shipping hte paseo
  settings/dameon already. What are we doing differently and why?"** — interrupt with a
  "stop and explain" demand.
- `2026-11-04T02:12:14Z` — **"send them if you ahvent, the queued"** — a follow-up that assumes
  the agent already has queued items to flush, ~8 s of context after a prior turn.

**Evidence of the mechanism:** `src/paseo.ts:164` hardcodes the default to
`activeTurnBehavior: "steer"` for every `sendMessage`, so every one of the above was a steer,
not a queue.

### (b) Keyboard-adjacent / phonetic shorthand (decode silently, don't stall)

Aub types fast on the same keyboard and doesn't correct. Every one of these is real, and each
needs a **silent decode** — never a "what did you mean by …?" stall:

| What Aub wrote (verbatim) | Intended | Evidence |
|---|---|---|
| "gold for a second" | **hold** for a second (g↔h are adjacent keys) | `2026-11-04T03:00:01Z` "dispatch ui fix lane and then gold for a second for me to ask you something" |
| "paseo la" | **paseo ls** (a↔s adjacent) | `2026-11-04T03:18:04Z` "…identify lessons we've learned. Such as how we got to the paseo la issue" |
| "emini" | **gemini** (dropped leading g) | `2026-11-02T23:41:04Z` "to have gemini scrape the paseo plugin page" (same message uses both "gemini" and "emini") |
| "dameon" / "damon" | **daemon** (a↔e transposed) | `2026-11-03T02:56:31Z`, `2026-11-03T03:16:14Z`, `2026-11-04T01:00:17Z` |
| "sotpped" | **stopped** (o↔t transposed) | `2026-11-04T01:49:13Z` "make sure nothing got sotpped please" |
| "ahvent" | **haven't** (a↔h transposed) | `2026-11-04T02:12:14Z` "send them if you ahvent, the queued" |
| "fo 2. do your lean btw A + B" | **for 2. do your lean between A + B** ("fo"→for, "btw"→between) | `2026-11-03T17:04:23Z` |
| recurring: "teh", "breif", "impliment", "instryctions", "profiels", "sping", "sidebaar", "acoclades" | the / brief / implement / instructions / profiles / spin / sidebar / accolades | throughout |

Decoding rule: **infer from context, act, and (only if truly ambiguous) confirm in one clause
while continuing.** The agent must not treat a misspelling as a new concept.

### (c) Mechanism-vs-outcome prompts (propose the primitive, don't obey literally)

Aub names the *mechanism* he can see; the correct move is to infer the *outcome* and propose
the cleaner architectural primitive. He even asked for exactly this translation:

> "is there any way to audit and catch other actions/features/commands where I'm suggesting an
> idea that works but there are commands or ways to do it better?"
> — `docs/PLAN_BETTER_WAY_AUDIT.md`, "## Aub's ask"

| Aub suggested (mechanism) | The cleaner primitive the agent proposed (outcome) | Evidence |
|---|---|---|
| "make a worktree" / "cleanup the projects folder" → "…where a product sat not a spam of worktrees" | The **worktree sanctuary** `%LOCALAPPDATA%\VibeSquad\worktrees\<repo>\<unit>` + workspace-id matching | `2026-11-04T03:10:54Z`; `docs/PLAN_WORKSPACES_CLEANUP.md` |
| "paseo ls to always find other lanes" → "something better than the paseo ls" | **`vs who lead`** live resolver (12k chars → one line, filtered in code) | `2026-11-02T02:12:42.231Z` "…better than the psaeo ls…"; `docs/PLAN_VS_WHO.md` |
| "we have like 20 profiles. Is the work flow … the best way" | **Role + Tier routing with auto-failover** (Claude→Gemini→DeepSeek), not 20 renamed profiles | `2026-11-04T03:08:15Z`; `docs/PLAN_PROFILES.md`, `docs/PLAN_PROVIDER_CONTINUITY.md` |
| "run as many lanes as you can" / "spin up ass many parallel lanes" | **Parallel-by-default lane orchestration** with a `Touches | Clashes with` table, not a serial spawn loop | `2026-11-04T01:15:17Z`, `2026-11-02T23:53:26Z`; `docs/PLAN_SPINOFFS_PARALLEL.md` |

In each case the plan's **Decided** section records the translation ("Aub said X → we built Y"),
which is the durable artifact future agents read.

### (d) Multi-item dumps (3–4 requests in 1–2 messages → parallel split + `@lane` routing)

Aub frequently packs several distinct asks into one message. These need automatic splitting
into parallel units and routing to lane handles, not one serial turn.

- `2026-11-03T17:04:23Z` — **"fo 2. do your lean btw A + B and 3. Go A"** — three asks in 40
  chars (do the lean on A+B, then Go on A).
- `2026-11-03T16:52:52Z` — **"yes with c please. I already see thoughts arent showing in chat
  with gemini AND chat doesn scroll to follow output … Also going to need a UI lane for fixing
  some things …"** — an approval + two bug reports + a request for a new UI lane.
- `2026-11-02T01:53:28.729Z` — **"1. iive removed roster … 2. yes 3. yes 4. Is there realistically
  an easy way to find our old workflow setup …"** — four numbered items.
- `2026-11-02T19:22:43.747Z` — **"1. yes I should just always have a buddy waiting for me … 2.
  yes. Also we're at 8% claude …"** — two approvals plus a quota warning.
- `2026-11-03T19:09:09.200Z` — **"Send all 3 to whatever relevant lanes already exist. spin up
  ones that dont. All should be gemini …"** — explicit multi-lane routing instruction.
- `2026-11-04T03:48:42Z` — **"1. i like suupporting commands and queuing by default … 2. YUp
  Buddy is jsut the branding for the wiki/docs from here …"** — two decisions in one.

---

## 5. Playbook

### What Agents Must Do

1. **Decode shorthand silently.** `dameon→daemon`, `emini→gemini`, `paseo la→paseo ls`,
   `gold for a second→hold for a second`, `fo→for`, `btw→between`, `sotpped→stopped`,
   `ahvent→haven't`. Infer from context and act; never stall on a misspelling.
2. **Translate mechanism → outcome.** When Aub names a means ("run paseo ls", "make a
   worktree", "20 profiles", "run as many lanes as you can"), do not obey literally — propose
   the cleaner primitive and record the translation in the plan's **Decided** section.
3. **Treat `also` / `on a nother note` / `btw` / `I also need` as a separate unit of work**,
   not a modifier on the current turn. If it lands mid-turn, queue it — do not let it rewrite
   the active turn.
4. **Split multi-item dumps automatically** (numbered lists, "Send all 3 …", "And also …") into
   parallel units and route each to its `@lane` handle. Never collapse them into one serial turn.
5. **Read short approvals as terminal go-signals** ("send it", "go for b", "a + a", "do it",
   "yes please", "go with it"). Execute; do not re-summarize or ask for confirmation.
6. **Never end a turn to "wait"** for a queued item — poll with a timeout or
   `paseo wait <id> --timeout <s>`.

### What Aub Can Use

| Tool | What it does | Aub's own words |
|---|---|---|
| **`/btw`** (or leading "btw" / "also") | queues a side-thought without interrupting the running turn | "I think you have a /btw command?" (`03:45:08Z`) |
| **Default queue + "Send this now"** | plain Enter queues; clicking "Send this now" steers/interrupts when you really mean it | "queuing by default with a little 'send this now' promt/thing to click on if you want to steer insteaad" (`03:48:42Z`) |
| **`@lane` handles** | route each item of a multi-item dump to the right lane in one message | "Send all 3 to whatever relevant lanes already exist. spin up ones that dont." (`19:09:09Z`) |
| **`Q:` vs `Go:` prefix** | `Q:` = question / decision needed (matches existing `needs-you` / `needs a decision on` prompts); `Go:` = approve and execute now | "Go for option 1" / "go for b" / "Go A" |
| **Keep approvals short** | "send it", "go for b", "a + a" are enough — they already work | 26 short approvals (21.8%) |

**One-line principle for both sides:** *Aub's Enter should mean "add to my queue"; only an
explicit "send this now" (or `Go:`) should mean "interrupt what's running and do this instead."*

---

## 6. References

- `owner-turns-extracted.json` (176 turns, timestamps cited inline above).
- `src/paseo.ts:157-170` — `sendMessage` defaults `activeTurnBehavior: "steer"`.
- `docs/PLAN_BETTER_WAY_AUDIT.md`, `docs/PLAN_WORKSPACES_CLEANUP.md`, `docs/PLAN_VS_WHO.md`,
  `docs/PLAN_PROFILES.md`, `docs/PLAN_PROVIDER_CONTINUITY.md`, `docs/PLAN_SPINOFFS_PARALLEL.md`,
  `docs/PLAN_DAEMON_SPAWN_HANG.md`, `docs/PLAN_SPAWN_HYGIENE.md`, `docs/PLAN_CONNECT_UX.md` —
  verbatim "## Aub's words" / "## Owner's words (verbatim)" sections.
