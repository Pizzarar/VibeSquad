// idea-419: forwarded worker reports (watch completion pings, the lane-log [done] relay, auto-forwarded reports) redact host
// paths token by token. The idea-249 error-text redactor used to swap every path-bearing report line for
// "request failed (detail names a host path; see the server log)", so reviews lost most of their findings.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const { redactHostPathTokens, redactHostPaths } = await import("../server/redact-host-paths.mjs");

// A fake project root with a space (the real home dir is a root too, so the fixtures avoid it except where noted).
const ROOT = String.raw`C:\Users\Jo Smith\projects\Proj`;
const opts = { repoRoots: [ROOT] };
const r = (text, o = opts) => redactHostPathTokens(text, o);

const home = os.homedir();
/** Any absolute host path form the redactor must never let through. */
function leaks(text) {
  const t = String(text);
  return (
    /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/.test(t) ||
    /file:\/\//i.test(t) ||
    /%(LOCALAPPDATA|APPDATA|USERPROFILE)%/i.test(t) ||
    /(?<![\w.~-])\/(?:home|Users)\/[^/\s]/i.test(t) ||
    /(?<![\w.~-])\/(?:mnt\/)?[a-z]\/Users\//i.test(t) ||
    /\\\\[A-Za-z0-9]/.test(t) ||
    t.toLowerCase().includes(home.toLowerCase()) ||
    t.toLowerCase().includes(home.replaceAll("\\", "/").toLowerCase()) ||
    /jo smith|jo%20smith/i.test(t)
  );
}

test("idea-419: a review report keeps every line; only the path tokens change", () => {
  const report = [
    "PASS H/M/L 0/1/2 f2d9ca8",
    "",
    "## Findings",
    String.raw`- **Medium** [server/foo.ts:12](file:///C:/Users/Jo%20Smith/AppData/Local/VibeSquad/worktrees/Proj/unit-x/server/foo.ts#L12): null deref when the lane has no lead.`,
    String.raw`- **Low** ` + "`" + String.raw`C:\Users\Jo Smith\projects\Proj\server\a.mjs:40` + "`" + ": the retry never backs off.",
    String.raw`- **Low** the log at C:\Users\Jo Smith\AppData\Local\VibeSquad\runner\agents\rn-1.jsonl shows the race.`,
    "Ran `npx tsx --test plugin/coordination-e2e.test.ts` from /c/Users/Jo Smith/projects/Proj: 41/41 pass.",
    "Live-Needs: server-restart",
  ].join("\n");
  const out = r(report);
  assert.equal(leaks(out), false, out);
  assert.doesNotMatch(out, /request failed|detail names a host path/);
  const lines = out.split("\n");
  assert.equal(lines.length, 8);
  assert.equal(lines[0], "PASS H/M/L 0/1/2 f2d9ca8");
  assert.equal(lines[2], "## Findings");
  assert.equal(lines[3], "- **Medium** [server/foo.ts:12](server/foo.ts#L12): null deref when the lane has no lead.");
  assert.equal(lines[4], "- **Low** `server/a.mjs:40`: the retry never backs off.");
  assert.equal(lines[5], "- **Low** the log at <host-path> shows the race.");
  assert.equal(lines[6], "Ran `npx tsx --test plugin/coordination-e2e.test.ts` from <repo-root>: 41/41 pass.");
  assert.equal(lines[7], "Live-Needs: server-restart");
});

test("idea-419: file:// markdown links into a worktree become repo-relative links", () => {
  const md = String.raw`See [vs.mjs](file:///C:/Users/Jo%20Smith/AppData/Local/VibeSquad/worktrees/VibeSquad/unit-redact-tokens/cli/vs.mjs:88) and [the dir](file:///C:/Users/Jo%20Smith/AppData/Local/VibeSquad/worktrees/VibeSquad/unit-redact-tokens).`;
  const out = r(md);
  assert.equal(out, "See [vs.mjs](cli/vs.mjs:88) and [the dir](<worktree:unit-redact-tokens>).");
  assert.equal(leaks(out), false);
});

test("idea-419: Windows, POSIX, Git-Bash, WSL, UNC, env-var and JSON-escaped paths are all swapped; punctuation stays", () => {
  const cases = [
    [String.raw`also D:\work\hidden\file.txt, then stop.`, "also <host-path>, then stop."],
    [String.raw`see D:/work/hidden/file.txt for more`, "see <host-path> for more"],
    ["posix /home/aub/src/x.js and /Users/aub/z.md here", "posix <host-path> and <host-path> here"],
    ["file:///home/aub/x.txt", "<host-path>"],
    ["git-bash /c/Users/Jo Smith/projects/Proj/test/a.test.mjs ok", "git-bash test/a.test.mjs ok"],
    ["wsl /mnt/c/Users/Jo Smith/projects/Proj/README.md ok", "wsl README.md ok"],
    [String.raw`share \\nas\share\stuff.txt ok`, "share <host-path> ok"],
    [String.raw`%LOCALAPPDATA%\VibeSquad\worktrees\VibeSquad\unit-y\cli\vs.mjs and %LOCALAPPDATA%\VibeSquad\runner`, "cli/vs.mjs and <host-path>"],
    [String.raw`json {"cwd":"C:\\Users\\Jo Smith\\projects\\Proj\\server"}`, String.raw`json {"cwd":"server"}`],
    [String.raw`root C:\Users\Jo Smith\projects\Proj done`, "root <repo-root> done"],
    ["upper C:/USERS/jo smith/Projects/proj/src/App.tsx", "upper src/App.tsx"],
  ];
  for (const [input, want] of cases) {
    const out = r(input);
    assert.equal(out, want, input);
    assert.equal(leaks(out), false, `${input} -> ${out}`);
  }
});

test("idea-419: text without a host path is returned unchanged", () => {
  const keep = [
    "https://github.com/Pizzarar/VibeSquad/blob/master/server/x.ts#L10 and http://localhost:6767/__vibesquad/status",
    "docs/Users/guide.md, src/home/page.tsx, a/b/c, and/or, w/ tests, 0/1/2, H/M/L, 3:2 ratio",
    "`vs status rn-1debc446477c` -- `npm test -- --queue` ~/notes.md ./server/x.mjs",
    "Live-Needs: build, frontend-reload",
    "",
  ];
  for (const t of keep) assert.equal(r(t), t);
  assert.equal(r(keep.join("\r\n")), keep.join("\r\n"), "line endings are kept");
});

test("idea-419: the real home dir is redacted; a repo root at or above home does not make home paths relative", () => {
  const under = path.join(home, "AppData", "Local", "secret", "x.txt");
  assert.equal(r(`log ${under} here`, { repoRoots: [home] }), "log <host-path> here");
  assert.equal(r(`log ${under} here`, { repoRoots: [path.dirname(home)] }), "log <host-path> here");
  const out = r(`file:///${under.replaceAll("\\", "/")} and \`${under}\``, { repoRoots: [] });
  assert.equal(leaks(out), false, out);
});

test("idea-419: the error-text behaviour for API errors is unchanged (head kept, the rest cut)", () => {
  const out = redactHostPaths({ error: String.raw`could not retire the old lead: EPERM, open 'C:\Users\Jo Smith\runner\agents.json'` });
  assert.equal(out.error, "could not retire the old lead (detail names a host path; see the server log)");
  assert.equal(redactHostPaths({ note: String.raw`C:\x\y failed` }).note, "request failed (detail names a host path; see the server log)");
});
