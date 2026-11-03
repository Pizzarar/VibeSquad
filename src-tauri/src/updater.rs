use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    sync::{atomic::Ordering, Arc},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{config_dir, save_config, stop_managed_server, SharedAppState};

pub const UPDATER_PUBKEY_B64: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZENDc0OERERTRBRjAyMjUKUldRbEFxL2szVWhIL2ZySlVFQWhVemM3UjU4NUZCcnFkeXhucXhTczFpaE5BUUF3NlRuNk1ZaFMK";

pub const STABLE_UPDATE_URL: &str =
    "https://github.com/Pizzarar/VibeSquad/releases/latest/download/latest.json";
pub const BETA_UPDATE_URL: &str =
    "https://github.com/Pizzarar/VibeSquad/releases/download/beta/latest.json";

#[derive(Debug, Clone, Default)]
pub struct UpdaterState {
    pub update_available: bool,
    pub available_version: String,
    pub notes: String,
    pub pub_date: String,
    pub downloaded: bool,
    pub downloaded_path: String,
    pub signature: String,
    pub last_checked_at: u64,
    pub last_error: String,
    pub install_triggered: bool,
    pub installed_version: String,
    pub forced_busy: Option<bool>,
}

pub fn normalize_channel(ch: &str) -> String {
    if ch.trim().eq_ignore_ascii_case("beta") {
        "beta".to_string()
    } else {
        "stable".to_string()
    }
}

/// The channel the updater follows. An explicit pick (Settings) wins. Otherwise a pre-release build
/// (0.1.1-beta.5) follows beta: with the first-run default "stable" it was offered the older 0.1.1 stable
/// and never saw the next beta (docs/PLAN_BUGS_BATCH1.md block 0d). Stable builds keep stable.
pub fn effective_channel(configured: &str, explicit: bool, current_version: &str) -> String {
    let ch = normalize_channel(configured);
    if explicit || ch == "beta" {
        return ch;
    }
    let pre = semver::Version::parse(current_version.trim().trim_start_matches('v'))
        .map(|v| !v.pre.is_empty())
        .unwrap_or(false);
    if pre { "beta".to_string() } else { ch }
}

fn channel_of(state: &Arc<SharedAppState>) -> String {
    let cfg = state.config.read().unwrap();
    effective_channel(&cfg.update_channel, cfg.update_channel_explicit, env!("CARGO_PKG_VERSION"))
}

pub fn endpoint_for_channel(channel: &str) -> String {
    let ch = normalize_channel(channel);
    if let Ok(base) = std::env::var("VIBESQUAD_UPDATE_BASE_URL") {
        let trimmed = base.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            return format!("{}/{}/latest.json", trimmed, ch);
        }
    }
    if ch == "beta" {
        BETA_UPDATE_URL.to_string()
    } else {
        STABLE_UPDATE_URL.to_string()
    }
}

pub fn verify_minisign_signature(
    pubkey_b64: &str,
    signature_b64: &str,
    data: &[u8],
) -> Result<(), String> {
    let pub_bytes = BASE64
        .decode(pubkey_b64.trim())
        .map_err(|e| format!("Invalid updater public key base64: {}", e))?;
    let pub_str = String::from_utf8(pub_bytes)
        .map_err(|e| format!("Invalid updater public key utf8: {}", e))?;
    let pk =
        PublicKey::decode(&pub_str).map_err(|e| format!("Invalid minisign public key: {}", e))?;

    let sig_trimmed = signature_b64.trim();
    if sig_trimmed.is_empty() {
        return Err("Missing signature".to_string());
    }
    let sig_str = if sig_trimmed.starts_with("untrusted comment:") {
        sig_trimmed.to_string()
    } else {
        let sig_bytes = BASE64
            .decode(sig_trimmed)
            .map_err(|e| format!("Invalid signature base64: {}", e))?;
        String::from_utf8(sig_bytes).map_err(|e| format!("Invalid signature utf8: {}", e))?
    };
    let sig = Signature::decode(&sig_str).map_err(|e| format!("Invalid minisign signature: {}", e))?;

    pk.verify(data, &sig, false)
        .map_err(|e| format!("Signature verification failed: {}", e))
}

