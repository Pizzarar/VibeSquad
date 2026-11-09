#!/usr/bin/env node
// Audit owner "rubber stamp" replies in runner transcripts (PLAN_JUST_SEND_IT S2; S3 re-measures with this).
// Usage: node scripts/audit-owner-stamps.mjs [--dir <path>] [--since <ISO>] [--until <ISO>] [--json] [--waste [--repo <git dir>]]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  const a = { dir: path.join(os.homedir(), '.vibesquad', 'runner', 'agents'), json: false, waste: false, repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') a.dir = argv[++i];
    else if (argv[i] === '--since') a.since = Date.parse(argv[++i]);
    else if (argv[i] === '--until') a.until = Date.parse(argv[++i]);
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--waste') a.waste = true;
    else if (argv[i] === '--repo') a.repo = argv[++i];
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

// ================= S2b waste report (buckets 2-4) =================
// VS system notices and VS-forwarded reports arrive as plain `input` events (many even carry
// owner:true), so they are told apart by prefix. Keep this list in one place.
export const SYSTEM_PREFIXES = [
  /^New team log event/, /^Idea sent over/, /^Report to ★/, /^Context check:/, /^Your Art Director/,
  /^Wrap up:/, /^Your reply (was|got) (cut|truncated)/, /^Reply truncated/, /^\(Resend/, /^restart complete/i,
];
export const isSystemNotice = (t) => SYSTEM_PREFIXES.some((p) => p.test(t));
// An agent report: "<Agent> ... report/PASS/merged ..." with evidence (run id, commit hash, verdict).
export const REPORT_HEAD = /^(@[\w-]+\b|[A-Z][\w★]*( [A-Z][\w★]*)?( \([^)]*\))?( lead| Buddy)?\s*(→[^:]{0,40})?(:|\sreport\b|\shere\b))/;
export const REPORT_EVIDENCE = /\b(PASS|FAIL|merged|DONE)\b|rn-[0-9a-f]{8,}|\b[0-9a-f]{7,9}\b/;
export const isAgentReport = (t) => !isSystemNotice(t) && REPORT_HEAD.test(t) && REPORT_EVIDENCE.test(t);

export const LEAD_HANDOFF_MIN_TOKENS = 100000;
export const FIXTURE_CWD = /handoff-test/;
export const FIX_UNIT = /(fix|followup|hotfix|regress|redo)/;
export const FIX_WINDOW_MS = 24 * 3600 * 1000;
export const isReviewer = (profile, firstInput) => /review/i.test(profile || '') || /ROLE:\s*review|^Review|read-only/i.test((firstInput || '').slice(0, 200));
export function unitOf(text) { const m = (text || '').match(/\b(unit-[a-z0-9][a-z0-9-]*)/); return m ? m[1] : null; }

export function loadRuns(dir) {
  const runs = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const run = { id: f.replace(/\.jsonl$/, ''), outputs: 0, maxCtx: 0, inputs: [] };
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'created') { run.ts = e.ts; run.cwd = e.cwd || ''; Object.assign(run, { role: e.meta?.role, lane: e.meta?.lane, team: e.meta?.team, profile: e.meta?.profile, title: e.meta?.title, labels: e.meta?.labels || {} }); }
      else if (e.type === 'output') run.outputs++;
      else if (e.type === 'status') { run.lastStatus = e.status || e.state || run.lastStatus; run.endTs = e.ts; }
      else if (e.type === 'usage') run.maxCtx = Math.max(run.maxCtx, e.contextTokens || 0);
      else if (e.type === 'input') run.inputs.push(e);
      if (e.ts) run.endTs = Math.max(run.endTs || 0, e.ts);
    }
    if (run.ts) runs.push(run);
  }
  return runs;
}

