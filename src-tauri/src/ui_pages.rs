use crate::DesktopConfig;

pub fn render_mode_choice_page(_cfg: &DesktopConfig, error_msg: Option<&str>) -> String {
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
<title>VibeSquad — Choose Setup Mode</title>
<style>
  :root {{
    --bg: #0c0b14;
    --panel: #121120;
    --panel-hi: #18172b;
    --line: #282644;
    --cyan: #00f0ff;
    --pink: #ff2a85;
    --ok: #00e676;
    --text: #eef2ff;
    --muted: #8a93b2;
  }}
  * {{ box-sizing: border-box; user-select: none; }}
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
  .choice-grid {{
    display: flex;
    flex-direction: column;
    gap: 12px;
  }}
  .choice-card {{
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 16px 18px;
    background: var(--panel-hi);
    border: 1px solid var(--line);
    color: var(--text);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s;
  }}
  .choice-card:hover {{
    border-color: var(--cyan);
    background: rgba(0, 240, 255, 0.08);
    box-shadow: 0 0 16px rgba(0, 240, 255, 0.15);
  }}
  .choice-card:disabled {{
    opacity: 0.55;
    cursor: wait;
  }}
  .choice-title {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 0.8px;
    color: var(--cyan);
  }}
  .choice-desc {{
    font-size: 12px;
    line-height: 1.45;
    color: var(--muted);
  }}
  .footer-actions {{
    display: flex;
    justify-content: flex-end;
    margin-top: 16px;
  }}
  .btn-secondary {{
    padding: 9px 12px;
    background: var(--panel-hi);
    color: var(--text);
    border: 1px solid var(--line);
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }}
  .btn-secondary:hover {{
    border-color: var(--cyan);
    color: var(--cyan);
  }}
</style>
</head>
<body>
  <div class="shell" data-testid="desktop-mode-choice">
    <div class="brand">
      <div class="brand-title">⚡ VIBESQUAD</div>
      <span class="brand-badge">FIRST LAUNCH</span>
    </div>
    <div class="subtitle">
      How will you use VibeSquad on this PC? Nothing starts in the background until you choose.
    </div>

    {err_banner}

    <div class="choice-grid">
      <button type="button" class="choice-card" id="choose-local-btn" data-testid="choose-mode-local">
        <div class="choice-title">
          <span>💻 Run agents on this PC</span>
          <span>→</span>
        </div>
        <div class="choice-desc">
          Starts the local VibeSquad server (127.0.0.1:4180) and agent runner on this machine.
        </div>
      </button>

      <button type="button" class="choice-card" id="choose-remote-btn" data-testid="choose-mode-remote">
        <div class="choice-title">
          <span>🔗 Connect to another PC</span>
          <span>→</span>
        </div>
        <div class="choice-desc">
          Pair with a VibeSquad server over Home LAN or Meshnet using a 6-digit code. Spawns zero local server or runner processes on this PC.
        </div>
      </button>
    </div>

    <div class="footer-actions">
      <button type="button" class="btn-secondary" id="check-update-btn" data-testid="desktop-check-update-btn">Check for Updates</button>
    </div>
  </div>

  <script>
    const localBtn = document.getElementById('choose-local-btn');
    const remoteBtn = document.getElementById('choose-remote-btn');
    const checkUpdateBtn = document.getElementById('check-update-btn');

    async function pickMode(mode) {{
      localBtn.disabled = true;
      remoteBtn.disabled = true;
      try {{
        const res = await fetch('/__desktop/choose-mode', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/json' }},
          body: JSON.stringify({{ mode }})
        }});
        const data = await res.json().catch(() => ({{}}));
        window.location.replace(data.redirect || (mode === 'remote' ? '/__desktop/setup' : '/'));
      }} catch (_) {{
        localBtn.disabled = false;
        remoteBtn.disabled = false;
      }}
    }}

    localBtn.addEventListener('click', () => pickMode('local'));
    remoteBtn.addEventListener('click', () => pickMode('remote'));
    if (checkUpdateBtn) {{
      checkUpdateBtn.addEventListener('click', async () => {{
        checkUpdateBtn.disabled = true;
        checkUpdateBtn.textContent = 'Checking for updates…';
        try {{
          const res = await fetch('/__desktop/updater/check', {{ method: 'POST' }});
          const data = await res.json().catch(() => ({{}}));
          if (data && data.updateAvailable && data.downloaded) {{
            checkUpdateBtn.textContent = 'Installing v' + data.availableVersion + '…';
            await fetch('/__desktop/updater/install', {{ method: 'POST' }});
            return;
          }}
          checkUpdateBtn.textContent = data && data.currentVersion ? ('Up to date (v' + data.currentVersion + ')') : 'Up to date';
        }} catch (_) {{
          checkUpdateBtn.textContent = 'Update check failed';
        }} finally {{
          checkUpdateBtn.disabled = false;
        }}
      }});
    }}
  </script>
