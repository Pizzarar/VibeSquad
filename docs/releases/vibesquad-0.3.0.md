# Release record: VibeSquad v0.3.0 (stable, Windows only)

| Field | Value |
| --- | --- |
| Version | 0.3.0 |
| Channel | stable |
| Frozen commit | `22d924d` (master, 2026-11-11) |
| Release commits | `10b6675` (`release: vibesquad 0.3.0 (stable) version bump, frozen from 22d924d`) + `546e45f` (`release: vibesquad 0.3.0 test/hygiene fixes and Boring Mode B4 credit`) on `release/vibesquad-0.3.0`, plus merges `ad86f60` and `1e09283` landing the v0.2.8 and v0.2.9 release records; built/tested commit = `546e45fe8f` (build stamp, audit B8) |
| Requester | Release Desk lead Rele5 (rn-cd9dc6ddfea4) |
| Approval | the owner; publish is ordered by Rele5, not by this record |
| Release URL | not yet published (this record is written before the tag) |
| Range | `v0.2.9..22d924d`: 242 commits, 86 merges |

Windows only. No Authenticode (no Azure Trusted Signing yet, owner waiver; `NO-AUTHENTICODE` marker): updater-signed with minisign only. `latest.json` is Windows-only (`windows-x86_64` is its only platform entry). No Android APK was built or attached.

## BREAKING: `VS_AGENT_TOKEN`
Agent identity is now a per-agent token (X1a-X1d). The runner mints `VS_AGENT_TOKEN` for each agent (memory only, never in argv, JSONL, `runner.json` or logs) and every CLI/MCP/server write from an agent shell must carry it.
- An agent id without its token is refused with 403 **before anything is sent** (`vs log`, `vs inbox triage`, `vs restart`, `vs archive`, `vs inspect`, MCP tools). The `VS_AGENT_TOKEN_REQUIRED` client fallback is gone.
- A leftover `VS_AGENT_TOKEN` with the agent id cleared is never treated as the owner.
- Custom scripts, wrappers or hand-launched agents that call `vs` / the VS API with an agent id but without the runner-issued token will now get 403. Run them as the owner (no agent id, no token) or launch them through the runner so the token is injected.
- Every CLI/MCP token sender first proves the loopback listener over the same socket (HMAC proof) before sending any token, so a rogue listener on the port never receives it.

## Tests (at 546e45f, full `npm test -- --queue`)
`tests 3477 / suites 220 / pass 3466 / fail 0 / cancelled 0 / skipped 11 / todo 0` (duration 108.2 s, exit 0). The known pre-existing flake `test/runner-park-bg-child.test.mjs` ("real process"), which also fails on clean master, passed in this run. Code under `server/`, `runner/`, `src/` and `src-tauri/src/` is byte-identical between the freeze `22d924d` and `546e45f` (`git diff --stat` empty), so the Tier A evidence at the freeze carries over.

## Build
`node server/release.mjs build --channel stable --commit 546e45f --no-authenticode` (built 2026-11-12 04:09Z). Build stamp `546e45fe8f` equals the release commit (audit B8). The updater signature verifies against the unchanged pubkey (audit B7, minisign Ed25519). The updater key and the Windows signing secrets never entered the review or this record.

## Artifacts (SHA-256)
| File | SHA-256 |
| --- | --- |
| VibeSquad-setup.exe (34,491,013 bytes) | `13431677c9de7bea5c796e7699a20c70579effd646fb7bea00e1b4eb3b247861` |
| VibeSquad-setup.exe.sig | `2cd464e20448bb2d8c103d0426f58c8ba06e656c20c1ad1303f8ae6b1fb864e1` |
| latest.json | `c703a0045e2db71f781ded876a0587249e6bf1ed5f7654f2a12dd3bc6ee458de` |
| THIRD-PARTY-LICENSES.txt | `714f31ae6e8a07a2598740894cd47f1497971e3d9af1c4e3fece68dcf5ccc2b2` |
| NO-AUTHENTICODE (marker, not published) | `8c1c3f6a4e24034b9b1a25b512bf8f0cac8bcfe5c26fd5ad5c6e08ba5b02bb40` |

