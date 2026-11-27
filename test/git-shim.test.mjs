// idea-888: the provider-neutral worker git gate. runner.mjs agentEnv puts runner/git-shim first on every role=worker
// agent's PATH (claude, agy/Gemini, opencode, Codex alike); its `git` refuses git writes in a repo's MAIN checkout through
// runner/git-guard-check.mjs (gitArgvViolation, the same classifier as the Claude PreToolUse hook) and execs the real git
// otherwise. Real temp repos: a main checkout (.git directory) with a linked worktree, driven through the real shim.
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv } from '../runner/runner.mjs';
import { applyGitShim, findViolation, GIT_GLOBAL_VALUE_OPTS, GIT_SAFE_BUILTINS, GIT_SHIM_DIR, GIT_SHIM_MARKER, GIT_SHIM_NODE_ENV, GIT_WRITE_VERBS, gitArgvViolation, isGitShimDir, scratchRootsOf, splitAlias } from '../runner/git-guard.mjs';

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
  // The suite may run inside a worker, whose PATH already holds the runtime shim copy: that one is dropped (idea-1167).
  const baseNoShim = base.PATH.split(':').filter((d) => d && !isGitShimDir(d)).join(':'); // production's rule (applyGitShim)
  assert.equal(workerEnv.PATH.split(':').slice(1).join(':'), baseNoShim, 'the rest of PATH is unchanged, minus inherited shims');
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
  for (const argv of [['status'], ['log'], ['checkout', 'side'], ['checkout', '-b', 'n'], ['reset'], ['reset', 'HEAD', 'a.txt'],
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
  for (const cmd of ['git commit --dry-run', 'git merge-base a b', 'git log --merges', 'git reset HEAD a.txt']) {
    assert.equal(findViolation(cmd, { cwd: MAIN, env }), null, cmd);
  }
});

test('leads keep current behavior: no shim, so a write in the main checkout runs', { skip: !posix }, () => {
  const before = head(MAIN);
  passed(run(MAIN, ['commit', '--allow-empty', '-m', 'lead commit'], leadEnv));
  assert.notEqual(head(MAIN), before);
});

// ---- idea-1167: every VibeSquad shim copy on the inherited PATH is dropped, not only this module's ----

/** A foreign shim copy (as ~/.vibesquad/runtime/runner/git-shim is to a source checkout): same file, another dir. */
const foreignShim = (() => {
  const d = path.join(root, 'runtime', 'runner', 'git-shim');
  mkdirSync(d, { recursive: true });
  copyFileSync(path.join(GIT_SHIM_DIR, 'git'), path.join(d, 'git'));
  chmodSync(path.join(d, 'git'), 0o755);
  return d;
})();
const realGitDir = posix ? path.dirname(execFileSync('sh', ['-c', 'command -v git'], {
  encoding: 'utf8', env: { ...base, PATH: base.PATH.split(':').filter((d) => !isGitShimDir(d)).join(':') } }).trim()) : null;

