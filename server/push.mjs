import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getBackend, runnerLanes, sharedRunnerBackend } from "./backend/index.mjs";
import { readPaseoConfig } from "./brainstorm.mjs";
import { readDaemonPassword, readPaseoLocalCredential } from "./daemon-password.mjs";
import { LEGACY_NEEDS_LABEL, clearConfigWarning, loadUserSettings, readJsonFileWithBom } from "./user-settings.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function vibesquadHome() {
  return process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
}

export function getVapidPath() {
  return join(vibesquadHome(), "vapid.json");
}

export function getPushSubsPath() {
  return join(vibesquadHome(), "push-subs.json");
}

export function toBase64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

export function fromBase64Url(str) {
  return Buffer.from(String(str ?? ""), "base64url");
}

/**
 * Generates or loads a P-256 VAPID keypair stored in `~/.vibesquad/vapid.json`.
 * `publicKey` is the 65-byte uncompressed P-256 point (`0x04 || x || y`) encoded as base64url.
 */
export function getOrCreateVapidKeys() {
  const file = getVapidPath();
  if (existsSync(file)) {
    const { value: parsed } = readJsonFileWithBom(file, { fallback: null, label: "vapid.json" });
    if (parsed?.publicKey && parsed?.jwk?.x && parsed?.jwk?.y && parsed?.jwk?.d) {
      return parsed;
    }
  }

  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const xBuf = fromBase64Url(jwk.x);
  const yBuf = fromBase64Url(jwk.y);
  const uncompressedPub = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);
  const record = {
    publicKey: toBase64Url(uncompressedPub),
    privateKey: jwk.d,
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      d: jwk.d,
    },
    subject: "mailto:vibesquad@localhost",
    createdAt: new Date().toISOString(),
  };

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  clearConfigWarning(file);
  return record;
}

/**
 * Creates a signed ES256 VAPID JWT and Authorization header for a push endpoint.
 */
export function buildVapidHeaders(endpoint, vapid = getOrCreateVapidKeys(), expSeconds = 12 * 3600) {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + expSeconds;
  const sub = vapid.subject || "mailto:vibesquad@localhost";

  const headerB64 = toBase64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payloadB64 = toBase64Url(JSON.stringify({ aud, exp, sub }));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privKey = crypto.createPrivateKey({ key: vapid.jwk, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: privKey,
    dsaEncoding: "ieee-p1363",
  });
  const token = `${signingInput}.${toBase64Url(sig)}`;

  return {
    token,
    authorization: `vapid t=${token}, k=${vapid.publicKey}`,
  };
}

function hkdfExtract(salt, ikm) {
  const key = salt && salt.length ? salt : Buffer.alloc(32, 0);
  return crypto.createHmac("sha256", key).update(ikm).digest();
}

function hkdfExpand(prk, info, length) {
  const out = [];
  let prev = Buffer.alloc(0);
  let counter = 1;
  let total = 0;
  while (total < length) {
    const hmac = crypto.createHmac("sha256", prk);
    hmac.update(prev);
    hmac.update(info);
    hmac.update(Buffer.from([counter]));
    prev = hmac.digest();
    out.push(prev);
    total += prev.length;
    counter += 1;
  }
  return Buffer.concat(out, total).subarray(0, length);
}

/**
 * Encrypts a UTF-8 or Buffer payload using RFC 8291 (`aes128gcm` content encoding, RFC 8188).
 */
