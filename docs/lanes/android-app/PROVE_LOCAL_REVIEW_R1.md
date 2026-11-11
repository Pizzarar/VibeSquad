# Prove-Local Security Review (R1) · `unit-and-prove-local` (`458961d..476f16a`)

- **Worktree:** `C:\Users\Fugma\AppData\Local\VibeSquad\worktrees\VibeSquad\unit-and-prove-local`
- **Commit:** `476f16a` on base `458961d`
- **Verdict:** **PASS** (0 High / 0 Medium / 1 Low — fixed in R2 `0e3bfa4`)
- **Cause-vs-Symptom Gate:** **PASS** — Centralizes all in-repo `x-vibesquad-token` transmission into `fetchWithLocalToken()` (`server/local-token.mjs`), requiring a fresh per-request port-bound HMAC proof (`proveLocalServer`) before the header is sent.

---

## 1. Security Evaluation (`458961d..476f16a`)

### 1.1 No path sends `x-vibesquad-token` before the proof succeeds
- All five in-repo callers (`requestLocalLoginUrl` in `server/local-token.mjs:39`, `requestWorkerSweep` in `cli/vs.mjs:1911`, `requestPairStart` in `cli/vs.mjs:2073`, `postLeadHandoffToServer` in `server/mcp/tools.mjs:468`, and `postBuddyRestartToServer` in `server/mcp/tools.mjs:675`) route through `fetchWithLocalToken()`.
- When a local token exists on disk, `fetchWithLocalToken()` awaits `proveLocalServer()` before issuing the token-bearing request.
- Any non-2xx response, non-JSON response, missing `proof` field, or HMAC mismatch throws an error tagged `proofFailed: true` (`server/local-token.mjs:64-68, 76`) and aborts before sending `x-vibesquad-token`.
- In `postLeadHandoffToServer` (`server/mcp/tools.mjs:477`) and `postBuddyRestartToServer` (`server/mcp/tools.mjs:684`), `if (e?.proofFailed) throw e;` ensures a failed proof is never treated as `{ unreachable: true }` (preventing `handoffLead` from silently falling back in-process when a rogue listener is on the port).

### 1.2 `tokenOptional` semantics
- Only the two MCP callers (`postLeadHandoffToServer` and `postBuddyRestartToServer`) set `tokenOptional: true`.
- When `readLocalToken(file)` returns `null` (missing or malformed file) and `tokenOptional: true`, no token exists to protect or send, so the request goes out without `x-vibesquad-token`.
- When `readLocalToken(file)` returns a valid 64-hex token, `if (token) await proveLocalServer(...)` still runs unconditionally even with `tokenOptional: true`.
- For all CLI callers (`tokenOptional: false`), a missing or malformed token file throws before any network request is made.

### 1.3 Per-call proof vs. caching and socket-level TOCTOU
- There is no proof cache: every call to `fetchWithLocalToken()` generates a fresh 128-bit nonce (`randomBytes(16).toString("hex")`) and verifies `HMAC-SHA256(token, "vs-local-proof\0" + nonce + "\0" + port)`, preventing a rogue listener that takes over the port after a server restart from receiving the token from a long-lived MCP process.
- **[L1 — Fixed in R2 `0e3bfa4`]:** In `476f16a`, `proveLocalServer()` and the follow-up `fetchImpl()` call in `fetchWithLocalToken()` were two independent `fetch` calls not pinned to a single TCP connection. If the proven listener closed the socket (or exited) immediately after answering `/__vibesquad/local-proof` and a rogue process bound the port before the second `fetch` connected, the second `fetch` could dial a new socket to the rogue listener. (Resolved in `0e3bfa4` via `singleConnectionClient`.)

### 1.4 Source-guard and adjusted tests
- `test/sec-prove-local.test.mjs` enforces that no file in `cli/` or `server/` outside `server/local-token.mjs` emits `LOCAL_TOKEN_HEADER`, `localTokenHeaders(`, or `"x-vibesquad-token"`.
- The updates in `test/worker-sweep-route.test.mjs` and `test/sec-phone-mint-pair.test.mjs` preserve all prior assertions while verifying that `requestWorkerSweep` and `requestPairStart` challenge the listener with a fresh nonce per call and never include the token on the challenge request.
- Out-of-scope callers (`src-tauri/src/main.rs:688` and `art/` screenshot scripts) are tracked separately as noted in the brief.

---

## 2. Finding Summary (R1)

- **[L1] (`server/local-token.mjs:55-110` in `476f16a`):** Proof and token-bearing request were not bound to a single TCP connection (sub-millisecond TOCTOU window if the proven socket closed and the port was rebound between the two requests). Fixed in R2 (`0e3bfa4`).
