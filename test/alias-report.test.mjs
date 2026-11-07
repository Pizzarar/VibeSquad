// Own-daemon Block 5: `vs mcp alias-report` grouping, and shared prompt text naming VS MCP tools (with the Paseo names as the fallback).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { aliasReport, parseDuration } from '../cli/vs.mjs';
import { ART_PAINTER_NOTE_BODY } from '../server/profiles.mjs';
import { WORKER_PACK, LEAD_FALLBACK_PACK } from '../plugin/index.server.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const hit = (ts, tool, caller, lane = 'runner-pilot', agent = caller) => ({ ts, agent, lane, type: 'metric', text: `mcp-alias: tool=${tool} caller=${caller} lane=${lane}`, refs: [] });

test('aliasReport groups by alias + caller, counts, keeps last-seen, sorts by hits', () => {
  const rows = aliasReport([
    hit('2026-11-01T10:00:00.000Z', 'create_agent', 'rn-1'),
    hit('2026-11-03T10:00:00.000Z', 'create_agent', 'rn-1'),
    hit('2026-11-02T10:00:00.000Z', 'create_agent', 'rn-2'),
    hit('2026-11-02T11:00:00.000Z', 'wait_for_agent', 'rn-1'),
    { ts: '2026-11-02T12:00:00.000Z', type: 'decision', text: 'mcp-alias: tool=x caller=y' },
    { ts: '2026-11-02T12:00:00.000Z', type: 'metric', text: 'tokens-per-plan: 5' },
  ]);
  assert.deepEqual(rows.map((r) => [r.alias, r.caller, r.hits, r.lastSeen]), [
    ['create_agent', 'rn-1', 2, '2026-11-03T10:00:00.000Z'],
    ['create_agent', 'rn-2', 1, '2026-11-02T10:00:00.000Z'],
    ['wait_for_agent', 'rn-1', 1, '2026-11-02T11:00:00.000Z'],
  ]);
});

test('aliasReport counts an entry mirrored into several logs once, and honours --since', () => {
  const e = hit('2026-11-05T00:00:00.000Z', 'list_agents', 'rn-9');
  const old = hit('2026-10-01T00:00:00.000Z', 'list_agents', 'rn-9');
  const now = Date.parse('2026-11-06T00:00:00.000Z');
  assert.equal(aliasReport([e, { ...e }, old], { now })[0].hits, 2);
  const recent = aliasReport([e, { ...e }, old], { now, sinceMs: parseDuration('7d') });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].hits, 1);
  assert.deepEqual(aliasReport([old], { now, sinceMs: parseDuration('7d') }), []);
});

test('parseDuration accepts s/m/h/d/w and rejects junk', () => {
  assert.equal(parseDuration('30m'), 30 * 60000);
  assert.equal(parseDuration('7d'), 7 * 86400000);
  assert.throws(() => parseDuration('soon'), /--since/);
});

test('vs mcp alias-report reads team logs under VIBESQUAD_HOME (text + --json)', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vs-alias-'));
  const dir = path.join(home, '.vibesquad', 'teams', 'vibesquad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'log.jsonl'), [hit(new Date().toISOString(), 'send_agent_prompt', 'rn-7')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, VIBESQUAD_HOME: path.join(home, '.vibesquad') };
  const cli = path.join(ROOT, 'cli', 'vs.mjs');
  const text = spawnSync(process.execPath, [cli, 'mcp', 'alias-report', '--since', '7d'], { env, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /send_agent_prompt\s+rn-7/);
  const json = JSON.parse(spawnSync(process.execPath, [cli, 'mcp', 'alias-report', '--json'], { env, encoding: 'utf8' }).stdout);
  assert.equal(json.total, 1);
  assert.equal(json.groups[0].caller, 'rn-7');
});

test('shared prompt text names only vs / VS MCP tools, never the Paseo ones', () => {
  assert.match(WORKER_PACK, /use `send` \(VS MCP or `vs send`\)/);
  assert.match(LEAD_FALLBACK_PACK, /`spawn_worker` \(VS MCP: `title`, `profile`, `prompt`, `cwd`, `labels` `\{job, ord\}`; the profile supplies provider\/model\/mode\)\. Pass the `profile`/);
  assert.match(ART_PAINTER_NOTE_BODY, /via `send` \(VS MCP or `vs send`\)/);
  for (const text of [WORKER_PACK, LEAD_FALLBACK_PACK, ART_PAINTER_NOTE_BODY]) {
    assert.ok(!/paseo (wait|ls|la|--help|agent|inspect)|Paseo MCP|create_agent|send_agent_prompt/.test(text), text.slice(0, 80));
  }
});
