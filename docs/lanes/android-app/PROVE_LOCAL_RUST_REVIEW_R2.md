# Prove-Local Rust & Proxy Hardening · Tier A Security Review R2 (`508d97e`)

VERDICT: PASS 0H / 0M / 0L

- **Worktree:** `C:\Users\Fugma\AppData\Local\VibeSquad\worktrees\VibeSquad\unit-and-prove-local-rust`
- **Branch / Commit:** `unit-and-prove-local-rust` at `508d97e` (`git diff master...HEAD`: `3ca7a39` + `508d97e`, base `26ce468`)
- **Files Reviewed:** `src-tauri/src/local_proof.rs`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `art/h1/src/h1b-shot.mjs`, `art/ui/u4b/src/u4b-shot.mjs`, `SECURITY.md`, `docs/lanes/android-app/PROVE_LOCAL_RUST_REVIEW_R1.md`
- **Cause-vs-Symptom Gate:** **PASS** — Commit `508d97e` fixes R1 `L1` at the root cause: `read_chunked` (`src-tauri/src/local_proof.rs:190-201`) validates `size > MAX_PROOF_BODY || body.len().checked_add(size).map_or(true, |t| t > MAX_PROOF_BODY)` before performing any arithmetic (`let framed = size + 2`) or slice indexing (`&pending[..size]`, `&pending[size..framed]`). Combined with `3ca7a39`, the unit binds the per-connection loopback HMAC-SHA256 challenge and `x-vibesquad-token` request to the same single `TcpStream`, sets `Origin: <scheme>://<host>` on both local and remote upstream requests, and replaces raw `x-vibesquad-token` browser headers in the art shot scripts with single-use `/__vibesquad/local-login?t=<nonce>` hops.

---

## 1. R1 Finding Verification (`508d97e`)

| R1 Finding | Status | Verification Evidence (`file:line`) |
|---|---|---|
| **[L1] Unchecked `body.len() + size` / `size + 2` overflow in `read_chunked`** | **FIXED (Root Cause)** | `src-tauri/src/local_proof.rs:190-201`: `if size > MAX_PROOF_BODY \|\| body.len().checked_add(size).map_or(true, \|t\| t > MAX_PROOF_BODY)` rejects any chunk size exceeding `MAX_PROOF_BODY` (`65536`) or overflowing cumulative `body.len()` before `let framed = size + 2` is computed. Because `size <= 65536`, `size + 2` cannot overflow `usize`, and the `while pending.len() < framed` loop guarantees `pending.len() >= size + 2` before `&pending[..size]`, `&pending[size..framed]`, and `pending.drain(..framed)` execute. |
| **Regression & boundary tests for R1 L1** | **VERIFIED** | `src-tauri/src/local_proof.rs:344-366` (`read_chunked_refuses_an_overflowing_chunk_size_without_panicking`): Tests the exact two-chunk R1 payload (`1\r\na\r\nffffffffffffffff\r\nx`), single-chunk `usize::MAX` (`ffffffffffffffff`) and `usize::MAX - 1` (`fffffffffffffffe`), `MAX_PROOF_BODY + 1` (`10001`), `Content-Length: 18446744073709551615`, 17-hex-digit `usize` parse overflow (`1ffffffffffffffff`), and end-to-end `dial_proven` returning `Err(ProofError::ProofFailed)` without panicking. |

---

## 2. Full Diff (`master...HEAD`) Security & Regression Check

- **Only expected files touched in `508d97e`:** `src-tauri/src/local_proof.rs` (`+51 / -6`) and `docs/lanes/android-app/PROVE_LOCAL_RUST_REVIEW_R1.md` (`+88`).
- **All R1 invariants preserved across `master...HEAD`:**
  - `local_proof` HMAC-SHA256 formula (`"vs-local-proof\0" + nonce + "\0" + port`), CSPRNG 128-bit nonce generation, and constant-time comparison (`ct_eq`) remain intact (`src-tauri/src/local_proof.rs:53-75,248-252`).
  - Same-socket binding for HTTP (`send_proven_local`, `src-tauri/src/main.rs:2264-2306`) and WebSocket (`proxy_websocket`, `src-tauri/src/main.rs:1862-1883`) without connection pooling or proof caching remains intact.
  - Fail-closed behavior on `ProofError::ProofFailed` (`src-tauri/src/main.rs:1877-1881,2310-2320,2495-2497`) and explicit `Origin: <scheme>://<host>` on local/remote upstreams (`:2402-2403,2450,2478`) remain intact.
  - Art scripts (`art/h1/src/h1b-shot.mjs`, `art/ui/u4b/src/u4b-shot.mjs`) and `SECURITY.md` remain unchanged from `3ca7a39`.

---

## 3. Verification Log

- `cargo test --manifest-path src-tauri/Cargo.toml local_proof` -> **8 passed; 0 failed; 1 ignored** (including `local_proof::tests::read_chunked_refuses_an_overflowing_chunk_size_without_panicking`).
- Full `cargo test` suite (43 unit tests + 1 live test) verified passing on `508d97e`.
