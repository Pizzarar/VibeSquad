use crate::DesktopConfig;

pub fn render_pair_page(cfg: &DesktopConfig, error_msg: Option<&str>) -> String {
    let err_banner = if let Some(msg) = error_msg {
        if !msg.is_empty() {
            format!(
                r#"<div class="alert-box" role="alert">
                    <span class="alert-dot">●</span>
                    <span>{}</span>
                </div>"#,
                html_escape(msg)
            )
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VibeSquad — Connect &amp; Pair</title>
<style>
  :root {{
    --bg: #0c0b14;
    --panel: #121120;
    --panel-hi: #18172b;
    --line: #282644;
    --cyan: #00f0ff;
    --pink: #ff2a85;
    --amber: #ffb800;
    --ok: #00e676;
    --text: #eef2ff;
    --muted: #8a93b2;
  }}
  * {{ box-sizing: border-box; user-select: none; }}
  input {{ user-select: text; }}
  body {{
    margin: 0;
    min-height: 100vh;
    background: radial-gradient(circle at 50% 0%, #1a1636 0%, var(--bg) 65%);
    color: var(--text);
    font-family: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }}
  .shell {{
    width: 100%;
    max-width: 560px;
    background: var(--panel);
    border: 1px solid var(--line);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65), 0 0 28px rgba(0, 240, 255, 0.08);
    padding: 28px;
    position: relative;
  }}
  .shell::before {{
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--cyan), var(--pink));
  }}
  .brand {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }}
  .brand-title {{
    font-size: 20px;
    font-weight: 800;
    letter-spacing: 2px;
    color: var(--cyan);
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 10px;
  }}
  .brand-badge {{
    font-size: 10px;
    padding: 3px 7px;
    background: rgba(0, 240, 255, 0.1);
    border: 1px solid var(--cyan);
    color: var(--cyan);
    letter-spacing: 1px;
  }}
  .subtitle {{
    font-size: 12px;
    line-height: 1.55;
    color: var(--muted);
    margin-bottom: 18px;
  }}
  .alert-box {{
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    margin-bottom: 16px;
    background: rgba(255, 42, 133, 0.12);
    border: 1px solid var(--pink);
    color: #ffd6e7;
    font-size: 12px;
    line-height: 1.45;
  }}
  .alert-dot {{ color: var(--pink); font-weight: 700; }}
  .field {{ margin-bottom: 16px; }}
  .label-row {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
    gap: 8px;
  }}
  label {{
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.2px;
    color: var(--muted);
    text-transform: uppercase;
  }}
  .probe-badge {{
    font-size: 11px;
    padding: 2px 7px;
    border: 1px solid var(--line);
    background: var(--panel-hi);
    color: var(--muted);
  }}
  .probe-badge.online {{
    border-color: var(--ok);
    color: var(--ok);
    background: rgba(0, 230, 118, 0.1);
  }}
  .preset-grid {{
    display: grid;
    grid-template-columns: 1fr;
    gap: 7px;
    margin-bottom: 10px;
  }}
  .preset-btn {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 9px 12px;
    background: var(--panel-hi);
    border: 1px solid var(--line);
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
  }}
  .preset-btn:hover {{
    border-color: var(--cyan);
    background: rgba(0, 240, 255, 0.08);
  }}
  .preset-btn.active {{
    border-color: var(--cyan);
    box-shadow: 0 0 12px rgba(0, 240, 255, 0.16);
  }}
  .preset-btn.reachable {{
    border-color: var(--ok);
  }}
  .preset-tag {{
    font-size: 10px;
    padding: 2px 6px;
    border: 1px solid var(--line);
    color: var(--muted);
  }}
  .preset-tag.ok {{
    border-color: var(--ok);
    color: var(--ok);
    background: rgba(0, 230, 118, 0.12);
  }}
  input[type="text"] {{
    width: 100%;
    padding: 11px 12px;
    background: #08070e;
    border: 1px solid var(--line);
    color: var(--text);
    font-family: inherit;
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }}
  input[type="text"]:focus {{
    border-color: var(--cyan);
    box-shadow: 0 0 12px rgba(0, 240, 255, 0.2);
  }}
  .code-input {{
    font-size: 22px !important;
    font-weight: 700;
    letter-spacing: 6px;
    text-align: center;
    color: var(--cyan) !important;
  }}
  .hint {{
    font-size: 11px;
    color: var(--muted);
    margin-top: 6px;
    line-height: 1.45;
  }}
  .hint code {{
    color: var(--text);
    background: rgba(255, 255, 255, 0.06);
    padding: 1px 5px;
  }}
  .actions {{
    display: flex;
    gap: 10px;
    margin-top: 20px;
  }}
  .btn-primary {{
    flex: 1;
    padding: 12px 16px;
    background: var(--cyan);
    color: #05060d;
    border: none;
    font-family: inherit;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    cursor: pointer;
    transition: filter 0.15s, transform 0.08s;
  }}
  .btn-primary:hover {{ filter: brightness(1.1); }}
  .btn-primary:active {{ transform: translateY(1px); }}
  .btn-primary:disabled {{ opacity: 0.5; cursor: wait; }}
  .footer-note {{
    margin-top: 18px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    color: var(--muted);
  }}
  .ca-pill {{
    color: var(--ok);
    display: flex;
    align-items: center;
    gap: 6px;
  }}
