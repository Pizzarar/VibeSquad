//! Loopback server proof (X1 prove-local Low, `unit-and-prove-local-rust`): the Rust port of
//! `proveLocalServer` + `singleConnectionClient` in `server/local-token.mjs`.
//!
//! Before the desktop proxy sends `x-vibesquad-token` to the local VibeSquad server it makes whatever
//! listens on that port prove it already holds the token: a fresh 128-bit nonce goes to
//! `GET /__vibesquad/local-proof?c=<nonce>` and the answer must be
//! `HMAC-SHA256(token, "vs-local-proof" \0 nonce \0 port)` (`server/auth.mjs` `localProof`). The port in
//! the MAC is the server's accepted-socket port, so a rogue on this port cannot relay the challenge to a
//! real server elsewhere. HMAC is a PRF, so the public oracle leaks nothing about the token.
//!
//! The proof and the token request ride ONE TCP connection: [`dial_proven`] dials, proves on the raw
//! stream, and hands that same stream back so the caller can run hyper (HTTP) or tungstenite (WebSocket)
//! over it. An established loopback socket cannot be taken over by a later bind, so the proof means
//! "this socket", not "whatever bound this port a millisecond ago". A failed proof is
//! [`ProofError::ProofFailed`] and the token never leaves the process. No proof cache: the proxy owns the
//! child server's lifecycle, but a per-process cache would hand the token to a rogue that grabs the port
//! after a restart (threat note P4); one extra loopback round trip per connection keeps that closed.

use ring::hmac;
use std::fmt;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

pub const LOCAL_PROOF_PREFIX: &str = "vs-local-proof";
/// Loopback round trips take about a millisecond; a listener that needs longer than this is not ours.
pub const PROOF_TIMEOUT: Duration = Duration::from_millis(2000);
/// Connect budget (Windows can take a couple of seconds to refuse a closed loopback port): a dial that does not
/// complete is "server down", not a failed proof, so the caller's ordinary restart/retry path runs.
pub const DIAL_TIMEOUT: Duration = Duration::from_millis(2500);
/// The proof reply is ~100 bytes of JSON; anything bigger is not the server's answer.
const MAX_PROOF_BODY: usize = 64 * 1024;
const MAX_PROOF_HEAD: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProofError {
    /// Nothing answered (or the socket broke): callers may retry / fall through like any transport error.
    Unreachable(String),
    /// Something answered but is not this install's server. Must never be mistaken for "server down":
    /// callers fail closed with this message and do not retry on another path.
    ProofFailed(String),
}

impl fmt::Display for ProofError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProofError::Unreachable(m) | ProofError::ProofFailed(m) => f.write_str(m),
        }
    }
}