// (2) owner-as-relay. strict = carries the runner's owner:true marker (human UI path, since 2026-11-07T17:56Z).
// Older inputs have no marker, so an unmarked report-shaped input could equally be an agent `send`: upper bound only.
export function relayBucket(runs, { since, until } = {}) {
  const r = { strict: 0, unmarkedUpperBound: 0, systemOrForwardedExcluded: 0, strictExamples: [] };
  for (const run of runs) {
    if (run.role !== 'brainstorm' && run.role !== 'lead') continue;
    for (const e of run.inputs) {
      if ((since !== undefined && e.ts < since) || (until !== undefined && e.ts > until)) continue;
      if (typeof e.text !== 'string' || e.text.startsWith('From ') || e.text.startsWith('You are ')) continue;
      if (isSystemNotice(e.text)) { r.systemOrForwardedExcluded++; continue; }
      if (!isAgentReport(e.text)) continue;
      if (e.owner) { r.strict++; r.strictExamples.push(e.text.slice(0, 40)); } else r.unmarkedUpperBound++;
    }
  }
  return r;
}

// (3) unneeded handoffs + lead churn per lane.
export function handoffBucket(runs, { since, until } = {}) {
  const byId = new Map(runs.map((x) => [x.id, x]));
  const leads = runs.filter((x) => x.role === 'lead');
  const fixtures = leads.filter((x) => FIXTURE_CWD.test(x.cwd));
  const real = leads.filter((x) => !FIXTURE_CWD.test(x.cwd) && !(since !== undefined && x.ts < since) && !(until !== undefined && x.ts > until));
  const r = { leadRuns: leads.length, fixtureRuns: fixtures.length, handoffs: { total: 0, under100k: 0, atOrOver100k: 0, predecessorUnknown: 0 }, byTrigger: {}, churn: {} };
  for (const x of real) {
    const from = x.labels['vs.handoff-from'];
    const lane = `${x.team}/${x.lane}`;
    const c = (r.churn[lane] ||= { runs: 0, handoffSuccessors: 0, freshSpawns: 0, thinRuns: 0 });
    c.runs++; from ? c.handoffSuccessors++ : c.freshSpawns++;
    if (x.outputs < 5) c.thinRuns++;
    if (!from) continue;
    r.handoffs.total++;
    const trig = x.labels['vs.handoff-trigger'] || '?';
    const p = byId.get(from);
    const k = !p || !p.maxCtx ? 'predecessorUnknown' : p.maxCtx < LEAD_HANDOFF_MIN_TOKENS ? 'under100k' : 'atOrOver100k';
    r.handoffs[k]++;
    (r.byTrigger[trig] ||= { under100k: 0, atOrOver100k: 0, predecessorUnknown: 0 })[k]++;
  }
  // Fixture runs per lane, so the hub's 31 are explained rather than hidden.
  r.fixtureByLane = {};
  for (const x of fixtures) { const lane = `${x.team}/${x.lane}`; r.fixtureByLane[lane] = (r.fixtureByLane[lane] || 0) + 1; }
  return r;
}

// (4) fixers passed around. Only implementers count: runner profile/labels first, text as fallback.
// Non-implementer profiles (reviewers, digests, art duet, leads) and non-implementing jobs are excluded.
export const NON_IMPL_PROFILE = /^(Review|Pre-check|Art Painter|Art Director|Lead)\b/i;
export const NON_IMPL_JOB = /\b(re-?review|review|verify|triage|scout|pre-?check|smoke|digest|audit|baseline|probe|painter|director)\b/i;
export const NON_IMPL_TEXT = /^(You are a digest agent|TASK:\s*review|Read-only|READ-ONLY)|ROLE:\s*review/i;
export function isImplementer(run) {
  if (run.role !== 'worker') return false;
  if (run.labels?.digestFor) return false;
  if (NON_IMPL_PROFILE.test(run.profile || '')) return false;
  const job = run.labels?.job || run.title || '';
  if (NON_IMPL_JOB.test(job) && !/\bfix/i.test(job)) return false;
  return !NON_IMPL_TEXT.test((run.inputs[0]?.text || '').slice(0, 200));
}

