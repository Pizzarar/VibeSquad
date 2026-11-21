// /__vibesquad/providers/offered-models through the real middleware: owner refresh, gated non-owner refresh, host-path redaction.
// PATH is emptied so `agy` is never found: hermetic, no CLI is spawned.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'vs-offered-home-'));
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'vs-offered-root-'));
after(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(ROOT, { recursive: true, force: true }); });
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = '1';
process.env.PATH = ''; process.env.Path = '';
const { createVibesquadMiddleware, isGatedRead } = await import('../server/vibesquad-api.mjs');
const { getLocalToken } = await import('../server/auth.mjs');
const { clearModelProbeCache, modelProbeStats } = await import('../server/providers-catalog.mjs');
const api = createVibesquadMiddleware(ROOT, { hooks: false });
const srv = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end('no'); }));
const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const owner = { 'x-vibesquad-token': getLocalToken() };
const get = async (route, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body };
};

test('isGatedRead: offered-models refresh=1 is gated, the plain read is not', () => {
  assert.equal(isGatedRead('/__vibesquad/providers/offered-models', '/__vibesquad/providers/offered-models?refresh=1'), true);
  assert.equal(isGatedRead('/__vibesquad/providers/offered-models', '/__vibesquad/providers/offered-models'), false);
});

test('owner GET offered-models: every provider listed; antigravity marked probed with a static fallback + error when agy is missing', async () => {
  clearModelProbeCache();
  const r = await get('/__vibesquad/providers/offered-models?refresh=1', owner);
  assert.equal(r.status, 200);
  const agy = r.body.providers['antigravity-cli'];
  assert.equal(agy.probed, true);
  assert.equal(agy.source, 'static');
  assert.match(agy.error, /not found/);
  assert.equal(r.body.providers.claude.probed, false);
  assert.ok(r.body.providers.claude.models.some((m) => m.id === 'claude-opus-5-5'));
});

test('read-only caller: refresh=1 is refused (no spawn); plain read works and repeated reads do not respawn the failing CLI', async () => {
  clearModelProbeCache();
  const before = modelProbeStats().runs;
  assert.equal((await get('/__vibesquad/providers/offered-models?refresh=1')).status, 403);
  assert.equal(modelProbeStats().runs, before, 'the gated refresh spawned nothing');
  assert.equal((await get('/__vibesquad/providers/offered-models')).status, 200);
  await get('/__vibesquad/providers/offered-models');
  await get('/__vibesquad/providers/offered-models');
  assert.equal(modelProbeStats().runs - before, 1, 'negative cache: one probe for three reads');
});

test('providers routes pass through sendFor: the settings path is owner-only', async () => {
  const o = await get('/__vibesquad/providers/settings', owner);
  assert.equal(typeof o.body.path, 'string');
  const n = await get('/__vibesquad/providers/settings');
  assert.equal(n.status, 200);
  assert.equal('path' in n.body, false, 'host path dropped for a non-owner');
});

test('UI wiring: paseoProviders.loadOfferedModels hits /offered-models (?refresh=1) and Settings renders the list + Refresh', () => {
  const api_ = readFileSync(new URL('../src/paseoProviders.ts', import.meta.url), 'utf8');
  assert.ok(api_.includes('loadOfferedModels = (refresh = false)') && api_.includes('`/offered-models${refresh ? "?refresh=1" : ""}`'));
  const ui = readFileSync(new URL('../src/RunnerSettingsSection.tsx', import.meta.url), 'utf8');
  assert.match(ui, /loadOfferedModels\(refresh\)/);
  assert.match(ui, /runner-offered-refresh-\$\{p\.provider\}[\s\S]*refreshOffered\(true\)/);
  assert.match(ui, /OFFERED MODELS/);
  assert.match(ui, /offered\[p\.provider\]\?\.probed/);
});