/// HMAC-SHA256(token, prefix \0 nonce \0 port), the same bytes `localProof()` in `server/auth.mjs` signs.
pub fn local_proof(token: &str, nonce: &str, port: u16) -> [u8; 32] {
    let key = hmac::Key::new(hmac::HMAC_SHA256, token.as_bytes());
    let msg = format!("{}\0{}\0{}", LOCAL_PROOF_PREFIX, nonce, port);
    let tag = hmac::sign(&key, msg.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

/// Constant-time equality (same shape as `ct_eq` in main.rs; duplicated so this module stands alone).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 32 lowercase hex chars from the OS RNG (the same source `random_hex_key` in main.rs uses).
pub fn fresh_nonce() -> String {
    let mut bytes = [0u8; 16];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut bytes)
        .expect("system RNG unavailable");
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hex_decode_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

/// The port a `host[:port]` string names, the way the server will see it on its accepted socket. `[::1]:4180`,
/// `127.0.0.1:4180`, `localhost` (→ 80, the plain-http default the proxy would dial).
pub fn host_port(host: &str) -> u16 {
    let rest = if host.starts_with('[') {
        host.find(']').map(|i| &host[i + 1..]).unwrap_or("")
    } else {
        host.find(':').map(|i| &host[i..]).unwrap_or("")
    };
    rest.strip_prefix(':').and_then(|p| p.parse::<u16>().ok()).unwrap_or(80)
}

/// Reads exactly one HTTP/1.1 response (status line, headers, Content-Length or chunked body) and leaves the
/// stream positioned after it, so the next request can reuse the connection. Refuses anything it cannot
/// frame (no length and not chunked, oversize) rather than guessing: a misframed proof reply fails closed.
pub async fn read_http1_response<S: AsyncRead + Unpin>(stream: &mut S) -> Result<(u16, Vec<u8>), String> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let head_end = loop {
        if let Some(i) = find_subslice(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_PROOF_HEAD {
            return Err("response head too large".into());
        }
        let mut chunk = [0u8; 1024];
        let n = stream.read(&mut chunk).await.map_err(|e| format!("read: {}", e))?;
        if n == 0 {
            return Err("connection closed before the response head".into());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .strip_prefix("HTTP/1.1 ")
        .or_else(|| status_line.strip_prefix("HTTP/1.0 "))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| format!("not an HTTP/1.x status line: {:?}", status_line))?;
    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "content-length" {
            content_length = Some(value.parse().map_err(|_| "bad content-length".to_string())?);
        } else if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        }
    }
    let mut rest = buf.split_off(head_end + 4);
    if chunked {
        let body = read_chunked(stream, &mut rest).await?;
        return Ok((status, body));
    }
    let len = content_length.unwrap_or(0);
    if len > MAX_PROOF_BODY {
        return Err("response body too large".into());
    }
    while rest.len() < len {
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await.map_err(|e| format!("read: {}", e))?;
        if n == 0 {
            return Err("connection closed mid-body".into());
        }
        rest.extend_from_slice(&chunk[..n]);
    }
    if rest.len() != len {
        // Bytes past the declared body would belong to a response nobody asked for: refuse to reuse the stream.
        return Err("extra bytes after the response body".into());
    }
    Ok((status, rest))
}

async fn read_chunked<S: AsyncRead + Unpin>(stream: &mut S, pending: &mut Vec<u8>) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        // size line
        let line_end = loop {
            if let Some(i) = find_subslice(pending, b"\r\n") {
                break i;
            }
            fill(stream, pending).await?;
        };
        let size_str = String::from_utf8_lossy(&pending[..line_end]).to_string();
        let size = usize::from_str_radix(size_str.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "bad chunk size".to_string())?;
        pending.drain(..line_end + 2);
        if size == 0 {
            // trailer section ends with an empty line
            while find_subslice(pending, b"\r\n").is_none() {
                fill(stream, pending).await?;
            }
            let i = find_subslice(pending, b"\r\n").unwrap();
            pending.drain(..i + 2);
            if !pending.is_empty() {
                return Err("extra bytes after the response body".into());
            }
            return Ok(body);
        }
        // Gemini R1 L1: cap the chunk size before any arithmetic on it. A hex size near usize::MAX would otherwise
        // overflow `body.len() + size` / `size + 2` (debug panic, release wrap-around past the cap and a slice panic).
        if size > MAX_PROOF_BODY || body.len().checked_add(size).map_or(true, |t| t > MAX_PROOF_BODY) {
            return Err("response body too large".into());
        }
        let framed = size + 2; // size <= MAX_PROOF_BODY here, so this cannot overflow
        while pending.len() < framed {
            fill(stream, pending).await?;
        }
        body.extend_from_slice(&pending[..size]);
        if &pending[size..framed] != b"\r\n" {
            return Err("bad chunk terminator".into());
        }
        pending.drain(..framed);
    }
}