// Why did unit get a second implementer? Classes, in waste priority order (the unit's class is its worst one).
export const FIXER_CLASSES = ['respawn after stall', 'duplicate dispatch', 'lead re-dispatch', 'review-fix round', 'follow-up'];
export const STALLED_STATUS = /^(queued|starting|running)$/;
export const REDISPATCH_GAP_MS = 3600 * 1000;
const normJob = (r) => (r.labels?.job || r.title || '').toLowerCase().replace(/^.*·\s*/, '').trim();
export function classifySuccessor(pred, succ) {
  const stalled = pred.outputs === 0 || STALLED_STATUS.test(pred.lastStatus || '');
  if (stalled) return 'respawn after stall';
  if (normJob(pred) && normJob(pred) === normJob(succ)) return 'duplicate dispatch';
  const job = succ.labels?.job || succ.title || '';
  const txt = (succ.inputs[0]?.text || '').slice(0, 300);
  if (/\b(fix\w*|finding\w*|nits?|review)\b/i.test(job) || /review (found|finding|fix)|findings|\bFAIL\b/i.test(txt)) return 'review-fix round';
  if (succ.ts < (pred.endTs || pred.ts) + 60000) return 'duplicate dispatch';
  if (!/rebase/i.test(job) && succ.ts - (pred.endTs || pred.ts) > REDISPATCH_GAP_MS) return 'lead re-dispatch';
  return 'follow-up';
}

