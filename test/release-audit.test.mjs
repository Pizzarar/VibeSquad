import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { formatTable, parseAddedLines, parseArgs, readZipEntries, recordAudit, runAudit, sweepText } from "../scripts/release-audit.mjs";

// Secret-shaped fixtures are assembled at runtime so this file never trips the repo's own sweep.
const FAKE_KEY = "-----BEGIN RSA PRIVATE" + " KEY-----";
const FAKE_PERSONAL = "zorblax-person-" + "7731";

function memFs(files) {
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  const keys = () => Object.keys(files);
  return {
    existsSync: (p) => norm(p) in files || keys().some((k) => k.startsWith(`${norm(p)}/`)),
    readFileSync: (p, enc) => { const v = files[norm(p)]; if (v === undefined) throw new Error(`ENOENT ${p}`); const b = Buffer.isBuffer(v) ? v : Buffer.from(v); return enc ? b.toString(enc) : b; },
    readdirSync: (p) => { const pre = `${norm(p).replace(/\/$/, "")}/`; return [...new Set(keys().filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split("/")[0]))]; },
    statSync: (p) => { const n = norm(p); const isFile = n in files; return { isDirectory: () => !isFile, isFile: () => isFile, size: isFile ? Buffer.byteLength(files[n]) : 0 }; },
  };
}

