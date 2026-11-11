// Android APK pairing (PLAN_ANDROID_MESHNET.md A1): server address + 6-digit code, a pasted pairing link, a QR scan
// or a vibesquad://pair deep link. All of them end in the same step the paired-PC browser takes: open
// https://<host>/pair?code=… so the server sets the vs_device cookie and serves its own UI.
// E5 §7 item 8: a RELAY link (`vibesquad://pair#hostId=&pub=&relay=&code=`) instead pairs inside the E2EE relay channel
// (remoteRelayConnect.ts): pinned host key, stored token, one hosts[] entry per PC. The relay session UI itself is not
// built yet (E5 §7 item 6), so this screen only pairs and reports; LAN/Meshnet still opens the PC's own UI.
import { useCallback, useEffect, useRef, useState } from "react";
import { pairingFragment, type PairingFragment } from "./remoteRelayTransport"; // first: strips a #fragment from the URL before anything else runs
import { connectWithRelayLink, parseRelayPairingLink, relayConnectErrorMessage } from "./remoteRelayConnect";
import {
  activeMeshnetHost,
  fetchHostId,
  forgetHost,
  mapRemoteError,
  normalizeCode,
  normalizeFp,
  normalizeHost,
  pairRedeemUrl,
  parsePairInput,
  readSession,
  remoteError,
  saveSession,
  serverUrl,
  setSessionHostId,
  type RemoteError,
} from "./remoteSession";
import { diagStep } from "./diagOverlay";
import { createTrustClient, nativeTrust, type TrustClient } from "./vsTrust";

const PROBE_MS = 5000;

// Set before opening the server's UI: coming back (Android Back) shows the form with Forget instead of reopening again.
const OPENED_KEY = "vs.remote.opened";

// Inside the APK the WebView cannot verify the PC's own VS CA, so pinning and reachability go through the native bridge
// (src-tauri/android/VsTrust.kt). Null in a plain browser, where the user has installed the CA instead.
let trustClient: TrustClient | null | undefined;
function trust(): TrustClient | null {
  if (trustClient === undefined) {
    const n = nativeTrust();
    trustClient = n ? createTrustClient(n) : null;
  }
  return trustClient;
}

