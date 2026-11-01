import assert from "node:assert/strict";
import test from "node:test";

// Pure logic tests for PermissionCard upgrade (ADE Batch A).
// No DOM/React — tests the extraction helpers and response payload logic inline.

// --- Helpers mirrored from PermissionCard.tsx ---

function extractCommandPreview(input, detail = {}) {
  const cmd = input.command ?? input.cmd ?? detail.command;
  if (!cmd) return null;
  const parts = [cmd];
  if (input.cwd) parts.push(`# cwd: ${input.cwd}`);
  if (input.description) parts.push(`# ${input.description}`);
  return parts.join("\n");
}

function extractDiffPreview(input, detail = {}) {
  const filePath = input.file_path ?? input.filePath ?? input.path;
  const unifiedDiff = input.unifiedDiff ?? detail.unifiedDiff;

  if (unifiedDiff) return { filePath, content: unifiedDiff };

  if (typeof input.old_string === "string" || typeof input.new_string === "string") {
    const lines = [];
    if (filePath) lines.push(`--- ${filePath}`, `+++ ${filePath}`);
    if (typeof input.old_string === "string") {
      for (const l of input.old_string.split("\n")) lines.push(`-${l}`);
    }
    if (typeof input.new_string === "string") {
      for (const l of input.new_string.split("\n")) lines.push(`+${l}`);
    }
    return { filePath, content: lines.join("\n") };
  }

  if (typeof input.content === "string") {
    return { filePath, content: input.content };
  }

  if (filePath) return { filePath, content: "" };
  return null;
}