pub fn is_version_newer_for_channel(
    current_ver_str: &str,
    remote_ver_str: &str,
    channel: &str,
) -> Result<bool, String> {
    let clean_cur = current_ver_str.trim().trim_start_matches('v');
    let clean_rem = remote_ver_str.trim().trim_start_matches('v');
    let cur = semver::Version::parse(clean_cur)
        .map_err(|e| format!("Invalid current semver '{}': {}", clean_cur, e))?;
    let rem = semver::Version::parse(clean_rem)
        .map_err(|e| format!("Invalid remote semver '{}': {}", clean_rem, e))?;

    // Stable channel ignores pre-release (beta) versions completely.
    if normalize_channel(channel) != "beta" && !rem.pre.is_empty() {
        return Ok(false);
    }
    Ok(rem > cur)
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn status_json(state: &Arc<SharedAppState>) -> Value {
    let channel = channel_of(state);
    let endpoint = endpoint_for_channel(&channel);
    let up = state.updater.lock().unwrap().clone();
    let busy = is_any_agent_running(state);
    json!({
        "ok": up.last_error.is_empty(),
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "channel": channel,
        "endpoint": endpoint,
        "updateAvailable": up.update_available,
        "availableVersion": up.available_version,
        "notes": up.notes,
        "pubDate": up.pub_date,
        "downloaded": up.downloaded,
        "downloadedPath": up.downloaded_path,
        "lastCheckedAt": up.last_checked_at,
        "lastError": up.last_error,
        "installTriggered": up.install_triggered,
        "installedVersion": up.installed_version,
        "agentTurnMidFlight": busy,
        "configWarning": crate::get_config_warning(),
    })
}

pub fn is_any_agent_running(state: &Arc<SharedAppState>) -> bool {
    if let Some(forced) = state.updater.lock().unwrap().forced_busy {
        return forced;
    }
    !state.tracker.lock().unwrap().running_agents.is_empty()
}

pub async fn check_for_updates(state: &Arc<SharedAppState>) -> Value {
    let channel = channel_of(state);
    let endpoint = endpoint_for_channel(&channel);
    let checked_at = now_unix_secs();

    let resp = match state
        .client()
        .get(&endpoint)
        .header("User-Agent", concat!("VibeSquad-Desktop-Updater/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let mut up = state.updater.lock().unwrap();
            up.last_checked_at = checked_at;
            up.last_error = format!("Update check failed: {}", e);
            drop(up);
            return status_json(state);
        }
    };

    if !resp.status().is_success() {
        let mut up = state.updater.lock().unwrap();
        up.last_checked_at = checked_at;
        up.last_error = format!("Update manifest returned HTTP {}", resp.status().as_u16());
        drop(up);
        return status_json(state);
    }

    let manifest_bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            let mut up = state.updater.lock().unwrap();
            up.last_checked_at = checked_at;
            up.last_error = format!("Failed reading update manifest: {}", e);
            drop(up);
            return status_json(state);
        }
    };

    let manifest: Value = match serde_json::from_slice(crate::strip_bom_bytes(&manifest_bytes)) {
        Ok(v) => v,
        Err(e) => {
            let mut up = state.updater.lock().unwrap();
            up.last_checked_at = checked_at;
            up.last_error = format!("Invalid update manifest JSON: {}", e);
            drop(up);
            return status_json(state);
        }
    };

    let remote_version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches('v')
        .to_string();
    let notes = manifest
        .get("notes")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let pub_date = manifest
        .get("pub_date")
        .or_else(|| manifest.get("pubDate"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let platform_obj = manifest
        .get("platforms")
        .and_then(|p| p.get("windows-x86_64").or_else(|| p.get("windows-x86_64-nsis")))
        .unwrap_or(&manifest);
    let download_url = platform_obj
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let signature = platform_obj
        .get("signature")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if remote_version.is_empty() || download_url.is_empty() {
        let mut up = state.updater.lock().unwrap();
        up.last_checked_at = checked_at;
        up.update_available = false;
        up.downloaded = false;
        up.last_error = "Rejected invalid latest.json (missing version or url)".to_string();
        drop(up);
        return status_json(state);
    }

    if signature.is_empty() {
        let mut up = state.updater.lock().unwrap();
        up.last_checked_at = checked_at;
        up.update_available = false;
        up.downloaded = false;
        up.last_error = "Rejected unsigned latest.json (missing signature)".to_string();
        drop(up);
        return status_json(state);
    }

    let newer = match is_version_newer_for_channel(env!("CARGO_PKG_VERSION"), &remote_version, &channel) {
        Ok(b) => b,
        Err(err) => {
            let mut up = state.updater.lock().unwrap();
            up.last_checked_at = checked_at;
            up.update_available = false;
            up.downloaded = false;
            up.last_error = err;
            drop(up);
            return status_json(state);
        }
    };

    if !newer {
        let mut up = state.updater.lock().unwrap();
        up.last_checked_at = checked_at;
        up.update_available = false;
        up.available_version.clear();
        up.downloaded = false;
        up.downloaded_path.clear();
        up.last_error.clear();
        drop(up);
        return status_json(state);
    }

    // Download the installer and cryptographically verify its Minisign signature before trusting it.
    let bin_resp = match state
        .client()
        .get(&download_url)
        .header("User-Agent", concat!("VibeSquad-Desktop-Updater/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let mut up = state.updater.lock().unwrap();
            up.last_checked_at = checked_at;
            up.update_available = false;
            up.downloaded = false;
            up.last_error = format!("Failed to download installer: {}", e);
            drop(up);
            return status_json(state);
        }
    };

    if !bin_resp.status().is_success() {
        let mut up = state.updater.lock().unwrap();
        up.last_checked_at = checked_at;
        up.update_available = false;
        up.downloaded = false;
        up.last_error = format!("Installer download returned HTTP {}", bin_resp.status().as_u16());
        drop(up);
        return status_json(state);
    }

    let installer_bytes = match bin_resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            let mut up = state.updater.lock().unwrap();
            up.last_checked_at = checked_at;
            up.update_available = false;
            up.downloaded = false;
            up.last_error = format!("Failed reading installer bytes: {}", e);
            drop(up);
            return status_json(state);
        }
    };

    if let Err(sig_err) = verify_minisign_signature(UPDATER_PUBKEY_B64, &signature, &installer_bytes) {
        let mut up = state.updater.lock().unwrap();
        up.last_checked_at = checked_at;
        up.update_available = false;
        up.downloaded = false;
        up.downloaded_path.clear();
        up.last_error = format!("Rejected tampered or unsigned installer ({})", sig_err);
        drop(up);
        return status_json(state);
    }

    let updates_dir = config_dir().join("updates");
    let _ = fs::create_dir_all(&updates_dir);
    let safe_ver: String = remote_version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    let installer_path = updates_dir.join(format!("VibeSquad-{}-setup.exe", safe_ver));
    if let Err(e) = fs::write(&installer_path, &installer_bytes) {
        let mut up = state.updater.lock().unwrap();
        up.last_checked_at = checked_at;
        up.last_error = format!("Failed saving verified installer: {}", e);
        drop(up);
        return status_json(state);
    }

    {
        let mut up = state.updater.lock().unwrap();
        up.last_checked_at = checked_at;
        up.update_available = true;
        up.available_version = remote_version;
        up.notes = notes;
        up.pub_date = pub_date;
        up.downloaded = true;
        up.downloaded_path = installer_path.to_string_lossy().to_string();
        up.signature = signature;
        up.last_error.clear();
    }

    // Auto-install immediately when no agent turn is mid-flight.
    if !is_any_agent_running(state) {
        let _ = install_downloaded_update(state);
    }

    status_json(state)
}