export function encryptWebPushPayload(payload, subscriptionKeys, options = {}) {
  const plainBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""), "utf8");
  const uaPublic = fromBase64Url(subscriptionKeys.p256dh);
  const authSecret = fromBase64Url(subscriptionKeys.auth);

  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error(`Invalid p256dh key length (${uaPublic.length}, expected 65-byte uncompressed P-256 key)`);
  }
  if (authSecret.length < 16) {
    throw new Error(`Invalid auth secret length (${authSecret.length}, expected >= 16 bytes)`);
  }

  const ecdh = crypto.createECDH("prime256v1");
  if (options.asPrivateKey) {
    ecdh.setPrivateKey(options.asPrivateKey);
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = options.salt ? Buffer.from(options.salt) : crypto.randomBytes(16);

  // RFC 8291 Section 3.3 / 3.4: Combine ECDH shared secret with auth secret
  const prkKey = hkdfExtract(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "ascii"), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  // RFC 8188 Section 2.2 / 2.3: Derive 16-byte CEK and 12-byte nonce
  const prk = hkdfExtract(salt, ikm);
  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "ascii");
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "ascii");
  const cek = hkdfExpand(prk, cekInfo, 16);
  const nonce = hkdfExpand(prk, nonceInfo, 12);

  // Final record delimiter 0x02
  const padded = Buffer.concat([plainBuf, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 Section 2.1 header: salt (16) || rs (4, uint32BE) || idlen (1, uint8) || keyid (65)
  const recordSize = options.recordSize ?? 4096;
  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0, 0, 16);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return {
    body: Buffer.concat([header, ciphertext]),
    salt,
    asPublic,
    cek,
    nonce,
  };
}

/**
 * Decrypts an RFC 8291 `aes128gcm` payload (used by tests to verify round-trip fidelity).
 */
export function decryptWebPushPayload(encryptedBody, uaEcdh, authSecretInput) {
  const buf = Buffer.isBuffer(encryptedBody) ? encryptedBody : Buffer.from(encryptedBody);
  const authSecret = Buffer.isBuffer(authSecretInput) ? authSecretInput : fromBase64Url(authSecretInput);
  const salt = buf.subarray(0, 16);
  const idlen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idlen);
  const ciphertextAndTag = buf.subarray(21 + idlen);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);

  const uaPublic = uaEcdh.getPublicKey();
  const ecdhSecret = uaEcdh.computeSecret(asPublic);

  const prkKey = hkdfExtract(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "ascii"), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12);

  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(authTag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0x00) end -= 1;
  if (end < 0 || padded[end] !== 0x02) {
    throw new Error("Invalid RFC 8188 padding delimiter");
  }
  return padded.subarray(0, end).toString("utf8");
}

export function readPushSubscriptions() {
  const file = getPushSubsPath();
  if (!existsSync(file)) return [];
  const { value: parsed } = readJsonFileWithBom(file, { fallback: [], label: "push-subs.json" });
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
  return list.filter((s) => s && typeof s.endpoint === "string" && (isDesktopSubscription(s) || (s.keys?.p256dh && s.keys?.auth)));
}

export const DESKTOP_ENDPOINT = "desktop://local";

export function isDesktopSubscription(s) {
  return s?.type === "desktop" && s?.endpoint === DESKTOP_ENDPOINT;
}

export function writePushSubscriptions(subs) {
  const file = getPushSubsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(subs, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  clearConfigWarning(file);
  return subs;
}

function isPrivateHost(rawHost) {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::" || host.startsWith("::ffff:")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return !host.includes(".");
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// Endpoints come from the client; fetch() to them must not reach loopback, LAN or metadata addresses.
function assertPublicHttpsEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("PushSubscription endpoint is not a valid URL");
  }
  if (url.protocol !== "https:" || isPrivateHost(url.hostname)) {
    throw new Error("PushSubscription endpoint must be a public https URL");
  }
}

function saveDesktopSubscription(sub) {
  const now = new Date().toISOString();
  const existing = readPushSubscriptions();
  const idx = existing.findIndex((s) => s.endpoint === DESKTOP_ENDPOINT);
  const entry = {
    endpoint: DESKTOP_ENDPOINT,
    type: "desktop",
    deviceName: String(sub.deviceName || "Windows · VibeSquad App").slice(0, 120),
    createdAt: idx >= 0 ? existing[idx].createdAt : now,
    updatedAt: now,
  };
  if (idx >= 0) existing[idx] = entry;
  else existing.push(entry);
  writePushSubscriptions(existing);
  return { ok: true, type: "desktop", subCount: existing.length, count: existing.length, subscription: entry };
}

