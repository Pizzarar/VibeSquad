// idea-767 worker main-checkout git guard: runner/git-guard.mjs + the --git-guard mode of runner/drain-hook.mjs, which
// adapters/claude.mjs installs as a PreToolUse hook for role=worker agents only. Real temp repos: a main checkout (.git
// directory), a linked worktree (.git gitfile) and a plain dir.
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { findViolation, gitGuardDecision, repoKind, tokenize } from '../runner/git-guard.mjs';
import { createClaudeAdapter, drainHookSettings, DRAIN_HOOK_SCRIPT, isWorkerAgent } from '../runner/adapters/claude.mjs';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vs-git-guard-')));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const MAIN = path.join(root, 'repo');
const WT = path.join(root, 'sanctuary', 'unit-x');
const PLAIN = path.join(root, 'plain');
mkdirSync(path.join(MAIN, 'src'), { recursive: true });
mkdirSync(PLAIN, { recursive: true });
git(MAIN, 'init', '-q', '-b', 'master');
git(MAIN, 'config', 'user.email', 't@example.com');
git(MAIN, 'config', 'user.name', 't');
writeFileSync(path.join(MAIN, 'src', 'a.ts'), 'a\n');
git(MAIN, 'add', '.');
git(MAIN, 'commit', '-q', '-m', 'init');
git(MAIN, 'worktree', 'add', '-q', '-b', 'unit-x', WT);
const env = { HOME: root, WT };

const bad = (cmd, cwd = MAIN, e = env) => {
  const v = findViolation(cmd, { cwd, env: e });
  assert.ok(v, `expected refusal: ${cmd} (cwd ${cwd})`);
  return v;
};
const ok = (cmd, cwd = MAIN, e = env) => assert.equal(findViolation(cmd, { cwd, env: e }), null, `expected pass: ${cmd} (cwd ${cwd})`);

test('repoKind: main checkout = .git directory, linked worktree = .git file, plain dir = none', () => {
  assert.deepEqual(repoKind(MAIN), { kind: 'main', root: MAIN });
  assert.deepEqual(repoKind(path.join(MAIN, 'src')), { kind: 'main', root: MAIN });
  assert.deepEqual(repoKind(WT), { kind: 'linked', root: WT });
  assert.deepEqual(repoKind(path.join(WT, 'src')), { kind: 'linked', root: WT });
  assert.equal(repoKind(PLAIN).kind, 'none');
});

test('destructive git in the main checkout is refused (cwd, subdir, every listed verb)', () => {
  for (const cmd of [
    'git reset --hard', 'git reset --hard HEAD~1', 'git reset --hard origin/master',
    'git checkout -- src/a.ts', 'git checkout .', 'git checkout HEAD -- .', 'git checkout -f master', 'git checkout src/a.ts',
    'git checkout HEAD~1 src/a.ts', 'git switch --discard-changes master', 'git switch -f master',
    'git clean -fd', 'git clean -fdx', 'git clean',
    'git stash', 'git stash -u', 'git stash push -m wip', 'git stash pop', 'git stash apply', 'git stash drop', 'git stash clear',
    'git restore src/a.ts', 'git restore .', 'git restore --staged --worktree .',
  ]) {
    const v = bad(cmd);
    assert.equal(v.root, MAIN);
    // from a subdir too (a relative path is relative to the cwd, as in git: src/a.ts from src/ matches nothing)
    bad(cmd.replace(/src\/a\.ts/, 'a.ts'), path.join(MAIN, 'src'));
  }
});