// A unit named only in prose ("read merged unit-x") is not this worker's unit: require a branch/worktree/task cue.
export function ownUnitFromText(text) {
  const head = text.slice(0, 600);
  const m = head.match(/(?:branch|worktree|task)[\s`:]*\(?`?(unit-[a-z0-9][a-z0-9-]*)/i) || head.slice(0, 200).match(/`(unit-[a-z0-9][a-z0-9-]*)`/);
  return m ? m[1] : null;
}

// merges = [{ts, branch}] (git merge commits on master).
export function fixerBucket(runs, merges = []) {
  const units = {};
  for (const x of runs) {
    if (!x.inputs[0] || !isImplementer(x)) continue;
    const u = unitOf(x.labels?.job || x.title || '') || ownUnitFromText(x.inputs[0].text || ''); if (!u) continue;
    const e = (units[u] ||= { runs: [], workers: new Set(), lanes: new Set(), firstTs: x.ts });
    e.runs.push(x); e.workers.add(x.id); if (x.lane) e.lanes.add(x.lane); e.firstTs = Math.min(e.firstTs, x.ts);
  }
  const r = { unitsSeen: Object.keys(units).length, multiWorker: [], laneBounce: [], fixAfterMerge: [], classes: Object.fromEntries(FIXER_CLASSES.map((c) => [c, []])), successorClasses: Object.fromEntries(FIXER_CLASSES.map((c) => [c, 0])) };
  for (const [u, e] of Object.entries(units)) {
    if (e.workers.size >= 2) {
      r.multiWorker.push([u, e.workers.size]);
      const rs = e.runs.sort((a, b) => a.ts - b.ts);
      const cls = rs.slice(1).map((s, i) => classifySuccessor(rs[i], s));
      cls.forEach((c) => r.successorClasses[c]++);
      const worst = FIXER_CLASSES.find((c) => cls.includes(c));
      r.classes[worst].push(u);
    }
    if (e.lanes.size >= 2) r.laneBounce.push([u, [...e.lanes].join(',')]);
    if (FIX_UNIT.test(u)) {
      const base = u.replace(/-?(fix|followup|hotfix|regress|redo)\w*/g, '').replace(/-+$/, '');
      const hit = merges.find((m) => m.branch !== u && e.firstTs - m.ts >= 0 && e.firstTs - m.ts <= FIX_WINDOW_MS && base.length > 8 && (m.branch.startsWith(base) || base.startsWith(m.branch)));
      if (hit) r.fixAfterMerge.push([u, hit.branch]);
    }
  }
  r.multiWorker.sort((a, b) => b[1] - a[1]);
  return r;
}

export function gitMerges(repo) {
  try {
    const out = execFileSync('git', ['-C', repo, 'log', 'master', '--merges', "--format=%ct %s"], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return out.split('\n').map((l) => l.match(/^(\d+) Merge branch '([^']+)'/)).filter(Boolean).map((m) => ({ ts: +m[1] * 1000, branch: m[2] }));
  } catch { return []; }
}

// ================= S6 bucket 5: fix offered as a question =================
// An agent output whose closing paragraphs ask permission for a fix/step it could just have done.
// Not counted: real owner choices (an A/B option list with no stated lean) and risky-step confirmations.
export const OFFER_PATTERNS = [
  /\b(want me to|do you want me to|would you like me to|should i|shall i|can i|ok(ay)? if i)\b[^?]*\?/,
  /\b(ok(ay)?|good|fine) with (that|this|it)\?/,
  /\bgo on (spawning|sending|writing|fixing|dispatching)\b[^?]*\?/,
  /\bsend (it|m\d+|p\d+[a-z]?|this|that)\?/,
  /\b(say so|say the word)\b[^.]{0,40}\b(i'?ll|i will|and i)\b/,
  /\bi can [^.?]{1,100} if you('d| would)? (like|want|prefer)\b/,
  /\bif you want( it| that)?( done)?( now)?,? (i can|i'?ll)\b/,
];
export const RISKY_STEP = /\b(delete|deleting|force[- ]?push|release|publish|sign(ing)?|overwrite|reset --hard|wipe|drop (the )?(table|branch)|replace the app|pay|spend|cost)\b/i;
export const OPTION_LIST = /(^|\n)\s*(?:[-*\d.]+\s*)?(?:\*\*)?\(?[a-c][).]\)?(?:\*\*)?[\s:]/gi;
export const STATED_LEAN = /\bi (still |strongly )?(lean|recommend|suggest|propose)|\bmy (pick|recommendation)|\bi'd (go|pick|choose|send|give|keep)\b/i;
export function offersFix(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 40) return false;
  const close = t.slice(-450).split(/\n\s*\n/).slice(-2).join(' ');
  // A question that restarts with ", or ..." / "or should I ..." offers alternatives = a real choice, not a fix offer.
  const hit = OFFER_PATTERNS.map((p) => close.toLowerCase().match(p)).find((m) => m && !(m[0].endsWith('?') && /,\s*or\b|\bor (should|do you|would you|want|shall)\b/.test(m[0])));
  if (!hit) return false;
  if (RISKY_STEP.test(close)) return false;
  const tail = t.slice(-900);
  if ((tail.match(OPTION_LIST) || []).length >= 2 && !STATED_LEAN.test(tail)) return false;
  return true;
}

// Lean-ask: the agent ends by asking the owner to confirm something it already has a lean on ("my leans are above",
// "Lean: ... Run the spike?"), or a failed inbox archive/triage (403) that ends in an owner ask. Not counted: asks about
// scope changes, public actions, money or deletes (RISKY_STEP + LEAN_SKIP), or anything offersFix already counts.
export const LEAN_MARK = /(?<!\bno )\blean(s|ing)?\b|\bmy (pick|recommendation)\b|\bi (recommend|suggest)\b/i;
export const LEAN_ASK_PATTERNS = [
  /\b(still )?needs? your (call|ok|go|decision)\b/i,
  /^[^\n]{0,12}\b(run|send|spawn|start|dispatch|go ahead with|queue|park)\b[^.?\n]{0,60}\?\s*$/im,
];
export const BLOCKED_MARK = /\b403\b|only (answers|accepts)[^.]{0,50}(app|desktop) window|no archive command/i;
export const BLOCKED_ASK = /\b(please|can you) (archive|close|triage|accept|reject)\b|\bneeds? your call\b/i;
export const LEAN_SKIP = /\b(scope|public|publicly|push(ing)? to|money|budget|spend|paid|cost|delet\w*|remove all)\b|\$\d/i;
export function leanAsk(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 40 || offersFix(t)) return false;
  const tail = t.slice(-900), close = t.slice(-450).split(/\n\s*\n/).slice(-2).join('\n');
  if (RISKY_STEP.test(close) || LEAN_SKIP.test(close)) return false;
  const ask = LEAN_ASK_PATTERNS.some((p) => p.test(close));
  if (ask && LEAN_MARK.test(tail)) return true;
  return BLOCKED_MARK.test(tail) && BLOCKED_ASK.test(close);
}

export function fixOfferBucket(dir, { since, until } = {}) {
  const r = { total: 0, leanAsks: 0, outputs: 0, byLane: {}, byRole: {}, byLaneRole: {}, examples: [] };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    let meta = {};
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'created') { meta = e.meta || {}; continue; }
      if (e.type !== 'output' || typeof e.text !== 'string') continue;
      if ((since !== undefined && e.ts < since) || (until !== undefined && e.ts > until)) continue;
      r.outputs++;
      const kind = offersFix(e.text) ? 'fix-offer' : leanAsk(e.text) ? 'lean-ask' : null;
      if (!kind) continue;
      if (kind === 'lean-ask') r.leanAsks++;
      const lane = meta.lane || '(none)', role = meta.role || '(none)', lr = `${lane}/${role}`;
      r.total++;
      r.byLane[lane] = (r.byLane[lane] || 0) + 1;
      r.byRole[role] = (r.byRole[role] || 0) + 1;
      r.byLaneRole[lr] = (r.byLaneRole[lr] || 0) + 1;
      r.examples.push({ kind, run: f.replace(/\.jsonl$/, ''), lane, role, ts: e.ts, tail: e.text.trim().slice(-200) });
    }
  }
  return r;
}

