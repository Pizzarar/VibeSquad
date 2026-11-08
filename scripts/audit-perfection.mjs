#!/usr/bin/env node
// Perfection audit run (PLAN_PERFECTION_AUDIT A2). The run follows docs/lanes/perfection/AUDIT_BRIEF.md, which reads
// docs/lanes/perfection/AUDIT_CHECKLIST.md. Two verbs:
//   node scripts/audit-perfection.mjs collect [--dir <runner/agents>] [--since <ISO>] [--repo <git dir>]
//       -> JSON { findings: [...] } of the mechanical checks (owner-stamp buckets 1-5, stale usage-review:* items).
//   node scripts/audit-perfection.mjs file <findings.json|-> [--dry-run]
//       -> files each finding as one inbox item (lane perfection, source "audit:perfection"), deduped against OPEN items.
// A finding is { key, text, evidence, risky? }. `key` is the stable dedupe id; risky/owner-only ones also go to `vs log needs-you`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { addInboxCards, readInboxCards } from '../server/inbox.mjs';
import { audit, loadRuns, relayBucket, handoffBucket, fixerBucket, fixOfferBucket, gitMerges } from './audit-owner-stamps.mjs';

export const AUDIT_SOURCE = 'audit:perfection';
export const STALE_USAGE_MS = 3 * 24 * 3600 * 1000;
const OPEN_STATUSES = new Set(['parked', 'accepted']);
const KEY_RE = /\(audit-key: ([^)]+)\)/;

/** The one place the audit lane id is chosen. A1's findAuditLane replaces this body. */
export function auditLaneId() { return 'perfection'; }

const keyOf = (text) => KEY_RE.exec(String(text ?? ''))?.[1] ?? null;
const today = (now) => new Date(now).toISOString().slice(0, 10);

/** Render a finding as inbox text: summary, evidence, and the stable dedupe key. */
export function renderFinding(f) {
  return `${String(f.text).trim()} Evidence: ${String(f.evidence).trim()} (audit-key: ${f.key})`;
}

/**
 * File findings as inbox items. Skips any finding whose key is already on an OPEN audit:perfection item (or earlier in
 * the same batch). `needsYou(text)` is called for each filed risky finding. `dryRun` returns what would be filed.
 */
export function fileFindings(findings, { baseHome, dryRun = false, needsYou = () => {} } = {}) {
  const open = new Set(
    readInboxCards(baseHome)
      .filter((c) => c.source === AUDIT_SOURCE && OPEN_STATUSES.has(c.status))
      .map((c) => keyOf(c.text))
      .filter(Boolean),
  );
  const filed = [];
  const skipped = [];
  for (const f of findings) {
    if (!f?.key || !f.text || !f.evidence) throw new Error(`finding needs key, text and evidence: ${JSON.stringify(f)}`);
    if (open.has(f.key)) { skipped.push(f.key); continue; }
    open.add(f.key);
    filed.push(f);
  }
  const lines = filed.map(renderFinding);
  if (!dryRun && lines.length) {
    addInboxCards({ ideas: lines, laneId: auditLaneId(), teamId: 'vibesquad', source: AUDIT_SOURCE, baseHome });
    for (const f of filed) if (f.risky) needsYou(renderFinding(f));
  }
  return { filed: filed.map((f, i) => ({ key: f.key, risky: !!f.risky, text: lines[i] })), skipped };
}

/** usage-review:* inbox items still open after STALE_USAGE_MS. */
export function staleUsageReviewFindings({ baseHome, now = Date.now() } = {}) {
  return readInboxCards(baseHome)
    .filter((c) => String(c.source || '').startsWith('usage-review:') && OPEN_STATUSES.has(c.status))
    .filter((c) => now - Date.parse(c.createdAt) > STALE_USAGE_MS)
    .map((c) => ({
      key: `stale-usage-review:${c.id}`,
      text: `Open ${c.source} item ${c.id} is older than 3 days: triage it (accept/reject) or fix it. "${String(c.title || c.text).slice(0, 80)}".`,
      evidence: `inbox ${c.id} created ${c.createdAt}, status ${c.status}`,
    }));
}

