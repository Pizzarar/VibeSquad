import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SECRET_TTL_MS,
  MAX_SECRET_BYTES,
  MAX_SECRET_TTL_MS,
  MIN_SECRET_TTL_MS,
  SECRET_ID_RE,
  SECRET_LABEL_RE,
  clampSecretTtlMs,
  createSecretFile,
  formatSecretPromptToken,
  handleSecretInputRequest,
  purgeExpiredSecrets,
  sanitizeSecretLabel,
} from "../server/secret-input.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function withTempSecretsDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vs-secret-test-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    });
}

test("createSecretFile writes sealed file in secretsDir and never returns value", async () => {
  await withTempSecretsDir((secretsDir) => {
    const secretValue = "sk-live-super-secret-value-1234567890";
    const res = createSecretFile({
      value: secretValue,
      label: "OPENAI_API_KEY",
      secretsDir,
    });

    assert.equal(res.ok, true);
    assert.match(res.id, SECRET_ID_RE);
    assert.equal(res.label, "OPENAI_API_KEY");
    assert.equal(res.path, join(resolve(secretsDir), `${res.id}.txt`));
    assert.equal(typeof res.expiresAt, "number");
    assert.ok(res.expiresAt > Date.now());
    assert.equal("value" in res, false);
    assert.equal(JSON.stringify(res).includes(secretValue), false);

    assert.equal(existsSync(res.path), true);
    assert.equal(readFileSync(res.path, "utf8"), secretValue);
  });
});

test("createSecretFile validates empty and oversized values", async () => {
  await withTempSecretsDir((secretsDir) => {
    assert.throws(() => createSecretFile({ value: "", secretsDir }), /non-empty string/i);
    assert.throws(() => createSecretFile({ value: "   ", secretsDir }), /non-empty string/i);
    assert.throws(() => createSecretFile({ value: null, secretsDir }), /non-empty string/i);

    const exactMax = "a".repeat(MAX_SECRET_BYTES);
    const okRes = createSecretFile({ value: exactMax, secretsDir });
    assert.equal(okRes.ok, true);
    assert.equal(readFileSync(okRes.path, "utf8").length, MAX_SECRET_BYTES);

    const oversized = "a".repeat(MAX_SECRET_BYTES + 1);
    assert.throws(() => createSecretFile({ value: oversized, secretsDir }), /maximum size/i);
  });
});

test("sanitizeSecretLabel prevents path traversal and never leaks secret value", async () => {
  await withTempSecretsDir((secretsDir) => {
    const secretValue = "my-top-secret-password";
    const res = createSecretFile({
      value: secretValue,
      label: "../../etc/passwd",
      secretsDir,
    });

    assert.equal(dirname(res.path), resolve(secretsDir));
    assert.equal(res.path.includes(".."), false);
    assert.equal(res.path.includes("passwd"), false);
    assert.equal(res.label.includes(".."), false);
    assert.equal(res.label.includes("/"), false);
    assert.equal(res.label.includes("\\"), false);
    if (res.label) {
      assert.match(res.label, SECRET_LABEL_RE);
    }

    // If user accidentally pastes secret value into label, label is cleared
    assert.equal(sanitizeSecretLabel(secretValue, secretValue), "");
    assert.equal(sanitizeSecretLabel("..\\..\\windows\\system32"), "windows_system32");
    assert.equal(sanitizeSecretLabel("DB_PASS-01"), "DB_PASS-01");
  });
});

test("clampSecretTtlMs clamps between 10s and 60m with 10m default", () => {
  assert.equal(clampSecretTtlMs(undefined), DEFAULT_SECRET_TTL_MS);
  assert.equal(clampSecretTtlMs(null), DEFAULT_SECRET_TTL_MS);
  assert.equal(clampSecretTtlMs(-500), DEFAULT_SECRET_TTL_MS);
  assert.equal(clampSecretTtlMs(500), MIN_SECRET_TTL_MS);
  assert.equal(clampSecretTtlMs(120 * 60 * 1000), MAX_SECRET_TTL_MS);
  assert.equal(clampSecretTtlMs(60_000), 60_000);
});

test("auto-expiry deletes secret file after ttlMs and purgeExpiredSecrets sweeps stale files", async () => {
  await withTempSecretsDir(async (secretsDir) => {
    // 1. Test scheduled setTimeout deletion after ttlMs
    const res = createSecretFile({
      value: "ephemeral-secret",
      secretsDir,
      minTtlMs: 15,
      ttlMs: 30,
    });
    assert.equal(existsSync(res.path), true);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(existsSync(res.path), false);

    // 2. Test purgeExpiredSecrets sweeping leftover stale files from prior runs
    const staleFile = join(secretsDir, "deadbeef0123456789abcdef.txt");
    writeFileSync(staleFile, "old-secret", "utf8");
    const pastTime = new Date(Date.now() - DEFAULT_SECRET_TTL_MS - 60_000);
    utimesSync(staleFile, pastTime, pastTime);
    assert.equal(existsSync(staleFile), true);

    // Next createSecretFile automatically sweeps expired files
    const fresh = createSecretFile({
      value: "fresh-secret",
      secretsDir,
    });
    assert.equal(existsSync(staleFile), false);
    assert.equal(existsSync(fresh.path), true);

    // Direct call to purgeExpiredSecrets with custom maxAgeMs
    const sweep = purgeExpiredSecrets(secretsDir, 0, Date.now() + 1000);
    assert.ok(sweep.purged >= 1);
    assert.equal(existsSync(fresh.path), false);
  });
});

