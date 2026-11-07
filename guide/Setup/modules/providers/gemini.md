---
id: gemini
group: providers
level: 1
method: npm
winget_id: n/a
verified: 2026-11-01 (install and login read from https://github.com/google-gemini/gemini-cli and https://geminicli.com/docs/get-started/installation; not run on this PC)
licence: own
size: small
---

# Google Gemini CLI

## When you want this
Pick this if you have a Gemini API key, or a Google Cloud "Gemini Code Assist" licence. Gemini is one provider inside
VibeSquad. You bring your own account.

**Read this first.** The official page says free individual access and Google AI Pro / Ultra (Google One) moved to
the **Antigravity CLI** on June 18, 2026, and that Gemini CLI is for Code Assist Standard / Enterprise licences.
If you have no paid Google licence or API key, pick [opencode](opencode.md) instead. The Antigravity CLI install
command: UNVERIFIED (the official page links a blog post but gives no command).

## Install (Windows)
Needs `node` (core module). The official page says Node.js 20.0.0 or newer, and Windows 11 24H2 or newer.
```powershell
npm.cmd install -g @google/gemini-cli
```
Official pages (fetched 2026-11-01): https://github.com/google-gemini/gemini-cli and
https://geminicli.com/docs/get-started/installation

Then run the PATH refresh (see `START_HERE.md`). If Verify still fails, restart your chat in VibeSquad
(or open a **new** terminal window if you are doing this by hand).

## macOS line
`macOS: brew install gemini-cli` (from the same official page; UNVERIFIED: not tested on a Mac).

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
gemini --version
```
Expected: a version matching `^\d+\.\d+\.\d+`.

## First run (the human's steps)
1. Run `gemini` once. The official page lists three logins: **Sign in with Google** (for a Code Assist licence), a
   **Gemini API key**, or **Vertex AI**. Use your own account.
2. Never paste an API key into the chat or a file. Set it only as the official page describes, in your own terminal.
3. Then in VibeSquad, make a profile for it under **⚙ SETTINGS**, **AGENT PROFILES** (**PROVIDER** and **MODEL**), and pick that profile in **PROFILE** (**+ NEW AGENT**) or **BRAINSTORM PROFILE** (**+ TEAM**) when you start a chat. You cannot change the provider of a chat that is already running. Whether the `PROVIDER` list offers the Gemini CLI itself: UNVERIFIED (the built-in runner knows Gemini as `antigravity-cli`, see VibeSquad `docs/PLAN_ANY_PROVIDER.md`).

## Gotchas
- In PowerShell use `npm.cmd`, not `npm` (a fresh PC blocks scripts). If a command you installed says "running scripts is disabled", run its `.cmd` form, for example `gemini.cmd --version`.
- Free access has moved. Check what your Google account can use before you install.

### Antigravity / Gemini as a worker
Lessons from running Google's Antigravity (`agy`) and Gemini agents on a team:
- In VibeSquad the runner approves an Antigravity worker's permission requests automatically, so it does not stall
  waiting for you (VibeSquad also sets `approvalPolicy: skip` on these workers itself; you do not set it). Because nothing
  asks you first, run it only on its own task branch or worktree, never on one that can reach `main`.
- Run commands in the foreground, with a `timeout` on every one.
- Put multi-part commands in a script file, with no nested quotes.
- It can only read inside its workspace, so copy any input files in first.
- It doesn't resume by itself after a wait, so poll it (check its status) instead of waiting for a ping.
- It invents numbers and `file:line` citations in prose. Require every number and citation to be "printed by a
  command this session", and check one.