</style>
</head>
<body>
  <div class="shell">
    <div class="brand">
      <div class="brand-title">
        <span>⚡ VIBESQUAD</span>
      </div>
      <span class="brand-badge">DESKTOP CLIENT</span>
    </div>
    <div class="subtitle">
      Connect to your VibeSquad server over your <b>Home LAN</b>, <b>Meshnet</b>, or <b>Localhost</b>. The Root CA is pinned inside this app — no Windows certificate install needed.
    </div>

    {err_banner}

    <form id="pair-form">
      <div class="field">
        <div class="label-row">
          <label>Quick Server Picker</label>
          <span class="probe-badge" id="probe-badge">Probing LAN &amp; Meshnet…</span>
        </div>
        <div class="preset-grid">
          <button type="button" class="preset-btn" id="preset-lan" data-host="">
            <span>🏠 Home LAN</span>
            <span class="preset-tag" id="tag-lan">Recommended on Wi-Fi/LAN</span>
          </button>
          <button type="button" class="preset-btn" id="preset-meshnet" data-host="">
            <span>🌐 Meshnet</span>
            <span class="preset-tag" id="tag-meshnet">Remote / VPN</span>
          </button>
          <button type="button" class="preset-btn" id="use-localhost-btn" data-host="127.0.0.1:4180" title="Connect directly to local server on this PC without a pairing code">
            <span>💻 This Server PC · <b>127.0.0.1:4180</b></span>
            <span class="preset-tag" id="tag-local">No code needed</span>
          </button>
        </div>

        <div class="label-row" style="margin-top:10px">
          <label for="serverHost">Server Address</label>
        </div>
        <input
          type="text"
          id="serverHost"
          name="serverHost"
          value="{server_host}"
          placeholder="host:4180"
          autocomplete="off"
          spellcheck="false"
          required
        />
        <div class="hint">
          Auto-discovery tries Home LAN first, then falls back to <code>{fallback_host}</code>.
        </div>
      </div>

      <div class="field" id="code-field">
        <div class="label-row">
          <label for="code">6-Digit Pairing Code</label>
          <span style="font-size:11px;color:var(--muted)">From server's <b>PAIR DEVICE</b> modal</span>
        </div>
        <input
          type="text"
          id="code"
          name="code"
          class="code-input"
          placeholder="000000"
          autocomplete="off"
          spellcheck="false"
          autofocus
        />
        <div class="hint">
          Open VibeSquad on your server PC → click <b>📱 Pair a device</b> → enter the 6-digit code (works for both Home LAN and Meshnet).
        </div>
      </div>

      <div id="form-error" class="alert-box" style="display:none">
        <span class="alert-dot">●</span>
        <span id="form-error-text"></span>
      </div>

      <div class="actions">
        <button type="submit" class="btn-primary" id="submit-btn">
          Connect &amp; Pair
        </button>
      </div>
    </form>

    <div class="footer-note">
      <span class="ca-pill">✓ Pinned Root CA (LAN + Meshnet)</span>
      <span>Shortcut: Ctrl+Shift+S</span>
    </div>
  </div>

  <script>
    const form = document.getElementById('pair-form');
    const hostInput = document.getElementById('serverHost');
    const codeInput = document.getElementById('code');
    const submitBtn = document.getElementById('submit-btn');
    const presetLan = document.getElementById('preset-lan');
    const presetMesh = document.getElementById('preset-meshnet');
    const localhostBtn = document.getElementById('use-localhost-btn');
    const probeBadge = document.getElementById('probe-badge');
    const tagLan = document.getElementById('tag-lan');
    const tagMesh = document.getElementById('tag-meshnet');
    const tagLocal = document.getElementById('tag-local');
    const errBox = document.getElementById('form-error');
    const errText = document.getElementById('form-error-text');

    // Allow ?host=... query param override
    try {{
      const qHost = new URLSearchParams(window.location.search).get('host');
      if (qHost) hostInput.value = qHost;
    }} catch (_) {{}}

    function isLocal(h) {{
      const clean = (h || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
      return clean.startsWith('localhost') || clean.startsWith('127.0.0.1') || clean.startsWith('[::1]');
    }}

    function syncLocalState() {{
      const val = (hostInput.value || '').trim();
      const lanHost = presetLan.dataset.host;
      const meshHost = presetMesh.dataset.host;
      presetLan.classList.toggle('active', Boolean(lanHost) && val.startsWith(lanHost));
      presetMesh.classList.toggle('active', Boolean(meshHost) && val.startsWith(meshHost));
      localhostBtn.classList.toggle('active', isLocal(val));

      if (isLocal(val)) {{
        codeInput.placeholder = 'No code needed on Server PC';
        submitBtn.textContent = 'Connect to Localhost';
      }} else {{
        codeInput.placeholder = '000000';
        submitBtn.textContent = 'Connect & Pair';
      }}
    }}

    hostInput.addEventListener('input', syncLocalState);
    syncLocalState();

    presetLan.addEventListener('click', () => {{
      if (presetLan.dataset.host) hostInput.value = presetLan.dataset.host;
      syncLocalState();
      codeInput.focus();
    }});

    presetMesh.addEventListener('click', () => {{
      if (presetMesh.dataset.host) hostInput.value = presetMesh.dataset.host;
      syncLocalState();
      codeInput.focus();
    }});

    localhostBtn.addEventListener('click', async () => {{
      hostInput.value = '127.0.0.1:4180';
      codeInput.value = '';
      syncLocalState();
      await submitPair();
    }});

    async function runProbe() {{
      try {{
        const res = await fetch('/__desktop/ping?probe=all', {{ cache: 'no-store' }});
        const data = await res.json().catch(() => ({{}}));
        const p = data.probes || {{}};
        if (p.lan) {{
          presetLan.classList.add('reachable');
          tagLan.textContent = '● Online (Home LAN)';
          tagLan.classList.add('ok');
        }}
        if (p.meshnet) {{
          presetMesh.classList.add('reachable');
          tagMesh.textContent = '● Online (Meshnet)';
          tagMesh.classList.add('ok');
        }}
        if (p.local) {{
          localhostBtn.classList.add('reachable');
          tagLocal.textContent = '● Healthy (This PC)';
          tagLocal.classList.add('ok');
        }}
        if (data.reachable && data.activeHost) {{
          probeBadge.textContent = '● Reachable: ' + data.activeHost;
          probeBadge.classList.add('online');
        }} else {{
          probeBadge.textContent = 'Server not detected yet';
        }}
      }} catch (_) {{
        probeBadge.textContent = 'Probe offline';
      }}
    }}
    runProbe();

    async function submitPair() {{
      errBox.style.display = 'none';
      submitBtn.disabled = true;
      const origText = submitBtn.textContent;
      submitBtn.textContent = 'Connecting…';
      try {{
        const res = await fetch('/__desktop/pair', {{
          method: 'POST',
          headers: {{
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }},
          body: JSON.stringify({{
            serverHost: hostInput.value.trim(),
            code: codeInput.value.trim()
          }})
        }});
        const data = await res.json().catch(() => ({{}}));
        if (!res.ok || !data.ok) {{
          errText.textContent = data.error || ('Connection failed (HTTP ' + res.status + ')');
          errBox.style.display = 'flex';
          submitBtn.disabled = false;
          submitBtn.textContent = origText;
          return;
        }}
        window.location.replace(data.redirect || '/');
      }} catch (err) {{
        errText.textContent = String(err);
        errBox.style.display = 'flex';
        submitBtn.disabled = false;
        submitBtn.textContent = origText;
      }}
    }}

    form.addEventListener('submit', (e) => {{
      e.preventDefault();
      submitPair();
    }});
  </script>
</body>
</html>"#,
        err_banner = err_banner,
        server_host = html_escape(&cfg.server_host),
        fallback_host = html_escape(&cfg.fallback_host),
    )
}