export function savePushSubscription(input) {
  const sub = input?.subscription ?? input;
  if (sub?.type === "desktop" || sub?.endpoint === DESKTOP_ENDPOINT) {
    if (sub.type !== "desktop" || sub.endpoint !== DESKTOP_ENDPOINT) {
      throw new Error('Desktop subscription requires type "desktop" and endpoint "desktop://local"');
    }
    return saveDesktopSubscription(sub);
  }
  const endpoint = String(sub?.endpoint ?? "").trim();
  const p256dh = String(sub?.keys?.p256dh ?? "").trim();
  const auth = String(sub?.keys?.auth ?? "").trim();
  if (!endpoint || !p256dh || !auth) {
    throw new Error("PushSubscription requires endpoint, keys.p256dh, and keys.auth");
  }
  assertPublicHttpsEndpoint(endpoint);

  const now = new Date().toISOString();
  const existing = readPushSubscriptions();
  const idx = existing.findIndex((s) => s.endpoint === endpoint);
  const entry = {
    endpoint,
    keys: { p256dh, auth },
    type: "webpush",
    ...(sub.deviceName ? { deviceName: String(sub.deviceName).slice(0, 120) } : {}),
    ...(sub.userAgent ? { userAgent: String(sub.userAgent).slice(0, 300) } : {}),
    expirationTime: sub.expirationTime ?? null,
    createdAt: idx >= 0 ? existing[idx].createdAt : now,
    updatedAt: now,
  };
  if (idx >= 0) existing[idx] = entry;
  else existing.push(entry);
  writePushSubscriptions(existing);
  return { ok: true, type: "webpush", count: existing.length, subCount: existing.length, subscription: entry };
}

export function removePushSubscription(endpointInput) {
  const endpoint = String(endpointInput?.endpoint ?? endpointInput ?? "").trim();
  const existing = readPushSubscriptions();
  const next = endpoint ? existing.filter((s) => s.endpoint !== endpoint) : [];
  const removed = existing.length - next.length;
  writePushSubscriptions(next);
  return { ok: true, removed, subCount: next.length };
}

export async function sendWebPushToSubscription(sub, payloadObj, vapid = getOrCreateVapidKeys()) {
  const jsonPayload = typeof payloadObj === "string" ? payloadObj : JSON.stringify(payloadObj);
  const { body } = encryptWebPushPayload(jsonPayload, sub.keys);
  const { authorization } = buildVapidHeaders(sub.endpoint, vapid);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "Content-Length": String(body.length),
      TTL: "86400",
      Urgency: "high",
      Authorization: authorization,
    },
    body,
  });

  if (res.status === 404 || res.status === 410) {
    removePushSubscription(sub.endpoint);
  }
  if (!res.ok) {
    throw new Error(`Push relay HTTP ${res.status}`);
  }
  return { status: res.status };
}

export async function broadcastWebPush(payloadObj) {
  const all = readPushSubscriptions();
  // Desktop subscriptions are served by the Tauri shell's native toasts, not by HTTP Web Push.
  const subs = all.filter((s) => s.keys?.p256dh && s.keys?.auth);
  const vapid = getOrCreateVapidKeys();
  let sent = 0;
  let failed = 0;
  const errors = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await sendWebPushToSubscription(sub, payloadObj, vapid);
        sent += 1;
      } catch (err) {
        failed += 1;
        errors.push(String(err?.message ?? err));
      }
    }),
  );

  return {
    ok: true,
    sent,
    failed,
    subCount: all.length,
    total: all.length,
    webPushCount: subs.length,
    desktopSubscribed: all.some(isDesktopSubscription),
    payload: payloadObj,
    ...(errors.length ? { errors } : {}),
  };
}

