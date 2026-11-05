import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_SECRET_TTL_MS = 10 * 60 * 1000;
export const MIN_SECRET_TTL_MS = 10_000;
export const MAX_SECRET_TTL_MS = 60 * 60 * 1000;
export const MAX_SECRET_BYTES = 65_536;
export const SECRET_ID_RE = /^[a-f0-9]{16,32}$/;
export const SECRET_LABEL_RE = /^[a-zA-Z0-9_-]{1,32}$/;

let tmpSeq = 0;

export function resolveSecretsDir(secretsDir) {
  const custom = secretsDir || process.env.VIBESQUAD_SECRETS_DIR;
  if (custom) return resolve(custom);
  const home = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  return resolve(join(home, "secrets"));
}

/**
 * Sanitizes an optional user-provided label to a safe slug matching /^[a-zA-Z0-9_-]{1,32}$/,
 * stripping path traversal sequences and disallowing the secret value itself.
 */
export function sanitizeSecretLabel(label, secretValue = "") {
  if (typeof label !== "string") return "";
  const trimmed = label.trim();
  if (!trimmed) return "";
  if (typeof secretValue === "string" && secretValue && trimmed === secretValue.trim()) {
    return "";
  }
  // Remove path traversal dots/slashes and collapse invalid characters into underscores
  const cleaned = trimmed
    .replace(/\.+/g, "_")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 32)
    .replace(/[_-]+$/g, "");
  if (!cleaned || !SECRET_LABEL_RE.test(cleaned)) return "";
  return cleaned;
}

export function clampSecretTtlMs(ttlMs, minTtlMs = MIN_SECRET_TTL_MS, maxTtlMs = MAX_SECRET_TTL_MS) {
  const num = Number(ttlMs);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_SECRET_TTL_MS;
  return Math.min(maxTtlMs, Math.max(minTtlMs, Math.floor(num)));
}

export function formatSecretPromptToken(result) {
  const rawLabel = typeof result?.label === "string" ? result.label.trim() : "";
  const safeLabel = rawLabel.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const filePath = String(result?.path ?? "").trim();
  return `[Secret${safeLabel ? ` (${safeLabel})` : ""} stored at ${filePath} — read from file, do not echo content]`;
}

/**
 * Sweeps and deletes expired secret files in `secretsDir` older than `maxAgeMs`.
 */
export function purgeExpiredSecrets(secretsDir, maxAgeMs = DEFAULT_SECRET_TTL_MS, now = Date.now()) {
  const dir = resolveSecretsDir(secretsDir);
  if (!existsSync(dir)) return { purged: 0 };
  const threshold = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : DEFAULT_SECRET_TTL_MS;
  let purged = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".txt") && !entry.name.includes(".tmp-")) continue;
      const fullPath = join(dir, entry.name);
      try {
        const st = statSync(fullPath);
        if (now - st.mtimeMs >= threshold) {
          rmSync(fullPath, { force: true });
          purged++;
        }
      } catch {
        // Ignore race if file was already removed
      }
    }
  } catch {
    // Best-effort directory sweep
  }
  return { purged };
}

/**
 * Writes a sealed secret to `<secretsDir>/<id>.txt` with mode 0600 and schedules auto-purge.
 * Never logs or returns `value`.
 */
export function createSecretFile({
  value,
  label,
  ttlMs,
  secretsDir,
  minTtlMs = MIN_SECRET_TTL_MS,
} = {}) {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new Error("Secret value must be a non-empty string");
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_SECRET_BYTES) {
    throw new Error(`Secret value exceeds maximum size of ${MAX_SECRET_BYTES} bytes`);
  }

  const dir = resolveSecretsDir(secretsDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on Windows
  }

  purgeExpiredSecrets(dir, DEFAULT_SECRET_TTL_MS);

  const id = randomBytes(12).toString("hex");
  if (!SECRET_ID_RE.test(id)) {
    throw new Error("Failed to generate valid secret id");
  }
  const safeLabel = sanitizeSecretLabel(label, value);
  const effectiveTtlMs = clampSecretTtlMs(ttlMs, minTtlMs, MAX_SECRET_TTL_MS);
  const filePath = join(dir, `${id}.txt`);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;

  try {
    writeFileSync(tmpPath, value, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Best-effort on Windows
    }
    renameSync(tmpPath, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Best-effort on Windows
    }
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {}
    throw new Error("Failed to write sealed secret file");
  }

  const expiresAt = Date.now() + effectiveTtlMs;
  const timer = setTimeout(() => {
    try {
      rmSync(filePath, { force: true });
    } catch {}
  }, effectiveTtlMs);
  timer.unref?.();

  return {
    ok: true,
    id,
    path: filePath,
    label: safeLabel,
    expiresAt,
  };
}

function defaultReadBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_SECRET_BYTES * 2) {
        done = true;
        rejectBody(Object.assign(new Error("Payload too large"), { status: 413 }));
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (done) return;
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        rejectBody(new Error("Invalid JSON body"));
      }
    });
    req.on("error", rejectBody);
  });
}

function defaultSendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader?.("content-type", "application/json");
  res.setHeader?.("cache-control", "no-store, no-cache, must-revalidate");
  res.end(JSON.stringify(payload));
}

export async function handleSecretInputRequest(req, res, helpers = {}) {
  const send = helpers.sendJson || defaultSendJson;
  if (req.method !== "POST") {
    return send(res, 405, { ok: false, error: "method not allowed" });
  }
  if (typeof helpers.isOwner === "function" && !helpers.isOwner(req)) {
    return send(res, 403, { ok: false, error: "owner access required", readOnly: true });
  }
  try {
    const read = helpers.readBody || defaultReadBody;
    const body = await read(req);
    const result = createSecretFile({
      value: body?.value,
      label: body?.label,
      ttlMs: body?.ttlMs,
      secretsDir: helpers.secretsDir,
    });
    return send(res, 200, result);
  } catch (err) {
    const status = err?.status === 413 ? 413 : 400;
    return send(res, status, { ok: false, error: String(err?.message ?? "Invalid secret input") });
  }
}