pub fn render_unreachable_page(cfg: &DesktopConfig, last_error: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VibeSquad — Server Unreachable / Recovery</title>
<style>
  :root {{
    --bg: #0c0b14;
    --panel: #121120;
    --panel-hi: #18172b;
    --line: #282644;
    --cyan: #00f0ff;
    --pink: #ff2a85;
    --amber: #ffb800;
    --ok: #00e676;
    --text: #eef2ff;
    --muted: #8a93b2;
  }}
  * {{ box-sizing: border-box; user-select: none; }}
  body {{
    margin: 0;
    min-height: 100vh;
    background: radial-gradient(circle at 50% 0%, #24132c 0%, var(--bg) 65%);
    color: var(--text);
    font-family: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }}
  .shell {{
    width: 100%;
    max-width: 560px;
    background: var(--panel);
    border: 1px solid var(--line);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65), 0 0 28px rgba(255, 42, 133, 0.1);
    padding: 28px;
    position: relative;
  }}
  .shell::before {{
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--pink), var(--amber));
  }}
  .head {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
    gap: 10px;
    flex-wrap: wrap;
  }}
  h1 {{
    margin: 0;
    font-size: 18px;
    font-weight: 800;
    color: var(--pink);
    letter-spacing: 1.4px;
    text-transform: uppercase;
  }}
  .status-pill {{
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 4px 9px;
    font-size: 11px;
    background: rgba(255, 184, 0, 0.12);
    border: 1px solid var(--amber);
    color: var(--amber);
  }}
  .pulse {{
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--amber);
    animation: blink 1.2s infinite ease-in-out;
  }}
  @keyframes blink {{
    0%, 100% {{ opacity: 1; }}
    50% {{ opacity: 0.25; }}
  }}
  .target-card {{
    background: #08070e;
    border: 1px solid var(--line);
    padding: 12px 14px;
    margin: 14px 0;
  }}
  .target-label {{
    font-size: 10px;
    letter-spacing: 1.2px;
    color: var(--muted);
    text-transform: uppercase;
    margin-bottom: 6px;
  }}
  .target-hosts {{
    font-size: 13px;
    color: var(--cyan);
    font-weight: 700;
  }}
  .err-detail {{
    margin-top: 6px;
    font-size: 11px;
    color: var(--muted);
    word-break: break-all;
  }}
  .checklist {{
    margin: 16px 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 12px;
    color: var(--text);
    line-height: 1.5;
  }}
  .checklist li {{
    display: flex;
    gap: 10px;
    align-items: flex-start;
    background: var(--panel-hi);
    border: 1px solid var(--line);
    padding: 10px 12px;
  }}
  .step-num {{
    color: var(--cyan);
    font-weight: 800;
  }}
  .actions {{
    display: flex;
    gap: 10px;
    margin-top: 20px;
    flex-wrap: wrap;
  }}
  .btn-primary {{
    flex: 1;
    min-width: 120px;
    padding: 11px 16px;
    background: var(--cyan);
    color: #05060d;
    border: none;
    font-family: inherit;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
  }}
  .btn-secondary {{
    padding: 11px 14px;
    background: var(--panel-hi);
    color: var(--text);
    border: 1px solid var(--line);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }}
  .btn-secondary:hover {{
    border-color: var(--cyan);
    color: var(--cyan);
  }}