export async function sendTestPush(overrides = {}) {
  const payload = {
    title: overrides.title || "VibeSquad · Test Alert",
    body: overrides.body || "Lock-screen Web Push is active.",
    url: overrides.url || "/?focus=needs-you",
    tag: overrides.tag || "vs-test-push",
    kind: overrides.kind || "permission",
    ...(overrides.agentId ? { agentId: overrides.agentId } : {}),
  };
  return broadcastWebPush(payload);
}

const PUSH_KIND_PREF = { permission: "permission", "needs-you": "needsYou", [LEGACY_NEEDS_LABEL]: "needsYou", finished: "finished", error: "errored" };

/** Settings › Notifications per-event toggles: false skips that kind. Missing/unknown = send. */
export function pushKindEnabled(kind, pushEvents = loadUserSettings().pushEvents) {
  const key = PUSH_KIND_PREF[kind];
  return !key || pushEvents?.[key] !== false;
}

/**
 * Pure transition detector for Paseo daemon agent updates.
 * Deduplicates per `(agentId, eventKey)` using `dedupeSet`.
 */
export function evaluateAgentTransition(prev, next, dedupeSet) {
  const notifications = [];
  if (!next || !next.id || next.archivedAt) return notifications;
  const agentId = String(next.id);
  const title = String(next.title || agentId.slice(0, 8));
  const labels = next.labels ?? {};
  const prevLabels = prev?.labels ?? {};
  const role = String(labels.role || "");
  const deepUrl = `/?agent=${encodeURIComponent(agentId)}&focus=needs-you`;

  const emitOnce = (eventKey, note) => {
    const fullKey = `${agentId}::${eventKey}`;
    if (dedupeSet.has(fullKey)) return;
    dedupeSet.add(fullKey);
    notifications.push(note);
  };

  // 1. New pendingPermissions on any agent
  const perms = Array.isArray(next.pendingPermissions) ? next.pendingPermissions : [];
  const prevPermIds = new Set(
    (Array.isArray(prev?.pendingPermissions) ? prev.pendingPermissions : []).map((p) => String(p?.id ?? p?.requestId ?? "")),
  );
  for (const p of perms) {
    const pid = String(p?.id ?? p?.requestId ?? p?.toolName ?? "perm");
    if (!prevPermIds.has(pid)) {
      emitOnce(`perm:${pid}`, {
        title: `VibeSquad · Permission Needed`,
        body: `${title}: approval requested`,
        url: deepUrl,
        tag: `vs-perm-${agentId}`,
        agentId,
        kind: "permission",
      });
    }
  }

  // 2. labels["needs-you"] transitions (legacy alias still read)
  const needsYou = String(labels["needs-you"] ?? labels[LEGACY_NEEDS_LABEL] ?? "").trim();
  const prevNeedsYou = String(prevLabels["needs-you"] ?? prevLabels[LEGACY_NEEDS_LABEL] ?? "").trim();
  if (needsYou && needsYou !== "cleared" && needsYou !== prevNeedsYou) {
    const userName = loadUserSettings().userName;
    emitOnce(`needs-you:${needsYou}`, {
      title: `VibeSquad · Needs ${userName}`,
      body: `${title}: needs ${userName === "you" ? "your" : `${userName}'s`} attention`,
      url: deepUrl,
      tag: `vs-needs-you-${agentId}`,
      agentId,
      kind: "needs-you",
    });
  }

  // 3. Lead or worker turn completions/errors
  if (prev && prev.status === "running" && (next.status === "idle" || next.status === "error")) {
    const isLeadOrWorker = role === "lead" || role === "worker" || !role;
    if (isLeadOrWorker) {
      const turnKey = `turn:${next.status}:${next.updatedAt || Date.now()}`;
      emitOnce(turnKey, {
        title: next.status === "error" ? `VibeSquad · Agent Error` : `VibeSquad · Turn Complete`,
        body: `${title} ${next.status === "error" ? "stopped with an error" : "finished its turn"}`,
        url: deepUrl,
        tag: `vs-turn-${agentId}`,
        agentId,
        kind: next.status === "error" ? "error" : "finished",
      });
    }
  }

  return notifications;
}

