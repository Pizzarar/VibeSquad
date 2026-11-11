# Prove-Local Security Review (R2) · `unit-and-prove-local` (`4733052..0e3bfa4`)

- **Worktree:** `C:\Users\Fugma\AppData\Local\VibeSquad\worktrees\VibeSquad\unit-and-prove-local`
- **Commit:** `0e3bfa4` on merge base `4733052`
- **Verdict:** **PASS** (0 High / 0 Medium / 0 Low)
- **Cause-vs-Symptom Gate:** **PASS** — Binds the challenge-response proof and the subsequent `x-vibesquad-token` request to a single TCP connection via `singleConnectionClient` (`node:http` `Agent` with `keepAlive: true`, `maxSockets: 1`, and a one-shot `createConnection` dialer that fails closed with `proofFailed: true` on any second dial attempt).

---

## 1. Verification of R2 Fixes & Hunt Targets

### 1.1 Single-socket binding (`server/local-token.mjs:86-121, 145-163`)
- `singleConnectionClient(port, host = "127.0.0.1")` constructs a dedicated `new HttpAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })` with a per-client `let dialed = false` guard in `agent.createConnection`.
- The first request (`GET /__vibesquad/local-proof?c=<nonce>`) sets `dialed = true` and opens the sole TCP connection via `net.createConnection({ ...options, host, port })`. Its response stream is fully drained (`res.on("end", ...)`) before `proveLocalServer()` resolves, returning the keep-alive socket to the agent's free pool.
- The second request (carrying `x-vibesquad-token`) reuses that exact TCP connection. If the proven socket was closed by the peer (e.g., `Connection: close`, FIN, or process exit), `HttpAgent` invokes `agent.createConnection` again; because `dialed === true`, `createConnection` immediately calls `cb(proofError("the proven connection to ... closed before the request; the local token was not sent"))` and returns `undefined` before any socket is created or any header bytes leave the process.
- `fetchWithLocalToken` rethrows `e?.proofFailed` (`server/local-token.mjs:158`), so MCP callers (`postLeadHandoffToServer`, `postBuddyRestartToServer`) treat a dropped proven connection as a hard proof failure rather than an `unreachable` fallback.
- `fetchLike` also pins `u.hostname === host && Number(u.port) === port` (`server/local-token.mjs:100`), rejecting any URL targeting a different host or port.

### 1.2 No keep-alive reuse across calls & deterministic cleanup on error (`server/local-token.mjs:145-163`)
- Every `fetchWithLocalToken` call instantiates its own `singleConnectionClient(port)` and destroys the agent (`client?.close()` -> `agent.destroy()`) inside a `finally` block (`lines 161-163`).
- Sockets are never shared across separate `fetchWithLocalToken` invocations, and any socket opened during a failed proof, timeout, or aborted request is immediately destroyed when `fetchWithLocalToken` exits.

### 1.3 No `fetchImpl = fetch` default leaking back in (`server/local-token.mjs:41, 140`, `cli/vs.mjs:1911, 2073`, `server/mcp/tools.mjs:472, 679`)
- `requestLocalLoginUrl`, `fetchWithLocalToken`, `requestWorkerSweep`, and `requestPairStart` all leave `fetchImpl` `undefined` by default; `postLeadHandoffToServer` and `postBuddyRestartToServer` pass `fetchImpl: ctx.fetch` (which is `undefined` outside unit tests).
- When `fetchImpl` is `undefined`, `fetchWithLocalToken` always uses `singleConnectionClient(port)`.
- `test/sec-prove-local.test.mjs:361` enforces that none of the five callers contain `fetchImpl = fetch` or `?? fetch`.

### 1.4 Redirect refusal (`server/local-token.mjs:60, 101-118, 154`)
- `singleConnectionClient` uses `node:http` `httpRequest` directly, which never follows `3xx` redirects (a `302` resolves with `status: 302, ok: false` and never forwards `x-vibesquad-token` to `Location`).
- Both `proveLocalServer` (`line 60`) and `fetchWithLocalToken` (`line 154`) also pass `redirect: "error"` so any injected `fetch`-compatible test implementation refuses redirects as well.

### 1.5 Expanded source guard (`test/sec-prove-local.test.mjs:330-342`)
- The source guard now walks `cli/`, `server/`, `runner/`, and `scripts/` (`> 40` files) and verifies that `LOCAL_TOKEN_HEADER`, `localTokenHeaders(`, and `"x-vibesquad-token"` are never emitted outside `server/local-token.mjs`.

---

## 2. Verification Evidence

Command run in `C:\Users\Fugma\AppData\Local\VibeSquad\worktrees\VibeSquad\unit-and-prove-local`:
```
node --test --import ./test/setup/hermetic.mjs test/sec-prove-local.test.mjs test/sec-phone-mint-pair.test.mjs test/cli-devices.test.mjs test/worker-sweep-route.test.mjs test/public-release.test.mjs && npm run typecheck
```
Result: **95 tests, 29 suites, 95 passed, 0 failed**; `tsc --noEmit && tsc --noEmit -p tsconfig.server.json` exited `0`.