async fn fill<S: AsyncRead + Unpin>(stream: &mut S, pending: &mut Vec<u8>) -> Result<(), String> {
    if pending.len() > MAX_PROOF_BODY + MAX_PROOF_HEAD {
        return Err("response body too large".into());
    }
    let mut chunk = [0u8; 4096];
    let n = stream.read(&mut chunk).await.map_err(|e| format!("read: {}", e))?;
    if n == 0 {
        return Err("connection closed mid-body".into());
    }
    pending.extend_from_slice(&chunk[..n]);
    Ok(())
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The `"proof":"<64 hex>"` value out of the reply body without pulling a JSON crate into the hot path.
fn proof_field(body: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    v.get("proof")?.as_str().map(|s| s.to_string())
}

/// Challenges the listener on `stream` (already connected to `host`, whose port is `port`) and verifies the
/// HMAC with `token`. On `Ok` the stream has consumed exactly the proof reply and is ready for the next request.
pub async fn prove_on_stream<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S, host: &str, port: u16, token: &str) -> Result<(), ProofError> {
    let nonce = fresh_nonce();
    let req = format!(
        "GET /__vibesquad/local-proof?c={} HTTP/1.1\r\nHost: {}\r\nConnection: keep-alive\r\nAccept: application/json\r\n\r\n",
        nonce, host
    );
    let fail = |m: String| ProofError::ProofFailed(format!("the listener on {} {}; the local token was not sent", host, m));
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| ProofError::Unreachable(format!("no VibeSquad server on {} ({})", host, e)))?;
    let (status, body) = match read_http1_response(stream).await {
        Ok(r) => r,
        Err(e) => return Err(fail(format!("did not answer the local-token proof ({})", e))),
    };
    if status != 200 {
        return Err(fail(format!("did not prove it is this install's VibeSquad server ({})", status)));
    }
    let want = local_proof(token, &nonce, port);
    let got = proof_field(&body).and_then(|p| hex_decode_32(&p)).unwrap_or([0u8; 32]);
    if !ct_eq(&got, &want) {
        return Err(fail("failed the local-token proof".to_string()));
    }
    Ok(())
}