</style>
</head>
<body>
  <div class="shell">
    <div class="head">
      <h1>Server Unreachable</h1>
      <span class="status-pill">
        <span class="pulse"></span>
        <span id="retry-status">Auto-retrying every 3s…</span>
      </span>
    </div>

    <div class="target-card">
      <div class="target-label">Current Target (LAN + Meshnet Auto-Discovery)</div>
      <div class="target-hosts">
        {server_host} <span style="color:var(--muted);font-weight:400">/</span> {fallback_host}
      </div>
      <div class="err-detail" id="err-detail">{last_error}</div>
    </div>

    <ul class="checklist">
      <li>
        <span class="step-num">1.</span>
        <div>Check that your PC can reach the VibeSquad server and that it is running on port <code>4180</code>.</div>
      </li>
      <li>
        <span class="step-num">2.</span>
        <div>If the server's Root CA was rotated or you want to switch servers, click <b>Change Server / Re-pair</b> below.</div>
      </li>
    </ul>

    <div class="actions">
      <button type="button" class="btn-primary" id="retry-btn">Retry Now</button>
      <a href="/__desktop/setup" class="btn-secondary" id="change-server-btn">Change Server / Re-pair</a>
      <a href="/__desktop/setup" class="btn-secondary" id="use-lan-btn">Change Server / Re-pair</a>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('retry-status');
    const retryBtn = document.getElementById('retry-btn');
    let checking = false;

    async function checkNow() {{
      if (checking) return;
      checking = true;
      statusEl.textContent = 'Checking server…';
      try {{
        const res = await fetch('/__desktop/ping', {{ cache: 'no-store' }});
        const data = await res.json().catch(() => ({{}}));
        if (data.reachable) {{
          statusEl.textContent = 'Connected! Loading…';
          window.location.replace('/');
          return;
        }}
        statusEl.textContent = 'Unreachable · retrying in 3s…';
      }} catch (e) {{
        statusEl.textContent = 'Unreachable · retrying in 3s…';
      }} finally {{
        checking = false;
      }}
    }}

    retryBtn.addEventListener('click', checkNow);
    setInterval(checkNow, 3000);
  </script>
