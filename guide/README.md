# everyone-can-vibe

A guide to making things with AI agents, for people who do not code. It is also an [Obsidian](https://obsidian.md) vault, and it holds a setup kit that gets a Windows PC ready.

Built for VibeSquad. You can point any agent at this folder and it'll walk you through it. Buddy means this chat; Lead means a second chat you hand the plan to.

Start with [ROLO](ROLO.md), the method on one page. Then follow [Maps/Start.md](Maps/Start.md).

The guide is read-only. It is written for [VibeSquad](https://github.com/Pizzarar/VibeSquad), the app where you talk to your Buddy and watch your Lead and workers. Claude Code, Codex, Gemini and OpenCode are providers: the AI that does the work inside it. You pick whichever you already pay for.

## Set up your PC first

1. Get this guide: on the VibeSquad repo page click **Code → Download ZIP** and unzip it somewhere you will find it again. (If you already have Git, `git clone` works too.) You only need the `guide` folder inside it: that is the folder you open for the setup chat. Do not open the whole repo folder; it is the VibeSquad source code and the chat would read the wrong files.
2. Install your AI provider and sign in with your own account. Claude plan: [Claude Code](Setup/modules/providers/claude-code.md). ChatGPT plan: [Codex](Setup/modules/providers/codex.md). Google licence or API key: [Node.js](Setup/modules/core/node.md), then [Gemini](Setup/modules/providers/gemini.md). No subscription: [Node.js](Setup/modules/core/node.md), then [OpenCode](Setup/modules/providers/opencode.md) and its free models.
3. Download `VibeSquad-setup.exe` from the [latest VibeSquad release](https://github.com/Pizzarar/VibeSquad/releases/latest) and run it. On first launch choose **💻 Run agents on this PC**. The **Setup Checklist** checks for Claude Code, Gemini / Antigravity and Git (optional). There is nothing big to download: VibeSquad has its own built-in runner. Once Claude Code or Gemini shows a tick, click **Continue**. (Codex and OpenCode users: the checklist does not list them, so close it with **✕** instead.) Steps and checks: [Setup/modules/core/vibesquad.md](Setup/modules/core/vibesquad.md). To run VibeSquad from source instead (advanced): [Setup/modules/advanced/vibesquad-from-source.md](Setup/modules/advanced/vibesquad-from-source.md).
4. Add the `guide` folder to VibeSquad: click **+ New squad** at the bottom of the left column, type the full path of the `guide` folder in **Folder path**, leave **Start a Buddy** ticked, pick a Brainstorm profile and click **Create**. If your provider is not Claude Code or Gemini, also set up a profile in **AGENT PROFILES** (**⚙ SETTINGS**, then the **Profiles** tab). That chat is your Buddy. Type: **read START_HERE.md**
5. Your first project goes in a **new, empty folder** (the setup chat makes one for you). Never use the `guide` folder or the repo folder as your project.

What to expect:

- It checks your PC first. Nothing is installed yet.
- It asks about 5 questions: what you want to make, what machines you own, which licences you have.
- It shows a plan and waits for you to say **go**.
- It installs, and shows proof (version numbers) after each step.
- You do the browser parts yourself: logins, licence sign-ins, and the "Yes" on Windows permission pop-ups.
- It takes 30 to 60 minutes. You can say **stop** or **skip** at any time. If something fails, it stops and shows you what happened.

Good to know:

- Your answers and progress are saved in a hidden folder called `.quickstart/`. It is never uploaded. If you close the window, click the `guide` squad and use **+ TEAM** in VibeSquad and say **read START_HERE.md**. It picks up where it stopped.
- Use your own accounts. Never paste a password or key into the chat.
- The kit is written for Windows. Mac lines are included but not tested.

## Folder map

| Path | What it is |
|---|---|
| [ROLO.md](ROLO.md) | The method on one page: Riff, Organize, Loop, Own |
| `Guide/` | The walkthrough, one step per sitting. Start at [Maps/Start.md](Maps/Start.md) |
| `Concepts/` | Short notes on the words used, such as [Buddy](Concepts/Buddy.md) |
| `Maps/` | Notes that link the steps in order |
| `Notebook/` | Aub's raw notes. Private; only the [README](Notebook/README.md) is shared |
| [START_HERE.md](START_HERE.md) | The instructions the setup agent follows |
| [AGENTS.md](AGENTS.md) | Rules for the setup agent (`CLAUDE.md` just points to it) |
| `Setup/modules/` | One short page per tool (how to install and check it) |
| `Setup/templates/` | Starter files for your own projects |