test('false positives: read-only git, checkout -b, branch switches, dry runs and --help pass in the main checkout', () => {
  for (const cmd of [
    'git status', 'git status --short', 'git diff', 'git log --oneline -5', 'git show HEAD', 'git rev-parse --show-toplevel',
    'git branch -a', 'git fetch origin', 'git worktree list', 'git reset', 'git reset --soft HEAD~1', 'git reset HEAD src/a.ts',
    'git checkout -b feat', 'git checkout -b feat origin/master', 'git checkout -B feat', 'git checkout master', 'git switch -c feat',
    'git switch master', 'git clean -n', 'git clean -nd', 'git clean --dry-run -fd', 'git stash list', 'git stash show -p',
    'git reset --help', 'git checkout -h', 'git log --grep="reset --hard"', 'echo "git reset --hard"', 'grep -r "git clean" docs',
    'ls', 'npm test', 'vs worktree create unit-x',
  ]) ok(cmd);
});

test('everything inside a linked worktree (or outside any repo) passes', () => {
  for (const cmd of ['git reset --hard', 'git checkout -- .', 'git clean -fdx', 'git stash', 'git stash pop', 'git restore .']) {
    ok(cmd, WT);
    ok(cmd, path.join(WT, 'src'));
    ok(cmd, PLAIN);
  }
});

test('cd X && git ..., git -C X and chained commands follow the directory', () => {
  // into the main checkout from a worktree
  bad(`cd ${MAIN} && git reset --hard`, WT);
  bad(`cd ${MAIN}; git clean -fd`, WT);
  bad(`git -C ${MAIN} reset --hard`, WT);
  bad(`git -C ${root} -C repo stash`, WT);
  bad('cd ../../repo && git checkout .', WT);
  bad(`git status && git reset --hard`);
  bad(`npm test || git stash`);
  bad(`git fetch\ngit reset --hard origin/master`);
  bad(`pushd ${MAIN} && git restore . && popd`, WT);
  bad(`(cd ${WT} && git status) && git reset --hard`, MAIN, env); // subshell cd does not leak out
  bad(`cd ${WT} | true; git reset --hard`); // a cd inside a pipeline runs in a subshell
  bad(`bash -c "cd ${MAIN} && git reset --hard"`, WT);
  bad(`sh -c 'git clean -fdx'`);
  bad(`eval git reset --hard`);
  bad(`echo $(git stash)`);
  bad(`FOO=1 git reset --hard`);
  bad(`env GIT_TRACE=1 git reset --hard`);
  bad(`/usr/bin/git reset --hard`);
  bad(`git --work-tree=${MAIN} --git-dir=${MAIN}/.git checkout -- .`, WT);
  bad(`git --git-dir=${MAIN}/.git stash`, WT);
  // and out of it into a worktree
  ok(`cd ${WT} && git reset --hard`);
  ok(`cd "${WT}" && pwd && git clean -fd`);
  ok(`git -C ${WT} reset --hard`);
  ok(`git -C "$WT" stash`);
  ok(`cd $WT && git checkout -- .`);
  ok(`D=${WT}; cd $D && git reset --hard`);
  ok(`cd ~/sanctuary/unit-x && git restore .`);
  ok(`(cd ${WT} && git reset --hard)`);
  ok(`cd ${WT} && git status; git log`);
});

test('an unresolvable directory fails closed for destructive git only', () => {
  const v = bad('cd "$(git rev-parse --show-toplevel)" && git reset --hard', WT);
  assert.equal(v.unresolved, true);
  bad('git -C "$NOPE" clean -fd', WT);
  bad('cd - && git stash', WT);
  ok('cd "$(git rev-parse --show-toplevel)" && git status', WT);
  ok('cd $NOPE && ls', WT);
});

// ---- review rn-95cd6f6c055e regressions ----

test('review #1: compound-command keywords and { } groups do not hide destructive git', () => {
  for (const cmd of [
    'if true; then git reset --hard; fi',
    'if git diff --quiet; then echo clean; else git stash; fi',
    'if false; then :; elif true; then git clean -fd; fi',
    'for x in 1; do git reset --hard; done',
    'while true; do git reset --hard; break; done',
    'until false; do git restore .; done',
    '{ git reset --hard; }',
    '{ echo hi; git checkout -- .; }',
    '! git reset --hard',
    'f() { git reset --hard; }; f',
    'case x in x) git stash;; esac',
    'if true\nthen\n  git reset --hard\nfi',
  ]) {
    bad(cmd);
    ok(cmd, WT); // the same lines inside a linked worktree still pass
  }
  ok('if git diff --quiet; then echo clean; fi');
  ok('for f in a b; do git log -1 -- $f; done');
  ok('find . -name "*.ts" -exec git log -1 {} \;');
  ok('git log --format={%h} -1');
  ok('{ git status; git diff; }');
});