test('1167: the shim file carries the marker; isGitShimDir needs both the git-shim basename and the marker', { skip: !posix }, () => {
  assert.ok(readFileSync(path.join(GIT_SHIM_DIR, 'git'), 'utf8').slice(0, 512).includes(GIT_SHIM_MARKER));
  assert.equal(isGitShimDir(GIT_SHIM_DIR), true);
  assert.equal(isGitShimDir(foreignShim), true);
  assert.equal(isGitShimDir(foreignShim + '/'), true, 'trailing slash');
  assert.equal(isGitShimDir(realGitDir), false, 'the real git dir');
  // A marker-carrying git outside a git-shim dir is not stripped (path rule), nor is a git-shim dir with another git.
  const elsewhere = path.join(root, 'bin-with-copy');
  mkdirSync(elsewhere, { recursive: true });
  copyFileSync(path.join(GIT_SHIM_DIR, 'git'), path.join(elsewhere, 'git'));
  assert.equal(isGitShimDir(elsewhere), false);
  const userShim = path.join(root, 'user', 'git-shim');
  mkdirSync(userShim, { recursive: true });
  writeFileSync(path.join(userShim, 'git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
  assert.equal(isGitShimDir(userShim), false, 'a git-shim dir without the marker');
  const empty = path.join(root, 'empty', 'git-shim');
  mkdirSync(path.join(empty, 'git'), { recursive: true }); // `git` is a directory
  assert.equal(isGitShimDir(empty), false);
  assert.equal(isGitShimDir(path.join(root, 'missing', 'git-shim')), false);
  assert.equal(isGitShimDir(''), false);
});

test('1127T T2: isGitShimDir opens `git` once and checks that fd: dir, symlinks, FIFO and unreadable files', { skip: !posix }, () => {
  const mk = (name) => { const d = path.join(root, 't2', name, 'git-shim'); mkdirSync(d, { recursive: true }); return d; };
  const target = path.join(foreignShim, 'git');
  const linked = mk('link-to-shim'); // a symlinked shim is followed: it IS a shim
  symlinkSync(target, path.join(linked, 'git'));
  assert.equal(isGitShimDir(linked), true, 'symlink to a real shim');
  const linkedDir = mk('link-to-dir');
  mkdirSync(path.join(root, 't2', 'some-dir'), { recursive: true });
  symlinkSync(path.join(root, 't2', 'some-dir'), path.join(linkedDir, 'git'));
  assert.equal(isGitShimDir(linkedDir), false, 'symlink to a directory');
  const linkedOther = mk('link-to-other');
  symlinkSync('/bin/sh', path.join(linkedOther, 'git'));
  assert.equal(isGitShimDir(linkedOther), false, 'symlink to a file without the marker');
  const dangling = mk('dangling');
  symlinkSync(path.join(root, 't2', 'nowhere'), path.join(dangling, 'git'));
  assert.equal(isGitShimDir(dangling), false, 'dangling symlink');
  const fifo = mk('fifo');
  execFileSync('mkfifo', [path.join(fifo, 'git')]);
  assert.equal(isGitShimDir(fifo), false, 'a FIFO fails fast (O_NONBLOCK), never hangs the open');
  const unreadable = mk('unreadable');
  copyFileSync(target, path.join(unreadable, 'git'));
  chmodSync(path.join(unreadable, 'git'), 0o000);
  if (process.getuid?.() !== 0) assert.equal(isGitShimDir(unreadable), false, 'an unreadable shim file');
  chmodSync(path.join(unreadable, 'git'), 0o755);
  assert.equal(isGitShimDir(unreadable), true, 'the same file once readable');
});

test('1167: a lead (any non-worker role) whose PATH carries a FOREIGN shim copy gets none, and its main-checkout commit runs', { skip: !posix }, () => {
  const inherited = { ...base, PATH: [foreignShim, GIT_SHIM_DIR, ...base.PATH.split(':'), foreignShim].join(':') };
  for (const meta of [{ role: 'lead' }, { role: 'brainstorm' }, {}, { labels: { role: 'lead' } }]) {
    const e = agentEnv('rn-1167', meta, inherited);
    const dirs = e.PATH.split(':');
    assert.deepEqual(dirs.filter((d) => path.basename(path.resolve(d)) === 'git-shim'), [], `no shim for ${JSON.stringify(meta)}: ${e.PATH}`);
    assert.ok(dirs.includes(realGitDir), 'the real git dir is kept');
    assert.equal(e[GIT_SHIM_NODE_ENV], undefined);
  }
  const lead = agentEnv('rn-1167-lead', { role: 'lead' }, inherited);
  const before = head(MAIN);
  passed(run(MAIN, ['commit', '--allow-empty', '-m', 'lead commit under a foreign shim'], lead));
  assert.notEqual(head(MAIN), before);
});

test('1167: a worker with a foreign copy on PATH gets exactly one shim, its own, first, and is still gated', { skip: !posix }, () => {
  const inherited = { ...base, PATH: [foreignShim, ...base.PATH.split(':'), `${foreignShim}/`, GIT_SHIM_DIR].join(':') };
  const e = agentEnv('rn-1167-w', { role: 'worker' }, inherited);
  const dirs = e.PATH.split(':');
  assert.equal(dirs[0], GIT_SHIM_DIR);
  assert.deepEqual(dirs.filter((d) => isGitShimDir(d)), [GIT_SHIM_DIR]);
  assert.ok(dirs.includes(realGitDir));
  // Direct call with a foreign shimDir: that copy goes first, ours is dropped like any other inherited copy.
  const own = applyGitShim({ PATH: [GIT_SHIM_DIR, realGitDir, foreignShim].join(':') }, { worker: true, shimDir: foreignShim }).PATH.split(':');
  assert.deepEqual(own, [foreignShim, realGitDir]);
  const before = head(MAIN);
  refused(run(MAIN, ['commit', '--allow-empty', '-m', 'worker commit'], e));
  assert.equal(head(MAIN), before);
});

test('1167: non-shim dirs holding a `git` stay on PATH, in order', { skip: !posix }, () => {
  const userShim = path.join(root, 'user2', 'git-shim');
  mkdirSync(userShim, { recursive: true });
  writeFileSync(path.join(userShim, 'git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
  const elsewhere = path.join(root, 'bin-with-copy2');
  mkdirSync(elsewhere, { recursive: true });
  copyFileSync(path.join(GIT_SHIM_DIR, 'git'), path.join(elsewhere, 'git'));
  const PATH = [realGitDir, userShim, elsewhere, '/usr/bin', '/bin'].join(':');
  assert.equal(applyGitShim({ PATH }, { worker: false }).PATH, PATH);
  assert.equal(applyGitShim({ PATH }, { worker: true }).PATH, `${GIT_SHIM_DIR}:${PATH}`);
});

test('1167: win32 stays a no-op, even with shim dirs on PATH', () => {
  const w = { PATH: `${foreignShim}:/usr/bin`, Path: 'C:\\x', [GIT_SHIM_NODE_ENV]: 'n' };
  for (const worker of [true, false]) assert.deepEqual(applyGitShim({ ...w }, { worker, platform: 'win32' }), w);
});

// ---- Tier A review round 1 (rn-6a6782d25ddc): every finding, failing on 77f30d4c ----

const opts1 = (extra = {}) => ({ cwd: MAIN, env: { HOME: root }, scratchRoots: [], ...extra });

test('F1 (High): aliases cannot smuggle a write past the shim or the hook (inline -c, --config-env, config files, !shell)', { skip: !posix }, () => {
  writeFileSync(path.join(MAIN, 'a.txt'), 'dirty\n');
  const before = head(MAIN);
  // The headline: inline -c alias, through the real shim, leaves the dirty tree alone.
  refused(run(MAIN, ['-c', 'alias.x=reset', 'x', '--hard']));
  refused(run(MAIN, ['-c', 'alias.x=reset --hard', 'x']));
  refused(run(MAIN, ['-c', 'ALIAS.X=checkout', 'x', '--', 'a.txt'])); // config keys are case-insensitive
  refused(run(MAIN, ['--config-env=alias.x=VS_T_ALIAS', 'x', '--hard'], workerEnv, { VS_T_ALIAS: 'reset' }));
  refused(run(MAIN, ['--config-env', 'alias.x=VS_T_ALIAS', 'x', '--hard'], workerEnv, { VS_T_ALIAS: 'reset' }));
  refused(run(MAIN, ['x', '--hard'], workerEnv, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.x', GIT_CONFIG_VALUE_0: 'reset' }));
  refused(run(MAIN, ['-c', 'alias.y=-c core.pager=cat reset', 'y', '--hard'])); // an alias carrying global options
  refused(run(MAIN, ['-c', 'alias.y=x', '-c', 'alias.x=reset', 'y', '--hard'])); // alias of an alias
  refused(run(MAIN, ['-c', 'alias.x=!git reset --hard', 'x'])); // a !shell alias runs past the shim: refused in a main checkout
  // A config-file alias (global ~/.gitconfig here; repo config works the same way).
  writeFileSync(path.join(root, '.gitconfig'), '[alias]\n\tco = checkout\n\tnuke = reset --hard\n\tst = status\n');
  try {
    refused(run(MAIN, ['co', '--', 'a.txt']));
    refused(run(MAIN, ['nuke']));
    refused(run(WT, ['-C', MAIN, 'nuke']));
    passed(run(MAIN, ['st', '--short'])); // a read alias still runs
  } finally { rmSync(path.join(root, '.gitconfig'), { force: true }); }
  assert.equal(readFileSync(path.join(MAIN, 'a.txt'), 'utf8'), 'dirty\n');
  assert.equal(head(MAIN), before);
  // Reads stay reads; a builtin can never be aliased (git ignores alias.status); worktrees keep their writes.
  passed(run(MAIN, ['-c', 'alias.x=status', 'x', '--short']));
  passed(run(MAIN, ['-c', 'alias.status=reset --hard', 'status', '--short']));
  const wt = head(WT);
  passed(run(WT, ['-c', 'alias.x=commit', 'x', '--allow-empty', '-m', 'alias in wt']));
  assert.notEqual(head(WT), wt);
  // The same decisions on argv (shim) and on a command line (Claude hook).
  for (const argv of [['-c', 'alias.x=reset', 'x', '--hard'], ['-c', 'alias.x=!echo hi', 'x'], ['-c', 'alias.x="reset" --hard', 'x']]) {
    assert.equal(gitArgvViolation(argv, opts1())?.root, MAIN, argv.join(' '));
  }
  assert.equal(gitArgvViolation(['-c', 'alias.x=status', 'x'], opts1()), null);
  assert.equal(gitArgvViolation(['nosuchcmd'], opts1()), null, 'no alias, no builtin: not a write');
  assert.equal(gitArgvViolation(['-c', 'alias.x=reset', 'x', '--hard'], opts1({ cwd: WT })), null);
  for (const cmd of ['git -c alias.x=reset x --hard', "git -c 'alias.x=reset --hard' x", 'git -c alias.x=\'!git reset --hard\' x',
    `cd ${WT} && git -C ${MAIN} -c alias.x=reset x --hard`]) {
    assert.equal(findViolation(cmd, { cwd: MAIN, env: { HOME: root } })?.root, MAIN, cmd);
  }
  assert.equal(findViolation('git -c alias.x=reset x --hard', { cwd: WT, env: { HOME: root } }), null);
  assert.equal(findViolation('git -c alias.x=status x', { cwd: MAIN, env: { HOME: root } }), null);
  assert.equal(findViolation('git -c "$A" x --hard', { cwd: MAIN, env: { HOME: root } })?.root, MAIN, 'a dynamic -c fails closed');
  assert.deepEqual(splitAlias(`reset "--hard" 'a b' c\\ d`), ['reset', '--hard', 'a b', 'c d']);
  assert.equal(splitAlias('reset "open'), null);
});

test('F1: the shim fast path is only read builtins; anything alias-capable reaches the check (broken check -> refused)', { skip: !posix }, () => {
  const broken = { [GIT_SHIM_NODE_ENV]: path.join(root, 'no-such-node') };
  for (const args of [['-c', 'alias.x=reset', 'x', '--hard'], ['x'], ['--config-env=alias.x=HOME', 'x'], ['lfs', 'status']]) {
    assert.equal(run(MAIN, args, workerEnv, broken).status, 128, args.join(' '));
  }
  for (const args of [['status'], ['-c', 'core.pager=cat', 'log', '-1'], ['--no-pager', 'diff'], ['-C', MAIN, 'status'], ['--version'],
    ['-c', 'alias.status=reset', 'status']]) {
    passed(run(MAIN, args, workerEnv, broken)); // no node start
  }
  // The shim's three lists match git-guard.mjs exactly.
  const sh = readFileSync(path.join(GIT_SHIM_DIR, 'git'), 'utf8').replace(/\\\r?\n\s*/g, '');
  const casePat = (re) => sh.match(re)[1].split('|').filter(Boolean);
  assert.deepEqual(casePat(/\n\s*(-C\|[^)]*)\) skip=1/).sort(), [...GIT_GLOBAL_VALUE_OPTS].sort());
  assert.deepEqual(casePat(/\n\s*''\|([^)]*)\) fast=1/).sort(), [...GIT_SAFE_BUILTINS].sort());
  assert.deepEqual(casePat(/\n\s*(reset\|[^)]*)\) fast=; break/).sort(), [...GIT_WRITE_VERBS].sort());
});

