// vs.http: the one plugin RPC the remote (relay) UI uses to reach the loopback VibeSquad server
// (PLAN_PASEO_PARITY.md block R2-1). The browser-side fetch shim is src/remoteTransport.ts.
//
// Off unless ~/.vibesquad/settings.json has "remote": { "enabled": true }. That file is only written
// locally (the settings endpoint never accepts `remote`, and POST /__vibesquad/settings is not proxied),
// so a relay client cannot switch the gate on. A Paseo plugin setting would be writable over the relay.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localTokenHeaders, localTokenPath } from "@vibesquad/server/local-token.mjs";
import {
  REMOTE_ALLOW,
  REMOTE_MAX_BODY_BYTES,
  REMOTE_MAX_TERMINALS,
  REMOTE_OWNER_READS,
  REMOTE_RESPONSE_HEADERS,
  REMOTE_TIMEOUT_MS,
  checkRemoteBody,
  checkRemoteRegistry,
  createRateLimiter,
  decideProxyRequest,
  decisionStatus,
  isOwnerRoute,
  isTerminalRoute,
  isTextContentType,
  needsRegistry,
  proxyTimeoutFor,
  redactBody,
  scrubResponseBody,
  utf8Bytes,
  type AllowMap,
  type RateLimiter,
} from "./remote-proxy-rules.ts";

export type VsHttpInput = { method: string; path: string; body?: string };
// `encoding: "base64"` marks a binary body (GET fs/read only, B8): `body` is base64 of the raw bytes.
export type VsHttpOutput = { status: number; headers: Record<string, string>; body: string; encoding?: "base64" };

const vsHome = () => process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad");

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** Gate: read on every call so switching it off takes effect at once. Missing/invalid → off. */
export function remoteEnabled(home = vsHome()): boolean {
  const s = readJson(path.join(home, "settings.json"));
  return s?.remote?.enabled === true;
}

// Loopback owner token (security S3, server/local-token.mjs). Sent on writes and on REMOTE_OWNER_READS (the B8
// fs/* reads); other remote GETs go without it, so S3's read-only loopback mode is a second wall (no writes,
// no isGatedRead paths) behind the allowlist.
export function vsTokenHeaders(home = vsHome()): Record<string, string> {
  return localTokenHeaders(localTokenPath(home));
}

function ownerIdentity(): { homeDir: string; userName: string } {
  let userName = "";
  try {
    userName = os.userInfo().username;
  } catch {}
  return { homeDir: os.homedir(), userName };
}

// Contract in the shape Paseo's plugin host expects (it only calls input/output.parseAsync).
// Hand-written so the plugin keeps zero runtime deps; the input parse is itself a security check.
function parseInput(raw: unknown): VsHttpInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("vs.http: input must be an object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "method" && k !== "path" && k !== "body") throw new Error(`vs.http: unexpected field ${k}`);
  }
  if (typeof r.method !== "string") throw new Error("vs.http: method must be a string");
  if (typeof r.path !== "string") throw new Error("vs.http: path must be a string");
  if (r.body !== undefined && typeof r.body !== "string") throw new Error("vs.http: body must be a string");
  return { method: r.method, path: r.path, ...(r.body !== undefined ? { body: r.body } : {}) };
}
function parseOutput(raw: unknown): VsHttpOutput {
  const r = raw as VsHttpOutput;
  if (!r || typeof r.status !== "number" || typeof r.body !== "string" || !r.headers || typeof r.headers !== "object") {
    throw new Error("vs.http: bad output");
  }
  return r;
}
export const vsHttp = {
  name: "vs.http",
  input: { parse: parseInput, parseAsync: async (v: unknown) => parseInput(v) },
  output: { parse: parseOutput, parseAsync: async (v: unknown) => parseOutput(v) },
};

/** A refusal: the message carries the HTTP-style status ("[403]") and so does `status` on the error. */
export class RemoteDenied extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`vs.http: ${message} [${status}]`);
    this.status = status;
  }
}

/** Raw-byte cap for binary GET fs/read (images, PDFs) shown in the remote Files panel. Text routes keep REMOTE_MAX_BODY_BYTES. */
export const REMOTE_MAX_BINARY_BYTES = 8 * 1024 * 1024;
const FS_READ_PATH = "/__vibesquad/fs/read";
const FS_READ_HEADERS = ["x-vs-size", "x-vs-modified"] as const;

