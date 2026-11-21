# Android launcher icons

Source of truth: the Windows VS mark in `../icon.png` / `../icon.ico` (never Tauri's default icon).

| Asset | Framing |
| --- | --- |
| `mipmap-*/ic_launcher.png` | Full mark (neon frame included), 83.3% of the canvas, 10%-radius rounded square. |
| `mipmap-*/ic_launcher_round.png` | Full mark, circle at 91.7% of the canvas. |
| `mipmap-*/ic_launcher_foreground.png` | Frame-free interior crop at 66% of the 108dp canvas (inside the 18dp safe-zone inset) so circle/squircle masks never clip the VS letters. |
| `values/ic_launcher_background.xml` | Solid plate `#0D091E`, matching the crop edge so the foreground plate is invisible. |

`public/vibesquad-192.png` / `vibesquad-512.png` use the same plate + mark composition (maskable-safe),
and `public/vibesquad.ico` is a copy of `../icon.ico`.

`npx tauri icon` output is **not** safe-zone framed: it writes a full-bleed foreground and a white
background. Re-apply the framing above if the icons are ever regenerated. Every Android build syncs this
tree into the gitignored `src-tauri/gen/android/app/src/main/res/` via `ensureAndroidIcons()` in
`server/build-android.mjs`; without that sync the APK ships Tauri's default mark.