test('F2 (Medium): a relative GIT_DIR / --git-dir resolves against the cwd, not the work tree', { skip: !posix }, () => {
  const before = head(MAIN);
  refused(run(MAIN, ['commit', '--allow-empty', '-m', 'x'], workerEnv, { GIT_DIR: '.git', GIT_WORK_TREE: WT }));
  refused(run(MAIN, ['--git-dir=.git', `--work-tree=${WT}`, 'commit', '--allow-empty', '-m', 'x']));
  refused(run(MAIN, ['--git-dir', '.git', '--work-tree', WT, 'commit', '--allow-empty', '-m', 'x']));
  assert.equal(head(MAIN), before);
  assert.ok(gitArgvViolation(['commit', '-m', 'x'], opts1({ env: { GIT_DIR: '.git', GIT_WORK_TREE: WT } })));
  assert.ok(findViolation(`GIT_DIR=.git GIT_WORK_TREE=${WT} git commit -m x`, { cwd: MAIN, env: { HOME: root } }));
  // A relative --git-dir naming the worktree's own git dir from elsewhere still passes.
  assert.equal(gitArgvViolation(['--git-dir', path.relative(PLAIN, WT_GITDIR), '--work-tree', WT, 'commit', '-m', 'x'], opts1({ cwd: PLAIN })), null);
});