/** Reachability only (up vs down). Native: TLS validated against the pinned CA. Browser: a no-cors fetch, which proves nothing about the host. */
async function probe(host: string): Promise<void> {
  const t = trust();
  if (t) return t.probe(host);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_MS);
  try {
    await fetch(`https://${host}/api/health`, { mode: "no-cors", cache: "no-store", signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function onDeepLink(handler: (urls: string[]) => void): Promise<() => void> {
  if (!(globalThis as any).__TAURI_INTERNALS__) return () => {};
  try {
    const dl = await import("@tauri-apps/plugin-deep-link");
    const current = await dl.getCurrent().catch(() => null);
    if (current?.length) handler(current);
    return await dl.onOpenUrl(handler);
  } catch {
    return () => {};
  }
}

function openServer(host: string): void {
  try {
    sessionStorage.setItem(OPENED_KEY, "1");
  } catch {
    /* no sessionStorage: Back just reopens */
  }
  location.href = serverUrl(host, location.origin);
}

export function RemotePairScreen() {
  // v:3 session (E4a): one active host out of hosts[]; the screen only ever shows the active one, and no switcher
  // chrome exists while hosts.length <= 1 (the switcher rule in remoteSession.ts says no). A second host arrives with E5.
  const session = readSession();
  const savedHost = activeMeshnetHost(session);
  const saved = savedHost ? { host: savedHost } : null;
  const [host, setHost] = useState(saved?.host ?? "");
  const [code, setCode] = useState("");
  const [fp, setFp] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState<RemoteError | null>(null);
  const [fromLink, setFromLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  // A relay link waiting for the user's Pair press (a web client gets it from the URL fragment, captured at load).
  const [relayLink, setRelayLink] = useState<PairingFragment | null>(() => pairingFragment);
  const [relayDone, setRelayDone] = useState("");
  // A saved server reopens on launch unless the user came here to re-pair.
  const [reopening, setReopening] = useState(() => {
    let cameBack = false;
    try {
      cameBack = Boolean(sessionStorage.getItem(OPENED_KEY));
      sessionStorage.removeItem(OPENED_KEY);
    } catch {
      /* no sessionStorage */
    }
    return Boolean(saved) && !cameBack && !pairingFragment;
  });

  const pairWith = useCallback(async (h: string, c: string, f: string) => {
    const hostN = normalizeHost(h);
    const codeN = normalizeCode(c);
    const fpN = normalizeFp(f);
    if (!hostN || !codeN) {
      setError(remoteError("bad-input"));
      return;
    }
    const t = trust();
    if (t && !fpN) {
      setError(remoteError("bad-input", "Scan the QR code, or also enter the CA fingerprint shown in Pair a device on your PC (at least the first 8 pairs)."));
      return;
    }
    setBusy(true);
    setError(null);
    let pinnedFp = fpN ?? "";
    try {
      // Native: fetching + pinning the CA is also the reachability check. Only the CA matching the fingerprint is trusted, for this host only.
      if (t) pinnedFp = (await t.pin(hostN, fpN!)) || pinnedFp;
      else await probe(hostN);
    } catch (e) {
      setError(/fingerprint/i.test(String((e as Error)?.message)) ? remoteError("unknown", (e as Error).message) : mapRemoteError(e));
      setBusy(false);
      return;
    }
    // The PC opens its own UI right after redeeming (no trip back here), so remember the host now. A rejected code leaves
    // a stale session that the next launch drops: the reopen probe checks the PC still recognizes this phone.
    // The host id (E4a) is best effort here: the status route answers unpaired callers, but a plain browser without
    // CORS gets "" and fills it in on a later reconnect.
    diagStep(`pinned ${hostN}; saving session`);
    saveSession(hostN, undefined, undefined, await fetchHostId(hostN), pinnedFp);
    // Android Back from the PC's UI should land on this form (with Forget), not bounce straight back to the PC.
    try {
      sessionStorage.setItem(OPENED_KEY, "1");
    } catch {
      /* no sessionStorage */
    }
    diagStep("leaving for /pair (redeem)");
    // Best effort: persist cookies now, but never hold the navigation more than ~500ms.
    // Shared client only: a second one would overwrite native.onmessage.
    await Promise.race([trust()?.flush().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
    location.href = pairRedeemUrl(hostN, codeN, undefined, location.origin);
  }, []);

  // E5: a relay link pairs inside the E2EE channel. Nothing is stored before the pinned handshake and the PC's redeem
  // succeeded; a known PC's key always wins over the link's (RelayPinMismatchError), and a known PC's relay endpoint
  // moves only after a plain yes/no (X1 wire L2; Cancel keeps the current relay and still pairs through it).
  const pairRelay = useCallback(async (f: PairingFragment) => {
    setBusy(true);
    setError(null);
    setRelayDone("");
    try {
      const r = await connectWithRelayLink(f, {
        confirmRepoint: ({ label, from, to }) =>
          window.confirm(`This link moves ${label} to a different relay:\n${to}\n\nIt is currently reached through:\n${from}\n\nSwitch to the new relay? Cancel keeps the current one.`),
      });
      r.client.close(); // nothing drives the session yet (E5 §7 item 6); the pin and token are stored for it
      setRelayDone(
        r.pending
          ? `Code accepted. Approve this phone on the device that made the code; ${r.label} is then paired over the relay.`
          : `Paired over the relay with ${r.label}${r.repointed ? " (relay endpoint updated)" : ""}. The relay session opens in a later build; LAN or Meshnet still opens the PC's UI.`,
      );
      setRelayLink(null);
      setFromLink(false);
    } catch (e) {
      setError(remoteError("unknown", relayConnectErrorMessage(e)));
    } finally {
      setBusy(false);
    }
  }, []);

  const apply = useCallback(
    (text: string, fromExternal = false) => {
      const rf = parseRelayPairingLink(text);
      if (rf) {
        setRelayLink(rf);
        setRelayDone("");
        setLink("");
        setError(null);
        setFromLink(fromExternal);
        return;
      }
      const p = parsePairInput(text);
      if (!p) {
        setError(remoteError("bad-input", "That isn't a VibeSquad pairing link, address or code."));
        return;
      }
      if (p.host) setHost(p.host);
      if (p.code) setCode(p.code);
      if (p.fp) setFp(p.fp);
      setLink("");
      setError(null);
      // Scans, links and deep links only fill the form; the user presses Pair after checking the address.
      setFromLink(fromExternal);
    },
    [],
  );

  const onReopenError = (e: unknown, h: string) => {
    // The PC answers but no longer knows this phone: drop the stale session instead of reopening into a 401 page.
    if (/unpaired/i.test(String((e as Error)?.message))) {
      void trust()?.forget(h).catch(() => {});
      forgetHost(h);
      setError(remoteError("unknown", "Your PC no longer recognizes this phone. Pair again with a new code."));
    } else setError(mapRemoteError(e));
  };

  // Manual retry for the saved PC (offline at launch, Back from the PC's UI, a transient auth error).
  const reconnect = (h: string) => {
    setBusy(true);
    setError(null);
    probe(h).then(
      () => openServer(h),
      (e) => {
        onReopenError(e, h);
        setBusy(false);
      },
    );
  };

  // Reopen the saved server. A dead one drops back to this form (with Forget) instead of a blank page.
  useEffect(() => {
    if (!saved || !reopening) return;
    let live = true;
    probe(saved.host).then(
      async () => {
        if (!live) return;
        // Fill in the PC's host id when the v:2 upgrade left it empty (never holds the open longer than the fetch timeout).
        if (session && !session.activeHostId) setSessionHostId(saved.host, await fetchHostId(saved.host));
        if (live) openServer(saved.host);
      },
      (e) => {
        if (!live) return;
        onReopenError(e, saved.host);
        setReopening(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    let off = () => {};
    let gone = false;
    void onDeepLink((urls) => urls[0] && (setReopening(false), applyRef.current(urls[0], true))).then((u) => (gone ? u() : (off = u)));
    return () => {
      gone = true;
      off();
    };
  }, []);

  if (reopening && saved) {
    return (
      <div className="remote-pair" data-testid="remote-pair">
        <div className="remote-pair-card">
          <h1 className="remote-pair-title">Connecting to {saved.host}…</h1>
          <button type="button" className="btn ghost remote-pair-forget" onClick={() => setReopening(false)}>
            Pair a different PC
          </button>
          <button
            type="button"
            className="btn ghost remote-pair-forget"
            data-testid="forget-pc"
            onClick={() => {
              void trust()?.forget(saved.host).catch(() => {});
              forgetHost(saved.host);
              setReopening(false);
            }}
          >
            Forget {saved.host}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="remote-pair" data-testid="remote-pair">
      <form
        className="remote-pair-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (link.trim()) apply(link);
          else if (relayLink) void pairRelay(relayLink);
          else void pairWith(host, code, fp);
        }}
      >
        <h1 className="remote-pair-title">Pair with your PC</h1>
        <p className="remote-pair-help">
          On the PC open <b>Pair a device</b>, then scan its QR code, or enter the address and 6-digit code. Works on the same Wi-Fi or over
          NordVPN Meshnet.
        </p>
        <button type="button" className="btn ok remote-pair-go" data-testid="scan-qr" onClick={() => setScanning(true)}>
          Scan QR code
        </button>
        {scanning && (
          <QrScanner
            onResult={(text) => {
              setScanning(false);
              apply(text, true);
            }}
            onClose={() => setScanning(false)}
            onError={(m) => {
              setScanning(false);
              setError(remoteError("unknown", m));
            }}
          />
        )}
        <label className="remote-pair-field">
          <span>Server address</span>
          <input
            data-testid="pair-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.20:4180 or pc.example:4180"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
        </label>
        <label className="remote-pair-field">
          <span>6-digit code</span>
          <input
            data-testid="pair-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
          />
        </label>
        <label className="remote-pair-field">
          <span>
            CA fingerprint <em>(filled by the QR code; otherwise copy it from Pair a device)</em>
          </span>
          <input
            data-testid="pair-fp"
            value={fp}
            onChange={(e) => setFp(e.target.value)}
            placeholder="AB:CD:EF:01:23:45:67:89"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="remote-pair-field">
          <span>
            or paste the pairing link <em>(optional)</em>
          </span>
          <textarea
            data-testid="pair-link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://192.168.1.20:4180/pair?code=123456"
            rows={2}
            spellCheck={false}
          />
        </label>
        {relayLink ? (
          <div className="remote-pair-help remote-pair-relay" data-testid="relay-confirm">
            A relay link for PC <b>{relayLink.hostId.slice(0, 12)}…</b> via <b>{safeRelayHost(relayLink.relay)}</b>. Only press Pair over relay if that is your PC.
            <button type="button" className="btn ghost small remote-pair-relay-drop" onClick={() => setRelayLink(null)}>
              Discard link
            </button>
          </div>
        ) : (
          fromLink &&
          host && (
            <div className="remote-pair-help" data-testid="pair-confirm">
              A link filled in <b>{host}</b>. Only press Pair if that is your PC.
            </div>
          )
        )}
        {relayDone && (
          <div className="remote-pair-help remote-pair-relay-done" data-testid="relay-done">
            {relayDone}
          </div>
        )}
        {error && (
          <div className="remote-pair-error" role="alert" data-testid="pair-error">
            {error.message}
          </div>
        )}
        <button type="submit" className="btn ok remote-pair-go" disabled={busy} data-testid="pair-go">
          {busy ? "Connecting…" : relayLink ? "Pair over relay" : "Pair"}
        </button>
        {saved && (
          <button type="button" className="btn ok remote-pair-go" data-testid="reconnect-pc" disabled={busy} onClick={() => reconnect(saved.host)}>
            Reconnect to {saved.host}
          </button>
        )}
        {saved && (
          <button
            type="button"
            className="btn ghost remote-pair-forget"
            onClick={() => {
              void trust()?.forget(saved.host).catch(() => {});
              forgetHost(saved.host);
              location.reload();
            }}
          >
            Forget {saved.host}
          </button>
        )}
      </form>
    </div>
  );
}

function safeRelayHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** Camera QR scan: getUserMedia frames decoded by jsQR (lazy-loaded). Needs the CAMERA permission in the APK manifest. */
function QrScanner({ onResult, onClose, onError }: { onResult: (text: string) => void; onClose: () => void; onError: (msg: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onResult, onError });
  cb.current = { onResult, onError };

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | null = null;
    let raf = 0;
    (async () => {
      try {
        const { default: jsQR } = await import("jsqr");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stop) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const tick = () => {
          if (stop) return;
          if (v.readyState >= 2 && v.videoWidth) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            ctx.drawImage(v, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (hit?.data && (parsePairInput(hit.data) || parseRelayPairingLink(hit.data))) return cb.current.onResult(hit.data);
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        if (!stop) cb.current.onError(`Couldn't open the camera (${(e as Error)?.message || "permission denied"}). Enter the address and code instead.`);
      }
    })();
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div data-testid="qr-scanner" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <video ref={video} playsInline muted style={{ width: "100%", background: "#000", borderRadius: 4 }} />
      <button type="button" className="btn ghost small" onClick={onClose}>
        Cancel scan
      </button>
    </div>
  );
}