</body>
</html>"#,
        server_host = html_escape(&cfg.server_host),
        fallback_host = html_escape(&cfg.fallback_host),
        last_error = html_escape(last_error),
    )
}

/// Lightweight desktop bridge injected into the proxied index.html.
/// Restores/saves lastHash, forwards browser Notification calls to native Windows toasts,
/// provides Ctrl+Shift+S / Alt+S shortcut to Change Server / Re-pair, a 3.5s empty-#root
/// recovery watchdog bar, and monitors upstream reachability.
pub fn desktop_bridge_script(last_hash: &str) -> String {
    let escaped_hash = serde_json::to_string(last_hash).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"<script>
(function() {{
  if (window.__VIBESQUAD_DESKTOP_BRIDGE__) return;
  window.__VIBESQUAD_DESKTOP_BRIDGE__ = true;
  const savedHash = {escaped_hash};
  if (!window.location.hash && savedHash && savedHash.startsWith('#')) {{
    try {{ history.replaceState(null, '', savedHash); }} catch (_) {{}}
  }}
  window.addEventListener('hashchange', () => {{
    fetch('/__desktop/hash', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ hash: window.location.hash || '' }})
    }}).catch(() => {{}});
  }});

  // Global keyboard shortcut: Ctrl+Shift+S or Alt+S -> Change Server / Re-pair
  window.addEventListener('keydown', (e) => {{
    if ((e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) || (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'S' || e.key === 's'))) {{
      e.preventDefault();
      window.location.href = '/__desktop/setup';
    }}
  }});

  // Watchdog: if #root has no child elements after 3.5s, mount a recovery bar at top of window
  setTimeout(() => {{
    const root = document.getElementById('root');
    if (!root || root.children.length === 0) {{
      if (document.getElementById('vs-dt-watchdog')) return;
      const bar = document.createElement('div');
      bar.id = 'vs-dt-watchdog';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;background:#121120;border-bottom:2px solid #ff2a85;color:#eef2ff;padding:10px 16px;font-family:monospace;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 8px 24px rgba(0,0,0,0.7)';
      bar.innerHTML = '<span><b style="color:#ff2a85">● UI did not finish loading</b> — Server bundle may be missing or unreachable.</span>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
        '<a href="/__desktop/setup" style="background:#00f0ff;color:#05060d;text-decoration:none;padding:5px 10px;font-weight:800">Change Server / Re-pair</a>' +
        '<button type="button" id="vs-dt-wd-reload" style="background:#18172b;color:#eef2ff;border:1px solid #282644;padding:5px 10px;font-family:inherit;cursor:pointer">Reload</button>' +
        '</div>';
      document.body.appendChild(bar);
      bar.querySelector('#vs-dt-wd-reload')?.addEventListener('click', () => window.location.reload());
    }}
  }}, 3500);

  // Forward WebView Notification API calls to native Windows Toasts via Rust backend
  const OrigNotification = window.Notification;
  function DesktopNotification(title, options) {{
    const opts = options || {{}};
    fetch('/__desktop/notify', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{
        title: String(title || 'VibeSquad'),
        body: String(opts.body || ''),
        tag: String(opts.tag || '')
      }})
    }}).catch(() => {{}});
    if (OrigNotification && OrigNotification.permission === 'granted') {{
      try {{ return new OrigNotification(title, options); }} catch (_) {{}}
    }}
  }}
  DesktopNotification.permission = 'granted';
  DesktopNotification.requestPermission = async () => 'granted';
  window.Notification = DesktopNotification;

  // Lightweight connection monitor banner when server becomes unreachable
  let banner = null;
  let consecutiveFailures = 0;
  function ensureBanner() {{
    if (banner) return banner;
    banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:99999;background:#121120;border:1px solid #ff2a85;color:#eef2ff;padding:8px 12px;font-family:monospace;font-size:12px;display:none;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,0.6)';
    banner.innerHTML = '<span style="color:#ff2a85">● Server unreachable (retrying every 3s…)</span>' +
      '<button id="vs-dt-retry" style="background:#00f0ff;color:#05060d;border:none;padding:3px 8px;font-family:inherit;font-weight:700;cursor:pointer">Retry</button>' +
      '<a href="/__desktop/setup" style="color:#00f0ff;text-decoration:none;border:1px solid #282644;padding:3px 8px">Change Server / Re-pair</a>';
    document.body.appendChild(banner);
    banner.querySelector('#vs-dt-retry')?.addEventListener('click', () => window.location.reload());
    return banner;
  }}
  setInterval(async () => {{
    try {{
      const r = await fetch('/__desktop/ping', {{ cache: 'no-store' }});
      const d = await r.json().catch(() => ({{}}));
      if (d.reachable) {{
        consecutiveFailures = 0;
        if (banner) banner.style.display = 'none';
      }} else {{
        consecutiveFailures++;
        if (consecutiveFailures >= 2) ensureBanner().style.display = 'flex';
      }}
    }} catch (_) {{
      consecutiveFailures++;
      if (consecutiveFailures >= 2) ensureBanner().style.display = 'flex';
    }}
  }}, 4000);
}})();
</script>"#,
        escaped_hash = escaped_hash
    )
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