test('F3 (Medium): --attr-source / --shallow-file take a value; the write verb after them is still seen', { skip: !posix }, () => {
  refused(run(MAIN, ['--attr-source', 'HEAD', 'reset', '--hard']));
  refused(run(MAIN, ['--shallow-file', path.join(root, 'none'), 'commit', '--allow-empty', '-m', 'x']));
  assert.ok(gitArgvViolation(['--attr-source', 'HEAD', 'reset', '--hard'], opts1()));
  assert.ok(gitArgvViolation(['--attr-source=HEAD', 'reset', '--hard'], opts1()));
  assert.ok(findViolation('git --attr-source HEAD reset --hard', { cwd: MAIN, env: { HOME: root } }));
});

test('F4 (Low): -h / --help / --dry-run count only as flags, never as an option value or after --', () => {
  for (const argv of [['commit', '-m', '-h'], ['commit', '-m', '--dry-run'], ['commit', '-am', '--dry-run'], ['commit', '--message', '--dry-run'],
    ['commit', '--mess', '--dry-run'], ['commit', '-F', '--dry-run'], ['clean', '-e', '-n', '-fd'], ['clean', '--exclude', '--dry-run', '-f'],
    ['commit', '-a', '--', '--dry-run'], ['reset', '--hard', '-h'], ['merge', 'side', '--help']]) {
    assert.ok(gitArgvViolation(argv, opts1()), argv.join(' '));
  }
  for (const argv of [['commit', '--dry-run', '-m', 'x'], ['commit', '-m', 'x', '--dry-run'], ['clean', '-e', 'x', '-n'], ['clean', '-fdn'],
    ['commit', '-h'], ['reset', '--help']]) {
    assert.equal(gitArgvViolation(argv, opts1()), null, argv.join(' '));
  }
  assert.ok(findViolation('git commit -m -h', { cwd: MAIN, env: { HOME: root } }));
});

