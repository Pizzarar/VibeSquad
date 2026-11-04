---
id: onshape
group: fab
level: 1
method: web
winget_id: n/a
verified: 2026-10-30 (onshape.com/en/pricing fetched)
licence: free
size: small   # web app, nothing to install
---

# Onshape

## When you want this
You want parametric CAD in the browser, with nothing to install, on any computer. It is a good way to try CAD on a laptop or a school machine.

**Important about the free plan.** The official pricing page says the Free plan is for non-commercial use only, and **all documents you make are public** (anyone can see them). Paid plans are needed for private documents and for commercial work. So do not put private or client work in a free account. Students and teachers have a separate free education option.

## Install (Windows)
No install. Open https://www.onshape.com , create an account, and choose the Free plan. Pricing and plan details: https://www.onshape.com/en/pricing

## macOS line
macOS: Same website. Nothing to install.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
**human check.** You sign in and create a document, then say "done". The agent has no command for this.

## First run (the human's steps)
1. Create your account in the browser (you do this part).
2. Click **Create > Document**.
3. Select a plane, sketch a rectangle, and use **Extrude**.
4. Export a part: right-click the part tab > **Export** and choose STEP, STL or DXF.

## Gotchas
- Public documents mean public. Do not put anything private in a free account.
- The agent cannot drive the browser app. It can make DXF/SVG or STL files from scripts for you to import.
- For private offline CAD, use [Fusion](fusion.md) (personal licence) or [FreeCAD](freecad.md).

## Try with your agent
Ask: "Write a script that outputs a 120x80 mm DXF plate with rounded corners and a 20 mm slot in the middle." Import it into an Onshape sketch (**Insert DXF**), extrude, then export a part.
