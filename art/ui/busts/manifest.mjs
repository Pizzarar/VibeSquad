// B13e: writes public/ui/busts/busts.json (canon Normal-mode mascot bust map). Run: node art/ui/busts/manifest.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('../../../public/ui/busts/busts.json', import.meta.url));
const role = (id, label, source, note) => ({ id, label, src: `/ui/busts/${id}.png`, light: `/ui/busts/${id}-light.png`, source, note });
const manifest = {
  version: 1,
  cell: '64x64',
  width: 64,
  height: 64,
  format: 'RGBA PNG, transparent outside the character; render with image-rendering: pixelated',
  palettes: { dark: 'art/palette/pc98-dark.gpl', light: 'art/palette/pc98-light.gpl' },
  build: 'art/ui/busts/build.lua (Aseprite -b), then node art/ui/busts/manifest.mjs',
  roles: [
    role('overlord', 'Overlord', 'art/ui/busts/overlord.aseprite', 'canon brain-jar TV (locked)'),
    role('riffbot', 'RiffBot', 'art/ui/busts/riffbot.aseprite', 'canon CRT head, stock-arrow mouth'),
    role('bugs', 'Bugs', 'art/ui/busts/bugs.aseprite', 'canon Hypnospace roach'),
    role('buddy', 'Buddy', 'art/cast/hypno/buddy-bust.aseprite', 'H0 bust, fx layer hidden'),
    role('lead', 'Lead', 'art/cast/hypno/lead-bust.aseprite', 'H0 bust, fx layer hidden'),
    role('worker', 'Worker', 'art/cast/hypno/mechanical-bust.aseprite', 'S2 mechanical bust, fx layer hidden'),
  ],
  aliases: { mech: 'worker' },
};
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote', out);