pub fn install_downloaded_update(state: &Arc<SharedAppState>) -> Result<Value, String> {
    let (downloaded, path_str, sig, ver) = {
        let up = state.updater.lock().unwrap();
        (
            up.downloaded,
            up.downloaded_path.clone(),
            up.signature.clone(),
            up.available_version.clone(),
        )
    };
    if !downloaded || path_str.is_empty() {
        return Err("No verified update is downloaded and ready to install".to_string());
    }
    let bytes = fs::read(&path_str).map_err(|e| format!("Failed reading downloaded installer: {}", e))?;
    verify_minisign_signature(UPDATER_PUBKEY_B64, &sig, &bytes)
        .map_err(|e| format!("Refusing to install unverified binary: {}", e))?;

    {
        let mut up = state.updater.lock().unwrap();
        up.install_triggered = true;
        up.installed_version = ver;
    }

    if std::env::var("VIBESQUAD_TEST_NO_EXEC_INSTALL").as_deref() == Ok("1") {
        return Ok(status_json(state));
    }

    state.quitting.store(true, Ordering::SeqCst);
    stop_managed_server(state);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new(&path_str)
            .arg("/S")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    if let Some(app) = state.app_handle.read().unwrap().as_ref() {
        app.exit(0);
    }

    Ok(status_json(state))
}

