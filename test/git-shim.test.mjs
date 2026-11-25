// idea-888: the provider-neutral worker git gate. runner.mjs agentEnv puts runner/git-shim first on every role=worker
// agent's PATH (claude, agy/Gemini, opencode, Codex alike); its `git` refuses git writes in a repo's MAIN checkout through
// runner/git-guard-check.mjs (gitArgvViolation, the same classifier as the Claude PreToolUse hook) and execs the real git
// otherwise. Real temp repos: a main checkout (.git directory) with a linked worktree, driven through the real shim.
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv } from '../runner/runner.mjs';
import { applyGitShim, findViolation, GIT_SHIM_DIR, GIT_SHIM_NODE_ENV, gitArgvViolation, scratchRootsOf } from '../runner/git-guard.mjs';

const posix = process.platform !== 'win32';
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vs-git-shim-')));
// The shim exempts main checkouts under the temp dir (test suites' scratch repos), so the fixture runs with TMPDIR elsewhere.
const altTmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vs-git-shim-tmp-')));
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(altTmp, { recursive: true, force: true }); });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const MAIN = path.join(root, 'repo');
const WT = path.join(root, 'sanctuary', 'unit-x');
const PLAIN = path.join(root, 'plain');
mkdirSync(MAIN, { recursive: true });
mkdirSync(PLAIN, { recursive: true });
git(MAIN, 'init', '-q', '-b', 'master');
git(MAIN, 'config', 'user.email', 't@example.com');
git(MAIN, 'config', 'user.name', 't');
writeFileSync(path.join(MAIN, 'a.txt'), 'a\n');
git(MAIN, 'add', '.');
git(MAIN, 'commit', '-q', '-m', 'init');
git(MAIN, 'branch', 'side');
git(MAIN, 'worktree', 'add', '-q', '-b', 'unit-x', WT);
const WT_GITDIR = path.join(MAIN, '.git', 'worktrees', 'unit-x');