/** Mechanical checks over the runner transcripts: scripts/audit-owner-stamps.mjs buckets 1-5 (reused, not reimplemented). */
export function transcriptFindings({ dir, since, until, repo = process.cwd(), now = Date.now() }) {
  const out = [];
  const day = today(now);
  const range = { dir, since, until };
  const stamps = audit(range);
  const nStamp = stamps.buckets['rubber stamp'] || 0;
  if (nStamp) out.push({ key: `rubber-stamps:${day}`, text: `${nStamp} owner rubber-stamp replies ("send it", "ok") in the window: decisions that should have run without asking.`, evidence: `audit-owner-stamps bucket 1, ${nStamp} of ${stamps.ownerInputs} owner inputs, top: ${JSON.stringify((stamps.topPhrases['rubber stamp'] || []).slice(0, 3))}` });
  const runs = loadRuns(dir);
  const relay = relayBucket(runs, range);
  if (relay.strict) out.push({ key: `owner-relay:${day}`, text: `${relay.strict} agent reports were relayed by the owner by hand instead of sent agent-to-agent.`, evidence: `audit-owner-stamps bucket 2 strict, examples ${JSON.stringify(relay.strictExamples.slice(0, 3))}` });
  const h = handoffBucket(runs);
  if (h.handoffs.under100k) out.push({ key: `early-handoffs:${day}`, text: `${h.handoffs.under100k} lead handoffs happened below 100k context tokens (unneeded churn).`, evidence: `audit-owner-stamps bucket 3, by trigger ${JSON.stringify(h.byTrigger)}` });
  const fx = fixerBucket(runs, gitMerges(repo));
  for (const [unit, branch] of fx.fixAfterMerge.slice(0, 5)) out.push({ key: `fix-after-merge:${unit}`, text: `Unit ${unit} started a fix less than 24h after ${branch} merged: the merge gate let a defect through.`, evidence: `audit-owner-stamps bucket 4 fixAfterMerge ${unit} <- ${branch}` });
  for (const [unit, n] of fx.multiWorker.slice(0, 5)) out.push({ key: `multi-implementer:${unit}`, text: `Unit ${unit} used ${n} implementers: fixer passed around.`, evidence: `audit-owner-stamps bucket 4 multiWorker ${unit}=${n}` });
  const fo = fixOfferBucket(dir, range);
  for (const e of fo.examples.slice(0, 5)) out.push({ key: `fix-offer:${e.run}`, text: `${e.lane}/${e.role} offered a fix as a question instead of doing it (R11).`, evidence: `transcript ${e.run} ts ${e.ts}: ...${e.tail.slice(-120).replace(/\s+/g, ' ')}` });
  return out;
}

function parseArgs(argv) {
  const a = { _: [], dir: path.join(process.env.VIBESQUAD_HOME || path.join(os.homedir(), '.vibesquad'), 'runner', 'agents'), repo: process.cwd(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') a.dir = argv[++i];
    else if (argv[i] === '--since') a.since = Date.parse(argv[++i]);
    else if (argv[i] === '--repo') a.repo = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
    else a._.push(argv[i]);
  }
  return a;
}

function vsNeedsYou(text) {
  const vs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'vs.mjs');
  try { execFileSync(process.execPath, [vs, 'log', 'needs-you', `perfection audit: ${text.slice(0, 300)}`], { stdio: 'ignore' }); }
  catch (e) { console.error(`needs-you log failed: ${e?.message ?? e}`); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const verb = args._[0];
  if (verb === 'collect') {
    const since = args.since ?? Date.now() - 24 * 3600 * 1000;
    const findings = [
      ...(fs.existsSync(args.dir) ? transcriptFindings({ dir: args.dir, since, repo: args.repo }) : []),
      ...staleUsageReviewFindings({}),
    ];
    console.log(JSON.stringify({ findings }, null, 2));
  } else if (verb === 'file') {
    const src = args._[1];
    if (!src) { console.error('usage: audit-perfection.mjs file <findings.json|-> [--dry-run]'); process.exit(2); }
    const data = JSON.parse(fs.readFileSync(src === '-' ? 0 : src, 'utf8'));
    const res = fileFindings(Array.isArray(data) ? data : data.findings, { dryRun: args.dryRun, needsYou: vsNeedsYou });
    console.log(JSON.stringify({ dryRun: args.dryRun, filed: res.filed, skipped: res.skipped }, null, 2));
  } else {
    console.error('usage: audit-perfection.mjs collect [--dir d] [--since ISO] | file <findings.json|-> [--dry-run]');
    process.exit(2);
  }
}
