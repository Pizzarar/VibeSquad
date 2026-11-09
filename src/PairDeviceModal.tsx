import { useCallback, useEffect, useState } from "react";
import { Modal } from "./TeamActions";
import { Ago } from "./ui";

type Fingerprint = { full: string | null; short: string | null };

type PairedDevice = {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

type PairStartResponse = {
  code: string;
  pairUrl: string;
  pairIpUrl: string;
  lanIp?: string | null;
  lanHttpsUrl?: string | null;
  lanCaUrl?: string | null;
  lanDesktopInstallerUrl?: string | null;
  lanPairUrl?: string | null;
  lanQrSvg?: string | null;
  lanAndroidApkUrl?: string | null;
  androidApkHttpUrl?: string | null;
  androidApkAvailable?: boolean;
  caHttpUrl: string;
  desktopSetupHttpUrl?: string;
  caFingerprint: Fingerprint;
  meshnetHost: string;
  meshnetIp: string;
  expiresAt: number;
  qrSvg: string;
  qrSvgIp: string;
  error?: string;
};

type DevicesResponse = {
  devices: PairedDevice[];
  caFingerprint: Fingerprint;
  meshnetHost: string;
  meshnetIp: string | null;
  lanIp?: string | null;
  port: number;
  caHttpUrl: string | null;
  desktopSetupHttpUrl?: string | null;
  androidApkHttpUrl?: string | null;
  lanHttpsUrl?: string | null;
  lanCaUrl?: string | null;
  lanDesktopInstallerUrl?: string | null;
  lanAndroidApkUrl?: string | null;
  androidApkAvailable?: boolean;
};

export function resolvePairModalUrls({
  pair,
  meta,
  networkMode,
  useIpMode,
}: {
  pair: Partial<PairStartResponse> | null;
  meta: {
    meshnetHost?: string | null;
    meshnetIp?: string | null;
    lanIp?: string | null;
    port?: number | null;
    caHttpUrl?: string | null;
    lanCaUrl?: string | null;
    lanDesktopInstallerUrl?: string | null;
    lanAndroidApkUrl?: string | null;
    androidApkHttpUrl?: string | null;
    androidApkAvailable?: boolean;
  } | null;
  networkMode: "lan" | "meshnet";
  useIpMode: boolean;
}) {
  const meshnetHost = (pair?.meshnetHost || meta?.meshnetHost || "").trim();
  const ip = (pair?.meshnetIp || meta?.meshnetIp || "").trim();
  const host = meshnetHost || ip;
  const lanIp = (pair?.lanIp || meta?.lanIp || "").trim();
  const port = meta?.port || 4180;
  const isLan = networkMode === "lan" && Boolean(lanIp);
  const effectiveIpMode = useIpMode || !meshnetHost;

  const caUrl = isLan
    ? pair?.lanCaUrl || meta?.lanCaUrl || `http://${lanIp}:${port}/ca.crt`
    : pair?.caHttpUrl || meta?.caHttpUrl || `http://${ip}:${port}/ca.crt`;

  const setupUrl = isLan
    ? pair?.lanDesktopInstallerUrl || meta?.lanDesktopInstallerUrl || `http://${lanIp}:${port}/VibeSquad-setup.exe`
    : pair?.desktopSetupHttpUrl || `http://${ip}:${port}/VibeSquad-setup.exe`;

  const androidApkAvailable = Boolean(pair?.androidApkAvailable || meta?.androidApkAvailable);
  const apkUrl = isLan
    ? pair?.lanAndroidApkUrl || meta?.lanAndroidApkUrl || `http://${lanIp}:${port}/VibeSquad.apk`
    : pair?.androidApkHttpUrl || meta?.androidApkHttpUrl || `http://${ip}:${port}/VibeSquad.apk`;

  const fallbackPairUrl =
    pair?.pairUrl && host ? pair.pairUrl.replace(/^https:\/\/(?=:|\s|$)/, `https://${host}`) : pair?.pairUrl || "";

  const activePairUrl = pair
    ? isLan && pair.lanPairUrl
      ? pair.lanPairUrl
      : effectiveIpMode
        ? pair.pairIpUrl || fallbackPairUrl
        : fallbackPairUrl
    : "";

  const activeQrSvg = pair
    ? isLan && pair.lanQrSvg
      ? pair.lanQrSvg
      : effectiveIpMode
        ? pair.qrSvgIp || pair.qrSvg || ""
        : pair.qrSvg || ""
    : "";

  return {
    meshnetHost,
    ip,
    host,
    lanIp,
    port,
    isLan,
    effectiveIpMode,
    caUrl,
    setupUrl,
    androidApkAvailable,
    apkUrl,
    activePairUrl,
    activeQrSvg,
  };
}

export function PairDeviceModal({ onClose }: { onClose: () => void }) {
  const [pair, setPair] = useState<PairStartResponse | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [meta, setMeta] = useState<{
    caFingerprint: Fingerprint;
    meshnetHost: string;
    meshnetIp: string | null;
    lanIp: string | null;
    port: number;
    caHttpUrl: string | null;
    lanCaUrl: string | null;
    lanDesktopInstallerUrl: string | null;
    lanAndroidApkUrl: string | null;
    androidApkHttpUrl: string | null;
    androidApkAvailable: boolean;
  } | null>(null);
  const [networkMode, setNetworkMode] = useState<"lan" | "meshnet">("lan");
  const [useIpMode, setUseIpMode] = useState(false);
  const [showFullFp, setShowFullFp] = useState(false);
  const [showWinHelp, setShowWinHelp] = useState(false);
  const [showAndroidHelp, setShowAndroidHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadDevices = useCallback(async () => {
    try {
      const r = await fetch("/__vibesquad/devices");
      if (!r.ok) return;
      const data = (await r.json()) as DevicesResponse;
      setDevices(data.devices ?? []);
      setMeta({
        caFingerprint: data.caFingerprint,
        meshnetHost: data.meshnetHost,
        meshnetIp: data.meshnetIp,
        lanIp: data.lanIp ?? null,
        port: data.port,
        caHttpUrl: data.caHttpUrl,
        lanCaUrl: data.lanCaUrl ?? null,
        lanDesktopInstallerUrl: data.lanDesktopInstallerUrl ?? null,
        lanAndroidApkUrl: data.lanAndroidApkUrl ?? null,
        androidApkHttpUrl: data.androidApkHttpUrl ?? null,
        androidApkAvailable: data.androidApkAvailable ?? false,
      });
      if (!data.lanIp) {
        setNetworkMode("meshnet");
      }
    } catch {}
  }, []);

  const startPairing = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/__vibesquad/pair/start", { method: "POST" });
      const data = (await r.json()) as PairStartResponse;
      if (!r.ok) {
        setErr(data.error || `HTTP ${r.status}`);
        return;
      }
      setPair(data);
      if (!data.lanIp) {
        setNetworkMode("meshnet");
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    void startPairing();
  }, [loadDevices, startPairing]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const revoke = async (id: string) => {
    try {
      const r = await fetch("/__vibesquad/devices/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await r.json();
      if (r.ok && Array.isArray(data.devices)) {
        setDevices(data.devices);
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1800);
    } catch {}
  };

  const {
    host,
    ip,
    lanIp,
    port,
    isLan,
    effectiveIpMode,
    caUrl,
    setupUrl,
    androidApkAvailable,
    apkUrl,
    activePairUrl,
    activeQrSvg,
  } = resolvePairModalUrls({ pair, meta, networkMode, useIpMode });

  const fp = pair?.caFingerprint?.short ? pair.caFingerprint : meta?.caFingerprint;

  const remainingSec = pair ? Math.max(0, Math.floor((pair.expiresAt - now) / 1000)) : 0;
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;

  const psCmd = `Invoke-WebRequest ${caUrl} -OutFile $env:TEMP\\vs-ca.crt; Import-Certificate -FilePath $env:TEMP\\vs-ca.crt -CertStoreLocation Cert:\\CurrentUser\\Root`;

  return (
    <Modal
      title="📱 PAIR A DEVICE · HOME LAN &amp; NORDVPN MESHNET HTTPS"
      onClose={onClose}
      wide
      footer={
        <>
          {err && <span className="stat-alert small">{err}</span>}
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="pair-modal" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Network Mode Switcher: Home LAN vs NordVPN Meshnet */}
        <div
          className="preview"
          style={{
            marginBottom: 0,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
          }}
          data-testid="pair-network-mode-bar"
        >
          <div>
            <div className="field-label">CONNECTION MODE (6-DIGIT CODE WORKS FOR BOTH)</div>
            <div className="muted small" style={{ marginTop: 2 }}>
              Use <b>Home LAN</b> on the same Wi-Fi/Ethernet ({lanIp}:{port}), or <b>NordVPN Meshnet</b> when away ({host}:{port}).
            </div>
          </div>
          <div className="seg" style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              className={isLan ? "on" : ""}
              onClick={() => setNetworkMode("lan")}
              data-testid="mode-home-lan"
            >
              🏠 Home LAN ({lanIp}:{port})
            </button>
            <button
              type="button"
              className={!isLan ? "on" : ""}
              onClick={() => setNetworkMode("meshnet")}
              data-testid="mode-meshnet"
            >
              🌐 NordVPN Meshnet ({host}:{port})
            </button>
          </div>
        </div>

        <div
          className="preview"
          style={{
            marginBottom: 0,
            border: "1px solid var(--cyan)",
            boxShadow: "0 0 18px rgba(0, 240, 255, 0.14)",
          }}
          data-testid="desktop-pair-hero"
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div className="field-label" style={{ color: "var(--cyan-t)" }}>
              🖥️ WINDOWS DESKTOP APP — ZERO-CERT PAIRING (RECOMMENDED)
            </div>
            <span className="badge">PINNED CA · LAN + MESHNET AUTO-DISCOVERY</span>
          </div>
          <div className="muted small" style={{ marginTop: 4, marginBottom: 10 }}>
            Install the app, open it, and enter this 6-digit code — auto-discovers Home LAN (<code>{lanIp}:{port}</code>) first, then falls back to Meshnet (<code>{host}:{port}</code>).
          </div>
          <div className="na-grid" style={{ alignItems: "stretch" }}>
            <div
              style={{
                padding: "10px 12px",
                background: "var(--navy)",
                border: "1px solid var(--line)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div>
                <div className="field-label">1. DOWNLOAD VIBESQUAD DESKTOP APP (WINDOWS)</div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  One-file NSIS installer with built-in Root CA (LAN + Meshnet), system tray badge, and native notifications.
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <a
                  className="btn ok"
                  href={setupUrl}
                  download="VibeSquad-setup.exe"
                  data-testid="download-desktop-app"
                >
                  ⬇ 1. Download VibeSquad Desktop App (Windows)
                </a>
                <button className="btn ghost small" onClick={() => copyText("setup", setupUrl)}>
                  {copied === "setup" ? "✓ Copied URL" : "Copy Installer URL"}
                </button>
              </div>
              <div className="muted small" style={{ wordBreak: "break-all" }}>
                Direct HTTP link ({isLan ? "Home LAN" : "Meshnet"}): <code>{setupUrl}</code>
              </div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                background: "var(--navy)",
                border: "1px solid var(--line)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span className="field-label">2. ENTER 6-DIGIT PAIRING CODE</span>
                {pair && remainingSec > 0 && (
                  <span className="small">
                    Expires in{" "}
                    <b style={{ color: remainingSec < 60 ? "var(--pink-t)" : "var(--cyan-t)" }}>
                      {mins}:{String(secs).padStart(2, "0")}
                    </b>
                  </span>
                )}
              </div>
              {pair && remainingSec > 0 ? (
                <>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "8px 12px",
                      background: "var(--well)",
                      border: "1px solid var(--cyan)",
                    }}
                  >
                    <code
                      style={{
                        fontSize: 24,
                        fontWeight: 700,
                        letterSpacing: 6,
                        color: "var(--cyan-t)",
                      }}
                      data-testid="pairing-code-display"
                    >
                      {pair.code}
                    </code>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button className="btn ok small" onClick={() => copyText("code", pair.code)}>
                        {copied === "code" ? "✓ Copied Code" : "Copy Code"}
                      </button>
                      <button className="btn ghost small" disabled={busy} onClick={startPairing}>
                        {busy ? "…" : "↻ New Code"}
                      </button>
                    </div>
                  </div>
                  <div className="muted small">
                    Server address in app: <code>{lanIp}:{port}</code> (Home LAN) or <code>{host}:{port}</code> (Meshnet)
                  </div>
                </>
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span className="muted small">{busy ? "Generating 6-digit pairing code…" : "Pairing code expired."}</span>
                  <button className="btn ok small" disabled={busy} onClick={startPairing}>
                    ↻ New Code
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="preview" style={{ marginBottom: 0 }}>
          <div className="field-label">ACTIVE SERVER ADDRESSES (HOME LAN + MESHNET)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginTop: 4 }} data-testid="pair-server-addresses">
            {lanIp && (
              <>
                <code>{lanIp}:{port}</code>
                <span className="muted">(Home LAN)</span>
              </>
            )}
            {(host || ip) && (
              <>
                {lanIp && <span className="muted">·</span>}
                <code>{host}:{port}</code>
                {ip && ip !== host && (
                  <>
                    <span className="muted">or</span>
                    <code>{ip}:{port}</code>
                  </>
                )}
                <span className="muted">(Meshnet)</span>
              </>
            )}
          </div>
          <div className="muted small" style={{ marginTop: 4 }}>
            Type either address into the Desktop App&apos;s Server Address field along with the 6-digit code above.
          </div>
        </div>

        {androidApkAvailable && (
          <div className="preview" style={{ marginBottom: 0 }} data-testid="android-apk-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div className="field-label">🤖 ANDROID APP (SIDELOAD APK · {isLan ? "HOME LAN" : "MESHNET"})</div>
                <div className="muted small" style={{ marginTop: 2 }}>
                  Install the app, then scan with the in-app Scan (not the phone camera). Direct HTTP link: <code>{apkUrl}</code>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <a
                  className="btn ok small"
                  data-testid="download-android-apk"
                  href={apkUrl}
                  download="VibeSquad.apk"
                >
                  ⬇ Download VibeSquad.apk (Android)
                </a>
                <button type="button" className="btn ghost small" onClick={() => copyText("apk", apkUrl)}>
                  {copied === "apk" ? "✓ Copied APK URL" : "Copy APK URL"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="na-grid">
          <div className="na-col" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="preview" style={{ marginBottom: 0 }}>
              <div className="field-label">PHONE / BROWSER STEP 1 — INSTALL ROOT CA (ONE-TIME PER DEVICE)</div>
              <div className="muted small" style={{ margin: "4px 0 8px" }}>
                Plain HTTP on {isLan ? "Home LAN" : "Meshnet"} serves <code>/ca.crt</code> and <code>/VibeSquad-setup.exe</code>. If you previously installed an older CA before LAN mode, re-install <code>/ca.crt</code> once.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <a className="btn ok small" href="/ca.crt" download="vibesquad-ca.crt">
                  ⬇ Download /ca.crt
                </a>
                <a className="btn ghost small" href={caUrl} target="_blank" rel="noreferrer" data-testid="ca-http-link">
                  {caUrl}
                </a>
                <button className="btn ghost small" onClick={() => copyText("ca", caUrl)}>
                  {copied === "ca" ? "✓ Copied" : "Copy URL"}
                </button>
              </div>

              <div className="field-label">CA SHA-256 FINGERPRINT</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                <code style={{ color: "var(--cyan-t)", fontWeight: 700 }}>{fp?.short ?? "generating…"}</code>
                {fp?.full && (
                  <button className="btn ghost small" onClick={() => setShowFullFp((v) => !v)}>
                    {showFullFp ? "Hide full" : "Full hex"}
                  </button>
                )}
              </div>
              {showFullFp && fp?.full && (
                <div style={{ marginTop: 4, wordBreak: "break-all" }}>
                  <code className="small">{fp.full}</code>
                </div>
              )}

              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <button className="btn ghost small" onClick={() => setShowWinHelp((v) => !v)}>
                  {showWinHelp ? "▾" : "▸"} Windows browser install steps (not needed for Desktop App)
                </button>
                {showWinHelp && (
                  <div style={{ padding: "6px 8px", background: "var(--navy)", border: "1px solid var(--line)" }}>
                    <div className="muted small">PowerShell (CurrentUser Root store, no admin prompt needed):</div>
                    <pre style={{ margin: "4px 0", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11, color: "var(--cyan-t)" }}>
                      {psCmd}
                    </pre>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <button className="btn ghost small" onClick={() => copyText("ps", psCmd)}>
                        {copied === "ps" ? "✓ Copied PowerShell" : "Copy PowerShell"}
                      </button>
                      <span className="muted small">
                        or <code>certutil -user -addstore Root vibesquad-ca.crt</code>
                      </span>
                    </div>
                  </div>
                )}

                <button className="btn ghost small" onClick={() => setShowAndroidHelp((v) => !v)}>
                  {showAndroidHelp ? "▾" : "▸"} Android / iPhone install steps ({isLan ? "Home LAN" : "Meshnet"})
                </button>
                {showAndroidHelp && (
                  <div className="muted small" style={{ padding: "6px 8px", background: "var(--navy)", border: "1px solid var(--line)" }}>
                    1. On your phone connected to {isLan ? "Home Wi-Fi" : "NordVPN Meshnet"}, open <code>{caUrl}</code> in Chrome/Safari to download <code>vibesquad-ca.crt</code>.<br />
                    2. <b>Android:</b> Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate (Tap &ldquo;Install anyway&rdquo;).<br />
                    3. Verify the SHA-256 fingerprint starts with <code>{fp?.short ?? ""}</code>, then scan the Step 2 QR code!
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="na-col" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="preview" style={{ marginBottom: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="field-label">
                  PHONE STEP 2 — SCAN QR TO PAIR ({isLan ? `HOME LAN ${lanIp}` : "MESHNET"})
                </span>
                {!isLan && (
                  <div className="seg">
                    <button className={!effectiveIpMode ? "on" : ""} onClick={() => setUseIpMode(false)}>
                      Meshnet Host
                    </button>
                    <button className={effectiveIpMode ? "on" : ""} onClick={() => setUseIpMode(true)}>
                      Meshnet IP
                    </button>
                  </div>
                )}
              </div>

              {pair && remainingSec > 0 ? (
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
                  <div
                    style={{ width: 148, height: 148, flex: "none", background: "#fff", padding: 4, border: "2px solid var(--cyan)" }}
                    dangerouslySetInnerHTML={{ __html: activeQrSvg }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 }}>
                    <div className="small">
                      Expires in{" "}
                      <b style={{ color: remainingSec < 60 ? "var(--pink-t)" : "var(--cyan-t)" }}>
                        {mins}:{String(secs).padStart(2, "0")}
                      </b>
                    </div>
                    <div className="field-label">DIRECT PAIRING LINK ({isLan ? "HOME LAN" : "MESHNET"})</div>
                    <a
                      href={activePairUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--cyan-t)", wordBreak: "break-all", fontSize: 11 }}
                      data-testid="active-pair-url"
                    >
                      {activePairUrl}
                    </a>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                      <button className="btn ok small" onClick={() => copyText("pair", activePairUrl)}>
                        {copied === "pair" ? "✓ Copied Link" : "Copy Pairing Link"}
                      </button>
                      <button className="btn ghost small" disabled={busy} onClick={startPairing}>
                        {busy ? "Generating…" : "↻ New QR Code"}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span className="muted small">{busy ? "Generating one-time pairing code…" : "Pairing code expired or unavailable."}</span>
                  <button className="btn ok small" disabled={busy} onClick={startPairing}>
                    ↻ New QR Code
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="preview" style={{ marginBottom: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="field-label">PAIRED DEVICES ({devices.length})</span>
            <button className="btn ghost small" onClick={loadDevices}>
              ↻ Refresh
            </button>
          </div>
          {devices.length === 0 ? (
            <div className="muted small" style={{ marginTop: 6 }}>
              No paired devices yet. Enter the 6-digit code in the Desktop App or scan the QR code on your phone.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {devices.map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "5px 8px",
                    background: "var(--navy)",
                    border: "1px solid var(--line)",
                  }}
                >
                  <b style={{ color: d.current ? "var(--cyan-t)" : "var(--text)" }}>{d.name}</b>
                  {d.current && <span className="badge">THIS DEVICE</span>}
                  <span className="muted small" style={{ marginLeft: "auto" }}>
                    last seen <Ago iso={d.lastSeenAt} /> ago
                  </span>
                  <button className="btn warn small" onClick={() => revoke(d.id)}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