const base = { ...process.env, HOME: root, TMPDIR: altTmp, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete base[k];
const workerEnv = agentEnv('rn-shim-test', { team: 'sq', lane: 'bug', role: 'worker' }, base);
const leadEnv = agentEnv('rn-shim-lead', { team: 'sq', lane: 'bug', role: 'lead' }, base);
/** `git <args>` resolved through env.PATH, as a worker's shell would (spawn looks the command up on options.env.PATH). */
const run = (cwd, args, env = workerEnv, extra = {}) => spawnSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const refused = (r, where = MAIN) => {
  assert.equal(r.status, 128, `expected refusal, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /vs git-guard: refused `git [a-z-]+[^`]*`/);
  if (where) assert.ok(r.stderr.includes(`in ${where}:`), r.stderr);
};
const passed = (r) => assert.equal(r.status, 0, `expected pass, got ${r.status}: ${r.stderr}`);

test('agentEnv: workers get the git shim first on PATH (any provider); leads, Buddies and role-less agents do not', { skip: !posix }, () => {
  assert.equal(workerEnv.PATH.split(':')[0], GIT_SHIM_DIR);
  assert.equal(workerEnv.PATH.split(':').slice(1).join(':'), base.PATH, 'the rest of PATH is unchanged');
  assert.equal(workerEnv[GIT_SHIM_NODE_ENV], process.execPath, 'the check runs with the runner\'s own node');
  for (const meta of [{ role: 'lead' }, { role: 'brainstorm' }, {}, { labels: { role: 'lead' } }]) {
    const e = agentEnv('rn-x', meta, workerEnv); // even when the runner's own env already carried a shim
    assert.ok(!e.PATH.split(':').includes(GIT_SHIM_DIR), `no shim for ${JSON.stringify(meta)}`);
    assert.equal(e[GIT_SHIM_NODE_ENV], undefined);
  }
  assert.equal(agentEnv('rn-x', { labels: { role: 'worker' } }, base).PATH.split(':')[0], GIT_SHIM_DIR, 'labels.role=worker counts');
  const again = agentEnv('rn-x', { role: 'worker' }, workerEnv).PATH.split(':');
  assert.equal(again.filter((d) => d === GIT_SHIM_DIR).length, 1, 'never stacked twice');
  // win32: no shim (a sh script); the env is left alone.
  const w = { PATH: 'C:\\x', Path: 'C:\\x' };
  assert.deepEqual(applyGitShim({ ...w }, { worker: true, platform: 'win32' }), w);
  // A runner hosted in a non-node executable leaves the shim on PATH's node.
  assert.equal(applyGitShim({ PATH: '/usr/bin' }, { worker: true, execPath: '/opt/app/electron' })[GIT_SHIM_NODE_ENV], undefined);
  accessSync(path.join(GIT_SHIM_DIR, 'git'), constants.X_OK);
  // A copy that dropped the exec bit would be skipped by PATH lookup (git unguarded, no error): the spawn restores it.
  const copy = path.join(root, 'copied', 'git-shim');
  mkdirSync(copy, { recursive: true });
  copyFileSync(path.join(GIT_SHIM_DIR, 'git'), path.join(copy, 'git'));
  chmodSync(path.join(copy, 'git'), 0o644);
  applyGitShim({ PATH: '/usr/bin' }, { worker: true, shimDir: copy });
  assert.equal(statSync(path.join(copy, 'git')).mode & 0o777, 0o755);
});

test('worker: git writes in the MAIN checkout are refused and the dirty tree survives', { skip: !posix }, () => {
  writeFileSync(path.join(MAIN, 'a.txt'), 'dirty\n');
  writeFileSync(path.join(MAIN, 'untracked.txt'), 'u\n');
  const before = head(MAIN);
  for (const args of [
    ['reset', '--hard'], ['checkout', '--', 'a.txt'], ['checkout', '.'], ['restore', 'a.txt'], ['clean', '-fd'], ['stash'],
    ['stash', 'pop'], ['switch', '-f', 'side'], ['commit', '-am', 'x'], ['commit', '--allow-empty', '-m', 'x'],
    ['merge', 'side'], ['rebase', 'side'], ['cherry-pick', 'side'], ['revert', '--no-edit', 'HEAD'], ['pull'],
    ['-c', 'core.pager=cat', 'reset', '--hard'], ['--no-pager', 'commit', '--allow-empty', '-m', 'x'],
  ]) refused(run(MAIN, args));
  refused(run(path.join(MAIN, '.git'), ['reset', '--hard']), MAIN); // from inside .git too: it walks up to the checkout
  assert.equal(readFileSync(path.join(MAIN, 'a.txt'), 'utf8'), 'dirty\n');
  assert.equal(readFileSync(path.join(MAIN, 'untracked.txt'), 'utf8'), 'u\n');
  assert.equal(head(MAIN), before);
  assert.equal(git(MAIN, 'stash', 'list'), '');
});

test('worker: read-only git and branch-safe commands pass in the MAIN checkout (real output)', { skip: !posix }, () => {
  const st = run(MAIN, ['status', '--short']);
  passed(st);
  assert.match(st.stdout, / M a\.txt/);
  assert.equal(run(MAIN, ['rev-parse', '--show-toplevel']).stdout.trim(), MAIN);
  for (const args of [['log', '--oneline', '-1'], ['diff', '--stat'], ['branch', '-a'], ['worktree', 'list'], ['stash', 'list'],
    ['clean', '-n'], ['commit', '--dry-run'], ['log', '--grep=reset', '--oneline'], ['reset', '-h']]) {
    const r = run(MAIN, args);
    assert.notEqual(r.status, 128, `${args.join(' ')}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /vs git-guard/);
  }
});

test('worker: the same writes are allowed inside its linked worktree', { skip: !posix }, () => {
  const before = head(WT);
  passed(run(WT, ['commit', '--allow-empty', '-m', 'wt commit']));
  assert.notEqual(head(WT), before);
  writeFileSync(path.join(WT, 'a.txt'), 'wt dirty\n');
  passed(run(WT, ['stash']));
  passed(run(WT, ['stash', 'pop']));
  passed(run(WT, ['checkout', '--', 'a.txt']));
  passed(run(WT, ['reset', '--hard', 'HEAD~1']));
  assert.equal(head(WT), before);
  passed(run(WT, ['merge', '--ff-only', 'side']));
  assert.equal(git(MAIN, 'rev-parse', 'master'), git(MAIN, 'rev-parse', 'side'), 'fixture: side == master');
});

test('worker: -C, --git-dir/--work-tree and GIT_DIR/GIT_WORK_TREE resolve the effective repo', { skip: !posix }, () => {
  const before = head(MAIN);
  refused(run(WT, ['-C', MAIN, 'commit', '--allow-empty', '-m', 'x']));
  refused(run(PLAIN, ['-C', MAIN, 'reset', '--hard']));
  refused(run(WT, ['-C', '..', '-C', '../repo', 'reset', '--hard'])); // cumulative -C
  refused(run(WT, ['--git-dir', path.join(MAIN, '.git'), '--work-tree', MAIN, 'reset', '--hard']));
  refused(run(WT, [`--git-dir=${path.join(MAIN, '.git')}`, `--work-tree=${MAIN}`, 'checkout', '--', 'a.txt']));
  refused(run(WT, ['reset', '--hard'], workerEnv, { GIT_DIR: path.join(MAIN, '.git'), GIT_WORK_TREE: MAIN }));
  refused(run(PLAIN, ['commit', '--allow-empty', '-m', 'x'], workerEnv, { GIT_DIR: path.join(MAIN, '.git') }));
  refused(run(PLAIN, ['commit', '--allow-empty', '-m', 'x'], workerEnv, { GIT_DIR: '../repo/.git' })); // relative to cwd
  assert.equal(head(MAIN), before);
  assert.equal(readFileSync(path.join(MAIN, 'a.txt'), 'utf8'), 'dirty\n');
  // ...and the worktree is still reachable the same ways from the main checkout.
  const wt = head(WT);
  passed(run(MAIN, ['-C', WT, 'commit', '--allow-empty', '-m', 'via -C']));
  passed(run(MAIN, ['commit', '--allow-empty', '-m', 'via env'], workerEnv, { GIT_DIR: WT_GITDIR, GIT_WORK_TREE: WT }));
  passed(run(PLAIN, ['commit', '--allow-empty', '-m', 'via git-dir'], workerEnv, { GIT_DIR: WT_GITDIR, GIT_WORK_TREE: WT }));
  assert.equal(git(WT, 'rev-list', '--count', `${wt}..HEAD`), '3');
});

test('fail closed: a broken check refuses writes (even in a worktree); reads never start node', { skip: !posix }, () => {
  const broken = { [GIT_SHIM_NODE_ENV]: path.join(root, 'no-such-node') };
  const r = run(WT, ['commit', '--allow-empty', '-m', 'x'], workerEnv, broken);
  assert.equal(r.status, 128);
  assert.match(r.stderr, /vs git-guard: the main-checkout check could not run \(exit 127/);
  passed(run(MAIN, ['status', '--short'], workerEnv, broken)); // fast path: no write name in argv, no node start
  passed(run(MAIN, ['log', '-1', '--format=%s'], workerEnv, broken));
  // No real git after the shim: a clear error, never a loop. Two shim entries do not loop either.
  const none = run(MAIN, ['status'], workerEnv, { PATH: GIT_SHIM_DIR });
  assert.equal(none.status, 127);
  assert.match(none.stderr, /no real git found on PATH/);
  passed(run(MAIN, ['status'], workerEnv, { PATH: `${GIT_SHIM_DIR}:${workerEnv.PATH}` }));
});

test('scratch repos under the temp dir (tests, scripts) are not gated', { skip: !posix }, () => {
  const before = head(MAIN);
  passed(run(MAIN, ['commit', '--allow-empty', '-m', 'scratch'], workerEnv, { TMPDIR: root }));
  assert.notEqual(head(MAIN), before);
  git(MAIN, 'reset', '-q', '--soft', before);
  assert.deepEqual(scratchRootsOf({ TMPDIR: '/' }), [], 'TMPDIR=/ never exempts every repo');
  assert.ok(scratchRootsOf({ TMPDIR: root }).includes(root));
});

test('gitArgvViolation: the shim decision on argv (no shell parsing), same classifier as the hook', () => {
  const opts = (extra = {}) => ({ cwd: MAIN, env: {}, scratchRoots: [], ...extra });
  for (const argv of [['reset', '--hard'], ['commit', '-m', 'x'], ['merge', 'side'], ['rebase', 'master'], ['pull'], ['am', 'p.patch'],
    ['checkout', 'a.txt'], ['-c', 'x=y', 'stash'], ['--git-dir', path.join(MAIN, '.git'), 'commit', '-m', 'x']]) {
    const v = gitArgvViolation(argv, opts());
    assert.ok(v, argv.join(' '));
    assert.equal(v.root, MAIN);
  }
  for (const argv of [['status'], ['log'], ['checkout', 'side'], ['checkout', '-b', 'n'], ['reset'], ['reset', '--soft', 'HEAD~1'],
    ['stash', 'list'], ['commit', '--dry-run'], ['merge', '--help'], ['fetch'], ['push'], []]) {
    assert.equal(gitArgvViolation(argv, opts()), null, argv.join(' '));
  }
  assert.equal(gitArgvViolation(['reset', '--hard'], opts({ cwd: WT })), null);
  assert.equal(gitArgvViolation(['reset', '--hard'], opts({ cwd: PLAIN })), null);
  assert.equal(gitArgvViolation(['reset', '--hard'], opts({ scratchRoots: [root] })), null, 'scratch root');
  assert.equal(gitArgvViolation(['-C'], opts()), null, 'no subcommand');
  assert.equal(gitArgvViolation(['-C', 'reset', '--hard'], opts()), null, '-C eats the next word, as git does (sub is --hard)');
  // A shadow repo over the checkout's files (opencode/agy snapshots) commits only to itself; a reset there still rewrites files.
  const shadow = path.join(root, 'shadow.git');
  assert.equal(gitArgvViolation(['commit', '-m', 's'], opts({ env: { GIT_DIR: shadow, GIT_WORK_TREE: MAIN } })), null);
  assert.ok(gitArgvViolation(['reset', '--hard'], opts({ env: { GIT_DIR: shadow, GIT_WORK_TREE: MAIN } })));
  assert.ok(gitArgvViolation(['commit', '-m', 's'], opts({ cwd: WT, env: { GIT_DIR: path.join(MAIN, '.git'), GIT_WORK_TREE: WT } })),
    'a commit into the main repo from a worktree\'s files still moves the shared branch');
});

test('hook (findViolation) refuses the R17 shared-branch writes too: one classifier for both gates', () => {
  const env = { HOME: root };
  for (const cmd of ['git commit -m x', 'git commit -am x', 'git merge side', 'git rebase master', 'git pull --rebase',
    'git cherry-pick abc', 'git revert HEAD', 'git am x.patch', `cd ${WT} && git -C ${MAIN} merge side`]) {
    assert.ok(findViolation(cmd, { cwd: MAIN, env }), cmd);
    if (!cmd.includes(' -C ')) assert.equal(findViolation(cmd, { cwd: WT, env }), null, `${cmd} in the worktree`);
  }
  for (const cmd of ['git commit --dry-run', 'git merge-base a b', 'git log --merges', 'git reset --soft HEAD~1']) {
    assert.equal(findViolation(cmd, { cwd: MAIN, env }), null, cmd);
  }
});

test('leads keep current behavior: no shim, so a write in the main checkout runs', { skip: !posix }, () => {
  const before = head(MAIN);
  passed(run(MAIN, ['commit', '--allow-empty', '-m', 'lead commit'], leadEnv));
  assert.notEqual(head(MAIN), before);
});
