// forge-host A3: listenerPid fallback chain (lsof -> ss -> /proc/net/tcp + fd scan), all via injected exec/fs fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { posixListenerPid, parseSs, parseProcNetTcp } from "../server/listener-pid.mjs";
import { listenerPid } from "../scripts/restart-runtime.mjs";

const enoent = () => { const e = new Error("spawn ENOENT"); e.code = "ENOENT"; throw e; };
const PORT = 4180; // 0x1054
const HDR = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const row = (hexPort, st, inode) => `   0: 00000000:${hexPort} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
const procFs = (tcp, tcp6, links) => ({
  readFile: (p) => { if (p === "/proc/net/tcp") { if (tcp == null) throw new Error("ENOENT"); return tcp; } if (tcp6 == null) throw new Error("ENOENT"); return tcp6; },
  readdir: (p) => { if (p === "/proc") return ["self", "1", "77", "88"]; const m = /^\/proc\/(\d+)\/fd$/.exec(p); if (m && links[m[1]]) return Object.keys(links[m[1]]); throw new Error("EACCES"); },
  readlink: (p) => { const m = /^\/proc\/(\d+)\/fd\/(\w+)$/.exec(p); return links[m[1]][m[2]]; },
});

test("lsof hit", () => {
  const calls = [];
  const exec = (f, a) => { calls.push([f, ...a]); return "1234\n"; };
  assert.equal(posixListenerPid(PORT, { exec }), 1234);
  assert.deepEqual(calls, [["lsof", "-nP", "-iTCP:4180", "-sTCP:LISTEN", "-t"]]);
});

test("lsof missing -> ss hit", () => {
  const exec = (f, a) => { if (f === "lsof") enoent(); assert.deepEqual(a, ["-ltnpH", "sport = :4180"]); return 'LISTEN 0 511 0.0.0.0:4180 0.0.0.0:* users:(("node",pid=555,fd=19))\n'; };
  assert.equal(posixListenerPid(PORT, { exec }), 555);
});

test("lsof empty and timeout fall through to ss", () => {
  const ss = 'LISTEN 0 511 *:4180 *:* users:(("node",pid=9,fd=3))\n';
  assert.equal(posixListenerPid(PORT, { exec: (f) => (f === "lsof" ? "" : ss) }), 9);
  assert.equal(posixListenerPid(PORT, { exec: (f) => { if (f === "lsof") throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); return ss; } }), 9);
});

test("malformed ss line is ignored (falls to /proc)", () => {
  const exec = (f) => { if (f === "lsof") enoent(); return "garbage pid=notanumber\nLISTEN users:((pid=)\n"; };
  const fs = procFs(HDR + row("1054", "0A", "5555"), null, { 77: { 3: "socket:[5555]" } });
  assert.equal(posixListenerPid(PORT, { exec, ...fs }), 77);
  assert.equal(parseSs("junk\nLISTEN 0 1 *:4180 *:* users:((\"x\",pid=0,fd=1))\n", PORT), null);
});

test("ss row for another port is ignored", () => {
  assert.equal(parseSs('LISTEN 0 1 *:9999 *:* users:(("x",pid=42,fd=1))\n', PORT), null);
});

test("ss missing -> /proc/net/tcp hit", () => {
  const fs = procFs(HDR + row("1054", "0A", "5555"), HDR, { 77: { 3: "socket:[1]", 4: "socket:[5555]" }, 88: { 3: "socket:[9]" } });
  assert.equal(posixListenerPid(PORT, { exec: enoent, ...fs }), 77);
});

test("/proc/net/tcp6 hit; non-LISTEN and other ports ignored", () => {
  const tcp = HDR + row("1054", "01", "111") + row("1055", "0A", "222");
  const tcp6 = HDR + row("1054", "0A", "6666");
  const fs = procFs(tcp, tcp6, { 77: { 3: "socket:[111]", 4: "socket:[222]" }, 88: { 5: "socket:[6666]" } });
  assert.equal(posixListenerPid(PORT, { exec: enoent, ...fs }), 88);
  assert.deepEqual(parseProcNetTcp(tcp, PORT), []);
});

test("all missing -> null without throwing", () => {
  const boom = () => { throw new Error("nope"); };
  assert.equal(posixListenerPid(PORT, { exec: enoent, readFile: boom, readdir: boom, readlink: boom }), null);
  // inode found but no process owns it
  const fs = procFs(HDR + row("1054", "0A", "5555"), null, { 77: { 3: "socket:[1]" } });
  assert.equal(posixListenerPid(PORT, { exec: enoent, ...fs }), null);
  assert.equal(posixListenerPid(NaN, { exec: enoent }), null);
});

test("listenerPid: non-win delegates to the chain; win keeps netstat", () => {
  assert.equal(listenerPid(PORT, { win: false, posix: { exec: () => "321\n" } }), 321);
  assert.equal(listenerPid(PORT, { win: false, posix: { exec: enoent, readFile: enoent, readdir: enoent } }), null);
  // win32 path never reaches the injected posix exec
  let touched = false;
  listenerPid(PORT, { win: true, posix: { exec: () => { touched = true; return "1"; } } });
  assert.equal(touched, false);
});
