// R4-4: condenseReason keeps the cause visible when a Needs-you / Workers-tab reason truncates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { condenseReason } from "../src/condenseReason.ts";

test("URL + trailing cause: cause first, URL reduced to its host", () => {
  assert.equal(condenseReason('Post "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent": EOF'), "EOF · Post cloudcode-pa.googleapis.com");
});
test("a URL with no trailing cause is only shortened to the host", () => {
  assert.equal(condenseReason("fetch failed https://api.example.com/v1/x?y=1 timed out"), "fetch failed api.example.com timed out");
});
test("plain reasons pass through unchanged", () => {
  assert.equal(condenseReason("rate limited: slow down"), "rate limited: slow down");
  assert.equal(condenseReason("error"), "error");
  assert.equal(condenseReason(""), "");
});
test("the cause leads the condensed text", () => {
  const out = condenseReason('Get "http://10.0.0.1:8080/a/b/c": connection refused');
  assert.ok(out.startsWith("connection refused"), out);
  assert.ok(!out.includes("/a/b/c"), out);
});
