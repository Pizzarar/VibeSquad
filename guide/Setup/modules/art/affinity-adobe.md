---
id: affinity-adobe
group: art
level: 1
method: licence-pointer
winget_id: Canva.Affinity
verified: 2026-10-30 (winget show Canva.Affinity: 3.3.1.4940); Adobe not checked (UNVERIFIED)
licence: own
size: large   # UNVERIFIED
---

# Affinity and Adobe Creative Cloud (pointer)

## When you want this
You already use Affinity or Adobe apps, or you want Photoshop, Illustrator or similar. This module does not hand out software. It points you to the official sources, and you use your own account or licence.

## Install (Windows)
**Affinity.** The official site says Affinity from Canva is free for individuals, and downloads start from a Canva login: https://www.affinity.studio/ . A winget ID also resolves:
```powershell
winget install --id Canva.Affinity --exact --accept-package-agreements --accept-source-agreements
```
Read the terms on the official page first.

**Adobe Creative Cloud.** Use Adobe's official plans page: https://www.adobe.com/creativecloud/plans.html . It has a Students and Teachers tab with a discount for qualified students. The page checked on 2026-10-30 showed no free trial for Photoshop or Illustrator. Prices and trials change, so read the page yourself. No Adobe winget ID was checked: UNVERIFIED.

## macOS line
macOS: Both vendors offer Mac versions on their own pages. No brew line checked: UNVERIFIED.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
You confirm that the app opens and you are signed in. For Affinity installed with winget:
```powershell
winget list --id Canva.Affinity --exact
```
Expected: a row named `Affinity`.

## First run (the human's steps)
1. Sign in with your own Canva or Adobe account in the browser.
2. Open the app once and create a blank document.
3. Tell your agent it is done so it can mark the module verified.

## Gotchas
- Never give an agent your account password. Sign in yourself.
- Adobe files (PSD, AI) are binary, so agents cannot edit them. They can work with SVG and PNG exports.
- For laser and CNC, export SVG or DXF, then follow [inkscape-laser](../fab/inkscape-laser.md).
