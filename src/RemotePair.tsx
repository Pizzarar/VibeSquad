// Remote boot (PLAN_PASEO_PARITY.md block R2-2): pairing screen for the remote (relay) UI. Takes the
// Paseo pairing link (the offer rides in the #fragment, so it never reaches a web server), an optional
// daemon password, probes the connection, then saves and reloads into the app. Must not import paseo.ts:
// that module builds the daemon client on load, and here there is no pairing yet.

import { useEffect, useState } from "react";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { probeRemote } from "./paseoRemote";
import { hasOfferFragment, parseOfferInput, readSession, saveSession, takeAuthNote, remoteError, type RemoteError } from "./remoteSession";

function initialLink(): string {
  return hasOfferFragment(location.hash) ? location.href : "";
}

function initialError(): RemoteError | null {
  const note = takeAuthNote();
  return note ? remoteError(note) : null;
}

export function RemotePair() {
  const [link, setLink] = useState(initialLink);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RemoteError | null>(initialError);
  // After an auth failure the offer is still stored: only the password is asked for again.
  const stored = readSession();
  const [hashOffer, setHashOffer] = useState(() => hasOfferFragment(location.hash));
  const linkNeeded = !stored || hashOffer;

  // A pairing link opened while this screen is up only changes the hash (no reload): take it.
  useEffect(() => {
    const onHash = () => {
      if (!hasOfferFragment(location.hash)) return;
      setHashOffer(true);
      setLink(location.href);
      setError(null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
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
    } catch (x) {
      setBusy(false);
      return setError(remoteError("unknown", `Couldn't save the pairing on this device: ${(x as Error)?.message ?? x}`));
    }
    // Reload without the fragment, so the link isn't left in the address bar or history.
    location.replace(location.pathname + location.search);
  }

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
            <span>Pairing link</span>
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
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
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
      </form>
    </div>
  );
}
