// Remote boot (PLAN_PASEO_PARITY.md block R2-2): pairing screen for the remote (relay) UI. Takes the
// Paseo pairing link (the offer rides in the #fragment, so it never reaches a web server), an optional
// daemon password, probes the connection, then saves and reloads into the app. Must not import paseo.ts:
// that module builds the daemon client on load, and here there is no pairing yet.

import { useEffect, useRef, useState } from "react";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { probeRemote } from "./paseoRemote";
import { canonicalOfferUrl, clearSession, hasOfferFragment, isAndroidUserAgent, isLocalHost, normalizeOfferInput, parseOfferInput, readPassword, readSession, saveSession, takeAuthNote, remoteError, type RemoteError } from "./remoteSession";

// The pairing link is the canonical Paseo URL, never this page's own (possibly local) address: when
// /__desktop/setup redirects the webview to `/?remote=1#offer=…` the textarea must show
// `https://app.paseo.sh/#offer=…`, not `http://127.0.0.1:…/?remote=1#offer=…`.
function initialLink(): string {
  return hasOfferFragment(location.hash) ? canonicalOfferUrl(location.hash) : "";
}

function initialError(): RemoteError | null {
  const note = takeAuthNote();
  return note ? remoteError(note) : null;
}

// A password arrives pre-filled either inline (?pw= from /__desktop/setup) or from the saved session.
// When it rides in the URL we strip it at once so it never lingers in the address bar or history.
function initialPassword(): string {
  const params = new URLSearchParams(location.search);
  const pw = params.get("pw");
  if (pw) {
    params.delete("pw");
    const qs = params.toString();
    const hash = location.hash.replace(/^#/, "");
    try {
      history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + (hash ? `#${hash}` : ""));
    } catch {}
  }
  return pw || readPassword();
}

export function RemotePair() {
  const [link, setLink] = useState(initialLink);
  const [password, setPassword] = useState(initialPassword);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RemoteError | null>(initialError);
  // After an auth failure the offer is still stored: only the password is asked for again.
  const [hasStored, setHasStored] = useState<boolean>(() => readSession() !== null);
  const [linkNeeded, setLinkNeeded] = useState<boolean>(() => readSession() === null || hasOfferFragment(location.hash));

  // A pairing link opened while this screen is up only changes the hash (no reload): take it.
  useEffect(() => {
    const onHash = () => {
      if (!hasOfferFragment(location.hash)) return;
      setLinkNeeded(true);
      setLink(canonicalOfferUrl(location.hash));
      setError(null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Incoming Android deep links (`vibesquad://pair#offer=…`) and the custom window event both prefill the offer.
  useEffect(() => {
    const checkTauriDeepLink = () => {
      const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== "function") return;
      try {
        const p = invoke("plugin:deep-link|get_current");
        if (p && typeof p.then === "function") {
          p.then((res: unknown) => {
            const entries = Array.isArray(res) ? res : [res];
            for (const entry of entries) {
              if (typeof entry === "string" && normalizeOfferInput(entry)) {
                setLinkNeeded(true);
                setLink(entry);
                setError(null);
                return;
              }
            }
          }).catch(() => {});
        }
      } catch {}
    };
    const onDeepLink = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      if (typeof detail === "string" && normalizeOfferInput(detail)) {
        setLinkNeeded(true);
        setLink(detail);
        setError(null);
      }
    };
    checkTauriDeepLink();
    window.addEventListener("focus", checkTauriDeepLink);
    document.addEventListener("visibilitychange", checkTauriDeepLink);
    window.addEventListener("vibesquad:deep-link", onDeepLink);
    return () => {
      window.removeEventListener("focus", checkTauriDeepLink);
      document.removeEventListener("visibilitychange", checkTauriDeepLink);
      window.removeEventListener("vibesquad:deep-link", onDeepLink);
    };
  }, []);

  function forget() {
    clearSession();
    setHasStored(false);
    setLinkNeeded(true);
    setError(null);
    setBusy(false);
  }

  function useLocalDaemon() {
    clearSession();
    try {
      localStorage.removeItem("vs.remote");
    } catch {}
    window.location.href = (window as any).__VIBESQUAD_DESKTOP_BRIDGE__ ? "/__desktop/mode" : "/";
  }

  async function doConnect() {
    if (busy) return;
    const stored = hasStored ? readSession() : null;
    let offer = stored?.offer;
    if (linkNeeded) {
      const parsed = parseOfferInput(link, parseConnectionOfferFromUrl);
      if (!parsed.ok) return setError(parsed.error);
      offer = parsed.offer;
    }
    if (!offer) return setError(remoteError("bad-link"));
    setBusy(true);
    setError(null);
    const err = await probeRemote(offer, password);
    if (err) {
      setBusy(false);
      return setError(err);
    }
    try {
      saveSession(offer, password, remember);
      setHasStored(true);
    } catch (x) {
      setBusy(false);
      return setError(remoteError("unknown", `Couldn't save the pairing on this device: ${(x as Error)?.message ?? x}`));
    }
    // Reload without the fragment, so the link isn't left in the address bar or history.
    location.replace(location.pathname + location.search);
  }

  function connect(e: React.FormEvent) {
    e.preventDefault();
    void doConnect();
  }

  // A pairing link opened with an inline password (?pw=#offer=…, from /__desktop/setup) pairs without a click.
  const autoConnectRef = useRef(false);
  useEffect(() => {
    if (autoConnectRef.current) return;
    if (!hasOfferFragment(location.hash)) return;
    if (!password) return;
    autoConnectRef.current = true;
    void doConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="remote-pair">
      <form className="remote-pair-card" onSubmit={connect}>
        <h1 className="remote-pair-title">VibeSquad · remote</h1>
        <p className="remote-pair-help">
          {linkNeeded
            ? "Paste the Paseo pairing link from your PC (or open it on this device). The link works like a password: anyone holding it can reach your daemon."
            : "This device is paired. Enter the daemon password to reconnect."}
        </p>
        {linkNeeded && (
          <label className="remote-pair-field">
            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              Pairing link
              <button
                type="button"
                className="btn ghost small"
                data-testid="remote-pair-paste"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text && text.trim()) {
                      setLink(text.trim());
                      setError(null);
                    }
                  } catch {
                    setError(remoteError("unknown", "Clipboard access was denied. Long-press the text box to paste."));
                  }
                }}
              >
                📋 Paste from Clipboard
              </button>
            </span>
            <textarea
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://app.paseo.sh/#offer=…"
              rows={3}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
        )}
        <label className="remote-pair-field">
          <span>Daemon password {linkNeeded && <em>(optional)</em>}</span>
          <input type="password" data-testid="remote-pair-password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <label className="remote-pair-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Remember the password on this device</span>
        </label>
        {error && (
          <div className="remote-pair-error" role="alert" data-kind={error.kind}>
            {error.message}
          </div>
        )}
        <button className="btn ok remote-pair-go" type="submit" disabled={busy || (linkNeeded && !link.trim())}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        {(hasStored || !linkNeeded) && (
          <button className="btn remote-pair-forget" type="button" data-testid="remote-pair-forget" onClick={forget}>
            Forget saved device
          </button>
        )}
        {isLocalHost(location.hostname) && !isAndroidUserAgent() && (
          <button className="btn remote-pair-forget" type="button" data-testid="remote-pair-local" onClick={useLocalDaemon}>
            ← Use Local Daemon / First-Time Setup
          </button>
        )}
      </form>
    </div>
  );
}
