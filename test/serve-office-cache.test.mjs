import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const { sendFile } = await import("../server/serve.mjs");

test("office art revalidates with ETag/304; index.html stays no-store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-cache-"));
  mkdirSync(join(dir, "office"));
  const png = join(dir, "office", "x.png");
  const html = join(dir, "index.html");
  writeFileSync(png, "one");
  writeFileSync(html, "<html></html>");
  const srv = createServer((req, res) => sendFile(res, req.url === "/index.html" ? html : png, req));
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const a = await fetch(`${base}/office/x.png`);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("cache-control"), "no-cache");
    const etag = a.headers.get("etag");
    assert.ok(etag);
    assert.equal(await a.text(), "one");

    const b = await fetch(`${base}/office/x.png`, { headers: { "if-none-match": etag } });
    assert.equal(b.status, 304);
    assert.equal(await b.text(), "");

    writeFileSync(png, "three!");
    utimesSync(png, new Date(), new Date(Date.now() + 5000));
    const c = await fetch(`${base}/office/x.png`, { headers: { "if-none-match": etag } });
    assert.equal(c.status, 200);
    assert.notEqual(c.headers.get("etag"), etag);
    assert.equal(await c.text(), "three!");

    const h = await fetch(`${base}/index.html`);
    assert.match(h.headers.get("cache-control"), /no-store/);
    assert.equal(h.headers.get("etag"), null);
  } finally {
    srv.close();
  }
});