</body>
</html>"#,
        err_banner = err_banner,
    )
}

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

    let saved_lan = cfg.last_lan_host.trim();
    let saved_mesh = if !cfg.last_meshnet_host.trim().is_empty() {
        cfg.last_meshnet_host.trim()
    } else {
        cfg.fallback_host.trim()
    };
    let picker_display = if saved_lan.is_empty() && saved_mesh.is_empty() {
        "display:none"
    } else {
        ""
    };
    let lan_display = if saved_lan.is_empty() {
        "display:none"
    } else {
        ""
    };
    let mesh_display = if saved_mesh.is_empty() {
        "display:none"
    } else {
        ""
    };
    let server_host_display = if cfg.server_mode == "remote" && crate::is_local_host(&cfg.server_host) {
        if !saved_lan.is_empty() {
            saved_lan.to_string()
        } else if !saved_mesh.is_empty() {
            saved_mesh.to_string()
        } else {
            String::new()
        }
    } else {
        cfg.server_host.clone()
    };
    let code_field_display = if server_host_display.is_empty()
        || crate::is_local_host(&server_host_display)
    {
        "display:none"
    } else {
        ""
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
  .preset-pills {{
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }}
  .preset-btn {{
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: auto;
    padding: 7px 11px;
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
  .preset-btn:disabled, .preset-btn.disabled {{
    opacity: 0.45;
    cursor: not-allowed;
    pointer-events: none;
    border-color: var(--line);
    background: rgba(18, 17, 32, 0.5);
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
    flex-wrap: wrap;
  }}
  .btn-primary {{
    flex: 1;
    min-width: 160px;
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
  .footer-link {{
    background: none;
    border: none;
    padding: 0;
    color: var(--muted);
    font-family: inherit;
    font-size: 11px;
    text-decoration: none;
    cursor: pointer;
    transition: color 0.15s;
  }}
  .footer-link:hover {{ color: var(--cyan); }}
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
      Paste a pairing link or enter your server address to connect.
    </div>

    {err_banner}

    <form id="pair-form">
      <div class="field" id="server-picker" style="{picker_display}">
        <div class="label-row">
          <label>Saved / Detected Servers</label>
          <span class="probe-badge" id="probe-badge">Probing…</span>
        </div>
        <div class="preset-pills">
          <button type="button" class="preset-btn" id="preset-lan" data-host="{saved_lan_host}" style="{lan_display}">
            <span>🏠 Home LAN</span>
            <span class="preset-tag" id="tag-lan">{saved_lan_host}</span>
          </button>
          <button type="button" class="preset-btn" id="preset-meshnet" data-host="{saved_meshnet_host}" style="{mesh_display}">
            <span>🌐 Meshnet</span>
            <span class="preset-tag" id="tag-meshnet">{saved_meshnet_host}</span>
          </button>
        </div>
      </div>

      <div class="field">
        <div class="label-row">
          <label for="serverHost">Pairing Link or Server Address</label>
        </div>
        <input
          type="text"
          id="serverHost"
          name="serverHost"
          value="{server_host_display}"
          placeholder="Paste pairing link, or enter server-ip:4180"
          autocomplete="off"
          spellcheck="false"
          autofocus
        />
        <div class="hint">
          Open VibeSquad on your server PC → click <b>📱 Pair a device</b>.
        </div>
      </div>

      <div class="field" id="code-field" style="{code_field_display}">
        <div class="label-row">
          <label for="code" id="code-label">6-Digit Pairing Code</label>
          <span id="code-hint" style="font-size:11px;color:var(--muted)">From server's <b>PAIR DEVICE</b> modal</span>
        </div>
        <input
          type="text"
          id="code"
          name="code"
          class="code-input"
          placeholder="000000"
          autocomplete="off"
          spellcheck="false"
        />
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
      <a href="/__desktop/mode" class="footer-link" id="back-to-mode-choice" data-testid="back-to-mode-choice">
        ← Switch Mode (Local / Remote)
      </a>
      <button type="button" class="footer-link" id="check-update-btn" data-testid="desktop-check-update-btn">
        Check for Updates
      </button>
    </div>
  </div>

  <script>
    const form = document.getElementById('pair-form');
    const hostInput = document.getElementById('serverHost');
    const codeInput = document.getElementById('code');
    const submitBtn = document.getElementById('submit-btn');
    const presetLan = document.getElementById('preset-lan');
    const presetMesh = document.getElementById('preset-meshnet');
    const serverPicker = document.getElementById('server-picker');
    const codeField = document.getElementById('code-field');
    const codeLabel = document.getElementById('code-label');
    const codeHint = document.getElementById('code-hint');
    const probeBadge = document.getElementById('probe-badge');
    const tagLan = document.getElementById('tag-lan');
    const tagMesh = document.getElementById('tag-meshnet');
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

    function syncPresetButtons() {{
      const lanHost = (presetLan.dataset.host || '').trim();
      const meshHost = (presetMesh.dataset.host || '').trim();
      presetLan.style.display = lanHost ? 'inline-flex' : 'none';
      if (lanHost && !tagLan.textContent) tagLan.textContent = lanHost;
      presetMesh.style.display = meshHost ? 'inline-flex' : 'none';
      if (meshHost && !tagMesh.textContent) tagMesh.textContent = meshHost;
      serverPicker.style.display = (lanHost || meshHost) ? 'block' : 'none';
    }}

    function tryExtractPairUrl(inputEl) {{
      const raw = (inputEl.value || '').trim();
      if (!raw) return;
      if (/^https?:\/\//i.test(raw) && raw.includes('code=')) {{
        try {{
          const u = new URL(raw);
          const c = u.searchParams.get('code');
          if (u.host) hostInput.value = u.port ? u.host : (u.hostname + ':4180');
          if (c) codeInput.value = c.trim();
        }} catch (_) {{}}
      }}
    }}

    function syncLocalState() {{
      syncPresetButtons();
      const val = (hostInput.value || '').trim();
      const lanHost = presetLan.dataset.host;
      const meshHost = presetMesh.dataset.host;
      presetLan.classList.toggle('active', Boolean(lanHost) && val.startsWith(lanHost));
      presetMesh.classList.toggle('active', Boolean(meshHost) && val.startsWith(meshHost));
      codeField.style.display = (!val || isLocal(val)) ? 'none' : 'block';

      codeLabel.textContent = '6-Digit Pairing Code';
      codeHint.innerHTML = 'From server\'s <b>PAIR DEVICE</b> modal';
      codeInput.type = 'text';
      if (isLocal(val)) {{
        codeInput.placeholder = 'No code needed on Server PC';
        submitBtn.textContent = 'Connect to Localhost';
      }} else {{
        codeInput.placeholder = '000000';
        submitBtn.textContent = 'Connect & Pair';
      }}
    }}

    hostInput.addEventListener('input', () => {{
      tryExtractPairUrl(hostInput);
      syncLocalState();
    }});
    codeInput.addEventListener('input', () => {{
      tryExtractPairUrl(codeInput);
      syncLocalState();
    }});
    syncLocalState();

    presetLan.addEventListener('click', () => {{
      if (presetLan.disabled || !presetLan.dataset.host) return;
      hostInput.value = presetLan.dataset.host;
      syncLocalState();
      codeInput.focus();
    }});

    presetMesh.addEventListener('click', () => {{
      if (presetMesh.disabled || !presetMesh.dataset.host) return;
      hostInput.value = presetMesh.dataset.host;
      syncLocalState();
      codeInput.focus();
    }});

    async function runProbe() {{
      try {{
        const res = await fetch('/__desktop/ping?probe=all', {{ cache: 'no-store' }});
        const data = await res.json().catch(() => ({{}}));
        const p = data.probes || {{}};
        if (data.lanHost) {{
          presetLan.dataset.host = data.lanHost;
        }}
        if (data.meshnetHost) {{
          presetMesh.dataset.host = data.meshnetHost;
        }}
        syncPresetButtons();
        if (p.lan && presetLan.dataset.host) {{
          presetLan.classList.add('reachable');
          tagLan.textContent = '● Online (' + presetLan.dataset.host + ')';
          tagLan.classList.add('ok');
        }} else if (presetLan.dataset.host) {{
          tagLan.textContent = presetLan.dataset.host;
        }}
        if (p.meshnet && presetMesh.dataset.host) {{
          presetMesh.classList.add('reachable');
          tagMesh.textContent = '● Online (' + presetMesh.dataset.host + ')';
          tagMesh.classList.add('ok');
        }} else if (presetMesh.dataset.host) {{
          tagMesh.textContent = presetMesh.dataset.host;
        }}
        if (data.reachable && data.activeHost) {{
          probeBadge.textContent = '● Reachable: ' + data.activeHost;
          probeBadge.classList.add('online');
        }} else {{
          probeBadge.textContent = '';
        }}
      }} catch (_) {{
        probeBadge.textContent = '';
      }}
    }}
    runProbe();

    async function submitPair() {{
      errBox.style.display = 'none';
      submitBtn.disabled = true;
      const origText = submitBtn.textContent;
      submitBtn.textContent = 'Connecting…';
      try {{
        tryExtractPairUrl(hostInput);
        tryExtractPairUrl(codeInput);
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
    const checkUpdateBtn = document.getElementById('check-update-btn');
    if (checkUpdateBtn) {{
      checkUpdateBtn.addEventListener('click', async () => {{
        checkUpdateBtn.disabled = true;
        checkUpdateBtn.textContent = 'Checking for updates…';
        try {{
          const res = await fetch('/__desktop/updater/check', {{ method: 'POST' }});
          const data = await res.json().catch(() => ({{}}));
          if (data && data.updateAvailable && data.downloaded) {{
            checkUpdateBtn.textContent = 'Installing v' + data.availableVersion + '…';
            await fetch('/__desktop/updater/install', {{ method: 'POST' }});
            return;
          }}
          checkUpdateBtn.textContent = data && data.currentVersion ? ('Up to date (v' + data.currentVersion + ')') : 'Up to date';
        }} catch (_) {{
          checkUpdateBtn.textContent = 'Update check failed';
        }} finally {{
          checkUpdateBtn.disabled = false;
        }}
      }});
    }}
  </script>
</body>
</html>"#,
        err_banner = err_banner,
        saved_lan_host = html_escape(saved_lan),
        saved_meshnet_host = html_escape(saved_mesh),
        picker_display = picker_display,
        lan_display = lan_display,
        mesh_display = mesh_display,
        server_host_display = html_escape(&server_host_display),
        code_field_display = code_field_display,
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
      <a href="/__desktop/mode" class="btn-secondary" id="first-time-setup-btn">First-Time Setup</a>
      <button type="button" class="btn-secondary" id="check-update-btn" data-testid="desktop-check-update-btn">Check for Updates</button>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('retry-status');
    const retryBtn = document.getElementById('retry-btn');
    const checkUpdateBtn = document.getElementById('check-update-btn');
    let checking = false;
    const RELOAD_KEY = 'vs.reconnect.reloads';
    const MAX_RELOADS = 3;
    let reloads = 0;
    try {{ reloads = Number(sessionStorage.getItem(RELOAD_KEY) || 0) || 0; }} catch (_) {{}}

    async function checkNow() {{
      if (checking) return;
      checking = true;
      statusEl.textContent = 'Checking server…';
      try {{
        const res = await fetch('/__desktop/ping', {{ cache: 'no-store' }});
        const data = await res.json().catch(() => ({{}}));
        if (data.reachable) {{
          if (reloads >= MAX_RELOADS) {{ statusEl.textContent = 'Server answers but the app is not loading · press Retry Now'; return; }}
          statusEl.textContent = 'Connected! Loading…';
          try {{ sessionStorage.setItem(RELOAD_KEY, String(reloads + 1)); }} catch (_) {{}}
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

    retryBtn.addEventListener('click', () => {{ reloads = 0; try {{ sessionStorage.removeItem(RELOAD_KEY); }} catch (_) {{}} checkNow(); }});
    if (checkUpdateBtn) {{
      checkUpdateBtn.addEventListener('click', async () => {{
        checkUpdateBtn.disabled = true;
        checkUpdateBtn.textContent = 'Checking for updates…';
        try {{
          const res = await fetch('/__desktop/updater/check', {{ method: 'POST' }});
          const data = await res.json().catch(() => ({{}}));
          if (data && data.updateAvailable && data.downloaded) {{
            checkUpdateBtn.textContent = 'Installing v' + data.availableVersion + '…';
            await fetch('/__desktop/updater/install', {{ method: 'POST' }});
            return;
          }}
          checkUpdateBtn.textContent = data && data.currentVersion ? ('Up to date (v' + data.currentVersion + ')') : 'Up to date';
        }} catch (_) {{
          checkUpdateBtn.textContent = 'Update check failed';
        }} finally {{
          checkUpdateBtn.disabled = false;
        }}
      }});
    }}
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
pub fn desktop_bridge_script(last_hash: &str, last_route: &str) -> String {
    let clean_hash = if last_hash.contains("offer=") { "" } else { last_hash };
    let escaped_hash = serde_json::to_string(clean_hash).unwrap_or_else(|_| "\"\"".to_string());
    let escaped_route = serde_json::to_string(&restore_path(last_route, last_hash)).unwrap_or_else(|_| "\"/\"".to_string()).replace('<', "\\u003c");
    format!(
        r#"<script>
(function() {{
  if (window.__VIBESQUAD_DESKTOP_BRIDGE__) return;
  window.__VIBESQUAD_DESKTOP_BRIDGE__ = true;
  try {{ sessionStorage.removeItem('vs.reconnect.reloads'); }} catch (_) {{}} // the app shell loaded: reset the reload-loop guard
  const savedHash = {escaped_hash};
  const savedRoute = {escaped_route};
  // A reload/reconnect lands on a bare "/": put the last route (path + ?team=&agent= + #hash) back before the app boots.
  if (window.location.pathname === '/' && !window.location.search && !window.location.hash && savedRoute && savedRoute !== '/') {{
    try {{ history.replaceState(null, '', savedRoute); }} catch (_) {{}}
  }} else if (!window.location.hash && savedHash && savedHash.startsWith('#')) {{
    try {{ history.replaceState(null, '', savedHash); }} catch (_) {{}}
  }}
  let routeTimer = 0;
  function saveRoute() {{
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {{
      const rawHash = window.location.hash || '';
      const cleanHash = rawHash.includes('offer=') ? '' : rawHash;
      fetch('/__desktop/hash', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        keepalive: true,
        body: JSON.stringify({{
          hash: cleanHash,
          route: window.location.pathname + window.location.search + cleanHash
        }})
      }}).catch(() => {{}});
    }}, 250);
  }}
  window.addEventListener('hashchange', saveRoute);
  window.addEventListener('popstate', saveRoute);
  for (const fn of ['pushState', 'replaceState']) {{
    const orig = history[fn];
    history[fn] = function () {{ const r = orig.apply(this, arguments); saveRoute(); return r; }};
  }}

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
        // The page's WS/fetches died with the old server: reload once the server is back instead of Re-pair.
        if (banner && banner.style.display !== 'none') window.location.reload();
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

/// The path + query + hash to open after a restart: the saved full route, else `/` plus the legacy saved hash.
/// Only same-origin app routes are accepted (never `//host`, never the relay's own `/__desktop/*`).
pub fn restore_path(last_route: &str, last_hash: &str) -> String {
    // A saved `#offer=` pairing link must never be restored: it re-mounts the pairing screen on reload.
    let r = last_route.trim().split("#offer=").next().unwrap_or("");
    if r.starts_with('/') && !r.starts_with("//") && !r.starts_with("/__desktop") && !r.contains('\\') && !r.contains(['\n', '\r']) {
        return r.to_string();
    }
    if last_hash.contains("offer=") {
        return "/".to_string();
    }
    let h = last_hash.trim();
    if h.starts_with('#') {
        format!("/{}", h)
    } else if !h.is_empty() {
        format!("/#{}", h)
    } else {
        "/".to_string()
    }
}

/// "Reconnecting…" card served instead of the browser's own error page while the upstream restarts.
/// Polls `/__desktop/ping` and reloads the same URL (route intact) once the server answers; after ~30 s
/// it becomes the Server Unreachable card with Retry · Switch server.
pub fn render_reconnecting_page(_cfg: &DesktopConfig, last_error: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VibeSquad — Reconnecting…</title>
<style>
  :root {{ --bg:#0c0b14; --panel:#121120; --panel-hi:#18172b; --line:#282644; --cyan:#00f0ff; --pink:#ff2a85; --amber:#ffb800; --text:#eef2ff; --muted:#8a93b2; }}
  * {{ box-sizing: border-box; user-select: none; }}
  body {{ margin:0; min-height:100vh; background:radial-gradient(circle at 50% 0%, #24132c 0%, var(--bg) 65%); color:var(--text);
    font-family:"JetBrains Mono","Cascadia Mono",Consolas,monospace; display:flex; align-items:center; justify-content:center; padding:24px; }}
  .shell {{ width:100%; max-width:560px; background:var(--panel); border:1px solid var(--line); box-shadow:0 20px 60px rgba(0,0,0,.65),0 0 28px rgba(255,42,133,.1); padding:28px; position:relative; }}
  .shell::before {{ content:""; position:absolute; top:0; left:0; right:0; height:3px; background:linear-gradient(90deg,var(--pink),var(--amber)); }}
  h1 {{ margin:0 0 12px; font-size:18px; font-weight:800; color:var(--amber); letter-spacing:1.4px; text-transform:uppercase; }}
  h1.down {{ color:var(--pink); }}
  .status-pill {{ display:inline-flex; align-items:center; gap:7px; padding:4px 9px; font-size:11px; background:rgba(255,184,0,.12); border:1px solid var(--amber); color:var(--amber); }}
  .pulse {{ width:7px; height:7px; border-radius:50%; background:var(--amber); animation:blink 1.2s infinite ease-in-out; }}
  @keyframes blink {{ 0%,100% {{ opacity:1; }} 50% {{ opacity:.25; }} }}
  p {{ font-size:12px; line-height:1.5; color:var(--muted); margin:14px 0 0; }}
  .err-detail {{ margin-top:10px; font-size:11px; color:var(--muted); word-break:break-all; }}
  .actions {{ display:flex; gap:10px; margin-top:20px; flex-wrap:wrap; }}
  .actions.show {{ display:flex; }}
  .btn-primary {{ flex:1; min-width:120px; padding:11px 16px; background:var(--cyan); color:#05060d; border:none; font-family:inherit; font-size:12px; font-weight:800; letter-spacing:1px; text-transform:uppercase; cursor:pointer; }}
  .btn-secondary {{ padding:11px 14px; background:var(--panel-hi); color:var(--text); border:1px solid var(--line); font-family:inherit; font-size:12px; font-weight:600; text-decoration:none; display:inline-flex; align-items:center; }}
  .btn-secondary:hover {{ border-color:var(--cyan); color:var(--cyan); }}
</style>
</head>
<body>
  <div class="shell" id="reconnect-card">
    <h1 id="title">Reconnecting…</h1>
    <span class="status-pill"><span class="pulse"></span><span id="retry-status">Server is restarting. You will be back where you were.</span></span>
    <p id="body-text">Your chat, squad and drafts are kept. This page reloads on its own as soon as the server answers.</p>
    <div class="err-detail" id="err-detail">{last_error}</div>
    <div class="actions" id="actions">
      <button type="button" class="btn-primary" id="retry-btn">Retry</button>
      <a href="/__desktop/setup" class="btn-secondary" id="switch-server-btn">Switch server / Re-pair</a>
      <a href="/__desktop/mode" class="btn-secondary" id="first-time-setup-btn">First-Time Setup</a>
      <button type="button" class="btn-secondary" id="check-update-btn" data-testid="desktop-check-update-btn">Check for Updates</button>
    </div>
  </div>
  <script>
    const started = Date.now();
    const GIVE_UP_MS = 30000;
    const statusEl = document.getElementById('retry-status');
    const checkUpdateBtn = document.getElementById('check-update-btn');
    let checking = false;
    // Loop guard: after 3 reloads that land back here, stop reloading and wait for a manual Retry.
    const RELOAD_KEY = 'vs.reconnect.reloads';
    const MAX_RELOADS = 3;
    let reloads = 0;
    try {{ reloads = Number(sessionStorage.getItem(RELOAD_KEY) || 0) || 0; }} catch (_) {{}}
    let halted = reloads >= MAX_RELOADS;
    function reloadApp() {{
      if (reloads >= MAX_RELOADS) {{ halted = true; showDown(); statusEl.textContent = 'Server answers but the app is not loading'; return; }}
      try {{ sessionStorage.setItem(RELOAD_KEY, String(reloads + 1)); }} catch (_) {{}}
      window.location.replace(window.location.pathname + window.location.search + window.location.hash);
    }}
    function showDown() {{
      const t = document.getElementById('title');
      t.textContent = 'Server Unreachable';
      t.className = 'down';
      document.getElementById('body-text').textContent = 'The server has not come back. Retry, or switch to another server. Your place is saved.';
      document.getElementById('actions').className = 'actions show';
    }}
    async function checkNow() {{
      if (checking) return;
      checking = true;
      try {{
        const res = await fetch('/__desktop/ping', {{ cache: 'no-store' }});
        const data = await res.json().catch(() => ({{}}));
        if (data.reachable) {{
          statusEl.textContent = 'Connected! Loading…';
          reloadApp();
          return;
        }}
      }} catch (e) {{}}
      finally {{ checking = false; }}
      if (Date.now() - started > GIVE_UP_MS) {{ showDown(); statusEl.textContent = 'Unreachable · retrying…'; }}
    }}
    document.getElementById('retry-btn').addEventListener('click', () => {{ reloads = 0; halted = false; try {{ sessionStorage.removeItem(RELOAD_KEY); }} catch (_) {{}} checkNow(); }});
    if (checkUpdateBtn) {{
      checkUpdateBtn.addEventListener('click', async () => {{
        checkUpdateBtn.disabled = true;
        checkUpdateBtn.textContent = 'Checking for updates…';
        try {{
          const res = await fetch('/__desktop/updater/check', {{ method: 'POST' }});
          const data = await res.json().catch(() => ({{}}));
          if (data && data.updateAvailable && data.downloaded) {{
            checkUpdateBtn.textContent = 'Installing v' + data.availableVersion + '…';
            await fetch('/__desktop/updater/install', {{ method: 'POST' }});
            return;
          }}
          checkUpdateBtn.textContent = data && data.currentVersion ? ('Up to date (v' + data.currentVersion + ')') : 'Up to date';
        }} catch (_) {{
          checkUpdateBtn.textContent = 'Update check failed';
        }} finally {{
          checkUpdateBtn.disabled = false;
        }}
      }});
    }}
    if (halted) {{ showDown(); statusEl.textContent = 'Server answers but the app is not loading'; }}
    setInterval(() => {{ if (!halted) checkNow(); }}, 1500);
  </script>
</body>
</html>"#,
        last_error = html_escape(last_error),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DesktopConfig;

    #[test]
    fn render_pair_page_simplifies_connect_ux_and_discloses_code_progressively() {
        let default_html = render_pair_page(&DesktopConfig::default(), None);
        assert!(!default_html.contains("Server not detected"));
        assert!(!default_html.contains("Pinned Root CA"));
        assert!(!default_html.contains("Shortcut: Ctrl+Shift+S"));
        assert!(!default_html.contains("use-localhost-btn"));
        assert!(
            default_html.contains("id=\"server-picker\" style=\"display:none\""),
            "empty config should hide the server picker"
        );
        assert!(
            default_html.contains("id=\"code-field\" style=\"display:none\""),
            "localhost config should hide the pairing-code field"
        );
        assert!(default_html.contains("data-testid=\"back-to-mode-choice\""));
        assert!(default_html.contains("data-testid=\"desktop-check-update-btn\""));

        let mut cfg = DesktopConfig::default();
        cfg.server_mode = "remote".to_string();
        cfg.last_lan_host = "192.168.1.50:4180".to_string();
        let remote_html = render_pair_page(&cfg, None);
        assert!(
            remote_html.contains("id=\"server-picker\" style=\"\""),
            "saved LAN host should reveal the server picker"
        );
        assert!(
            remote_html.contains("id=\"code-field\" style=\"\""),
            "remote host should reveal the pairing-code field"
        );
    }

    #[test]
    fn restore_path_and_bridge_strip_offer_hash() {
        assert_eq!(
            restore_path("/?remote=1#offer=abc", "#offer=abc"),
            "/?remote=1"
        );
        assert!(!desktop_bridge_script("#offer=abc", "/?remote=1#offer=abc").contains("#offer=abc"));
    }
}