test('review #2: $(...) and backtick bodies run in the dir the shell is in at that point', () => {
  // bypass: the substitution runs after cd into the main checkout
  bad(`cd ${MAIN} && echo $(git reset --hard)`, WT);
  bad(`cd ${MAIN} && echo \`git clean -fd\``, WT);
  bad(`cd ${MAIN}; X="$(git stash)"`, WT);
  // false refusal: the substitution runs after cd into the worktree
  ok(`cd ${WT} && echo $(git stash)`);
  ok(`cd ${WT} && echo \`git reset --hard\``);
  ok(`cd ${WT} && R="$(git checkout -- .)"`);
  // a substitution inside a cd target runs before that cd
  assert.equal(bad(`cd "$(git stash; echo ${WT})" && ls`).root, MAIN, 'the body runs in the main checkout, before the cd');
  ok(`cd "$(git stash; echo ${WT})" && ls`, WT);
  // a cd to a substitution is still unresolvable, so a destructive git after it fails closed (not the body's fault)
  assert.equal(bad(`cd "$(git status >/dev/null; echo ${WT})" && git reset --hard`).unresolved, true);
});

test('review #3: wrapper options that take a value are skipped; env -C / sudo -D move the target dir', () => {
  for (const cmd of [
    'env -u FOO git reset --hard', 'env --unset FOO git reset --hard', 'env --unset=FOO git stash', 'env -i PATH=/usr/bin git clean -fd',
    'sudo -u someone git reset --hard', 'sudo -u someone -g grp git restore .', 'sudo --user=x git reset --hard',
    'nice -n 5 git reset --hard', 'nice --adjustment 5 git stash', 'nice -10 git clean -fd',
    'timeout 30 git reset --hard', 'timeout -s KILL -k 5 30 git reset --hard', 'time -p git clean -fd', 'time git stash',
    'exec -a name git reset --hard', 'command git reset --hard', 'nohup git reset --hard',
    'env -S "git reset --hard"', 'env --split-string="GIT_TRACE=1 git stash"', 'env -- git reset --hard',
  ]) {
    bad(cmd);
    ok(cmd, WT);
  }
  bad(`env -C ${MAIN} git reset --hard`, WT);
  bad(`env --chdir=${MAIN} git stash`, WT);
  bad(`env -C ../../repo git clean -fd`, WT);
  bad(`sudo -D ${MAIN} git reset --hard`, WT);
  ok(`env -C ${WT} git reset --hard`);
  ok(`sudo --chdir ${WT} git checkout -- .`);
  bad(`env -C ${WT} true && git reset --hard`, MAIN, env); // env -C moves only the wrapped command
  bad('env -C "$(pwd)" git reset --hard', WT).unresolved === true || assert.fail('dynamic env -C fails closed');
});

test('review #4: GIT_WORK_TREE / GIT_DIR prefixes and exports point git at the main checkout', () => {
  bad(`GIT_WORK_TREE=${MAIN} GIT_DIR=${MAIN}/.git git checkout -- .`, WT);
  bad(`GIT_DIR=${MAIN}/.git git stash`, WT);
  bad(`env GIT_WORK_TREE=${MAIN} git reset --hard`, WT);
  bad(`export GIT_WORK_TREE=${MAIN}; git reset --hard`, WT);
  bad(`export GIT_DIR=${MAIN}/.git && git clean -fd`, WT);
  bad(`GIT_WORK_TREE="$NOPE" git reset --hard`, WT); // unresolvable: fails closed
  ok(`GIT_DIR=${WT}/.git git reset --hard`); // a linked worktree's gitfile
  ok(`GIT_WORK_TREE=${MAIN} git status`, WT);
  ok(`GIT_DIR=${MAIN}/.git true; git reset --hard`, WT); // a prefix on another command does not reach git
  ok(`GIT_WORK_TREE=${MAIN} git --work-tree=${WT} --git-dir=${WT}/.git reset --hard`, WT); // flags override the env
});

