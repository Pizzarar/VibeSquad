// The server's runner /events tail must follow the runner across a restart on a new port, and must notice a stream that goes
// silent (heartbeats stop) without ever erroring, otherwise live chat updates stop until the VS server restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerClient } from "../server/backend/runner-client.mjs";

const fakeRunner = (frames, { silent = false } = {}) =>
  new Promise((resolve) => {
    const conns = new Set();
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": ok\n\n");
      if (!silent) for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      conns.add(res);
      res.on("close", () => conns.delete(res));
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({ port: srv.address().port, stop: () => { for (const c of conns) c.destroy(); srv.close(); } }),
    );
  });

const home = () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "vs-rc-"));
  fs.writeFileSync(path.join(h, "token"), "t");
  return h;
};
const point = (h, port) => fs.writeFileSync(path.join(h, "runner.json"), JSON.stringify({ port, pid: process.pid, startedAt: 1 }));
const until = async (fn, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) assert.fail("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("stream follows the runner to a new port after a restart", async () => {
  const h = home();
  const a = await fakeRunner([{ id: "rn-a", event: { seq: 1, type: "output" } }]);
  point(h, a.port);
  const got = [];
  const rc = new RunnerClient({ home: h });
  const s = rc.stream({ onMessage: (m) => got.push(m.event.seq), retryMs: 30 });
  await until(() => got.includes(1));
  a.stop();
  const b = await fakeRunner([{ id: "rn-a", event: { seq: 2, type: "output" } }]);
  point(h, b.port);
  await until(() => got.includes(2));
  s.close();
  b.stop();
});

test("stream reconnects when the runner goes silent without closing the socket", async () => {
  const h = home();
  const a = await fakeRunner([], { silent: true }); // opens, then never writes again: a half-open stream
  point(h, a.port);
  const got = [];
  const opens = [];
  const rc = new RunnerClient({ home: h });
  const s = rc.stream({ onMessage: (m) => got.push(m.event.seq), onOpen: () => opens.push(Date.now()), retryMs: 30, idleMs: 150 });
  await until(() => opens.length === 1);
  const b = await fakeRunner([{ id: "rn-a", event: { seq: 7, type: "output" } }]);
  point(h, b.port); // the silent stream's runner was replaced; only a watchdog notices
  await until(() => got.includes(7));
  s.close();
  a.stop();
  b.stop();
});