// ================= O7 bucket 6: unrouted ops =================
// Lead/handoff messages that mention a server restart, a runtime sync, or a Gotchas-style blocker
// (OPS_MENTION) but were never routed to the Overlord (`vs send`) or @bug (`vs inbox add --lane
// bug-chaser`) within the window. Report-only: no blocking, no penalties. Audit key `unrouted-ops:<date>`.
export const OPS_MENTION_PATTERNS = [
  /\bneeds? (a )?(server )?restart\b/i,
  /\brestart (the )?(vs |vibesquad )?(server|runner)\b/i,
  /\bruntime sync\b/i,
  /\bsync (the )?runtime\b/i,
  /\buntracked files?\b/i,
  /\bnode_modules junction\b/i,
  /\bflaky\b/i,
];
export const isOpsMention = (text) => typeof text === 'string' && OPS_MENTION_PATTERNS.some((p) => p.test(text));
// A route to @bug: the literal `vs inbox add --lane bug-chaser` command an agent runs in a shell.
const INBOX_ADD_RE = /vs inbox add\s+--lane[=\s]+bug-chaser/i;
// A lead run is "routed" if, within the window, it actually sent the ops blocker to the Overlord
// (a `send` tool whose recipient is an Overlord run) or added it to @bug's inbox. Detected from the
// runner's `tool` events in the lead's own transcript (the send's `input.id` is the Overlord's run id).
export function unroutedOpsBucket(dir, { since, until } = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  // Pass 1: run metadata + the set of Overlord (hub lead) run ids (role=lead on the hub lane, i.e. lane === team).
  const meta = new Map();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'created') { meta.set(f.replace(/\.jsonl$/, ''), { role: e.meta?.role, lane: e.meta?.lane, team: e.meta?.team }); break; }
    }
  }
  const overlordIds = new Set([...meta].filter(([, m]) => m.role === 'lead' && m.lane && m.lane === m.team).map(([id]) => id));
  // Pass 2: feature-lane leads' ops mentions, suppressed when the run routed to Overlord/@bug in the window.
  const r = { total: 0, mentions: 0, routed: 0, byLane: {}, examples: [] };
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, '');
    const m = meta.get(id);
    if (!m || m.role !== 'lead' || overlordIds.has(id)) continue; // the Overlord is the sink, not a source.
    const mentions = [];
    let routed = false;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'input' && e.type !== 'output' && e.type !== 'tool') continue;
      if (since !== undefined && e.ts < since) continue;
      if (until !== undefined && e.ts > until) continue;
      if (e.type === 'tool') {
        if (INBOX_ADD_RE.test(JSON.stringify(e))) routed = true;
        else if (/send/i.test(String(e.name || ''))) { const to = e.input?.id ?? e.input?.agentId; if (typeof to === 'string' && overlordIds.has(to)) routed = true; }
        continue;
      }
      if (typeof e.text === 'string' && isOpsMention(e.text)) mentions.push({ ts: e.ts, text: e.text });
    }
    if (!mentions.length) continue;
    r.mentions += mentions.length;
    if (routed) { r.routed += mentions.length; continue; }
    const lane = m.lane || '(none)';
    r.byLane[lane] = (r.byLane[lane] || 0) + mentions.length;
    r.total += mentions.length;
    for (const mn of mentions) r.examples.push({ run: id, lane, ts: mn.ts, tail: mn.text.trim().slice(-160) });
  }
  r.examples.sort((a, b) => (a.lane === b.lane ? a.ts - b.ts : a.lane < b.lane ? -1 : 1));
  return r;
}

