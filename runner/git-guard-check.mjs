// The worker git shim's check (idea-888): runner/git-shim/git runs `node git-guard-check.mjs <git argv>` in git's cwd and
// env for argv that may be a write. Exit 0 = run the real git; exit 77 = refused (the reason is on stderr). Any other exit
// (an import error, a crash) is refused by the shim too, so a broken check never lets a write through.
import { gitArgvViolation, gitGuardRefusalText } from './git-guard.mjs';

// VS_GIT_REAL: the real git the shim found (alias lookups must not depend on PATH order); the shim always sets it.
const git = process.env.VS_GIT_REAL || 'git';
const env = { ...process.env };
delete env.VS_GIT_REAL; // judge (and look aliases up in) the env the real git will get
const v = gitArgvViolation(process.argv.slice(2), { cwd: process.cwd(), env, git });
if (v) {
  process.stderr.write(`${gitGuardRefusalText(v)}\n`);
  process.exitCode = 77;
}