## Audit B1-B9
Command: `node scripts/release-audit.mjs --from v0.2.9 --commit 546e45f --artifacts dist-desktop --pubkey-config src-tauri/tauri.conf.json`. The script exits non-zero on the B1/B2 keyword hits below; both were hand-triaged to PASS using the same method as 0.2.9.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| B1 | secrets in diff + tree | PASS (triaged; script FAIL High on keyword hits) | Script: 89 keyword hits (S5 `sk-` x15, S3 `pass:` x55, S2 storepass x16, S4 x3). Same classes as 0.2.9: prose and identifiers (`task-id` placeholder `src/TeamActions.tsx:391`, `task-`/`disk-` text, CSS), `pass:` boolean fields and comments ("always pass", "boot pass"), `-storepass:env` keytool argument names in `scripts/rotate-android-keystore.mjs`, `AZURE_CLIENT_SECRET: clientSecret(d)` resolved at run time in `scripts/sign-windows.mjs:135`, regex guards in tests, release records quoting the patterns. Value-shaped sweep of the tracked tree (`AKIA`, `gh*_`, `xox*`, `AIza`, long `sk-`, JWT shape, `BEGIN ... PRIVATE KEY`): 0 hits. gitleaks not installed: SKIP. |
| B2 | secrets/personal data in artifacts | PASS (triaged; script FAIL High on keyword hits) | 9 keyword hits in the staged `runtime/`: `runner/runner.mjs:59,811,832` (comments: "never pass", "boot pass"), `server/auth.mjs:723` (comment "always pass"), `server/providers-catalog.mjs:437` (`pass:` boolean field), `server/build-android.mjs:170-171` (`storePass = resolveKsSecret(...)`, no literal), plus 2 further `pass:`/storepass lines of the same classes. Value-shaped sweep of the staged runtime and `dist/`: 0 hits. Personal-pattern sweep SKIP (no pattern file); installer interior not swept (7z not installed), as in 0.2.8/0.2.9. The 0.2.8/0.2.9 Low (build checkout path in `build-stamp.json`) is closed: the stamp has no local path (B8). |
| B3 | telemetry / PII | PASS (manual) | 8 "new hosts" are inert: `pizzarar.github.io` (README links), `cdn.tailwindcss.com`, `fonts.googleapis.com`, `fonts.gstatic.com`, `cdnjs.cloudflare.com` (all only in `public/how-it-works.html`, a static explainer page served to the reader's own browser, no app code loads them), `app.example` and two further example hosts (test fixtures `test/relay-connect.test.mjs`). `server/push.mjs` redirects are no longer followed (X1 F10). No analytics or telemetry SDK. |
| B4 | network exposure | PASS (script + manual) | Script: no new `0.0.0.0` binds or route/upgrade handlers in the diff. Manual review with file:line below: no High or Critical, one Low, one Info. |
| B5 | dependencies | PASS / SKIP | No `^`/`~` ranges in `package.json` (count 0); `@tauri-apps/plugin-deep-link` pinned exactly: `package.json:30` `"2.6.3"`, `package-lock.json:15` and `:626-627` (2.6.3), `src-tauri/Cargo.lock:4213-4214` (2.6.3). `npm audit`: 0 critical / 0 high / 0 moderate / 0 low. cargo-audit not installed: SKIP. License allowlist (`generate-licenses.mjs`) ran clean during the build. |
| B6 | permissions/capabilities | PASS | Script: no capability, manifest permission or CSP changes in the diff. |
| B7 | update + signing integrity | PASS | Logged PASS 2026-11-12 06:57Z by the desk on runtime `f736924` (= `22d924d` + idea-162 `d6c7171`/`66ea7a7` + 2 docs commits `5d9efdc`/`f736924`): runner 39244 and server 46796 alive, HTTP 200 on :4180. Script: pubkey unchanged vs v0.2.9; 1 endpoint, https on github.com; `latest.json` signature equals `.sig`; URLs https on the updater repo; minisign Ed25519 verified against the pubkey for `VibeSquad-setup.exe`. Open Low (carried from 0.2.9, tracked as unit `rd-updater-key-pw`): the updater key has no password. |
| B8 | provenance | PASS | HEAD == `546e45f`; build stamp `546e45fe8f` == commit; no local path in the stamp; tree clean; version 0.3.0 in `package.json` / `tauri.conf.json` / `latest.json`; `latest.json` has only `windows-x86_64`; SHA-256 of every file in the table above. |
| B9 | credits | PASS | `CREDITS.md` "Community Accolades (v0.3)" (`:30-39`) carries the Boring Mode B1, B2, B3, B2r, B2r round 1 and B4 lines (Antigravity by Google DeepMind, Claude Code by Anthropic) and the relay line (@noble/curves by Paul Miller); `546e45f` adds the missing B4 line, so it is in the shipped licenses file too. No source is named for Phone Cockpit and none is invented. Vibe-only inspiration gets no credit. |

### B4 notes (network / identity / pairing / relay), with file:line at 546e45f
Method: route-string sets of `server/vibesquad-api.mjs` and `server/auth.mjs` diffed v0.2.9 vs the freeze, then runner, runner-api, Rust proxy and relay diffs read by hand. Lines re-checked against 546e45f.

- **Listeners.** The VS server binds loopback only by default (`server/serve.mjs:488` `server.listen(port, "127.0.0.1")`); LAN/Meshnet stay opt-in (`:511`). The runner binds 127.0.0.1 on an ephemeral port. The desktop proxy is unchanged (127.0.0.1:4189, fallback port 0; all new `TcpListener::bind` sites are in `#[cfg(test)]`). No new `0.0.0.0` binds.
- **New routes.** `GET /__vibesquad/local-proof` (loopback only, answers an HMAC over nonce and local port, so it leaks no token), `GET /pair/status` (scoped to the caller's own `vs_device` cookie), `GET /__vibesquad/pair/pending` and `POST /__vibesquad/pair/approve` (owner-gated; only the minting device may decide; audit-logged without token, hash or code), runner `GET /verify-agent` (agent headers required), runner `POST /agents/:id/unwedge` (admin bearer only).
- **X1 per-agent tokens.** `randomBytes(32)` hex, minted once per agent id per runner lifetime (`runner/runner.mjs:301` `tokenFor`), held in memory only, redacted from the log store, delivered only as the child's `VS_AGENT_TOKEN` env var (Claude `.mcp.json` holds the literal `${VS_AGENT_TOKEN}`; ACP gets it in the in-memory `session/new` env), never in argv. Verified in constant time; refused for gone, exited, archived, retired or orphan agents. A request naming an agent is never the owner; a bad or missing token is `denied(403)` and a runner that cannot answer is 503, never an owner fallback (`server/auth.mjs:846` `resolveCaller`; middleware returns `caller.status`, `server/vibesquad-api.mjs:1662`). Clients refuse before any socket opens (`server/mcp/tools.mjs` `agentHeaders`, `server/backend/runner-client.mjs` `authHeadersFor`). Live check by the desk worker: 0 hits of its own token in the command lines of all 434 running processes and in 3592 files under `~/.vibesquad/runner` and `~/.vibesquad/logs` (counts only).
- **Cross-Squad Overlord input.** `crossSquadInput` (`runner/runner.mjs:127`) lets only an Overlord send input to a live lead (an Overlord or lane lead) of a different Squad; never a worker, Buddy or an exited/archived/retired/orphan lead. Cancel, archive, config and meta stay same-Squad. The sender id comes from the verified caller and `owner` is forced false (`runner/server.mjs:194-205`); every cross-Squad send is written as a `decision` `xsquad input <from> (<squad>) -> <to> (<squad>)` entry to the sender's team log.
- **E5 relay links OFF by default.** `normalizeRelaySettings` returns null unless `relay.endpoint` is a `wss://` URL (`server/user-settings.mjs:201`, applied `:195-196`); `startRelayFromSettings` returns null without a relay (`server/relay-wiring.mjs:215`, started from `server/serve.mjs:541`); `saveUserSettings` never takes `relay` from a patch, so no HTTP caller can enable it; no hosted relay ships. The pairing link is offered only while the relay is running on a `wss://` endpoint (`relayPairingFor`, `server/auth.mjs:1118-1127`). Link format `vibesquad://pair#hostId=&pub=&relay=&code=` keeps everything in the fragment and publishes only origin+path of the endpoint (`server/relay-link.mjs:35`). The code is the one-time pair code: `randomInt(100_000, 1_000_000)` (`server/auth.mjs:1099`, about 19.8 bits), TTL 5 minutes (`CODE_TTL_MS = 300_000`, `:16`), one live code per minter, deleted on any redeem. Redeem limits: 5 attempts per session and 10 host-wide, then all codes are burned and a needs-you entry is raised (`server/relay-tunnel.mjs:556` and following); LAN redeem has a per-IP throttle with exponential lock. **Low:** about 20 bits is guessable only inside those limits; acceptable for a 5-minute one-shot code, noted for the record.
- **E4b origin check.** `cookieWriteRefusal` (`server/auth.mjs:725`): safe methods pass; with an `Origin` header it must equal the listener's own scheme://Host; without one `Sec-Fetch-Site` must be absent, `none` or `same-origin`; otherwise 403. Enforced at the trust gate (`server/vibesquad-api.mjs:1645`) and the not-owner write gate (`:1664`, never for agent callers).
- **Cockpit settings and provider switcher (E1c).** No new server routes. The only `fetch` in `src/PhoneCockpit.tsx` is the existing owner-only `POST /__vibesquad/restart-runner` (`:62`); the Psycho/Corpo toggle and default-provider toggle are client prefs / localStorage with no network; a Buddy switch uses `POST /__vibesquad/brainstorm-restart` and a lead switch the existing `/__vibesquad/lead-handoff` flow, both owner-gated (a paired device is the owner) and role/lane-checked for agents.
- **Info.** A verified agent can read any agent's runner status and timeline (`GET /agents`, `/agents/:id`, `/agents/:id/timeline` have no scope check, `runner/server.mjs:180-195`). Inside the accepted same-OS-user limit (`SECURITY.md`).

## Findings
- Critical: none. High: none.
- Medium: none.
- Low: updater minisign key has no password (carried from 0.2.9, unit `rd-updater-key-pw`); relay pair code is about 20 bits (limited by redeem throttles and a 5-minute TTL); the installer interior is not swept for secrets (7z not installed).
- Info: agent-readable runner status (above).

## Release notes
# VibeSquad v0.3.0

**BREAKING: `VS_AGENT_TOKEN`.** Agents now identify themselves with a per-agent token that the runner injects. Scripts that call `vs` or the VS API with an agent id but without the token get 403. See the BREAKING section above.

### Identity and security (X1)
- X1a-X1d: per-agent identity tokens (memory only), default-deny agent write gate with role checks, clients refuse before sending, loopback prove-local proof before any token is sent (CLI, MCP and the desktop proxy), no Paseo identity shortcuts.
- Cookie-authenticated writes need a same-origin proof (E4b); phone-minted pairing with two-step confirm and cascade revoke.
- Squad Overlords may send input to another Squad's live leads and Overlord (audited in the sender's team log).

### Phone Cockpit and relay
- Phone Cockpit settings overlay, Psycho/Corpo toggle and a 1-tap Claude <-> Gemini provider switcher (E1c); drawer lists every pinned lane.
- E5 outbound end-to-end encrypted relay is wired in but **off by default** (opt-in by a hand-edited `wss://` endpoint, no hosted relay, never local-trusted); relay pairing links, pinned connect path, `vs host-key rotate`.

### Boring Mode (Normal / Psycho)
- Boring Mode B1-B4: whole-app ADE shell, card-grid dashboards, compact corporate header, first-launch "Choose your layout" picker and 4K polish.

### Runner, restarts and watching
- Restarts never cut or wedge agents: prompt-less resumes are settled and verified, mid-turn agents continue their turn, `vs restart` holds for background work.
- `vs watch add|list|cancel` (+ MCP `watch`), one at-most-once ping per set; `npm test` lock with FIFO `--queue`; digests dedupe (one per worker turn, replayed turns skipped).
- `vs worktree create` junctions `node_modules`; sweep unlinks it safely. First Buddy start, send redirects to successors, stakes ladder default for security work is Opus.

### Docs and hygiene
- README, guide (Modes, restart-safe runner, pairing) and SECURITY.md refreshed; interactive "How It Actually Works" explainer; `docs/WORKFLOWS.md` index.
- Packaged `build-stamp.json` no longer embeds the build checkout path; the licenses file is generated deterministically.

### Credits
- Implemented Boring Mode B1-B4 — Thanks to Antigravity by Google DeepMind and Claude Code by Anthropic
- Implemented outbound E2EE relay hardening — Thanks to @noble/curves by Paul Miller (paulmillr)
- Earlier accolades are listed in `CREDITS.md`.

Windows only. Updater-signed (minisign); no Authenticode yet. Android is not part of this release.