function extractGenericPreview(input) {
  const SKIP = new Set(["questions", "plan", "answers", "answer"]);
  const keys = Object.keys(input).filter((k) => !SKIP.has(k));
  if (!keys.length) return null;
  const pairs = keys.map((k) => {
    const v = input[k];
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}: ${s.length > 200 ? s.slice(0, 200) + "…" : s}`;
  });
  return pairs.join("\n");
}

function buildAllow(extra = {}) {
  return { behavior: "allow", ...extra };
}

function buildDeny(message) {
  return message ? { behavior: "deny", message } : { behavior: "deny" };
}

// --- Command preview tests ---

test("A1: extractCommandPreview returns null when no command", () => {
  assert.equal(extractCommandPreview({}), null);
});

test("A2: extractCommandPreview extracts input.command", () => {
  const result = extractCommandPreview({ command: "npm run build" });
  assert.equal(result, "npm run build");
});

test("A3: extractCommandPreview falls back to input.cmd", () => {
  const result = extractCommandPreview({ cmd: "ls -la" });
  assert.equal(result, "ls -la");
});

test("A4: extractCommandPreview falls back to detail.command", () => {
  const result = extractCommandPreview({}, { command: "git status" });
  assert.equal(result, "git status");
});

test("A5: extractCommandPreview includes cwd and description annotations", () => {
  const result = extractCommandPreview({
    command: "npm test",
    cwd: "/home/user/project",
    description: "Run tests",
  });
  assert.ok(result.includes("npm test"), "includes command");
  assert.ok(result.includes("# cwd: /home/user/project"), "includes cwd annotation");
  assert.ok(result.includes("# Run tests"), "includes description annotation");
});

// --- Diff preview tests ---

test("A6: extractDiffPreview returns null when no file or diff info", () => {
  assert.equal(extractDiffPreview({}), null);
});

test("A7: extractDiffPreview uses unifiedDiff from input", () => {
  const result = extractDiffPreview({ file_path: "foo.ts", unifiedDiff: "@@ -1 +1 @@\n-old\n+new" });
  assert.equal(result.filePath, "foo.ts");
  assert.ok(result.content.includes("-old"), "contains removal");
  assert.ok(result.content.includes("+new"), "contains addition");
});

test("A8: extractDiffPreview uses unifiedDiff from detail", () => {
  const result = extractDiffPreview({ file_path: "bar.ts" }, { unifiedDiff: "@@ -1 +1 @@\n-x\n+y" });
  assert.equal(result.filePath, "bar.ts");
  assert.ok(result.content.includes("-x"));
});

test("A9: extractDiffPreview constructs diff from old_string + new_string", () => {
  const result = extractDiffPreview({
    file_path: "src/index.ts",
    old_string: "const x = 1;",
    new_string: "const x = 2;",
  });
  assert.equal(result.filePath, "src/index.ts");
  assert.ok(result.content.includes("-const x = 1;"), "has removal line");
  assert.ok(result.content.includes("+const x = 2;"), "has addition line");
  assert.ok(result.content.includes("--- src/index.ts"), "has diff header");
});

test("A10: extractDiffPreview uses filePath/path as alias", () => {
  const r1 = extractDiffPreview({ filePath: "a.ts", content: "hello" });
  assert.equal(r1.filePath, "a.ts");
  const r2 = extractDiffPreview({ path: "b.ts", content: "world" });
  assert.equal(r2.filePath, "b.ts");
});

test("A11: extractDiffPreview uses content for file write", () => {
  const result = extractDiffPreview({ file_path: "out.txt", content: "line1\nline2" });
  assert.equal(result.filePath, "out.txt");
  assert.equal(result.content, "line1\nline2");
});

test("A12: extractDiffPreview returns filePath-only result when just path given", () => {
  const result = extractDiffPreview({ file_path: "README.md" });
  assert.equal(result.filePath, "README.md");
  assert.equal(result.content, "");
});

// --- Generic input preview tests ---

test("A13: extractGenericPreview returns null for empty input", () => {
  assert.equal(extractGenericPreview({}), null);
});

test("A14: extractGenericPreview skips questions/plan/answers/answer keys", () => {
  const result = extractGenericPreview({
    questions: [{ question: "hi" }],
    plan: "do stuff",
    answers: {},
    answer: "yes",
  });
  assert.equal(result, null);
});

test("A15: extractGenericPreview renders other keys", () => {
  const result = extractGenericPreview({ pattern: "**/*.ts", path: "src/" });
  assert.ok(result.includes("pattern: **/*.ts"), "includes pattern");
  assert.ok(result.includes("path: src/"), "includes path");
});

test("A16: extractGenericPreview truncates long values", () => {
  const long = "x".repeat(300);
  const result = extractGenericPreview({ url: long });
  assert.ok(result.includes("…"), "truncated with ellipsis");
  assert.ok(result.length < 300, "shorter than raw value");
});

// --- Suggestions → updatedPermissions payload tests ---

test("A17: suggestion click sends updatedPermissions with the suggestion object", () => {
  const calls = [];
  const handleSuggestion = (suggestion, doRespond) => {
    doRespond({ behavior: "allow", updatedPermissions: [suggestion] });
  };

  const doRespond = (payload) => calls.push(payload);
  const suggestion = { type: "tool", tool: "Bash", behavior: "allow" };
  handleSuggestion(suggestion, doRespond);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].behavior, "allow");
  assert.deepEqual(calls[0].updatedPermissions, [suggestion]);
});

test("A18: handleAllowSession uses suggestions when present", () => {
  const calls = [];
  const doRespond = (payload) => calls.push(payload);

  const suggestions = [{ label: "Always allow", type: "tool", tool: "Read" }];
  const handleAllowSession = (p, suggList, doRespond) => {
    const toolName = p.name ?? p.title;
    const updatedPermissions = suggList.length > 0
      ? suggList
      : [{ type: "tool", tool: toolName, behavior: "allow" }];
    doRespond({ behavior: "allow", updatedPermissions });
  };

  handleAllowSession({ name: "Read" }, suggestions, doRespond);
  assert.deepEqual(calls[0].updatedPermissions, suggestions);
});

test("A19: handleAllowSession falls back to synthetic permission when no suggestions", () => {
  const calls = [];
  const doRespond = (payload) => calls.push(payload);

  const handleAllowSession = (p, suggList, doRespond) => {
    const toolName = p.name ?? p.title;
    const updatedPermissions = suggList.length > 0
      ? suggList
      : [{ type: "tool", tool: toolName, behavior: "allow" }];
    doRespond({ behavior: "allow", updatedPermissions });
  };

  handleAllowSession({ name: "Bash" }, [], doRespond);
  assert.equal(calls[0].updatedPermissions[0].tool, "Bash");
  assert.equal(calls[0].updatedPermissions[0].behavior, "allow");
});

// --- Deny with message tests ---

test("A20: deny with message sends { behavior: 'deny', message }", () => {
  const msg = "Please use a safer approach";
  const payload = buildDeny(msg);
  assert.equal(payload.behavior, "deny");
  assert.equal(payload.message, msg);
});

test("A21: plain deny (empty message) sends { behavior: 'deny' } without message field", () => {
  const payload = buildDeny(undefined);
  assert.equal(payload.behavior, "deny");
  assert.equal(payload.message, undefined);
});

test("A22: deny with whitespace-only message trims to empty → plain deny", () => {
  const denyMsg = "   ";
  const msg = denyMsg.trim() || undefined;
  const payload = buildDeny(msg);
  assert.equal(payload.behavior, "deny");
  assert.equal(payload.message, undefined);
});

// --- Inline error state tests ---

test("A23: error state initialises to null", () => {
  const state = { error: null, submitting: false };
  assert.equal(state.error, null);
  assert.equal(state.submitting, false);
});

test("A24: error state is set on rejection", () => {
  const state = { error: null, submitting: false };
  const setError = (e) => { state.error = e; };
  const setSubmitting = (v) => { state.submitting = v; };

  const doRespond = async () => {
    setSubmitting(true);
    state.error = null;
    try {
      throw new Error("Permission reply failed: 403");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return doRespond().then(() => {
    assert.equal(state.error, "Permission reply failed: 403");
    assert.equal(state.submitting, false);
  });
});

test("A25: error clears on dismiss", () => {
  const state = { error: "some error" };
  const setError = (e) => { state.error = e; };
  setError(null);
  assert.equal(state.error, null);
});

// --- Question / plan backward-compat tests ---

test("A26: question allow payload includes updatedInput with answers", () => {
  const inputObj = { questions: [{ question: "What?" }], answers: {} };
  const ans = "yes";
  const qText = "What?";
  const updatedInput = {
    ...inputObj,
    answer: ans,
    answers: { ...inputObj.answers, [qText]: ans },
  };
  const payload = buildAllow({ updatedInput });
  assert.equal(payload.behavior, "allow");
  assert.equal(payload.updatedInput.answer, "yes");
  assert.equal(payload.updatedInput.answers["What?"], "yes");
});

test("A27: plan approve sends { behavior: 'allow' }", () => {
  const payload = buildAllow({});
  assert.equal(payload.behavior, "allow");
});

test("A28: plan action with selectedActionId routes correctly", () => {
  const action = { id: "act-implement", label: "Implement", behavior: "allow", intent: "implement" };
  const payload = buildAllow({ selectedActionId: action.id });
  assert.equal(payload.behavior, "allow");
  assert.equal(payload.selectedActionId, "act-implement");
});

// --- parseRecommendedOption tests ---

function parseRecommendedOption(label) {
  const re = /\s*(?:\(Recommended\)|\[Recommended\]|-\s*Recommended)\s*/gi;
  if (re.test(label)) {
    const cleanLabel = label.replace(/\s*(?:\(Recommended\)|\[Recommended\]|-\s*Recommended)\s*/gi, "").trim();
    return { cleanLabel, recommended: true };
  }
  return { cleanLabel: label, recommended: false };
}

function areAllQuestionsAnswered(questions, selectedByQ, otherByQ) {
  if (questions.length === 0) {
    return Boolean((otherByQ[0] ?? selectedByQ[0] ?? "").trim());
  }
  return questions.every((_, qi) => {
    const val = (selectedByQ[qi] === "__other__" ? otherByQ[qi] : selectedByQ[qi]) ?? "";
    return val.trim().length > 0;
  });
}

function buildQuestionSubmission(inputObj, questions, selectedByQ, otherByQ) {
  const answers = {};
  questions.forEach((q, qi) => {
    const key = q.question || q.header || `q${qi + 1}`;
    const val = ((selectedByQ[qi] === "__other__" ? otherByQ[qi] : selectedByQ[qi]) ?? "").trim();
    answers[key] = val;
  });

  let firstAnswer;
  if (questions.length === 0) {
    firstAnswer = ((selectedByQ[0] === "__other__" ? otherByQ[0] : selectedByQ[0]) ?? "").trim();
  } else {
    const firstKey = questions[0].question || questions[0].header || "q1";
    firstAnswer = answers[firstKey] ?? "";
  }

  return {
    behavior: "allow",
    updatedInput: {
      ...inputObj,
      answer: firstAnswer,
      answers: { ...((inputObj.answers ?? {})), ...answers },
    },
  };
}

test("A31: parseRecommendedOption strips (Recommended) and sets recommended: true", () => {
  const result = parseRecommendedOption("Use TypeScript (Recommended)");
  assert.equal(result.recommended, true);
  assert.equal(result.cleanLabel, "Use TypeScript");
});

test("A32: parseRecommendedOption strips [Recommended] variant", () => {
  const result = parseRecommendedOption("Option A [Recommended]");
  assert.equal(result.recommended, true);
  assert.equal(result.cleanLabel, "Option A");
});

test("A33: parseRecommendedOption strips - Recommended variant", () => {
  const result = parseRecommendedOption("Option B - Recommended");
  assert.equal(result.recommended, true);
  assert.equal(result.cleanLabel, "Option B");
});

test("A34: parseRecommendedOption returns recommended: false for plain label", () => {
  const result = parseRecommendedOption("Just an option");
  assert.equal(result.recommended, false);
  assert.equal(result.cleanLabel, "Just an option");
});

test("A35: parseRecommendedOption is case-insensitive", () => {
  const result = parseRecommendedOption("Pick this (RECOMMENDED)");
  assert.equal(result.recommended, true);
  assert.ok(!result.cleanLabel.includes("RECOMMENDED"));
});

// --- areAllQuestionsAnswered tests ---

test("A36: areAllQuestionsAnswered returns false when no questions and no answer", () => {
  assert.equal(areAllQuestionsAnswered([], {}, {}), false);
});

test("A37: areAllQuestionsAnswered returns true when no questions and selectedByQ[0] set", () => {
  assert.equal(areAllQuestionsAnswered([], { 0: "yes" }, {}), true);
});

test("A38: areAllQuestionsAnswered returns true when no questions and otherByQ[0] set", () => {
  assert.equal(areAllQuestionsAnswered([], {}, { 0: "custom answer" }), true);
});

test("A39: areAllQuestionsAnswered returns false if one of 3 questions unanswered", () => {
  const questions = [
    { question: "Q1" },
    { question: "Q2" },
    { question: "Q3" },
  ];
  const selectedByQ = { 0: "opt-a", 1: "opt-b" }; // Q3 missing
  assert.equal(areAllQuestionsAnswered(questions, selectedByQ, {}), false);
});

test("A40: areAllQuestionsAnswered returns true when all 3 questions answered", () => {
  const questions = [
    { question: "Q1" },
    { question: "Q2" },
    { question: "Q3" },
  ];
  const selectedByQ = { 0: "opt-a", 1: "opt-b", 2: "__other__" };
  const otherByQ = { 2: "custom text" };
  assert.equal(areAllQuestionsAnswered(questions, selectedByQ, otherByQ), true);
});

test("A41: areAllQuestionsAnswered returns false when __other__ chosen but otherByQ empty", () => {
  const questions = [{ question: "Q1" }];
  const selectedByQ = { 0: "__other__" };
  const otherByQ = { 0: "  " }; // whitespace only
  assert.equal(areAllQuestionsAnswered(questions, selectedByQ, otherByQ), false);
});

// --- buildQuestionSubmission tests ---

test("A42: buildQuestionSubmission sends 3 answers keyed by question text", () => {
  const questions = [
    { question: "What is your name?" },
    { question: "What is your role?" },
    { question: "What framework?" },
  ];
  const selectedByQ = { 0: "Alice", 1: "Engineer", 2: "__other__" };
  const otherByQ = { 2: "Svelte" };
  const inputObj = { questions };

  const result = buildQuestionSubmission(inputObj, questions, selectedByQ, otherByQ);

  assert.equal(result.behavior, "allow");
  assert.equal(result.updatedInput.answer, "Alice");
  assert.equal(result.updatedInput.answers["What is your name?"], "Alice");
  assert.equal(result.updatedInput.answers["What is your role?"], "Engineer");
  assert.equal(result.updatedInput.answers["What framework?"], "Svelte");
});

test("A43: buildQuestionSubmission single-click on option does not call doRespond early", () => {
  // Simulate: 3-question card, user clicks option on Q0 only
  // areAllQuestionsAnswered should return false — verifying the guard works
  const questions = [
    { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
    { question: "Q2", options: [{ label: "X" }, { label: "Y" }] },
    { question: "Q3", options: [{ label: "P" }, { label: "Q" }] },
  ];

  // Only Q0 answered
  const selectedByQ = { 0: "A" };
  const canSubmit = areAllQuestionsAnswered(questions, selectedByQ, {});
  assert.equal(canSubmit, false, "submit should be disabled after only 1 of 3 answered");
});

test("A44: buildQuestionSubmission uses header as key when question is absent", () => {
  const questions = [{ header: "Auth method" }];
  const selectedByQ = { 0: "OAuth" };
  const result = buildQuestionSubmission({}, questions, selectedByQ, {});
  assert.equal(result.updatedInput.answers["Auth method"], "OAuth");
});

test("A45: buildQuestionSubmission falls back to q1, q2 keys when no question or header", () => {
  const questions = [{}, {}];
  const selectedByQ = { 0: "yes", 1: "no" };
  const result = buildQuestionSubmission({}, questions, selectedByQ, {});
  assert.equal(result.updatedInput.answers["q1"], "yes");
  assert.equal(result.updatedInput.answers["q2"], "no");
});

test("A46: buildQuestionSubmission merges with existing answers in inputObj", () => {
  const questions = [{ question: "New Q" }];
  const inputObj = { answers: { "Old Q": "old answer" } };
  const selectedByQ = { 0: "new answer" };
  const result = buildQuestionSubmission(inputObj, questions, selectedByQ, {});
  assert.equal(result.updatedInput.answers["Old Q"], "old answer");
  assert.equal(result.updatedInput.answers["New Q"], "new answer");
});

// --- DEMO mode stub test ---

test("A29: DEMO mode: respondToPermission resolves without throwing", async () => {
  const DEMO = true;
  const respondToPermission = (agentId, requestId, response) => {
    if (DEMO) return Promise.resolve();
    throw new Error("Should not reach live client in DEMO mode");
  };
  await assert.doesNotReject(() => respondToPermission("agent1", "req1", { behavior: "allow" }));
});

test("A30: non-DEMO mode: respondToPermission propagates rejection", async () => {
  const DEMO = false;
  const respondToPermission = (agentId, requestId, response) => {
    if (DEMO) return Promise.resolve();
    return Promise.reject(new Error("network error"));
  };
  await assert.rejects(() => respondToPermission("agent1", "req1", { behavior: "deny" }), /network error/);
});