/**
 * Web Push for runner-owned agents (no Paseo daemon involved): the runner's event stream feeds the same
 * transition detector (running -> idle/error, needs-you, permission) the Paseo path uses. A (re)connect roster
 * only seeds dedupe keys, so a server restart never re-pages. Returns the unsubscribe.
 */
export function watchRunnerTransitions(runner, { dedupeSet = new Set(), notify = defaultNotify } = {}) {
  const agentsById = new Map();
  const seed = (agent) => {
    agentsById.set(agent.id, agent);
    for (const p of Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions : []) dedupeSet.add(`${agent.id}::perm:${String(p?.id ?? p?.toolName ?? "perm")}`);
    const needsYou = String(agent.labels?.["needs-you"] ?? agent.labels?.[LEGACY_NEEDS_LABEL] ?? "").trim();
    if (needsYou && needsYou !== "cleared") dedupeSet.add(`${agent.id}::needs-you:${needsYou}`);
  };
  return runner.subscribeEvents((ev) => {
    if (ev.kind === "roster") {
      for (const a of ev.agents ?? []) seed(a);
    } else if (ev.kind === "agent" && ev.agent?.id) {
      const prev = agentsById.get(ev.agent.id);
      agentsById.set(ev.agent.id, ev.agent);
      for (const note of evaluateAgentTransition(prev, ev.agent, dedupeSet)) notify(note);
    } else if (ev.kind === "remove") {
      // Permission pages come from the "agent" upsert (pendingPermissions), the single path for runner agents.
      agentsById.delete(ev.agentId);
    }
  });
}

function defaultNotify(note) {
  if (pushKindEnabled(note.kind)) broadcastWebPush(note).catch(() => {});
}

let activeWatcher = null;
let watcherClient = null;
let watcherStarted = false;
let lastRootDir = null;

function unrefClientTimers(client) {
  if (!client || typeof client !== "object") return;
  for (const key of ["connectTimeout", "reconnectTimeout", "livenessHeartbeatTimer", "pendingGenericTransportErrorTimeout"]) {
    client[key]?.unref?.();
  }
}

export async function stopPushWatcher() {
  watcherStarted = false;
  const current = activeWatcher;
  activeWatcher = null;
  watcherClient = null;
  if (current) {
    await current.stop();
  }
}

export async function restartPushWatcher(rootDir) {
  await stopPushWatcher();
  watcherStarted = false;
  const targetRoot = rootDir || lastRootDir;
  if (targetRoot) {
    return startPushWatcher(targetRoot);
  }
  return null;
}

/** teams.json can flip a lane to/from the runner while the server runs: restart a live watcher whose runner coverage went stale. */
export async function syncRunnerPushWatch(rootDir) {
  if (!activeWatcher) return null;
  if (activeWatcher.watchingRunner === (runnerLanes().size > 0)) return activeWatcher;
  return restartPushWatcher(rootDir);
}

/**
 * Connects to the Paseo daemon via DaemonClient, seeds initial agent state,
 * and dispatches Web Push notifications on permission requests, needs-you transitions,
 * and lead/worker turn completions or errors.
 */
