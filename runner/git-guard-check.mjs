// The worker git shim's check (idea-888): runner/git-shim/git runs `node git-guard-check.mjs <git argv>` in git's cwd and
// env for argv that may be a write. Exit 0 = run the real git; exit 77 = refused (the reason is on stderr). Any other exit
// (an import error, a crash) is refused by the shim too, so a broken check never lets a write through.
import { gitArgvViolation, gitGuardRefusalText } from './git-guard.mjs';

const v = gitArgvViolation(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
if (v) {
  process.stderr.write(`${gitGuardRefusalText(v)}\n`);
  process.exitCode = 77;
}
