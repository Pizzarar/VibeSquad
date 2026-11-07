"""Writes pc98-dark.gpl / pc98-light.gpl and prints WCAG contrast ratios.
Single source of truth for the two index-matched PC-98 vaporwave palettes."""
import pathlib

# slot, role, dark (Midnight Mall), light (Pastel Morning)
SLOTS = [
    (0,  "BG",       "140c26", "fdf4ec"),
    (1,  "PANEL",    "21163d", "f5e6ef"),
    (2,  "PANEL_HI", "33255c", "e9d5e8"),
    (3,  "LINE",     "54428a", "bba3cf"),
    (4,  "MARBLE",   "d9cde9", "fffdfa"),
    (5,  "TEXT",     "f7f0ff", "2b1840"),
    (6,  "MUTED",    "b5a5d8", "65507d"),
    (7,  "TEAL",     "4fd6cf", "1a868a"),
    (8,  "VIOLET",   "9b72e8", "9a7fe0"),
    (9,  "PINK",     "ff68a8", "d63f88"),
    (10, "CORAL",    "ff8e78", "f6967f"),
    (11, "AMBER",    "ffc46c", "f7bf5c"),
    (12, "MINT",     "79dfa8", "2e9462"),
    (13, "SKY_TOP",  "2a1b6b", "95d3f2"),
    (14, "SKIN",     "f1c2a2", "f6cdb2"),
    (15, "INK",      "07040f", "35204c"),
]
here = pathlib.Path(__file__).parent

def lum(h):
    c = [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

def cr(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)

for mode, col, name in (("dark", 2, "Midnight Mall"), ("light", 3, "Pastel Morning")):
    lines = ["GIMP Palette", f"Name: VibeSquad PC-98 {name} ({mode})", "Columns: 8", "#"]
    for s in SLOTS:
        h = s[col]
        r, g, b = (int(h[i:i+2], 16) for i in (0, 2, 4))
        lines.append(f"{r:3d} {g:3d} {b:3d}\t{s[0]:02d} {s[1]}")
    (here / f"pc98-{mode}.gpl").write_text("\n".join(lines) + "\n", newline="\n")
    p = {s[1]: s[col] for s in SLOTS}
    print(f"--- {mode}")
    for fg in ("TEXT", "MUTED", "TEAL", "VIOLET", "PINK", "AMBER", "MINT", "CORAL"):
        print(f"{fg:7s} on BG {cr(p[fg], p['BG']):5.2f}  on PANEL {cr(p[fg], p['PANEL']):5.2f}  on PANEL_HI {cr(p[fg], p['PANEL_HI']):5.2f}")
    print(f"MARBLE on PINK (badge) {cr(p['MARBLE'], p['PINK']):.2f}  INK on PINK {cr(p['INK'], p['PINK']):.2f}  INK on AMBER {cr(p['INK'], p['AMBER']):.2f}")
