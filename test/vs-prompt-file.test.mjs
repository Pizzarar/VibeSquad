import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPromptInput } from "../cli/vs.mjs";

const BIG = "brief line with \"quotes\" and $vars\n".repeat(1500); // ~54k chars, over the 32,767 Windows command-line limit
const noStdin = () => assert.fail("stdin must not be read");

test("vs spawn --prompt-file <path> reads the brief from a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-pf-"));
  try {
    const f = join(dir, "brief.md");
    writeFileSync(f, BIG);
    const flags = loadPromptInput("spawn", { _: [], title: "t", profile: "p", promptFile: f }, noStdin);
    assert.equal(flags.prompt, BIG);
    assert.deepEqual(flags._, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vs spawn: --prompt-file -, --prompt - and a bare - all read stdin", () => {
  for (const f of [{ promptFile: "-" }, { prompt: "-" }, { _: ["-"] }]) {
    const flags = loadPromptInput("spawn", { _: [], profile: "p", ...f }, () => BIG);
    assert.equal(flags.prompt, BIG);
    assert.deepEqual(flags._, []);
  }
});

test("vs send <agent> --prompt-file / - / --prompt-file - put the text in the second positional", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-pf-"));
  try {
    const f = join(dir, "msg.md");
    writeFileSync(f, BIG);
    assert.deepEqual(loadPromptInput("send", { _: ["rn-a"], promptFile: f }, noStdin)._, ["rn-a", BIG]);
    assert.deepEqual(loadPromptInput("send", { _: ["rn-a", "-"] }, () => BIG)._, ["rn-a", BIG]);
    assert.deepEqual(loadPromptInput("send", { _: ["rn-a"], promptFile: "-" }, () => BIG)._, ["rn-a", BIG]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("inline text and other verbs are untouched; empty input is an error", () => {
  const inline = { _: ["rn-a", "hello"] };
  assert.deepEqual(loadPromptInput("send", inline, noStdin)._, ["rn-a", "hello"]);
  assert.equal(loadPromptInput("spawn", { _: [], prompt: "do it" }, noStdin).prompt, "do it");
  assert.deepEqual(loadPromptInput("status", { _: ["rn-a"] }, noStdin)._, ["rn-a"]);
  assert.throws(() => loadPromptInput("send", { _: ["rn-a", "-"] }, () => "  \n"), /empty/);
});