export function startPushWatcher(rootDir = REPO_ROOT, { runner = runnerLanes().size ? sharedRunnerBackend() : null } = {}) {
  lastRootDir = rootDir;
  if (activeWatcher) return activeWatcher;
  watcherStarted = true;

  const agentsById = new Map();
  const dedupeSet = new Set();
  let stopped = false;

  const { listen } = readPaseoConfig(rootDir);
  const wsUrl = listen.startsWith("ws://") || listen.startsWith("wss://") ? `${listen.replace(/\/$/, "")}/ws` : `ws://${listen}/ws`;
  const password = readDaemonPassword();
  const client = new DaemonClient({
    url: wsUrl,
    clientId: `vibesquad-push-watcher-${ process.pid }`,
    clientType: "cli",
    appVersion: "0.0.1",
    connectTimeoutMs: 5000,
    ...(password ? { password } : {}),
    localCredential: () => readPaseoLocalCredential() || null,
    reconnect: { enabled: true, baseDelayMs: 1500, maxDelayMs: 15000 },
  });
  watcherClient = client;
  const backend = getBackend(client);

  const handleAgentSnapshot = (agent, isInitialSeed = false) => {
    if (!agent || !agent.id) return;
    const prev = agentsById.get(agent.id);
    agentsById.set(agent.id, agent);

    if (isInitialSeed) {
      // Seed dedupe keys for already-existing permissions and needs-you so startup doesn't re-page.
      for (const p of Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions : []) {
        const pid = String(p?.id ?? p?.requestId ?? p?.toolName ?? "perm");
        dedupeSet.add(`${agent.id}::perm:${pid}`);
      }
      const needsYou = String(agent.labels?.["needs-you"] ?? agent.labels?.[LEGACY_NEEDS_LABEL] ?? "").trim();
      if (needsYou && needsYou !== "cleared") {
        dedupeSet.add(`${agent.id}::needs-you:${needsYou}`);
      }
      return;
    }

    const notes = evaluateAgentTransition(prev, agent, dedupeSet);
    for (const note of notes) {
      if (pushKindEnabled(note.kind)) broadcastWebPush(note).catch(() => {});
    }
  };

  backend.subscribe((event) => {
    if (stopped) return;
    if (event.type === "agent_update" && event.payload?.agent) {
      handleAgentSnapshot(event.payload.agent, false);
    } else if (event.type === "agent_permission_request" && event.agentId) {
      const agent = agentsById.get(event.agentId) ?? { id: event.agentId, title: event.agentId.slice(0, 8) };
      const pid = String(event.request?.id ?? event.request?. toolName ?? "perm");
      const fullKey = `${event.agentId}::perm:${pid}`;
      if (!dedupeSet.has(fullKey)) {
        dedupeSet.add(fullKey);
        if (pushKindEnabled("permission")) broadcastWebPush({
          title: "VibeSquad · Permission Needed",
          body: `${agent.title || event.agentId}: approval requested`,
          url: `/?agent=${encodeURIComponent(event.agentId)}&focus=needs-you`,
          tag: `vs-perm-${event.agentId}`,
          agentId: event.agentId,
          kind: "permission",
        }).catch(() => {});
      }
    } else if (event.type === "agent_deleted" && event.agentId) {
      agentsById.delete(event.agentId);
    }
  });

  const seedAgents = async () => {
    try {
      const res = await backend.fetchAgents({ subscribe: {}, filter: { includeArchived: false } });
      for (const entry of res?.entries ?? []) {
        if (entry?.agent) handleAgentSnapshot(entry.agent, true);
      }
    } catch {
      // Daemon may not be running yet; reconnect listener will retry.
    }
  };

  backend.subscribeConnectionStatus((st) => {
    queueMicrotask(() => unrefClientTimers(client));
    if (!stopped && st.status === "connected") {
      void seedAgents();
    }
  });

  const stopRunnerWatch = runner ? watchRunnerTransitions(runner, { dedupeSet }) : null;
  const watchingRunner = !!runner;

  backend.connect().then(() => seedAgents()).catch(() => {});
  unrefClientTimers(client);
  queueMicrotask(() => unrefClientTimers(client));

  activeWatcher = {
    watchingRunner,
    stop() {
      stopped = true;
      stopRunnerWatch?.();
      watcherStarted = false;
      activeWatcher = null;
      if (watcherClient === client) watcherClient = null;
      return backend.close().catch(() => {});
    },
  };
  return activeWatcher;
}