#[derive(Debug, Deserialize)]
pub struct ChannelPayload {
    #[serde(default)]
    pub channel: String,
}

#[derive(Debug, Deserialize)]
pub struct BusyPayload {
    pub busy: Option<bool>,
}

pub async fn handle_updater_status(State(state): State<Arc<SharedAppState>>) -> impl IntoResponse {
    Json(status_json(&state))
}

pub async fn handle_updater_channel(
    State(state): State<Arc<SharedAppState>>,
    Json(payload): Json<ChannelPayload>,
) -> Response {
    let raw = payload.channel.trim().to_lowercase();
    if raw != "stable" && raw != "beta" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "channel must be 'stable' or 'beta'" })),
        )
            .into_response();
    }
    {
        let mut cfg = state.config.write().unwrap();
        cfg.update_channel = raw;
        cfg.update_channel_explicit = true;
        let _ = save_config(&cfg);
    }
    {
        let mut up = state.updater.lock().unwrap();
        up.update_available = false;
        up.available_version.clear();
        up.downloaded = false;
        up.downloaded_path.clear();
        up.last_error.clear();
    }
    let st = check_for_updates(&state).await;
    Json(st).into_response()
}

pub async fn handle_updater_check(State(state): State<Arc<SharedAppState>>) -> impl IntoResponse {
    let st = check_for_updates(&state).await;
    if st.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        return (StatusCode::BAD_REQUEST, Json(st)).into_response();
    }
    Json(st).into_response()
}

pub async fn handle_updater_install(State(state): State<Arc<SharedAppState>>) -> Response {
    match install_downloaded_update(&state) {
        Ok(st) => Json(st).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}

pub async fn handle_updater_busy(
    State(state): State<Arc<SharedAppState>>,
    Json(payload): Json<BusyPayload>,
) -> impl IntoResponse {
    {
        let mut up = state.updater.lock().unwrap();
        up.forced_busy = payload.busy;
    }
    let ready = {
        let up = state.updater.lock().unwrap();
        up.downloaded && !up.install_triggered
    };
    if ready && !is_any_agent_running(&state) {
        let _ = install_downloaded_update(&state);
    }
    Json(status_json(&state))
}

pub fn spawn_updater_loop(state: Arc<SharedAppState>) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let _ = check_for_updates(&state).await;
        let mut ticks = 0u64;
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            ticks += 1;
            // Every 30s, if a downloaded update is waiting for an in-flight agent turn to finish, install once idle.
            let pending = {
                let up = state.updater.lock().unwrap();
                up.downloaded && !up.install_triggered
            };
            if pending && !is_any_agent_running(&state) {
                let _ = install_downloaded_update(&state);
            }
            // Poll every 5 minutes (10 * 30s) when disconnected, or every 4 hours (480 * 30s = 14400s) when connected.
            let disconnected = state.active_upstream.read().unwrap().is_none();
            if (disconnected && ticks % 10 == 0) || ticks % 480 == 0 {
                let _ = check_for_updates(&state).await;
            }
        }
    });
}
