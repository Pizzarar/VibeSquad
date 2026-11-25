// usa-54 (idea-861): only first-parent merges on the default branch are units. Back-merges of main into a feature branch and
// branch-to-branch merges stop counting once the branch lands; GitHub "Merge pull request #N from <owner>/<branch>" subjects
// name their unit; the ledger re-fold marks stale non-unit rows `excluded` (append-only, never deleted). Temp dirs only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUsageCache, getUsage, mergeSubjectBranch, readMergedUnits, readUsageLedger } from '../server/providers-catalog.mjs';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-usa54-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const L = (sha, parents, ct, subject) => [sha, parents, ct, subject].join('\x1f');
const noSchedule = { suppressSchedule: true };
const T0 = Date.UTC(2026, 10, 19, 12);
const sec = (n) => String(Math.round(T0 / 1000) + n);

// History (newest first), HEAD = PM:
//   PM  Merge remote-tracking branch 'origin/master'   mainline pull merge  -> excluded "back-merge"
//   M2  Merge pull request #12 from org/cg-contracts   mainline             -> unit cg-contracts
//   BB  Merge sf-m2 into sf-m3                          on M2's merged side  -> excluded "not-first-parent"
//   M1  Merge branch 'unit-f' (@usa)                    mainline             -> unit unit-f
//   BM  Merge branch 'master' into unit-f               on M1's merged side  -> excluded "not-first-parent"
//   OLD a merge whose parents fell off the bounded log -> neither a unit nor excluded (unknown != excluded)
const HISTORY = [
  L('PM', 'M2 X1', sec(190), "Merge remote-tracking branch 'origin/master'"),
  L('X1', 'M1', sec(185), 'hotfix pushed from another clone'),
  L('M2', 'M1 BB', sec(180), 'Merge pull request #12 from org/cg-contracts'),
  L('BB', 'S3 S2', sec(170), 'Merge sf-m2 into sf-m3'),
  L('S3', 'M1', sec(165), 'sf-m3 work (@usa)'),
  L('S2', 'M1', sec(160), 'sf-m2 work review r3'),
  L('M1', 'A2 F2', sec(150), "Merge branch 'unit-f' (@usa)"),
  L('F2', 'BM', sec(140), 'fix (@usa) review r2'),
  L('BM', 'F1 A2', sec(130), "Merge branch 'master' into unit-f"),
  L('A2', 'A1', sec(120), 'mainline work'),
  L('F1', 'A1', sec(110), 'feat (@usa) review r1'),
  L('A1', 'root', sec(100), 'mainline start'),
  L('OLD', 'gone1 gone2', sec(50), "Merge branch 'unit-ancient'"),
  L('root', '', sec(0), 'init'),
].join('\n');
const gitWith = (head, log) => (args) => {
  if (args[0] === 'rev-parse') return `${head}\n`;
  if (args[0] === 'log') return args.includes('--numstat') ? '' : log;
  return '';
};

test('usa-54 mergeSubjectBranch: git, hand-typed unit and GitHub PR subjects', () => {
  assert.equal(mergeSubjectBranch('Merge pull request #12 from org/cg-contracts'), 'cg-contracts');
  assert.equal(mergeSubjectBranch('Merge pull request #7 from Pizzarar/feature/save-v2'), 'feature/save-v2', 'slashes in the branch are kept');
  assert.equal(mergeSubjectBranch('Merge pull request #301 from some-user/unit-efi-12.'), 'unit-efi-12', 'trailing punctuation trimmed');
  assert.equal(mergeSubjectBranch("Merge branch 'unit-x' (@usa)"), 'unit-x');
  assert.equal(mergeSubjectBranch("Merge branch 'unit-y' into 'main'"), 'unit-y', "GitLab \"into 'main'\" form");
  assert.equal(mergeSubjectBranch('Merge unit-usa-53-burst-plan-drilldown: burst cohort table'), 'unit-usa-53-burst-plan-drilldown');
  assert.equal(mergeSubjectBranch('Merge pull request #12 from'), null, 'no owner/branch: no unit');
  assert.equal(mergeSubjectBranch('Merge sf-m2 into sf-m3'), null);
  assert.equal(mergeSubjectBranch('feat: Merge pull request #1 from a/b'), null, 'anchored at the subject start');
});

test('usa-54 readMergedUnits: only first-parent merges are units; back-merge / branch-to-branch merges are excluded', () => {
  const units = readMergedUnits(gitWith('PM', HISTORY));
  assert.deepEqual(units.map((u) => [u.sha, u.unit]).sort(), [['M1', 'unit-f'], ['M2', 'cg-contracts']]);
  const m1 = units.find((u) => u.sha === 'M1');
  assert.equal(m1.reviewRounds, 2, 'the merged side still walks through the back-merge (F1 r1, F2 r2)');
  assert.equal(m1.code, 'usa');
  assert.equal(m1.firstBranchCtMs, (Math.round(T0 / 1000) + 110) * 1000, 'first branch commit = F1');
  const m2 = units.find((u) => u.sha === 'M2');
  assert.equal(m2.reviewRounds, 3, 'branch-to-branch merge folds into the PR unit it landed with');
  assert.equal(m2.code, 'usa');
  assert.deepEqual(Object.fromEntries(units.excluded), { BM: 'not-first-parent', BB: 'not-first-parent', PM: 'back-merge' });
  assert.ok(!units.excluded.has('OLD'), 'a merge outside the walked history is not provably excluded');
});