test('review #5: git -c k=v does not hide the subcommand', () => {
  bad('git -c core.pager=cat reset --hard');
  bad('git -c user.name=x -c user.email=y stash');
  bad(`git -c core.quotepath=off -C ${MAIN} clean -fd`, WT);
  ok(`git -c core.pager=cat -C ${WT} reset --hard`);
  ok('git -c core.pager=cat log -1');
  ok('git -c reset.hard=1 status');
});

test('tokenize: quotes, escapes, redirections and comments', () => {
  const words = (s) => tokenize(s, { env }).tokens.filter((t) => t.type === 'word').map((t) => t.text);
  assert.deepEqual(words(`git commit -m "a && b" 2>&1`), ['git', 'commit', '-m', 'a && b', '2>&1']);
  assert.deepEqual(words(`echo 'x;y' \\; z # git reset --hard`), ['echo', 'x;y', ';', 'z']);
  ok('git commit -m "reset --hard; git clean -fd"');
  ok('ls # git reset --hard');
  // heredoc bodies are data: a commit message or inbox note that mentions destructive git is not a command
  ok(`vs inbox add "$(cat <<'EOF'\nworker ran git reset --hard\ngit clean -fd\nEOF\n)"`);
  ok(`cat > notes.md <<EOF\ngit stash\nEOF\ngit status`);
  bad(`cat > notes.md <<-EOF\n\tgit status\n\tEOF\ngit reset --hard`);
});

test('gitGuardDecision: Bash and PowerShell only, refusal names vs worktree create + cd', () => {
  const why = gitGuardDecision({ tool_name: 'Bash', cwd: MAIN, tool_input: { command: 'git reset --hard' } }, { env });
  assert.match(why, /vs git-guard: refused `git reset --hard`/);
  assert.match(why, /MAIN checkout/);
  assert.match(why, /vs worktree create <unit>/);
  assert.match(why, /cd <the path it prints> && pwd/);
  assert.ok(why.includes(MAIN));
  assert.match(gitGuardDecision({ tool_name: 'PowerShell', cwd: WT, tool_input: { command: `Set-Location ${MAIN}; git clean -fd` } }, { env }), /refused/);
  assert.equal(gitGuardDecision({ tool_name: 'Read', cwd: MAIN, tool_input: { command: 'git reset --hard' } }, { env }), null);
  assert.equal(gitGuardDecision({ tool_name: 'Bash', cwd: WT, tool_input: { command: 'git reset --hard' } }, { env }), null);
  assert.equal(gitGuardDecision({ tool_name: 'Bash', cwd: MAIN, tool_input: {} }, { env }), null);
  const unres = gitGuardDecision({ tool_name: 'Bash', cwd: WT, tool_input: { command: 'git -C "$(pwd)/../x" reset --hard' } }, { env });
  assert.match(unres, /could not be resolved/);
  assert.match(unres, /vs worktree create <unit>/);
});

// ---- the hook process and its install ----
const runHook = (args, input) => spawnSync(process.execPath, [DRAIN_HOOK_SCRIPT, ...args], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: root } });
const call = (cwd, command) => ({ tool_name: 'Bash', cwd, tool_input: { command } });