function printWaste({ buckets, ownerInputs, waste: { relay, handoffs, fixers, fixOffers, unroutedOps } }) {
  console.log('\n== waste report ==');
  console.log(`(1) rubber stamps: ${buckets['rubber stamp'] || 0} of ${ownerInputs} owner inputs`);
  console.log(`(2) owner-as-relay: strict (owner:true, report-shaped, VS notices/forwards excluded) = ${relay.strict}`);
  console.log(`    unmarked report-shaped (upper bound, may be agent sends) = ${relay.unmarkedUpperBound}; system/forwarded excluded = ${relay.systemOrForwardedExcluded}`);
  const h = handoffs.handoffs;
  console.log(`(3) lead runs ${handoffs.leadRuns} (${handoffs.fixtureRuns} are handoff-test fixtures, excluded). Real handoffs ${h.total}: <100k ${h.under100k}, >=100k ${h.atOrOver100k}, predecessor unknown ${h.predecessorUnknown}`);
  console.log('    by trigger:', JSON.stringify(handoffs.byTrigger));
  console.log('    fixture runs by lane:', JSON.stringify(handoffs.fixtureByLane));
  for (const [lane, c] of Object.entries(handoffs.churn)) console.log(`    churn ${lane}: runs ${c.runs} (handoff successors ${c.handoffSuccessors}, fresh ${c.freshSpawns}, thin <5 outputs ${c.thinRuns})`);
  console.log(`(4) fixers: ${fixers.unitsSeen} units seen; 2+ implementers ${fixers.multiWorker.length}; across lanes ${fixers.laneBounce.length}; fix unit <24h after merge ${fixers.fixAfterMerge.length}`);
  for (const c of FIXER_CLASSES) console.log(`    class ${c}: ${fixers.classes[c].length} units (${fixers.successorClasses[c]} extra implementers) ${JSON.stringify(fixers.classes[c].slice(0, 8))}`);
  console.log('    multi-worker:', JSON.stringify(fixers.multiWorker.slice(0, 15)));
  console.log('    lane bounce:', JSON.stringify(fixers.laneBounce.slice(0, 10)));
  console.log('    fix after merge:', JSON.stringify(fixers.fixAfterMerge.slice(0, 10)));
  console.log(`(5) fix offered as a question (incl. ${fixOffers.leanAsks} lean-asks): ${fixOffers.total} of ${fixOffers.outputs} agent outputs`);
  console.log('    by lane:', JSON.stringify(fixOffers.byLane));
  console.log('    by role:', JSON.stringify(fixOffers.byRole));
  for (const x of fixOffers.examples.slice(0, 3)) console.log(`    e.g. ${x.run} ${x.lane}/${x.role}: ...${x.tail.slice(-120).replace(/\n/g, ' ')}`);
  const day = new Date().toISOString().slice(0, 10);
  console.log(`(6) unrouted ops (audit-key: unrouted-ops:${day}): ${unroutedOps.total} unrouted of ${unroutedOps.mentions} mentions (${unroutedOps.routed} routed)`);
  console.log('    by lane:', JSON.stringify(unroutedOps.byLane));
  for (const x of unroutedOps.examples.slice(0, 3)) console.log(`    e.g. ${x.run} ${x.lane}: ...${x.tail.slice(-100).replace(/\n/g, ' ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const r = audit(args);
  if (args.waste) {
    const runs = loadRuns(args.dir);
    r.waste = { relay: relayBucket(runs, args), handoffs: handoffBucket(runs), fixers: fixerBucket(runs, gitMerges(args.repo)), fixOffers: fixOfferBucket(args.dir, args), unroutedOps: unroutedOpsBucket(args.dir, args) };
  }
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
    if (r.waste) printWaste(r);
  }
}
