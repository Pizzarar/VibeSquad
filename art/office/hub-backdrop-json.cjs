// A1: writes public/office/hub-backdrop.json from the P0 palettes (top = SKY_TOP slot 13, the tile's row 0;
// ground = PANEL slot 1, the road colour of the tile's bottom rows = the floor plate's street).
// scale = native px multiplier relative to the floor plate's integer scale (1 = same px as the tower).
// Run: node art/office/hub-backdrop-json.cjs   (repo root)
const fs = require('fs');
const slot = (mode, n) => {
  const rows = fs.readFileSync(`art/palette/pc98-${mode}.gpl`, 'utf8').split(/\r?\n/)
    .filter((l) => /^\s*\d+\s+\d+\s+\d+/.test(l));
  const [r, g, b] = rows[n].trim().split(/\s+/).map(Number);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
};
const json = {
  w: 640, h: 360, groundY: 332, repeat: 'x', scale: 1,
  top: { dark: slot('dark', 13), light: slot('light', 13) },
  ground: { dark: slot('dark', 1), light: slot('light', 1) },
};
fs.writeFileSync('public/office/hub-backdrop.json', JSON.stringify(json) + '\n', 'utf8');
console.log(JSON.stringify(json));