test('F5 (Low): reset --merge/--keep/--soft and a branch-moving reset are refused; unstaging still passes', { skip: !posix }, () => {
  writeFileSync(path.join(MAIN, 'a.txt'), 'dirty\n');
  const before = head(MAIN);
  for (const args of [['reset', '--merge'], ['reset', '--keep', 'HEAD'], ['reset', '--soft', 'HEAD~0'], ['reset', 'side'], ['reset', '--mixed', 'side'],
    ['reset', '--ha'], ['reset', '--har', 'HEAD'], ['switch', '--disc', 'side'], ['checkout', '--forc', 'side']]) {
    refused(run(MAIN, args));
  }
  assert.equal(readFileSync(path.join(MAIN, 'a.txt'), 'utf8'), 'dirty\n');
  assert.equal(head(MAIN), before);
  git(MAIN, 'add', 'a.txt');
  for (const args of [['reset'], ['reset', '-q'], ['reset', 'a.txt'], ['reset', 'HEAD', 'a.txt'], ['reset', '--', 'a.txt'], ['reset', 'HEAD'], ['reset', '-p', '-h']]) {
    const r = run(MAIN, args);
    assert.doesNotMatch(r.stderr, /vs git-guard/, args.join(' '));
  }
  assert.ok(gitArgvViolation(['reset', '--soft', 'HEAD~1'], opts1()));
  assert.ok(gitArgvViolation(['reset', 'HEAD~1'], opts1()));
  assert.ok(findViolation('git reset --merge', { cwd: MAIN, env: { HOME: root } }));
  assert.equal(findViolation('git reset HEAD a.txt', { cwd: MAIN, env: { HOME: root } }), null);
  // A soft reset in a shadow repo over the checkout writes only the shadow repo.
  assert.equal(gitArgvViolation(['reset', '--soft', 'HEAD~1'], opts1({ env: { GIT_DIR: path.join(root, 'shadow.git'), GIT_WORK_TREE: MAIN } })), null);
});
