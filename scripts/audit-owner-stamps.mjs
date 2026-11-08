#!/usr/bin/env node
// Audit owner "rubber stamp" replies in runner transcripts (PLAN_JUST_SEND_IT S2; S3 re-measures with this).
// Usage: node scripts/audit-owner-stamps.mjs [--dir <path>] [--since <ISO>] [--until <ISO>] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Pattern table (single source of truth; S3 reuses this). Matched against the whole
// normalized input (lowercased, trailing punctuation/emoji stripped), first bucket wins. ----
export const BUCKET_PATTERNS = [
  // Test pings from @bug: exclude from stamps.
  ['reply ok', [/^reply ok$/]],
  // Real picks: a choice between options.
  ['real pick', [
    /^(option |go for |go with |pick |take |do |let'?s do |lets do )?\(?[a-d1-9]\)?$/,
    /^(option|go for|go with|pick|take|do|let'?s do|lets do) \(?[a-d1-9]\)?( please)?$/,
  ]],
  // Rubber stamps: approval of something already decided.
  ['rubber stamp', [
    /^(yeah |yep |yup |yes |ok |okay |sure |please )?(send|send it|send it off|go send it|go for a send|go for send|just send it)( please)?$/,
    /^(yeah |yep |yup |ok |okay |sure )?do it$/,
    /^(yes|yeah|yep|yup|ok|okay|sure|k|kk|go|go ahead|approved?|proceed|continue|sounds good|lgtm|looks good|fine)( please)?$/,
    /^(yes|yeah|yep|yup|ok|okay|sure) (go ahead|do it|proceed|please)$/,
  ]],
];
export const TOP_N = 15;
export const MAX_SHORT_WORDS = 4;
export const MAX_OWNER_CHARS = 400;

export function normalize(text) {
  return String(text).trim().toLowerCase().replace(/[\s.!,;:]+$/g, '').replace(/\s+/g, ' ');
}
export function classify(text) {
  const n = normalize(text);
  for (const [bucket, pats] of BUCKET_PATTERNS) if (pats.some((p) => p.test(n))) return bucket;
  return 'other';
}
export const isOwnerInput = (text) =>
  typeof text === 'string' && !text.startsWith('From ') && !text.startsWith('You are ') && text.length <= MAX_OWNER_CHARS;
export const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;

function parseArgs(argv) {
  const a = { dir: path.join(os.homedir(), '.vibesquad', 'runner', 'agents'), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') a.dir = argv[++i];
    else if (argv[i] === '--since') a.since = Date.parse(argv[++i]);
    else if (argv[i] === '--until') a.until = Date.parse(argv[++i]);
    else if (argv[i] === '--json') a.json = true;
  }
  if ((a.since !== undefined && Number.isNaN(a.since)) || (a.until !== undefined && Number.isNaN(a.until))) {
    console.error('bad --since/--until date'); process.exit(2);
  }
  return a;
}

export function audit({ dir, since, until }) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const r = { transcripts: files.length, ownerInputs: 0, shortInputs: 0, shortToBrainstorm: 0, buckets: {}, topPhrases: {} };
  const counts = {};
  for (const f of files) {
    let role = null;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'created') { role = e.meta?.role ?? null; continue; }
      if (e.type !== 'input' || !isOwnerInput(e.text)) continue;
      if ((since !== undefined && e.ts < since) || (until !== undefined && e.ts > until)) continue;
      r.ownerInputs++;
      if (wordCount(e.text) > MAX_SHORT_WORDS) continue;
      r.shortInputs++;
      if (role === 'brainstorm') r.shortToBrainstorm++;
      const b = classify(e.text);
      r.buckets[b] = (r.buckets[b] || 0) + 1;
      const k = normalize(e.text);
      ((counts[b] ||= {})[k] = (counts[b][k] || 0) + 1);
    }
  }
  for (const b of Object.keys(counts)) r.topPhrases[b] = Object.entries(counts[b]).sort((x, y) => y[1] - x[1]).slice(0, TOP_N);
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const r = audit(args);
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`transcripts scanned:        ${r.transcripts}`);
    console.log(`owner inputs:               ${r.ownerInputs}`);
    console.log(`short inputs (<=${MAX_SHORT_WORDS} words):   ${r.shortInputs}`);
    console.log(`  to brainstorm agents:     ${r.shortToBrainstorm}`);
    console.log('buckets (short inputs):');
    for (const [b] of [...BUCKET_PATTERNS, ['other']]) {
      console.log(`  ${b}: ${r.buckets[b] || 0}`);
      for (const [p, n] of r.topPhrases[b] || []) console.log(`      ${n}x ${p}`);
    }
  }
}
