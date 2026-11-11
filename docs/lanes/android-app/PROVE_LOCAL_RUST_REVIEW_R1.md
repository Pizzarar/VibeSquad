# Prove-Local Rust & Proxy Hardening · Tier A Security Review R1 (`3ca7a39`)

VERDICT: PASS 0H / 0M / 1L

- **Worktree:** `C:\Users\Fugma\AppData\Local\VibeSquad\worktrees\VibeSquad\unit-and-prove-local-rust`
- **Branch / Commit:** `unit-and-prove-local-rust` at `3ca7a39` (`git diff master...HEAD`, base `26ce468`)
- **Files Reviewed:** `src-tauri/src/local_proof.rs`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `art/h1/src/h1b-shot.mjs`, `art/ui/u4b/src/u4b-shot.mjs`, `SECURITY.md`
- **Cause-vs-Symptom Gate:** **PASS** — Addresses the root causes directly: (a) binds the loopback HMAC-SHA256 challenge-response proof (`GET /__vibesquad/local-proof?c=<nonce>`) and the subsequent `x-vibesquad-token` HTTP/WebSocket request to the same single hand-dialed `TcpStream` per request without caching; (b) explicitly sets `Origin: <scheme>://<host>` on both local (`http`) and remote (`https`) upstream requests so `cookieWriteRefusal` (`server/auth.mjs:724-736`) succeeds via positive `Origin === ownOrigin(req)` match rather than relying on omitted `Origin` + forwarded `Sec-Fetch-Site`; and (c) replaces raw `extraHTTPHeaders: { "x-vibesquad-token": tok }` in the art shot scripts with a single-use `/__vibesquad/local-login?t=<nonce>` hop minted via `fetchWithLocalToken`.

---

## 1. Verification of Intent & Requirements

| Requirement | Status | Evidence (`file:line`) |
|---|---|---|
| **(a) HMAC-SHA256 challenge matches `server/local-token.mjs` (`proveLocalServer`)** | **VERIFIED** | `src-tauri/src/local_proof.rs:25,53-60,68-75`: `fresh_nonce()` generates 16 bytes (32 lowercase hex chars) from `rustls::crypto::ring::default_provider().secure_random`. `local_proof(token, nonce, port)` computes `HMAC-SHA256(token, "vs-local-proof\0" + nonce + "\0" + port)` via `ring::hmac::HMAC_SHA256`, matching `server/auth.mjs:1538-1540` and `server/local-token.mjs:66`. Pinned by KAT at `src-tauri/src/local_proof.rs:287-294`. |
| **(a) Same-socket per-connection binding before `x-vibesquad-token` is ever sent** | **VERIFIED** | `src-tauri/src/local_proof.rs:227-273`: `dial_proven(host, token)` dials a fresh `TcpStream`, runs `prove_on_stream(&mut stream, host, port, token)`, and returns that exact `TcpStream` only after the 200 JSON proof reply is completely framed and verified. For HTTP (`src-tauri/src/main.rs:2264-2306`, `send_proven_local`), the proven `TcpStream` is wrapped in `hyper::client::conn::http1::handshake(TokioIo::new(stream))` and sends one request carrying `LOCAL_TOKEN_HEADER`. For WebSocket (`src-tauri/src/main.rs:1862-1883`, `proxy_websocket`), `LOCAL_TOKEN_HEADER` is inserted into `ws_req` only inside `Ok(stream)` after `dial_proven` succeeds, and `client_async_tls_with_config(ws_req, stream, None, None)` performs the upgrade over that same `TcpStream`. |
| **(a) Fails closed and uses constant-time compare** | **VERIFIED** | `src-tauri/src/local_proof.rs:63-65,245-250`: `ct_eq` folds XOR over all 32 bytes in constant time; malformed/missing JSON `proof` decodes to `[0u8; 32]` (`:246`) and still runs `ct_eq(&got, &want)` before returning `ProofError::ProofFailed`. In `proxy_http_handler` (`src-tauri/src/main.rs:2488-2497`), `UpstreamError::ProofFailed` skips `ensure_local_server_running`, skips candidate fallback and HTML nav retries, and immediately returns a `502 Bad Gateway` plain-text `no-store` response (`proof_failed_response`, `:2310-2320`). In `proxy_websocket` (`:1877-1881`), `ProofFailed` closes `client_ws` and returns immediately. |
| **(b) `Origin: https://<host>` set on remote upstreams; `vs_desktop` & `vs_local` stripped; token never sent to non-loopback** | **VERIFIED** | `src-tauri/src/main.rs:2402-2403,2450,2478`: `scheme` is `"http"` when `host_is_local` and `"https"` otherwise; `upstream_origin = format!("{}://{}", scheme, host)` is sent as `Origin` on both `send_proven_local` (`:2290`) and the pooled `reqwest` builder (`:2478`). `strip_local_cookies` (`:721-728`, called at `:2432`) strips `vs_desktop=` and `vs_local=`. Client-supplied `x-vibesquad-token` is stripped at `:2424`, and `state.local_token()` is only read inside `if host_is_local` (`:2453`) and `if is_local` (`:1851`), where `is_local_host` (`:302-317`) permits only exact `localhost`, `127.0.0.1`, or `[::1]`. |
| **(c) Art shot scripts use single-use nonce login URL instead of raw token** | **VERIFIED** | `art/h1/src/h1b-shot.mjs:9,23-30` and `art/ui/u4b/src/u4b-shot.mjs:5,14-21` remove `readFileSync(... "local-token")` and `extraHTTPHeaders: { "x-vibesquad-token": tok }`. Both mint a single-use nonce via `fetchWithLocalToken("/__vibesquad/local-login/nonce", { method: "POST", port })` (which proves the loopback listener first) and navigate the page to `new URL(loginPath, url)` to set the `HttpOnly; SameSite=Strict` `vs_local` cookie before visiting `url`. |

