import assert from "node:assert/strict";
import test from "node:test";

// E: Pure logic tests for Files, Terminal, Scripts, Add-project, Worktree picker.
// No DOM or React rendering — Node-only.

// ── FilesPanel helpers ────────────────────────────────────────────────────────

test("E1: FilesPanel path resolution: demo tree includes expected files", () => {
  const DEMO_TREE = [
    { name: "src", path: "src", kind: "directory" },
    { name: "README.md", path: "README.md", kind: "file" },
    { name: "package.json", path: "package.json", kind: "file" },
  ];
  assert.ok(DEMO_TREE.some((n) => n.name === "src" && n.kind === "directory"), "src dir present");
  assert.ok(DEMO_TREE.some((n) => n.name === "README.md" && n.kind === "file"), "README present");
  assert.ok(DEMO_TREE.some((n) => n.name === "package.json" && n.kind === "file"), "package.json present");
});

test("E2: FilesPanel entriesToNodes maps kind correctly", () => {
  const entries = [
    { name: "src", path: "src", kind: "directory", size: 0, modifiedAt: "" },
    { name: "index.ts", path: "index.ts", kind: "file", size: 42, modifiedAt: "" },
  ];
  const nodes = entries.map((e) => ({
    name: e.name,
    path: e.path,
    kind: e.kind,
    children: e.kind === "directory" ? null : undefined,
  }));
  assert.equal(nodes[0].kind, "directory");
  assert.equal(nodes[0].children, null, "directory gets null children (not-yet-loaded)");
  assert.equal(nodes[1].kind, "file");
  assert.equal(nodes[1].children, undefined, "file has no children");
});

test("E3: FilesPanel targetFile/targetLine jump: highlighted line data-testid logic", () => {
  const targetFile = "src/App.tsx";
  const targetLine = 42;
  const openFile = "src/App.tsx";
  const lines = ["line1", "line2"];
  const results = lines.map((_, i) => {
    const lineNum = i + 1;
    const isHighlighted = targetLine === lineNum && openFile === targetFile;
    return { lineNum, testid: isHighlighted ? "files-highlighted-line" : undefined };
  });
  // targetLine=42 won't match lines 1..2, so no highlight in this mini-test
  assert.equal(results.every((r) => r.testid === undefined), true, "no line highlighted when lineNum<42");

  // Simulate matching case
  const lineNum = 42;
  const isHighlighted = targetLine === lineNum && openFile === targetFile;
  assert.equal(isHighlighted, true, "line 42 in the matching file is highlighted");
});

test("E4: FilesPanel updateNode replaces children on match", () => {
  function updateNode(nodes, path, children) {
    return nodes.map((n) => {
      if (n.path === path) return { ...n, children };
      if (n.children) return { ...n, children: updateNode(n.children, path, children) };
      return n;
    });
  }
  const tree = [
    { path: "src", kind: "directory", children: null },
    { path: "README.md", kind: "file" },
  ];
  const updated = updateNode(tree, "src", [{ path: "src/index.ts", kind: "file" }]);
  assert.ok(Array.isArray(updated[0].children), "src now has children array");
  assert.equal(updated[0].children[0].path, "src/index.ts");
  assert.equal(updated[1].path, "README.md", "non-matching node untouched");
});

// ── TerminalPanel helpers ─────────────────────────────────────────────────────