test('drain-hook --git-guard: exit 2 + reason in the main checkout, 0 in a worktree; no flag = no guard', () => {
  const r = runHook(['-', '--git-guard'], call(MAIN, 'git reset --hard'));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /vs git-guard: refused/);
  assert.equal(runHook(['-', '--git-guard'], call(WT, 'git reset --hard')).status, 0);
  assert.equal(runHook(['-', '--git-guard'], call(MAIN, 'git status')).status, 0);
  assert.equal(runHook([path.join(root, 'no-drain.json'), '--git-guard'], call(MAIN, 'git checkout -b x')).status, 0);
  assert.equal(runHook([path.join(root, 'no-drain.json'), '--git-guard'], call(MAIN, 'git clean -fd')).status, 2);
  assert.equal(runHook([path.join(root, 'no-drain.json')], call(MAIN, 'git reset --hard')).status, 0, 'leads/Buddies: no --git-guard flag');
  // drain still works alongside the guard
  const drainFile = path.join(root, 'drain.json');
  writeFileSync(drainFile, JSON.stringify({ since: Date.now(), until: Date.now() + 60_000, reason: 'vs restart' }));
  const d = runHook([drainFile, '--git-guard'], { tool_name: 'Bash', cwd: WT, tool_input: { command: 'npm test', run_in_background: true } });
  assert.equal(d.status, 2);
  assert.match(d.stderr, /draining/);
  assert.equal(runHook([drainFile, '--git-guard'], call(MAIN, 'git stash')).status, 2);
  rmSync(drainFile);
  const bad = spawnSync(process.execPath, [DRAIN_HOOK_SCRIPT, '-', '--git-guard'], { input: 'not json', encoding: 'utf8', timeout: 10_000 });
  assert.equal(bad.status, 0, 'unparseable stdin fails open');
});

function fakeSpawn() {
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    impl.calls.push({ file, args, opts });
    return child;
  };
  impl.calls = [];
  return impl;
}
const hooksOf = (impl) => JSON.parse(impl.calls[0].args[impl.calls[0].args.indexOf('--settings') + 1]).hooks;

test('adapter: --git-guard only for role=worker (even without a drain path); leads and Buddies never get it', () => {
  assert.equal(isWorkerAgent({}, { VS_ROLE: 'worker' }), true);
  assert.equal(isWorkerAgent({ role: 'worker' }, {}), true);
  assert.equal(isWorkerAgent({ labels: { role: 'worker' } }), true);
  assert.equal(isWorkerAgent({ role: 'worker' }, { VS_ROLE: 'lead' }), false, 'the agent env (runner agentEnv) wins');
  for (const role of ['lead', 'brainstorm', 'former-lead', '']) assert.equal(isWorkerAgent({}, { VS_ROLE: role }), false);

  const start = (env, drainFile = null) => {
    const impl = fakeSpawn();
    createClaudeAdapter({ spawnImpl: impl, command: process.execPath, mcp: false, promptsDir: path.join(root, 'p'), drainFile })
      .start({ id: 'gg', cwd: os.tmpdir(), env, emit() {}, onExit() {} });
    return hooksOf(impl);
  };
  const drainFile = path.join(root, 'drain.json');
  const worker = start({ VS_ROLE: 'worker' }, drainFile).PreToolUse[0];
  assert.equal(worker.matcher, 'Bash|PowerShell');
  assert.match(worker.hooks[0].command, /^node .*drain-hook\.mjs .*drain\.json --git-guard$/);
  assert.match(start({ VS_ROLE: 'worker' }).PreToolUse[0].hooks[0].command, /^node .*drain-hook\.mjs - --git-guard$/);
  assert.match(start({ VS_ROLE: 'lead' }, drainFile).PreToolUse[0].hooks[0].command, /drain\.json"?$/);
  assert.equal(start({ VS_ROLE: 'brainstorm' }), undefined);

  // the installed command runs through a shell and refuses in the main checkout
  const cmd = drainHookSettings(drainFile, DRAIN_HOOK_SCRIPT, { gitGuard: true }).PreToolUse[0].hooks[0].command;
  const sh = (input) => spawnSync(cmd, { shell: true, input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000 });
  assert.equal(sh(call(MAIN, `git -C ${MAIN} reset --hard`)).status, 2);
  assert.equal(sh(call(WT, 'git reset --hard')).status, 0);
});
