# E5 Relay Pairing Links & Pinned Connect Path · Tier A Security Review R1 (`unit-and-e5-relay-links` @ `0c28094`)

VERDICT: FAIL 0H/2M/3L

- **Branch / Commit**: `unit-and-e5-relay-links` (`0c28094`, `git diff master...HEAD`)
- **Context**: `docs/lanes/android-app/E5_THREAT_MODEL.md` (rev 4, §7 item 8, §11)
- **Cause-vs-symptom gate**: **Fixes the cause** (enforces self-certifying `hostId` on links, resolves pins from storage before dialing, gates endpoint repointing behind an explicit confirmation callback, defers persistence until after a pinned handshake + redeem/auth succeed, and builds `#fragment`-only links from `publicRelayEndpoint`). Fails R1 on two Medium host-fold / pin-association bugs and three Low issues detailed below.

---

## Verification of Security Intent & Hunt Targets

| Hunt Target / Requirement | Status | Evidence |
|---|---|---|
| `PairDeviceModal` shows relay links only when relay is running; `relay=` uses `publicRelayEndpoint` | **PASS** | `server/auth.mjs:1119-1130` (`relayPairingFor`) returns `null` unless `st.running === true` and `st.endpoint` is `wss://`; strips userinfo/query/fragment via `publicRelayEndpoint` (`server/relay-link.mjs:17-20, 35-50`). `src/PairDeviceModal.tsx:471` renders the card only when `pair?.relay?.link && remainingSec > 0`. |
| Client connect path uses `relayPinFor`; pinned key always wins over link; mismatch raises `RelayPinMismatchError` with plain error | **PASS** | `src/remoteRelayConnect.ts:80-88` validates `acceptPairingFragment(f)`, reads `relayPinFor(f.hostId, store)`, throws `RelayPinMismatchError` on key mismatch (`!sameRelayKey(stored.pubKey, f.pub)`), and dials with `d.pin.pubKey` (`src/remoteRelayConnect.ts:123`). Plain error mapped in `src/remoteRelayConnect.ts:171-172`. |
| E4a host id and relay id fold into one `hosts[]` entry | **FAIL (M1, M2)** | LAN→Relay folds in `src/remoteRelayConnect.ts:151-158` + `src/remoteSession.ts:466-498`, but see **M1** (LAN re-pair at same address copies old PC's `relay` pin onto a new PC) and **M2** (`foldRelayHost` ignores `caFp` on cloned `~/.vibesquad` hosts, and Relay→LAN order fails to fold). |
| Repointing a known host's relay endpoint requires user confirm (X1 E5 L2); not bypassable, defaults to no | **PASS** | `src/remoteRelayConnect.ts:90-92` defaults `yes` to `false` when `confirmRepoint` is omitted or returns non-`true`, keeping `stored.endpoint`. `src/remoteSession.ts:444` only updates `endpoint` when `opts.repoint` is truthy. `src/RemotePairScreen.tsx:161-163` prompts via `window.confirm`. |
| Relay stays off by default; no HTTP route can set relay settings or status provider | **PASS** | `server/auth.mjs:1113` defaults `relayStatusProvider = null`; `server/vibesquad-api.mjs:455-458` wires it only from `setRelayStatus` (called by `server/serve.mjs:543` when `settings.json` has `relay.endpoint`). |
| Pairing code / secrets leaking to server via query, log, or history | **FAIL (L1)** | Link puts all params in `#fragment` (`server/relay-link.mjs:49-50`); `remoteRelayTransport.ts:214-229` strips the fragment via `history.replaceState`. However, `src/main.tsx:1` imports `src/diagOverlay.ts` before `remoteRelayTransport.ts`, logging `location.href` at boot before the fragment is stripped (see **L1**). |
| XSS from link params | **PASS** | `src/PairDeviceModal.tsx:480-486` and `src/RemotePairScreen.tsx:373-396` render link/endpoint/error fields as React text children; `qrSvg` is generated server-side by `server/qr.mjs:51-60` as a path-only SVG matrix. |
| New HTTP routes exposing relay endpoint or host key to unauthenticated callers | **PASS** | No new HTTP routes. `POST /__vibesquad/pair/start` (`server/auth.mjs:1311-1315`) requires `localOwner` or authenticated paired `minter` (403 otherwise). `GET /api/auth/status` (`server/vibesquad-api.mjs:466`) omits `relay` for `!isTrusted(req)`. |

---

## Findings

### [M1] `saveSession` and `setSessionHostId` carry a previous PC's `relay` pin and bearer token onto a different PC at the same LAN address
- **Severity**: Medium
- **Files**: `src/remoteSession.ts:287-298`, `src/remoteSession.ts:307-320`
- **Evidence**:
  In `saveSession` (`src/remoteSession.ts:287-298`):
  ```ts
  const me = { hostId: id, caFp: fp };
  const same = prev?.hosts.find((x) => x.meshnetHost === h) ?? prev?.hosts.find((x) => samePc(x, me));
  const hosts = prev?.hosts.filter((x) => x !== same && x.meshnetHost !== h && !samePc(x, me)) ?? [];
  const entry: StoredRemoteHost = {
    ...same,
    hostId: id || same?.hostId || "",
    label: same?.label && same.label !== same.meshnetHost ? same.label : h,
    meshnetHost: h,
    savedAt: now.toISOString(),
  };
  if (fp) entry.caFp = fp;
  else if (id && same?.hostId && same.hostId !== id) delete entry.caFp; // a new PC behind the same address: the old pin is not its pin
  ```
- **Impact**:
  1. Suppose PC 1 (`hostId: E4A_1, caFp: FP_1`) was paired at `192.168.1.20:4180` and folded with its relay pin `relay: { hostId: ID_1, pubKey: PUB_1, token: TOK_1 }`.
  2. Later, a different PC 2 (`hostId: E4A_2, caFp: FP_2`) is at `192.168.1.20:4180` (e.g., DHCP lease change or a fresh `~/.vibesquad` install) and the user pairs with PC 2 over LAN.
  3. `same` matches PC 1's entry by `x.meshnetHost === h`, and `...same` copies PC 1's `relay` pin (`ID_1`, `PUB_1`, `TOK_1`) onto PC 2's entry (`hostId: E4A_2, caFp: FP_2`). While line 297 clears `entry.caFp` for a new PC behind the same address, `entry.relay` is never cleared.
  4. Furthermore, if the user subsequently scans PC 2's own relay pairing link (`ID_2`, `PUB_2`), `foldRelayHost(ID_2, E4A_2)` (`src/remoteSession.ts:484`) sees `lan.relay.pubKey === PUB_1 !== PUB_2` and refuses to fold, leaving PC 2's entry permanently stuck with PC 1's relay pin.
  5. The same stale-pin carry happens in `setSessionHostId` (`src/remoteSession.ts:315`) when `s.hosts[i].hostId` was already set to `E4A_1` and changes to `E4A_2`.
- **Fix**:
  In `saveSession`, if `same` has a conflicting identity (`(id && same.hostId && same.hostId !== id) || (fp && same.caFp && same.caFp !== fp)`), delete `entry.relay` (just as `entry.caFp` is cleared/replaced). In `setSessionHostId`, if `s.hosts[i].hostId && s.hosts[i].hostId !== id`, delete `merged.relay`.

### [M2] `foldRelayHost` matches on the public `e4aHostId` alone (ignoring `caFp` on cloned `~/.vibesquad` hosts), and Relay-first → LAN-second pairing fails to fold
- **Severity**: Medium
- **Files**: `src/remoteSession.ts:287`, `src/remoteSession.ts:466-498`, `src/remoteRelayConnect.ts:151-158`
- **Evidence**:
  In `src/remoteSession.ts:216-222` (`samePc`, X1 R1 L2), two entries are treated as the same PC only when **both** `hostId` and `caFp` match, because `hostId` is public (`GET /api/auth/status`) and shared when `~/.vibesquad` is cloned across two machines.
  However, in `foldRelayHost` (`src/remoteSession.ts:475`):
  ```ts
  const li = s.hosts.findIndex((h, j) => j !== ri && h.hostId === hid);
  ```
  And in `connectWithRelayLink` (`src/remoteRelayConnect.ts:151-158`):
  ```ts
  const st = (await (await client.fetch("/api/auth/status")).json()) as { hostId?: unknown; relay?: { hostId?: unknown; pub?: unknown } | null } | null;
  const e4a = normalizeHostId(st?.hostId);
  const self = st?.relay;
  if (e4a && self && self.hostId === f.hostId && typeof self.pub === "string" && sameRelayKey(self.pub, d.pin.pubKey)) {
    foldRelayHost(f.hostId, e4a, store);
    hostId = e4a;
  }
  ```
- **Impact**:
  1. **Cross-PC fold on cloned `~/.vibesquad` (or spoofed `hostId` from a second relay host)**: If the phone has two saved LAN PCs sharing `E4A_ID` with different CA pins (`clone.example` with `FP_B` at `hosts[0]`, `home.example` with `FP_A` at `hosts[1]`, as tested in `test/android-pair.test.mjs:516-528`) and the user pairs over relay with `home.example` (`ID_A`), `foldRelayHost` matches `hosts[0]` (`clone.example`, `FP_B`) because it ignores `caFp`, attaching `home.example`'s relay pin onto `clone.example`. Similarly, if PC 1 (`E4A_1, FP_1`) has no relay pin yet and the user pairs over relay with a second PC (`ID_B, PUB_B`) that reports `hostId: E4A_1` with a different `caFingerprint` (`FP_2`), PC 2's relay pin folds into PC 1's LAN entry.
  2. **Relay-first → LAN-second never folds**: If the user pairs with a PC over the **relay first**, `foldRelayHost` updates `hosts[0].hostId = E4A_A` while `hosts[0].caFp` remains `undefined`. When the user later pairs with the same PC over LAN (`saveSession(host, store, now, E4A_A, FP_A)`), `saveSession` (`src/remoteSession.ts:287`) checks `samePc(x, me)` which returns `false` because `hosts[0].caFp` is `undefined`. This creates a **second** entry in `hosts[]` with the same `hostId: E4A_A` (breaking the single-entry invariant, turning on `showHostSwitcher` for one PC, and making the second entry unreachable via `activeHostId`).
- **Fix**:
  `GET /api/auth/status` (`server/vibesquad-api.mjs:465-471`) already returns `caFingerprint.full` over the authenticated relay channel. Read `caFp = normalizeFp(st?.caFingerprint?.full)` in `connectWithRelayLink` and pass it into `foldRelayHost(f.hostId, e4a, store, caFp)`:
  - When updating a relay-only entry (`li < 0`), set `...(caFp ? { caFp } : {})` on the entry so a later LAN `saveSession` matches `samePc(x, me)` and folds in both pairing orders (Relay→LAN as well as LAN→Relay).
  - When searching for a LAN entry (`li`), require `(!h.caFp || (Boolean(caFp) && h.caFp === caFp))` (and store `caFp` on `merged`), preventing a cloned `~/.vibesquad` or a different-CA host from folding into a pinned LAN entry with a different `caFp`.

### [L1] `src/main.tsx` imports `diagOverlay.ts` before `remoteRelayTransport.ts`, logging `location.href` before `takePairingFragment` strips `#fragment`
- **Severity**: Low
- **Files**: `src/main.tsx:1, 10`, `src/diagOverlay.ts:47, 62`, `docs/lanes/android-app/E5_THREAT_MODEL.md:23-24`
- **Evidence**:
  `E5_THREAT_MODEL.md` §2 item 3 specifies: *"The entry module must import `remoteRelayTransport.ts` first so the fragment is stripped before any other module runs."*
  In `src/main.tsx`:
  ```ts
  1: import { diagStep } from "./diagOverlay"; // first import: installs the Android error overlay before any other module can throw
  ...
  10: import { RemotePairScreen } from "./RemotePairScreen";
  ```
  When `diagOverlay.ts` evaluates on Android (`src/diagOverlay.ts:47, 62`), it runs:
  ```ts
  diagStep(`boot ${win.location.href.replace(/([?&](?:code|fp|token)=)[^&#]*/gi, "$1…")}`);
  ```
  before `RemotePairScreen.tsx:8` imports `remoteRelayTransport.ts`.
- **Impact**:
  The full `#hostId=...&pub=...&relay=...` fragment is recorded into `diagLines()` before `takePairingFragment` strips it, and if `code=` is placed first in the hash (`#code=123456&hostId=...`), the regex `([?&](?:code|fp|token)=)` does not match `#code=`, recording the plaintext 6-digit pairing code in the on-screen diagnostic buffer.
- **Fix**:
  Import `./remoteRelayTransport` first in `src/main.tsx` (or strip/redact `#` fragments in `src/diagOverlay.ts:47` using `([?&#](?:code|fp|token)=)`).

### [L2] Relay-only pairings have no Forget UI in `RemotePairScreen` and cannot be removed by `forgetHost`
- **Severity**: Low
- **Files**: `src/remoteRelayConnect.ts:172`, `src/RemotePairScreen.tsx:83-85, 406-418`, `src/remoteSession.ts:339-347`
- **Evidence**:
  `relayConnectErrorMessage` (`src/remoteRelayConnect.ts:172`) instructs the user on `RelayPinMismatchError`:
  > `"This phone already trusts a different key for that PC, so the link was ignored. If the PC really changed its relay key, forget the PC here first, then use a new link."`
  However, `src/RemotePairScreen.tsx:84-85` gates `saved` on `activeMeshnetHost(session)` (`meshnetHost` only), and `forgetHost` (`src/remoteSession.ts:339-347`) normalizes its argument with `normalizeHost` and filters only by `x.meshnetHost !== h`.
- **Impact**:
  A phone paired with a PC over the relay only (`meshnetHost === undefined`) renders no `"Forget"` button on `RemotePairScreen` and cannot remove the entry via `forgetHost`, leaving no in-app way to follow the recovery instruction in `relayConnectErrorMessage`.
- **Fix**:
  Allow `forgetHost` to remove an entry by `meshnetHost`, `hostId`, or `relay.hostId`, and render a Forget button in `RemotePairScreen` when `activeHost(session)` is present even without `meshnetHost`.

### [L3] X1 E4b L1 parity: opening a relay link with a device-minted (`pending`) code on an already-paired phone overwrites its live token with an unapproved ticket
- **Severity**: Low
- **Files**: `src/remoteRelayConnect.ts:125-147`
- **Evidence**:
  On LAN (`server/auth.mjs:1366-1368`, X1 E4b L1), an already-paired device opening a pairing link keeps its live credential so a device-minted code cannot downgrade the owner's phone to a `pending` ticket or make it a cascade-revocable child of the minter.
  In `connectWithRelayLink` (`src/remoteRelayConnect.ts:125-147`), `if (code)` runs unconditionally and passes the resulting `token` to `saveRelayPin(..., { token })` even when `d.pin.token` already holds a working owner token and `r.pending === true`.
- **Impact**:
  If an already-paired phone opens a relay pairing link minted by another paired device (`requiresApproval` / `pending: true`), its active relay token is overwritten by the unauthenticated pending ticket.
- **Fix**:
  When `d.pin.token` already exists and `r.pending === true` (or if `d.pin.token` still authenticates), do not overwrite a live non-pending token with a pending ticket (or keep the existing token until approval completes).