test("formatSecretPromptToken produces path reference token without secret value", () => {
  const secretValue = "ghp_verySecretGitHubTokenValue999";
  const withLabel = formatSecretPromptToken({
    path: "/home/user/.vibesquad/secrets/a1b2c3d4e5f60718293a4b5c.txt",
    label: "GITHUB_TOKEN",
  });
  assert.equal(
    withLabel,
    "[Secret (GITHUB_TOKEN) stored at /home/user/.vibesquad/secrets/a1b2c3d4e5f60718293a4b5c.txt — read from file, do not echo content]",
  );
  assert.equal(withLabel.includes(secretValue), false);

  const withoutLabel = formatSecretPromptToken({
    path: "/home/user/.vibesquad/secrets/a1b2c3d4e5f60718293a4b5c.txt",
  });
  assert.equal(
    withoutLabel,
    "[Secret stored at /home/user/.vibesquad/secrets/a1b2c3d4e5f60718293a4b5c.txt — read from file, do not echo content]",
  );
});

test("handleSecretInputRequest enforces POST and owner guard and returns sealed metadata", async () => {
  await withTempSecretsDir(async (secretsDir) => {
    const callHandler = async (method, bodyObj, isOwner = true) => {
      const req = new EventEmitter();
      req.method = method;
      let status = 200;
      let payload = null;
      const res = {
        setHeader() {},
        end(str) {
          payload = str ? JSON.parse(str) : null;
        },
        set statusCode(code) {
          status = code;
        },
        get statusCode() {
          return status;
        },
      };
      const promise = handleSecretInputRequest(req, res, {
        secretsDir,
        isOwner: () => isOwner,
      });
      if (bodyObj !== undefined) {
        req.emit("data", Buffer.from(JSON.stringify(bodyObj), "utf8"));
      }
      req.emit("end");
      await promise;
      return { status, payload };
    };

    const getRes = await callHandler("GET");
    assert.equal(getRes.status, 405);

    const unauthRes = await callHandler("POST", { value: "secret" }, false);
    assert.equal(unauthRes.status, 403);

    const emptyRes = await callHandler("POST", { value: "" }, true);
    assert.equal(emptyRes.status, 400);
    assert.equal(emptyRes.payload.ok, false);

    const secret = "super-confidential-token";
    const okRes = await callHandler("POST", { label: "API_TOKEN", value: secret }, true);
    assert.equal(okRes.status, 200);
    assert.equal(okRes.payload.ok, true);
    assert.equal(okRes.payload.label, "API_TOKEN");
    assert.equal("value" in okRes.payload, false);
    assert.equal(JSON.stringify(okRes.payload).includes(secret), false);
    assert.equal(readFileSync(okRes.payload.path, "utf8"), secret);
  });
});

test("route wiring in server/vibesquad-api.mjs and UI wiring in src/Composer.tsx & src/SecretInputPopover.tsx", () => {
  const apiSrc = readFileSync(join(REPO_ROOT, "server", "vibesquad-api.mjs"), "utf8");
  assert.ok(apiSrc.includes('import { handleSecretInputRequest } from "./secret-input.mjs"'));
  assert.ok(apiSrc.includes('case "/__vibesquad/secret-input":'));

  const popoverSrc = readFileSync(join(REPO_ROOT, "src", "SecretInputPopover.tsx"), "utf8");
  assert.ok(popoverSrc.includes("export function formatSecretPromptToken"));
  assert.ok(popoverSrc.includes("export function SecretInputPopover"));
  assert.ok(popoverSrc.includes("/__vibesquad/secret-input"));
  assert.ok(popoverSrc.includes("Written to a 0600 local file in ~/.vibesquad/secrets/ (auto-deleted in 10m). Only the file path is inserted into your prompt."));

  const composerSrc = readFileSync(join(REPO_ROOT, "src", "Composer.tsx"), "utf8");
  assert.ok(composerSrc.includes("SecretInputPopover"));
  assert.ok(composerSrc.includes('testid: "composer-secret-btn"'));
  assert.ok(composerSrc.includes('title: "Insert sealed secret (written to 0600 temp file, never shown in chat)"'));
  assert.ok(composerSrc.includes("🔒"));
});