test('usa-54 readMergedUnits: a master merge reachable only through a back-merge 2nd parent is still a unit', () => {
  // Master was at U1 (a real unit merge) when unit-b back-merged it, then master moved without U1 as a first parent
  // (fast-forward / another clone). A back-merge's 2nd parent is default-branch history, so U1 stays a unit.
  const log = [
    L('M5', 'A1 B2', sec(50), "Merge branch 'unit-b' (@usa)"),
    L('B2', 'BMB', sec(45), 'b work review r1'),
    L('BMB', 'B1 U1', sec(40), 'Merge origin/master into unit-b (@usa)'),
    L('U1', 'A1 W1', sec(30), "Merge branch 'unit-w' (@usa)"),
    L('W1', 'A1', sec(25), 'w work'),
    L('B1', 'A1', sec(20), 'b start'),
    L('A1', 'root', sec(10), 'mainline'),
    L('root', '', sec(0), 'init'),
  ].join('\n');
  const units = readMergedUnits(gitWith('M5', log));
  assert.deepEqual(units.map((u) => [u.sha, u.unit]).sort(), [['M5', 'unit-b'], ['U1', 'unit-w']]);
  assert.deepEqual(Object.fromEntries(units.excluded), { BMB: 'not-first-parent' });
  assert.equal(units.find((u) => u.sha === 'M5').reviewRounds, 1, "unit-b's side stops at master history (W1 is not walked)");
});

test('usa-54 ledger re-fold: non-unit rows marked excluded (never deleted), PR rows get their unit, idempotent', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'runner', 'agents'), { recursive: true });
  const ledgerFile = path.join(home, 'runner', 'usage-ledger.jsonl');
  const row = (sha, unit, extra = {}) => ({ kind: 'unit', unit, sha, ts: new Date(T0).toISOString(), lane: 'usage', implementerProfile: null, implementerProvider: null, workflowMode: 'unattributed', reviewRounds: 0, firstTryPass: true, costUsd: null, totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, cycleMs: null, locAdded: 0, locDeleted: 0, filesChanged: 0, fixedAfterMerge: false, ...extra });
  // Rows written by the pre-usa-54 parser: back-merge + branch-to-branch counted as units, the PR merge with unit null,
  // plus a real unit whose merge already fell off the git log (must keep folding).
  const seeded = [row('BM', 'master'), row('BB', null), row('M2', null, { costUsd: 4, workflowMode: 'sonnet' }), row('AGED', 'unit-aged', { costUsd: 2 })];
  const seededText = seeded.map((r) => JSON.stringify(r) + '\n').join('');
  fs.writeFileSync(ledgerFile, seededText);

  const opts = { home, laneCodes: { usa: 'usage' }, usageReview: noSchedule, now: () => T0 + 86_400_000 };
  clearUsageCache();
  const u = getUsage({ ...opts, git: gitWith('PM', HISTORY) });
  const shas = u.merged.units.map((m) => m.sha).sort();
  assert.deepEqual(shas, ['AGED', 'M1', 'M2'], 'back-merge / branch-to-branch rows are not folded back in');
  assert.equal(u.merged.units.find((m) => m.sha === 'AGED').fromLedger, true, 'an unrelated aged-out unit still folds');

  const text = fs.readFileSync(ledgerFile, 'utf8');
  assert.ok(text.startsWith(seededText), 'append-only: every seeded line is kept verbatim');
  const ledger = readUsageLedger(home);
  const bySha = (s) => ledger.find((r) => r.sha === s);
  assert.equal(bySha('BM').excluded, 'not-first-parent');
  assert.equal(bySha('BM').unit, 'master', 'the excluded row keeps its original fields for audit');
  assert.equal(bySha('BB').excluded, 'not-first-parent');
  assert.equal(bySha('M2').unit, 'cg-contracts', 'PR merge row gets its branch');
  assert.equal(bySha('M2').costUsd, 4, 'a row that already had a cost keeps it');
  assert.equal(bySha('M2').excluded, undefined);
  assert.equal(bySha('AGED').excluded, undefined, 'a sha git says nothing about is never marked');
  assert.equal(bySha('PM'), undefined, 'the mainline pull merge is never written as a unit');
  assert.equal(ledger.filter((r) => r.sha === 'BM').length, 1, 'one record per sha after supersede');

  clearUsageCache();
  getUsage({ ...opts, git: gitWith('PM', HISTORY) });
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), text, 're-fold is idempotent: the second sync appends nothing');

  // Once the excluded merges fall off the bounded git log, their marked rows still never fold back in.
  const later = [L('M9', 'PM Y1', sec(300), "Merge branch 'unit-later' (@usa)"), L('Y1', 'PM', sec(290), 'later (@usa)'), L('PM', 'root', sec(190), 'squashed')].join('\n') + '\n' + L('root', '', sec(0), 'init');
  clearUsageCache();
  const u2 = getUsage({ ...opts, git: gitWith('M9', later) });
  const shas2 = u2.merged.units.map((m) => m.sha);
  assert.ok(!shas2.includes('BM') && !shas2.includes('BB'), 'excluded rows stay out after aging off the log');
  assert.ok(shas2.includes('M2') && shas2.includes('AGED'), 'real units keep folding from the ledger');
  assert.equal(fs.readFileSync(ledgerFile, 'utf8').split('\n').filter((l) => l.includes('"sha":"BM"')).length, 2, 'stale line + one marking line');
});