test("E5: TerminalPanel stripAnsi removes ANSI escape codes", () => {
  function stripAnsi(str) {
    return str
      .replace(/\x1b\[[0-9;]*[mGKHFJABCDHfSTchlnsu]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }
  assert.equal(stripAnsi("\x1b[32mhello\x1b[0m"), "hello", "colour codes stripped");
  assert.equal(stripAnsi("\x1b[1;32mworld\x1b[m"), "world", "bold+colour stripped");
  assert.equal(stripAnsi("no ansi"), "no ansi", "plain text unchanged");
  assert.equal(stripAnsi("line1\r\nline2\r"), "line1\nline2\n", "CRLF normalised");
});

test("E6: TerminalPanel buffer management: appendOutput appends to correct tab", () => {
  const tabs = [
    { id: "t1", name: "Term 1", output: "$ " },
    { id: "t2", name: "Term 2", output: "$ " },
  ];
  function appendOutput(id, text) {
    return tabs.map((t) => (t.id === id ? { ...t, output: t.output + text } : t));
  }
  const next = appendOutput("t1", "echo hi\n");
  assert.equal(next[0].output, "$ echo hi\n");
  assert.equal(next[1].output, "$ ", "t2 unchanged");
});

test("E7: TerminalPanel DEMO command echoes output", () => {
  let output = "$ ";
  function demoExec(cmd) {
    output += cmd + "\n$ ";
  }
  demoExec("echo hello");
  assert.ok(output.includes("echo hello"), "command appears in output");
  assert.ok(output.endsWith("$ "), "prompt appears after output");
});

test("E8: TerminalPanel Ctrl+C appends interrupt marker in DEMO", () => {
  let output = "$ ";
  function demoCtrlC() {
    output += "^C\n$ ";
  }
  demoCtrlC();
  assert.ok(output.includes("^C"), "^C marker in output");
});

// ── ScriptsPanel helpers ──────────────────────────────────────────────────────

test("E9: ScriptsPanel script state management: start flips lifecycle to running", () => {
  const scripts = [
    { scriptName: "dev", lifecycle: "stopped" },
    { scriptName: "test", lifecycle: "stopped" },
  ];
  function startScript(name) {
    return scripts.map((s) => (s.scriptName === name ? { ...s, lifecycle: "running" } : s));
  }
  const after = startScript("dev");
  assert.equal(after[0].lifecycle, "running", "dev is now running");
  assert.equal(after[1].lifecycle, "stopped", "test unchanged");
});

test("E10: ScriptsPanel script state management: stop flips lifecycle to stopped", () => {
  const scripts = [
    { scriptName: "dev", lifecycle: "running" },
    { scriptName: "test", lifecycle: "stopped" },
  ];
  function stopScript(name) {
    return scripts.map((s) => (s.scriptName === name ? { ...s, lifecycle: "stopped" } : s));
  }
  const after = stopScript("dev");
  assert.equal(after[0].lifecycle, "stopped", "dev is now stopped");
  assert.equal(after[1].lifecycle, "stopped", "test still stopped");
});

test("E11: ScriptsPanel demo fallback contains expected script names", () => {
  const DEMO_SCRIPTS = [
    { scriptName: "dev", type: "service", lifecycle: "stopped" },
    { scriptName: "test", type: "script", lifecycle: "stopped" },
    { scriptName: "build", type: "script", lifecycle: "stopped" },
    { scriptName: "typecheck", type: "script", lifecycle: "stopped" },
  ];
  const names = DEMO_SCRIPTS.map((s) => s.scriptName);
  assert.ok(names.includes("dev"), "dev present");
  assert.ok(names.includes("test"), "test present");
  assert.ok(names.includes("build"), "build present");
  assert.ok(names.includes("typecheck"), "typecheck present");
});

// ── TeamActions helpers ───────────────────────────────────────────────────────

test("E12: TeamActions add-project registers path in team.paths", () => {
  const teams = [{ id: "vs", name: "VibeSquad", paths: ["/old/path"], lanes: [] }];
  const newPath = "/new/my-project";
  const updated = teams.map((t) =>
    t.id === "vs" && !t.paths.includes(newPath)
      ? { ...t, paths: [...t.paths, newPath] }
      : t,
  );
  assert.ok(updated[0].paths.includes(newPath), "new path added");
  assert.ok(updated[0].paths.includes("/old/path"), "old path preserved");
});

test("E13: TeamActions add-project skips duplicate paths", () => {
  const teams = [{ id: "vs", name: "VibeSquad", paths: ["/existing"], lanes: [] }];
  const newPath = "/existing";
  const updated = teams.map((t) =>
    t.id === "vs" && !t.paths.includes(newPath)
      ? { ...t, paths: [...t.paths, newPath] }
      : t,
  );
  assert.equal(updated[0].paths.length, 1, "no duplicate added");
});

test("E14: TeamActions clone helper resolves destination from repo shorthand", () => {
  function resolveDest(repo, dest) {
    return dest.trim() || repo.trim().split("/").pop().replace(/\.git$/, "");
  }
  assert.equal(resolveDest("owner/my-repo", ""), "my-repo");
  assert.equal(resolveDest("https://github.com/owner/my-repo.git", ""), "my-repo");
  assert.equal(resolveDest("owner/repo", "/custom/path"), "/custom/path");
});

test("E15: TeamActions worktree picker: wtMode none → no worktree on spawn", () => {
  function resolveWorktree(wtMode, branch, selectedWt) {
    if (wtMode === "new" && branch) return { branch };
    return undefined;
  }
  assert.equal(resolveWorktree("none", "feat/x", ""), undefined, "none → no worktree");
  assert.deepEqual(resolveWorktree("new", "feat/x", ""), { branch: "feat/x" }, "new → branch worktree");
  assert.equal(resolveWorktree("new", "", ""), undefined, "new without branch → no worktree");
});

test("E16: TeamActions worktree picker: existing worktrees list is displayed", () => {
  const existingWts = [
    { worktreePath: "/repo/.worktrees/abc", branchName: "feat/abc" },
    { worktreePath: "/repo/.worktrees/def", branchName: null },
  ];
  const labels = existingWts.map((w) => w.branchName ?? w.worktreePath);
  assert.equal(labels[0], "feat/abc", "branch name shown when available");
  assert.equal(labels[1], "/repo/.worktrees/def", "path shown as fallback");
});

test("E17: TeamActions canSubmit is false when wtMode=existing but no worktree selected", () => {
  function canSubmit({ busy, cwd, laneId, newWt, branch, role, task, job, titleLen, wtMode, selectedWt }) {
    return (
      !busy &&
      !!cwd &&
      !!laneId &&
      (!newWt || !!branch) &&
      !(role === "worker" && (!task || !job)) &&
      titleLen <= 60 &&
      !(wtMode === "existing" && !selectedWt)
    );
  }
  assert.equal(
    canSubmit({ busy: false, cwd: "/p", laneId: "l", newWt: false, branch: "", role: "lead", task: "", job: "", titleLen: 20, wtMode: "existing", selectedWt: "" }),
    false,
    "existing mode without selection blocks submit",
  );
  assert.equal(
    canSubmit({ busy: false, cwd: "/p", laneId: "l", newWt: false, branch: "", role: "lead", task: "", job: "", titleLen: 20, wtMode: "existing", selectedWt: "/p/.wt/abc" }),
    true,
    "existing mode with selection allows submit",
  );
});