---

## 2. Threat Hunt Results

1. **Token sent before the proof or on a different socket:**
   - **None.** `LOCAL_TOKEN_HEADER` (`"x-vibesquad-token"`) appears in `src-tauri/src/main.rs` only at `:689` (definition), `:1869` (WebSocket upgrade on proven `stream` after `dial_proven` returns `Ok(stream)`), `:2291` (`send_proven_local` over the proven `stream`'s `hyper` HTTP/1.1 connection), and `:2424` (stripping client-supplied header). No other code path in `src-tauri/` reads `local_token_file` or attaches the header.
2. **Connection reuse or pooling that breaks the binding:**
   - **None.** `send_proven_local` (`src-tauri/src/main.rs:2264-2306`) dials a fresh `TcpStream` via `dial_proven`, performs `hyper::client::conn::http1::handshake`, sends a single request on `sender`, and drops `sender` when the function returns. The pooled `state.client()` (`reqwest::Client`) is only used when `!host_is_local` or `state.local_token()` is `None` (`:2471`, e.g., `--headless-proxy` mode where `require_desktop_key` is `false` and `local_token()` returns `None` at `:534`). In `read_http1_response` (`src-tauri/src/local_proof.rs:152-159,183-185`), any extra pipelined bytes after the declared `Content-Length` or `0\r\n\r\n` chunk terminator fail closed with `"extra bytes after the response body"`, preventing response smuggling into `hyper` or `tokio-tungstenite`.
3. **Proof skipped on some path (WebSocket, SSE, retries, redirects):**
   - **None.**
     - **WebSocket:** `proxy_websocket` (`src-tauri/src/main.rs:1862-1883`) calls `local_proof::dial_proven(&host, &token)` before attaching `LOCAL_TOKEN_HEADER` and upgrading the same socket via `client_async_tls_with_config`.
     - **SSE / streaming:** `proxy_http_handler` routes all local token-bearing requests through `send_proven_local` and streams the response body via `Upstream::Proven(r).into_body()` (`src-tauri/src/main.rs:2230-2234,2566`) while the spawned `conn` task drives the proven socket until EOF.
     - **Retries:** On `UpstreamError::Transport` (`src-tauri/src/main.rs:2489-2492`) or `RELAY_RETRY_BACKOFF_MS` navigation retries (`:2657-2661`), `send_upstream().await` invokes `send_proven_local` afresh, dialing a new socket and running a fresh HMAC proof before sending the token. On `UpstreamError::ProofFailed` (`:2495-2497`), the handler returns immediately with no retry.
     - **Redirects:** Neither `hyper::client::conn::http1` nor `state.client()` (`reqwest::redirect::Policy::none()` at `src-tauri/src/main.rs:823`) follows `3xx` redirects, so a `3xx` response never forwards `x-vibesquad-token` to a `Location` target.
4. **Timing-unsafe compares:**
   - **None.** `local_proof::ct_eq` (`src-tauri/src/local_proof.rs:63-65`) and `main::ct_eq` (`src-tauri/src/main.rs:712-714`) both perform a bitwise XOR-accumulate over equal-length byte slices. When `proof_field(&body).and_then(|p| hex_decode_32(&p))` returns `None`, `prove_on_stream` substitutes `[0u8; 32]` (`local_proof.rs:246`) and still executes `ct_eq(&got, &want)`.
5. **Origin spoofing that lets a remote page write:**
   - **None.** Although `proxy_http_handler` stamps `Origin: <scheme>://<host>` on upstream requests (`src-tauri/src/main.rs:2450,2478`), every request to the desktop loopback proxy is gated first by the router-wide middleware `guard_local_request` (`src-tauri/src/main.rs:2787-2807,2857`):
     1. `check_local_request` (`:2748-2780`) rejects duplicate `host`/`origin`/`sec-fetch-site`/`referer` headers, requires `Host` to match `127.0.0.1:<local_port>` or `localhost:<local_port>`, requires any present `Origin` to match `allowed_local_origins(port)` (`http://127.0.0.1:<port>`, `http://localhost:<port>`, `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`), and rejects `Sec-Fetch-Site: cross-site` / `same-site` when `Origin` is absent unless `Referer` is in `allowed_local_origins(port)`.
     2. Outside `--headless-proxy` mode, `guard_local_request` (`:2799-2805`) requires the `HttpOnly; SameSite=Strict` `vs_desktop` cookie matching `state.desktop_key` in constant time.
     A remote or cross-site page in a browser is blocked with `403` at `guard_local_request` before `proxy_http_handler` ever runs.
6. **Token leaking into logs or URLs:**
   - **None.** `local_proof::prove_on_stream` (`src-tauri/src/local_proof.rs:227-251`) puts only the random 128-bit `nonce` in the query string (`GET /__vibesquad/local-proof?c=<nonce>`), never the token. Error messages (`local_proof.rs:233,237,240,243,248,260,261,268`, `main.rs:1878,2317,3330`) log only `host`, HTTP status, or transport error text, never `token`.
7. **Panics or DoS on malformed challenge replies:**
   - **1 Low finding (`L1` below):** `read_chunked` (`src-tauri/src/local_proof.rs:188,191,194`) uses unchecked `body.len() + size` and `size + 2` arithmetic when validating a chunk's hex size against `MAX_PROOF_BODY`, allowing a rogue loopback listener to trigger a task panic with a crafted two-chunk reply (`1\r\na\r\nffffffffffffffff\r\nx`). Details and 1-line fix below.

---

## 3. Findings

### [L1] Unchecked `body.len() + size` / `size + 2` overflow in `read_chunked` panics the request task on a crafted chunked challenge reply (`src-tauri/src/local_proof.rs:174,188,191,194`)
- **Severity:** Low (local task panic / DoS on a rogue loopback listener reply; `x-vibesquad-token` is still never sent)
- **Evidence:** `src-tauri/src/local_proof.rs:174,188-195`:
  ```rust
  let size = usize::from_str_radix(size_str.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "bad chunk size".to_string())?;
  ...
  if body.len() + size > MAX_PROOF_BODY {
      return Err("response body too large".into());
  }
  while pending.len() < size + 2 {
      fill(stream, pending).await?;
  }
  body.extend_from_slice(&pending[..size]);
  ```
- **Failure scenario:** If a rogue listener on the local port responds to `GET /__vibesquad/local-proof?c=<nonce>` with `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\nffffffffffffffff\r\nx`:
  1. Chunk 1 (`size = 1`) appends `b"a"` to `body` (`body.len() == 1`).
  2. Chunk 2 (`size_str = "ffffffffffffffff"`) parses via `usize::from_str_radix(..., 16)` as `size = usize::MAX`.
  3. At `:188`, `body.len() + size` (`1 + usize::MAX`) **panics in debug builds** with `attempt to add with overflow`.
  4. In **release builds** (where integer addition wraps), `1usize.wrapping_add(usize::MAX)` wraps to `0` (`<= MAX_PROOF_BODY`), bypassing the `MAX_PROOF_BODY` guard; at `:191`, `size.wrapping_add(2)` wraps to `1` (which is `<= pending.len()` when 1 byte `x` is buffered, skipping `fill`); and at `:194`, `&pending[..size]` **panics unconditionally in release builds** with `range end index 18446744073709551615 out of range for slice of length 1`.
  5. The panic aborts the Axum handler task (`proxy_http_handler` or `proxy_websocket`) instead of returning the clean 502 `ProofError::ProofFailed` response. Because the panic occurs inside `dial_proven` before `Ok(stream)` returns, `x-vibesquad-token` is never sent.
- **Recommended fix:** Use checked/saturating arithmetic or bound `size` before adding:
  ```rust
  if size > MAX_PROOF_BODY || body.len() + size > MAX_PROOF_BODY {
      return Err("response body too large".into());
  }
  ```
- **Note (out-of-unit informational):** Two sibling scripts not in this unit's `TASKS.json` file list — `art/ui/u4b/src/u4b-contrast.mjs:11,125` and `art/ui/u4b/src/u4b-dom.mjs:8,9` — still read `~/.vibesquad/local-token` directly into `extraHTTPHeaders: { "x-vibesquad-token": tok }`.

---

## 4. Verification Log

Commands run in `C:\Users\Fugma\AppData\Local\VibeSquad\worktrees\VibeSquad\unit-and-prove-local-rust`:
- `cargo test --manifest-path src-tauri/Cargo.toml` -> **43 passed; 0 failed; 1 ignored** (`local_proof::tests::*`, `tests::local_token_is_sent_only_after_the_listener_proves_it_holds_it`, `tests::a_rogue_listener_never_sees_the_token_and_the_window_gets_a_plain_error`, `tests::desktop_proxy_requires_desktop_key_and_attaches_local_token_only_to_localhost`).
- `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live_server` -> **1 passed; 0 failed** (`local_proof::tests::live_server_passes_the_proof_and_keeps_the_socket_open`).
- `node --test --import ./test/setup/hermetic.mjs test/sec-prove-local.test.mjs test/sec-origin-check.test.mjs` -> **49 passed; 0 failed**.
- `npm run typecheck` -> exited `0`.
