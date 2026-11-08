// Android APK pairing (PLAN_ANDROID_MESHNET.md A1): server address + 6-digit code, a pasted pairing link, a QR scan
// or a vibesquad://pair deep link. All of them end in the same step the paired-PC browser takes: open
// https://<host>/pair?code=… so the server sets the vs_device cookie and serves its own UI.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearSession,
  mapRemoteError,
  normalizeCode,
  normalizeHost,
  pairRedeemUrl,
  parsePairInput,
  readSession,
  remoteError,
  saveSession,
  serverUrl,
  type RemoteError,
} from "./remoteSession";

const PROBE_MS = 5000;

/** Reachability check: /api/health is open on the server's HTTPS port; no-cors is enough to tell up from down. */
async function probe(host: string): Promise<void> {
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

export function RemotePairScreen() {
  const saved = readSession();
  const [host, setHost] = useState(saved?.host ?? "");
  const [code, setCode] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState<RemoteError | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  // A saved server reopens on launch unless the user came here to re-pair.
  const [reopening, setReopening] = useState(Boolean(saved));

  const pairWith = useCallback(async (h: string, c: string) => {
    const hostN = normalizeHost(h);
    const codeN = normalizeCode(c);
    if (!hostN || !codeN) {
      setError(remoteError("bad-input"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await probe(hostN);
    } catch (e) {
      setError(mapRemoteError(e));
      setBusy(false);
      return;
    }
    saveSession(hostN);
    location.href = pairRedeemUrl(hostN, codeN);
  }, []);

  const apply = useCallback(
    (text: string, autoPair: boolean) => {
      const p = parsePairInput(text);
      if (!p) {
        setError(remoteError("bad-input", "That isn't a VibeSquad pairing link, address or code."));
        return;
      }
      const h = p.host || host;
      const c = p.code || code;
      if (p.host) setHost(p.host);
      if (p.code) setCode(p.code);
      setLink("");
      setError(null);
      if (autoPair && p.host && p.code) void pairWith(h, c);
    },
    [host, code, pairWith],
  );

  // Reopen the saved server. A dead one drops back to this form (with Forget) instead of a blank page.
  useEffect(() => {
    if (!saved || !reopening) return;
    let live = true;
    probe(saved.host).then(
      () => live && (location.href = serverUrl(saved.host)),
      (e) => {
        if (!live) return;
        setError(mapRemoteError(e));
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
          if (link.trim()) apply(link, true);
          else void pairWith(host, code);
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
            placeholder="192.168.1.20:4180 or host.nord:4180"
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
        {error && (
          <div className="remote-pair-error" role="alert" data-testid="pair-error">
            {error.message}
          </div>
        )}
        <button type="submit" className="btn ok remote-pair-go" disabled={busy} data-testid="pair-go">
          {busy ? "Connecting…" : "Pair"}
        </button>
        {saved && (
          <button
            type="button"
            className="btn ghost remote-pair-forget"
            onClick={() => {
              clearSession();
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
            if (hit?.data && parsePairInput(hit.data)) return cb.current.onResult(hit.data);
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