/** Streams the body into one buffer, giving up (null) as soon as it passes `max` raw bytes. */
async function readBytesCapped(res: Response, signal: AbortSignal, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("vs.http: timed out");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return buf;
}

async function readCapped(res: Response, signal: AbortSignal): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(len) && len > REMOTE_MAX_BODY_BYTES) {
    throw new Error(`vs.http: response too large (${len} bytes, cap ${REMOTE_MAX_BODY_BYTES})`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("vs.http: timed out");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REMOTE_MAX_BODY_BYTES) throw new Error(`vs.http: response too large (cap ${REMOTE_MAX_BODY_BYTES} bytes)`);
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/** The live registry for registry-checked writes: a token-less loopback GET /api/teams. null when unreadable. */
async function readRegistry(port: number, doFetch: typeof fetch, signal: AbortSignal): Promise<unknown> {
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/api/teams`, { method: "GET", redirect: "manual", signal });
    if (res.status !== 200) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    return JSON.parse(await readCapped(res, signal));
  } catch {
    return null;
  }
}

export type VsHttpDeps = {
  port?: number;
  home?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  allow?: AllowMap; // tests only; production is REMOTE_ALLOW
  limiter?: RateLimiter;
  homeDir?: string;
  userName?: string;
};

export function makeVsHttpHandler(deps: VsHttpDeps = {}) {
  const limiter = deps.limiter ?? createRateLimiter();
  // Terminals this handler (one paired PC session) created and has not seen die: the per-caller cap.
  const remoteTerms = new Set<string>();
  const owner = { ...ownerIdentity(), ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}), ...(deps.userName !== undefined ? { userName: deps.userName } : {}) };
  const trackTerminal = (method: string, pathname: string, status: number, text: string) => {
    const id = /^\/__vibesquad\/terminals\/(tm-[a-f0-9]{12})\//.exec(pathname)?.[1];
    if (method === "POST" && pathname === "/__vibesquad/terminals" && status === 201) {
      try {
        const made = JSON.parse(text)?.terminal?.id;
        if (typeof made === "string") remoteTerms.add(made);
      } catch {}
    } else if (id && (pathname.endsWith("/kill") || status === 404 || status === 409)) {
      remoteTerms.delete(id);
    } else if (id && pathname.endsWith("/poll") && status === 200) {
      try {
        if (JSON.parse(text)?.exited) remoteTerms.delete(id);
      } catch {}
    }
  };
  return async (input: VsHttpInput): Promise<VsHttpOutput> => {
    const home = deps.home ?? vsHome();
    if (!remoteEnabled(home)) {
      throw new RemoteDenied(403, 'remote access is off (set "remote": { "enabled": true } in ~/.vibesquad/settings.json)');
    }
    const d = decideProxyRequest(input.method, input.path, deps.allow ?? REMOTE_ALLOW);
    if (!d.ok) throw new RemoteDenied(decisionStatus(d.code), d.error);
    if (input.body !== undefined && utf8Bytes(input.body) > REMOTE_MAX_BODY_BYTES) {
      throw new RemoteDenied(413, `request body too large (cap ${REMOTE_MAX_BODY_BYTES} bytes)`);
    }
    const write = d.method !== "GET";
    // Terminal + script routes are a shell on the host: owner token or nothing (never forwarded tokenless).
    const ownerRoute = isOwnerRoute(d.pathname);
    const termRoute = isTerminalRoute(d.pathname);
    if (ownerRoute && Object.keys(vsTokenHeaders(home)).length === 0) {
      throw new RemoteDenied(403, "terminals and scripts are owner-only (no owner token on the host)");
    }
    if (termRoute && d.method === "POST" && d.pathname === "/__vibesquad/terminals" && remoteTerms.size >= REMOTE_MAX_TERMINALS) {
      throw new RemoteDenied(429, `too many remote terminals (max ${REMOTE_MAX_TERMINALS}); close one first`);
    }
    // Per-endpoint typed body allowlist (R2-5): checked before a rate-limit slot is spent.
    const bodyCheck = checkRemoteBody(d.method, d.pathname, input.body);
    if (!bodyCheck.ok) throw new RemoteDenied(bodyCheck.status, bodyCheck.error);
    const slot = limiter.acquire(termRoute ? "term" : write ? "write" : "read", `${d.method} ${d.pathname}`);
    if (!slot.ok) throw new RemoteDenied(429, slot.error);
    const hasBody = input.body !== undefined && write;
    // What was checked is what is sent: the parsed body, re-serialised (after any registry pinning).
    let sendBody = hasBody ? JSON.stringify(bodyCheck.value) : undefined;
    const port = deps.port ?? Number(process.env.VIBESQUAD_PORT || 4180);
    // Host is fixed: the caller only ever supplies an allowlisted pathname + query.
    const url = `http://127.0.0.1:${port}${d.pathname}${d.search}`;
    const timeoutMs = deps.timeoutMs ?? proxyTimeoutFor(d.pathname);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      if (write && needsRegistry(d.pathname)) {
        const reg = checkRemoteRegistry(d.pathname, bodyCheck.value, await readRegistry(port, deps.fetch ?? fetch, abort.signal), (s) =>
          redactBody(s, owner.homeDir, owner.userName),
        );
        if (!reg.ok) throw new RemoteDenied(reg.status, reg.error);
        if (hasBody) sendBody = JSON.stringify(reg.value);
      }
      const res = await (deps.fetch ?? fetch)(url, {
        method: d.method,
        // No caller headers are forwarded: just our content type and the loopback token.
        headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(write || ownerRoute || REMOTE_OWNER_READS.includes(d.pathname) ? vsTokenHeaders(home) : {}) },
        ...(hasBody ? { body: sendBody } : {}),
        redirect: "manual",
        signal: abort.signal,
      });
      const ct = res.headers.get("content-type");
      // Every 200 on GET fs/read is file content: no scrub/redact (it would rewrite the owner's name inside the
      // file), x-vs-size/x-vs-modified kept. Text is capped at the text cap, binary at 8 MB raw and sent as base64.
      // Terminal bodies (poll / output / create) are the same: raw, byte-exact, 413 over the text cap.
      const rawFs = d.method === "GET" && d.pathname === FS_READ_PATH && res.status === 200;
      const rawTerm = termRoute && res.status >= 200 && res.status < 300 && isTextContentType(ct);
      if (rawFs || rawTerm) {
        const isText = isTextContentType(ct);
        const cap = isText ? REMOTE_MAX_BODY_BYTES : REMOTE_MAX_BINARY_BYTES;
        const size = Number(res.headers.get("x-vs-size") ?? res.headers.get("content-length") ?? NaN);
        const bytes = Number.isFinite(size) && size > cap ? null : await readBytesCapped(res, abort.signal, cap);
        if (!bytes) {
          res.body?.cancel().catch(() => {});
          const lim = isText ? `${Math.floor(cap / 1024)} KB` : `${Math.floor(cap / (1024 * 1024))} MB`;
          return {
            status: 413,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: false, error: `${rawTerm ? "terminal output" : "file"} too large to preview remotely (over ${lim})`, ...(Number.isFinite(size) ? { size } : {}) }),
          };
        }
        const headers: Record<string, string> = {};
        for (const h of [...REMOTE_RESPONSE_HEADERS, ...FS_READ_HEADERS]) {
          const v = res.headers.get(h);
          if (v !== null) headers[h] = v;
        }
        if (rawTerm) {
          const text = new TextDecoder().decode(bytes);
          trackTerminal(d.method, d.pathname, res.status, text);
          return { status: res.status, headers, body: text };
        }
        return isText
          ? { status: 200, headers, body: new TextDecoder().decode(bytes) }
          : { status: 200, headers, body: Buffer.from(bytes).toString("base64"), encoding: "base64" };
      }
      if (!isTextContentType(ct)) {
        res.body?.cancel().catch(() => {});
        throw new Error(`vs.http: non-text response (${ct}) is not proxied`);
      }
      if (termRoute && res.status >= 400) trackTerminal(d.method, d.pathname, res.status, "");
      const body = redactBody(scrubResponseBody(d.pathname, await readCapped(res, abort.signal), res.status), owner.homeDir, owner.userName);
      const headers: Record<string, string> = {};
      for (const h of REMOTE_RESPONSE_HEADERS) {
        const v = res.headers.get(h);
        if (v !== null) headers[h] = v;
      }
      return { status: res.status, headers, body };
    } catch (e: any) {
      if (abort.signal.aborted) throw new Error(`vs.http: timed out after ${timeoutMs} ms`);
      if (String(e?.message ?? "").startsWith("vs.http:")) throw e;
      throw new Error(`vs.http: VibeSquad server unreachable on 127.0.0.1:${port}`);
    } finally {
      clearTimeout(timer);
      slot.release();
    }
  };
}