/// Dials `host` (an exact loopback host, `is_local_host` already checked by the caller), runs the proof on that
/// socket, and returns it proven. The whole exchange is bounded by [`PROOF_TIMEOUT`].
pub async fn dial_proven(host: &str, token: &str) -> Result<TcpStream, ProofError> {
    let port = host_port(host);
    let dial_target = if host.contains(':') || host.starts_with('[') { host.to_string() } else { format!("{}:{}", host, port) };
    let mut stream = match tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect(dial_target.as_str())).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(ProofError::Unreachable(format!("no VibeSquad server on {} ({})", host, e))),
        Err(_) => return Err(ProofError::Unreachable(format!("no VibeSquad server on {} (connect timed out)", host))),
    };
    let _ = stream.set_nodelay(true);
    match tokio::time::timeout(PROOF_TIMEOUT, prove_on_stream(&mut stream, host, port, token)).await {
        Ok(Ok(())) => Ok(stream),
        Ok(Err(e)) => Err(e),
        // Accepted the socket, then went quiet: not "server down" (something holds the port), so fail closed.
        Err(_) => Err(ProofError::ProofFailed(format!(
            "the listener on {} did not answer the local-token proof in time; the local token was not sent",
            host
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    const TOKEN: &str = "abababababababababababababababababababababababababababababababab";

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }

    #[test]
    fn local_proof_matches_the_node_server() {
        // node -e 'createHmac("sha256","ab".repeat(32)).update("vs-local-proof\0"+nonce+"\x004180").digest("hex")'
        let got = local_proof(TOKEN, "0123456789abcdef0123456789abcdef", 4180);
        assert_eq!(hex(&got), "7be4843278cb8168fb7fd0aba8a9152f7ec7aaf287275f4376ce6e5e47045ea4");
        // The port is part of the MAC: a relay from another port cannot reuse an answer.
        assert_ne!(local_proof(TOKEN, "0123456789abcdef0123456789abcdef", 4181), got);
        assert_ne!(local_proof(TOKEN, "0123456789abcdef0123456789abcdef", 418), got);
    }

    #[test]
    fn host_port_reads_every_loopback_shape() {
        assert_eq!(host_port("127.0.0.1:4180"), 4180);
        assert_eq!(host_port("localhost:9"), 9);
        assert_eq!(host_port("[::1]:4180"), 4180);
        assert_eq!(host_port("localhost"), 80);
        assert_eq!(host_port("[::1]"), 80);
    }

    #[test]
    fn nonce_is_32_hex_and_fresh() {
        let a = fresh_nonce();
        let b = fresh_nonce();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn read_http1_response_frames_content_length_and_chunked_and_refuses_the_rest() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        b.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\nhello").await.unwrap();
        let (status, body) = read_http1_response(&mut a).await.unwrap();
        assert_eq!((status, body.as_slice()), (200, &b"hello"[..]));

        b.write_all(b"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n").await.unwrap();
        let (status, body) = read_http1_response(&mut a).await.unwrap();
        assert_eq!((status, body.as_slice()), (404, &b"abcde"[..]));

        // Two responses glued together: the second one was never requested, so the stream is not reusable.
        b.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nxHTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        assert!(read_http1_response(&mut a).await.unwrap_err().contains("extra bytes"));

        let (mut a, mut b) = tokio::io::duplex(4096);
        b.write_all(b"SSH-2.0-OpenSSH\r\n\r\n").await.unwrap();
        assert!(read_http1_response(&mut a).await.unwrap_err().contains("status line"));
        drop(b);
        let (mut a, b) = tokio::io::duplex(4096);
        drop(b);
        assert!(read_http1_response(&mut a).await.unwrap_err().contains("closed"));
    }

    /// Gemini R1 L1: a chunk size near usize::MAX must be a plain "too large" error, never an overflow panic
    /// (debug) or a wrapped-past-the-cap slice panic (release). First reply is the exact crafted one from the review.
    #[tokio::test]
    async fn read_chunked_refuses_an_overflowing_chunk_size_without_panicking() {
        for reply in [
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\nffffffffffffffff\r\nx"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\nx"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nfffffffffffffffe\r\nx"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10001\r\nx"[..], // 64 KiB + 1: over the cap
            &b"HTTP/1.1 200 OK\r\nContent-Length: 18446744073709551615\r\n\r\nx"[..],
        ] {
            let (mut a, mut b) = tokio::io::duplex(4096);
            b.write_all(reply).await.unwrap();
            drop(b);
            let err = read_http1_response(&mut a).await.unwrap_err();
            assert!(err.contains("too large"), "{:?}: {}", String::from_utf8_lossy(reply), err);
        }
        // A 17-digit hex size does not even parse as usize: still a plain error.
        let (mut a, mut b) = tokio::io::duplex(4096);
        b.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1ffffffffffffffff\r\nx").await.unwrap();
        drop(b);
        assert!(read_http1_response(&mut a).await.unwrap_err().contains("bad chunk size"));
        // Through the proof path such a reply is ProofFailed, not a task panic.
        let (host, _) = raw_listener(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\nffffffffffffffff\r\nx").await;
        assert!(matches!(dial_proven(&host, TOKEN).await, Err(ProofError::ProofFailed(m)) if m.contains("did not answer the local-token proof")));
    }

    /// A listener that writes `reply` verbatim to every connection.
    async fn raw_listener(reply: &'static [u8]) -> (String, u16) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf).await;
                let _ = s.write_all(reply).await;
            }
        });
        (format!("127.0.0.1:{}", port), port)
    }

    /// A listener that answers the proof route with `answer(nonce, port)` and then echoes a second request,
    /// so a test can show the proof and the follow-up ride the same socket.
    async fn listener(answer: impl Fn(&str, u16) -> String + Send + 'static) -> (String, u16) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                let (r, mut w) = s.split();
                let mut r = tokio::io::BufReader::new(r);
                let mut requests = 0;
                loop {
                    let mut line = String::new();
                    if tokio::io::AsyncBufReadExt::read_line(&mut r, &mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let mut h = String::new();
                    while tokio::io::AsyncBufReadExt::read_line(&mut r, &mut h).await.unwrap_or(0) > 2 {
                        h.clear();
                    }
                    requests += 1;
                    let body = if let Some(c) = line.strip_prefix("GET /__vibesquad/local-proof?c=") {
                        let nonce = c.split_whitespace().next().unwrap_or("").to_string();
                        answer(&nonce, port)
                    } else {
                        format!("{{\"echo\":{},\"line\":{:?}}}", requests, line.trim())
                    };
                    let _ = w.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).as_bytes()).await;
                }
            }
        });
        (format!("127.0.0.1:{}", port), port)
    }

    #[tokio::test]
    async fn real_server_proves_and_the_next_request_rides_the_same_socket() {
        let (host, _port) = listener(|nonce, port| format!("{{\"proof\":\"{}\",\"port\":{}}}", hex(&local_proof(TOKEN, nonce, port)), port)).await;
        let mut stream = dial_proven(&host, TOKEN).await.expect("proof passes");
        stream.write_all(format!("GET /second HTTP/1.1\r\nHost: {}\r\n\r\n", host).as_bytes()).await.unwrap();
        let (status, body) = read_http1_response(&mut stream).await.unwrap();
        assert_eq!(status, 200);
        // `echo: 2` = the second request on the connection that carried the proof (not a fresh dial).
        assert!(String::from_utf8_lossy(&body).contains("\"echo\":2"), "{}", String::from_utf8_lossy(&body));
    }

    #[tokio::test]
    async fn wrong_key_wrong_port_replay_and_non_server_all_fail_closed() {
        let other = "cd".repeat(32);
        let (host, _) = listener(move |nonce, port| format!("{{\"proof\":\"{}\"}}", hex(&local_proof(&other, nonce, port)))).await;
        assert!(matches!(dial_proven(&host, TOKEN).await, Err(ProofError::ProofFailed(m)) if m.contains("failed the local-token proof") && m.contains("not sent")));

        // Relay through another port: the right key, the wrong port in the MAC.
        let (host, _) = listener(|nonce, port| format!("{{\"proof\":\"{}\"}}", hex(&local_proof(TOKEN, nonce, port.wrapping_add(1))))).await;
        assert!(matches!(dial_proven(&host, TOKEN).await, Err(ProofError::ProofFailed(_))));

        // Replay of a proof for an old nonce.
        let stale = hex(&local_proof(TOKEN, "0123456789abcdef0123456789abcdef", 4180));
        let (host, _) = listener(move |_, _| format!("{{\"proof\":\"{}\"}}", stale)).await;
        assert!(matches!(dial_proven(&host, TOKEN).await, Err(ProofError::ProofFailed(_))));

        // Something that answers 200 with no proof at all, and a malformed proof.
        let (host, _) = listener(|_, _| "{\"ok\":true}".to_string()).await;
        assert!(matches!(dial_proven(&host, TOKEN).await, Err(ProofError::ProofFailed(_))));
        let (host, _) = listener(|_, _| "{\"proof\":\"zz\"}".to_string()).await;
        assert!(matches!(dial_proven(&host, TOKEN).await, Err(ProofError::ProofFailed(_))));

        // Nothing listening: unreachable, the one error a caller may treat as "server down".
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let r = dial_proven(&format!("127.0.0.1:{}", port), TOKEN).await;
        assert!(matches!(r, Err(ProofError::Unreachable(_))), "{:?}", r);
    }

    /// Against the real Node server on this PC (`cargo test -- --ignored live_server`): the formula, the framing
    /// (Content-Length + keep-alive) and the port binding all line up end to end. Skips when no server is up.
    #[tokio::test]
    #[ignore]
    async fn live_server_passes_the_proof_and_keeps_the_socket_open() {
        let Some(token) = crate::read_local_token(&crate::default_local_token_file()) else {
            eprintln!("skip: no local token on this PC");
            return;
        };
        let port = std::env::var("VIBESQUAD_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(4180);
        let host = format!("127.0.0.1:{}", port);
        let mut stream = match dial_proven(&host, &token).await {
            Ok(s) => s,
            Err(ProofError::Unreachable(m)) => {
                eprintln!("skip: {}", m);
                return;
            }
            Err(e) => panic!("{}", e),
        };
        stream.write_all(format!("GET /api/auth/status HTTP/1.1\r\nHost: {}\r\n\r\n", host).as_bytes()).await.unwrap();
        let (status, body) = read_http1_response(&mut stream).await.unwrap();
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    }

    #[tokio::test]
    async fn a_listener_that_never_answers_is_a_failed_proof_not_a_down_server() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
            drop(s);
        });
        let r = dial_proven(&format!("127.0.0.1:{}", port), TOKEN).await;
        assert!(matches!(r, Err(ProofError::ProofFailed(m)) if m.contains("in time")));
    }
}