const ROOT = "/repo";
function gitExec({ tracked = {}, diff = "", names = "", dirty = "" } = {}) {
  return (cmd, args) => {
    if (cmd !== "git") { const e = new Error("not found"); e.code = "ENOENT"; throw e; }
    if (args[0] === "ls-files") return Object.keys(tracked).join("\0");
    if (args[0] === "diff" && args[1] === "--name-only") return names;
    if (args[0] === "diff") return diff;
    if (args[0] === "status") return dirty;
    if (args[0] === "grep") return "";
    if (args[0] === "show") return JSON.stringify({ plugins: { updater: { pubkey: "PK", endpoints: ["https://github.com/o/r/releases/latest/download/latest.json"] } } });
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const row = (checks, id) => checks.find((c) => c.id === id);

describe("release-audit", () => {
  test("parseArgs maps the documented flags", () => {
    const o = parseArgs(["--repo-root", "r", "--from", "v1", "--commit", "abc", "--artifacts", "a", "--record", "x.md", "--pubkey-config", "t.json", "--personal-patterns", "p.txt"]);
    assert.deepEqual(o, { repoRoot: "r", from: "v1", commit: "abc", artifacts: "a", record: "x.md", pubkeyConfig: "t.json", personalPatterns: "p.txt" });
    assert.throws(() => parseArgs(["--nope"]));
  });

  test("missing tools and pattern file are SKIP, never PASS", () => {
    const fs = memFs({ [`${ROOT}/a.txt`]: "hello", "/art/x.exe": "MZ", [`${ROOT}/src-tauri/runtime/r.txt`]: "ok" });
    const { checks } = runAudit({ repoRoot: ROOT, artifacts: "/art", personalPatterns: "/nope.txt" }, { fs, exec: gitExec({ tracked: { "a.txt": 1 } }), env: {} });
    assert.equal(row(checks, "B1").result, "SKIP");
    assert.match(row(checks, "B1").evidence, /gitleaks not installed/);
    assert.equal(row(checks, "B2").result, "SKIP");
    assert.match(row(checks, "B2").evidence, /7z not installed/);
    assert.match(row(checks, "B2").evidence, /no pattern file/);
    assert.equal(row(checks, "B5").result, "SKIP");
    assert.match(row(checks, "B5").evidence, /cargo audit not installed/);
    assert.equal(row(checks, "B3").result, "SKIP");
  });

  test("secret and personal hits are redacted and fail with High", () => {
    const fs = memFs({
      [`${ROOT}/leak.txt`]: `ok\nkey ${FAKE_KEY} here\n`,
      "/art/note.txt": `contact ${FAKE_PERSONAL} now\n`,
      "/pp.txt": `# c\n${FAKE_PERSONAL}\n`,
    });
    const { checks, table, exitCode } = runAudit({ repoRoot: ROOT, artifacts: "/art", personalPatterns: "/pp.txt" }, { fs, exec: gitExec({ tracked: { "leak.txt": 1 } }), env: {} });
    assert.equal(row(checks, "B1").result, "FAIL");
    assert.equal(row(checks, "B2").result, "FAIL");
    assert.match(row(checks, "B1").evidence, /S1×1 \[leak\.txt:2\]/);
    assert.match(row(checks, "B2").evidence, /P1×1 \[artifacts\/note\.txt:1\]/);
    assert.ok(!table.includes(FAKE_PERSONAL), "personal value leaked");
    assert.ok(!table.includes("PRIVATE"), "secret value leaked");
    assert.equal(exitCode, 1);
  });

  test("APK entries are swept via the built-in zip reader", () => {
    const name = Buffer.from("assets/x.txt");
    const data = Buffer.from(`line\nkey ${FAKE_KEY}\n`);
    const comp = deflateRawSync(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(30 + name.length + comp.length, 16);
    const zip = Buffer.concat([local, name, comp, cen, name, eocd]);
    assert.equal(readZipEntries(zip)[0].name, "assets/x.txt");
    const fs = memFs({ "/art/app.apk": zip });
    const { checks } = runAudit({ repoRoot: ROOT, artifacts: "/art", personalPatterns: "/nope" }, { fs, exec: gitExec(), env: {} });
    assert.equal(row(checks, "B2").result, "FAIL");
    assert.match(row(checks, "B2").evidence, /app\.apk!\/assets\/x\.txt:2/);
  });

  test("exit code is non-zero only for Critical/High FAIL", () => {
    const clean = memFs({ [`${ROOT}/a.txt`]: "fine" });
    const ok = runAudit({ repoRoot: ROOT }, { fs: clean, exec: gitExec({ tracked: { "a.txt": 1 } }), env: {} });
    assert.equal(ok.exitCode, 0);
    const bind = runAudit({ repoRoot: ROOT, from: "v1", commit: "abc" }, { fs: clean, exec: gitExec({ tracked: { "a.txt": 1 }, diff: "+++ b/server/s.mjs\n@@ -1 +1 @@\n+server.listen(80, \"0.0.0.0\");\n" }), env: {} });
    assert.equal(row(bind.checks, "B4").result, "FAIL");
    assert.equal(bind.exitCode, 1);
  });

  test("B7 fails on signature mismatch, B8 on stamp mismatch", () => {
    const conf = JSON.stringify({ version: "1.0.0", plugins: { updater: { pubkey: "PK", endpoints: ["https://github.com/o/r/releases/latest/download/latest.json"] } } });
    const files = {
      [`${ROOT}/src-tauri/tauri.conf.json`]: conf,
      [`${ROOT}/package.json`]: JSON.stringify({ version: "1.0.0" }),
      [`${ROOT}/src-tauri/runtime/build-stamp.json`]: JSON.stringify({ commit: "1111111" }),
      "/art/latest.json": JSON.stringify({ version: "1.0.0", platforms: { "windows-x86_64": { signature: "WRONG", url: "https://github.com/o/r/releases/download/v1/s.exe" } } }),
      "/art/s.exe.sig": "RIGHT\n",
    };
    const { checks, exitCode } = runAudit({ repoRoot: ROOT, from: "v0", commit: "2222222", artifacts: "/art", pubkeyConfig: "src-tauri/tauri.conf.json" }, { fs: memFs(files), exec: gitExec({ tracked: {} }), env: {} });
    assert.equal(row(checks, "B7").result, "FAIL");
    assert.equal(row(checks, "B7").severity, "Critical");
    assert.equal(row(checks, "B8").result, "FAIL");
    assert.equal(exitCode, 1);
  });

  test("sweepText / parseAddedLines report positions only", () => {
    assert.deepEqual(sweepText("a\nb sk-ABC\n", "f", [{ id: "X", re: /sk-[A-Z]/ }]), [{ file: "f", line: 2, id: "X" }]);
    assert.deepEqual(parseAddedLines("+++ b/f\n@@ -1,2 +5,2 @@\n ctx\n+new\n"), [{ file: "f", line: 6, text: "new" }]);
  });

  test("--record updates only the Audit section", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-rec-"));
    try {
      const p = join(dir, "rec.md");
      const before = "# T\n\n## Changelog\n\nkeep me\n\n## Audit\n\nold\n\n## Artifacts (SHA-256)\n\n- a: b\n";
      writeFileSync(p, before);
      const table = formatTable([{ id: "B1", name: "n", result: "SKIP", severity: "-", evidence: "e|x" }]);
      recordAudit(p, table);
      const after = readFileSync(p, "utf8");
      assert.match(after, /\| B1 \| n \| SKIP \| - \| e\\\|x \|/);
      assert.ok(after.includes("keep me") && after.includes("## Artifacts (SHA-256)\n\n- a: b"));
      assert.ok(!after.includes("\nold\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
