---
id: opencode
group: providers
level: 1
method: npm
winget_id: n/a
verified: 2026-11-01 (install and free-model list read from https://opencode.ai/docs/ and https://opencode.ai/docs/zen/; not run on this PC; npm package opencode-ai 1.19.5 was seen 2026-10-30)
licence: own
size: small
---

# OpenCode

## When you want this
Pick this if you have no AI subscription. OpenCode is one provider inside VibeSquad, and it has free models you can
use to start. It can also use many paid providers if you have an account with one of them.

## Install (Windows)
Needs `node` (core module).
```powershell
npm.cmd install -g opencode-ai
```
Official page (fetched 2026-11-01): https://opencode.ai/docs/ . It also lists `choco install opencode` and
`scoop install opencode`, and recommends WSL on Windows for better performance (UNVERIFIED: how well it runs
outside WSL on the Windows PCs this kit targets).

Then run the PATH refresh (see `START_HERE.md`). If Verify still fails, restart your chat in VibeSquad
(or open a **new** terminal window if you are doing this by hand).

## macOS line
`macOS: npm install -g opencode-ai` (UNVERIFIED: not tested on a Mac).

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
opencode --version
```
Expected: a version matching `^\d+\.\d+\.\d+`.

## Free models
From https://opencode.ai/docs/zen/ (fetched 2026-11-01). The page says most are free "for a limited time", so
check it again before you rely on one:

| Name | Model ID |
|---|---|
| Big Pickle | `big-pickle` |
| GLM-5.3-Flash Free | `glm-5.3-flash-free` |
| DeepSeek V4.1 Flash Free | `deepseek-v4.1-flash-free` |
| Beam Free | `beam-free` (not available in some countries; see the page) |
| Flint 40B Free | `flint-40b-free` |
| MiMo-V2.6-Flash Free | `mimo-v2.6-flash-free` |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` |
| Nemotron 3.5 Super VL Free | `nemotron-3.5-super-vl-free` |
| Jev 1.13 Free | `jev-1.13-free` |

The page says free models only work inside OpenCode. Whether you need an account to use them: UNVERIFIED (the page
does not say). Which of these is best for planning or building: UNVERIFIED, nobody here has compared them.

## First run (the human's steps)
1. Run `opencode` once in any folder. For paid models the official page says to run `/connect` inside it and sign
   in at opencode.ai/auth. How to pick a free model in its screen: UNVERIFIED, read what it shows you.
2. Never paste an API key into the chat or a file. Enter it only in the tool's own prompt.
3. Then in VibeSquad, make a profile for it under **⚙ TEAM SETTINGS**, **AGENT PROFILES** (**PROVIDER** and **MODEL**), and pick that profile in **PROFILE** (**+ NEW AGENT**) or **BUDDY PROFILE** (**+ ADD BUDDY**) when you start a chat. You cannot change the provider of a chat that is already running. The Paseo provider id is `opencode` (VibeSquad `docs/PLAN_ANY_PROVIDER.md`).

## Gotchas
- In PowerShell use `npm.cmd`, not `npm` (a fresh PC blocks scripts). If a command you installed says "running scripts is disabled", run its `.cmd` form, for example `opencode.cmd --version`.
- Free models change. A model that is free today can be paid or gone next month.
- Free models are weaker than paid ones. Keep jobs small and ask for proof (see [Proof, not prose](../../../Concepts/Proof-not-Prose.md)).
