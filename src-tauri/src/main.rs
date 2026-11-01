#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ui_pages;
mod updater;

use axum::{
    body::Body,
    extract::{
        ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::BufReader,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tokio::net::TcpListener;
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{client::IntoClientRequest, Message as TungMessage},
    Connector,
};

const PINNED_CA_PEM: &[u8] = include_bytes!("../certs/vibesquad-ca.crt");
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/32x32.png");

const DEFAULT_LAN_HOST: &str = "";
const DEFAULT_MESHNET_HOST: &str = "";
const DEFAULT_MESHNET_IP_HOST: &str = "";

/// The bundled/local VibeSquad server. (DEFAULT_LAN_HOST stays empty so no personal IPs ship in the binary.)
fn default_server_host() -> String {
    "127.0.0.1:4180".to_string()
}

fn default_fallback_host() -> String {
    DEFAULT_MESHNET_HOST.to_string()
}

fn default_update_channel() -> String {
    "stable".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    #[serde(default)]
    pub server_mode: String,
    #[serde(default = "default_server_host")]
    pub server_host: String,
    #[serde(default = "default_fallback_host")]
    pub fallback_host: String,
    #[serde(default)]
    pub last_lan_host: String,
    #[serde(default)]
    pub last_meshnet_host: String,
    #[serde(default)]
    pub device_token: String,
    #[serde(default)]
    pub start_at_login: bool,
    #[serde(default)]
    pub last_hash: String,
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            server_mode: String::new(),
            server_host: default_server_host(),
            fallback_host: default_fallback_host(),
            last_lan_host: String::new(),
            last_meshnet_host: String::new(),
            device_token: String::new(),
            start_at_login: false,
            last_hash: String::new(),
            update_channel: default_update_channel(),
        }
    }
}

/// Unifies config storage into `%LOCALAPPDATA%\com.vibesquad.desktop` alongside WebView2 state.
pub fn config_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("VIBESQUAD_DESKTOP_CONFIG_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        if !local_appdata.trim().is_empty() {
            return PathBuf::from(local_appdata).join("com.vibesquad.desktop");
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return PathBuf::from(appdata).join("com.vibesquad.desktop");
        }
    }
    PathBuf::from(".").join(".vibesquad-desktop")
}

/// Removes legacy `%APPDATA%\VibeSquad` directory so stale config from earlier builds never traps the user.
pub fn cleanup_legacy_config_dir() {
    if std::env::var("VIBESQUAD_DESKTOP_CONFIG_DIR").is_ok() {
        return;
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let legacy_dir = PathBuf::from(appdata).join("VibeSquad");
        if legacy_dir.exists() {
            let _ = fs::remove_dir_all(&legacy_dir);
        }
    }
}

pub fn config_file_path() -> PathBuf {
    config_dir().join("desktop-config.json")
}

/// Strips a leading UTF-8 BOM (`\u{feff}` / `EF BB BF`) written by PowerShell `Set-Content`.
pub fn strip_bom(s: &str) -> &str {
    s.trim_start_matches('\u{feff}')
}

pub fn strip_bom_bytes(b: &[u8]) -> &[u8] {
    b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b)
}

static DESKTOP_CONFIG_WARNING: std::sync::OnceLock<Mutex<Option<String>>> =
    std::sync::OnceLock::new();

fn config_warning_slot() -> &'static Mutex<Option<String>> {
    DESKTOP_CONFIG_WARNING.get_or_init(|| Mutex::new(None))
}

pub fn get_config_warning() -> Option<String> {
    config_warning_slot().lock().ok().and_then(|g| g.clone())
}

pub fn set_config_warning(warning: Option<String>) {
    if let Ok(mut g) = config_warning_slot().lock() {
        *g = warning;
    }
}

pub fn load_config() -> DesktopConfig {
    cleanup_legacy_config_dir();
    let path = config_file_path();
    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(raw) => {
                let had_bom = raw.starts_with('\u{feff}');
                let cleaned = strip_bom(&raw);
                match serde_json::from_str::<DesktopConfig>(cleaned) {
                    Ok(mut cfg) => {
                        if cfg.server_host.trim().is_empty() && cfg.server_mode != "remote" {
                            cfg.server_host = default_server_host();
                        }
                        if cfg.fallback_host.trim().is_empty() {
                            cfg.fallback_host = default_fallback_host();
                        }
                        if cfg.update_channel != "beta" && cfg.update_channel != "stable" {
                            cfg.update_channel = default_update_channel();
                        }
                        if cfg.server_mode.trim().is_empty() {
                            if !cfg.device_token.trim().is_empty() || !is_local_host(&cfg.server_host) {
                                cfg.server_mode = "remote".to_string();
                            }
                        }
                        set_config_warning(None);
                        if had_bom {
                            let _ = save_config(&cfg);
                        }
                        return cfg;
                    }
                    Err(err) => {
                        let msg = format!(
                            "Invalid JSON in desktop-config.json ({}): {}",
                            path.display(),
                            err
                        );
                        eprintln!("[vibesquad-desktop] {}", msg);
                        set_config_warning(Some(msg));
                        // Never overwrite a corrupt config file on disk with defaults.
                        return DesktopConfig::default();
                    }
                }
            }
            Err(err) => {
                let msg = format!(
                    "Failed reading desktop-config.json ({}): {}",
                    path.display(),
                    err
                );
                eprintln!("[vibesquad-desktop] {}", msg);
                set_config_warning(Some(msg));
                return DesktopConfig::default();
            }
        }
    }
    set_config_warning(None);
    let cfg = DesktopConfig::default();
    let _ = save_config(&cfg);
    cfg
}

pub fn is_lan_host(host: &str) -> bool {
    let ip_part = normalize_host(host)
        .split(':')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let parts: Vec<u16> = ip_part
        .split('.')
        .filter_map(|p| p.parse::<u16>().ok())
        .collect();
    if parts.len() == 4 {
        if parts[0] == 192 && parts[1] == 168 {
            return true;
        }
        if parts[0] == 10 {
            return true;
        }
        if parts[0] == 172 && (16..=31).contains(&parts[1]) {
            return true;
        }
    }
    false
}

pub fn save_config(cfg: &DesktopConfig) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("desktop-config.json");
    let json_str = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, json_str).map_err(|e| e.to_string())?;
    set_config_warning(None);
    Ok(())
}

pub fn is_local_host(host: &str) -> bool {
    let clean = normalize_host(host).to_lowercase();
    clean.starts_with("localhost")
        || clean.starts_with("127.0.0.1")
        || clean.starts_with("[::1]")
}

pub fn normalize_host(input: &str) -> String {
    let mut s = input.trim().to_string();
    if let Some(rest) = s.strip_prefix("https://") {
        s = rest.to_string();
    } else if let Some(rest) = s.strip_prefix("http://") {
        s = rest.to_string();
    }
    if let Some(idx) = s.find('/') {
        s = s[..idx].to_string();
    }
    let s = s.trim().to_string();
    if s.is_empty() {
        return default_server_host();
    }
    if !s.contains(':') {
        format!("{}:4180", s)
    } else {
        s
    }
}

fn html_no_store_response(status: StatusCode, html_body: String) -> Response {
    Response::builder()
        .status(status)
        .header(
            axum::http::header::CONTENT_TYPE,
            "text/html; charset=utf-8",
        )
        .header(
            axum::http::header::CACHE_CONTROL,
            "no-store, no-cache, must-revalidate",
        )
        .body(Body::from(html_body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Verifies that a local `127.0.0.1:4180` / `localhost:4180` server is actually running AND has a built `dist/index.html` (`<div id="root">`).
async fn check_local_server_healthy(client: &reqwest::Client, host: &str) -> Result<(), String> {
    let norm = normalize_host(host);
    let status_url = format!("http://{}/api/auth/status", norm);
    if let Ok(resp) = client
        .get(&status_url)
        .timeout(Duration::from_millis(1800))
        .send()
        .await
    {
        if let Ok(json_val) = resp.json::<Value>().await {
            if json_val.get("distReady").and_then(|v| v.as_bool()) == Some(false) {
                return Err("dist/index.html missing on localhost".to_string());
            }
        }
    }

    let root_url = format!("http://{}/", norm);
    let resp = client
        .get(&root_url)
        .timeout(Duration::from_millis(1800))
        .send()
        .await
        .map_err(|e| format!("Localhost unreachable: {}", e))?;

    if resp.status() != reqwest::StatusCode::OK {
        return Err(format!("Localhost returned HTTP {}", resp.status()));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed reading localhost response: {}", e))?;
    if body.contains("dist/index.html missing") || !body.contains("<div id=\"root\">") {
        return Err("dist/index.html missing on localhost".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn set_start_at_login_registry(enabled: bool) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = hkcu
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|e| e.to_string())?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let val = format!("\"{}\"", exe.display());
        run_key
            .set_value("VibeSquad", &val)
            .map_err(|e| e.to_string())?;
    } else {
        let _ = run_key.delete_value("VibeSquad");
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_start_at_login_registry(_enabled: bool) -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub struct AgentAlertTracker {
    seeded: bool,
    needs_by_agent: HashMap<String, String>,
    pub running_agents: HashSet<String>,
    dedupe: HashSet<String>,
}

pub struct SharedAppState {
    pub config: RwLock<DesktopConfig>,
    pub active_upstream: RwLock<Option<String>>,
    pub setup_mode: AtomicBool,
    pub quitting: AtomicBool,
    pub needs_count: AtomicUsize,
    pub local_port: AtomicUsize,
    pub http_client: RwLock<reqwest::Client>,
    pub ws_tls_connector: RwLock<Connector>,
    pub app_handle: RwLock<Option<AppHandle>>,
    pub tray_needs_item: RwLock<Option<MenuItem<tauri::Wry>>>,
    pub tracker: Mutex<AgentAlertTracker>,
    pub updater: Mutex<updater::UpdaterState>,
    /// The `node.exe server/serve.mjs` child we spawned (None when we reused an already-running server).
    pub managed_server: Mutex<Option<std::process::Child>>,
}

impl SharedAppState {
    pub fn client(&self) -> reqwest::Client {
        self.http_client.read().unwrap().clone()
    }

    pub fn ws_connector(&self) -> Connector {
        self.ws_tls_connector.read().unwrap().clone()
    }

    pub fn reload_tls(&self) {
        if let Ok((http, ws)) = build_http_and_ws_clients() {
            *self.http_client.write().unwrap() = http;
            *self.ws_tls_connector.write().unwrap() = ws;
        }
    }

    /// Builds the ordered candidate list for remote servers:
    /// `active_upstream` (if valid), configured `server_host`, Home LAN, Meshnet host, and Meshnet IP, deduplicated.
    pub fn candidate_hosts(&self) -> Vec<String> {
        let cfg = self.config.read().unwrap().clone();
        if cfg.server_mode.trim().is_empty() {
            return Vec::new();
        }
        let primary = normalize_host(&cfg.server_host);
        if cfg.server_mode == "local" || (cfg.server_mode != "remote" && is_local_host(&primary)) {
            return vec![primary];
        }
        let fallback = if cfg.fallback_host.trim().is_empty() {
            String::new()
        } else {
            normalize_host(&cfg.fallback_host)
        };
        let mut list = Vec::new();
        let push_unique = |vec: &mut Vec<String>, h: String| {
            let trimmed = h.trim().to_string();
            if !trimmed.is_empty() && !is_local_host(&trimmed) && !vec.contains(&trimmed) {
                vec.push(trimmed);
            }
        };

        if let Some(active) = self.active_upstream.read().unwrap().clone() {
            if !is_local_host(&active) {
                push_unique(&mut list, active);
            }
        }
        push_unique(&mut list, primary);
        push_unique(&mut list, cfg.last_lan_host.clone());
        push_unique(&mut list, DEFAULT_LAN_HOST.to_string());
        push_unique(&mut list, fallback);
        push_unique(&mut list, cfg.last_meshnet_host.clone());
        push_unique(&mut list, DEFAULT_MESHNET_HOST.to_string());
        push_unique(&mut list, DEFAULT_MESHNET_IP_HOST.to_string());
        list
    }

    pub fn set_needs_count(&self, count: usize) {
        let _prev = self.needs_count.swap(count, Ordering::SeqCst);
        if let Some(item) = self.tray_needs_item.read().unwrap().as_ref() {
            let _ = item.set_text(format!("Needs You: {}", count));
        }
        if let Some(app) = self.app_handle.read().unwrap().as_ref() {
            if let Some(tray) = app.tray_by_id("main-tray") {
                let tooltip = if count > 0 {
                    format!("VibeSquad — {} needs you", count)
                } else {
                    "VibeSquad — Connected".to_string()
                };
                let _ = tray.set_tooltip(Some(&tooltip));
                if let Ok(icon) = render_tray_icon(count) {
                    let _ = tray.set_icon(Some(icon));
                }
            }
        }
    }

    pub fn fire_native_notification(&self, title: &str, body: &str) {
        if let Some(app) = self.app_handle.read().unwrap().as_ref() {
            let _ = app
                .notification()
                .builder()
                .title(title)
                .body(body)
                .show();
        }
    }
}

pub fn render_tray_icon(needs_count: usize) -> Result<Image<'static>, String> {
    let img = image::load_from_memory(TRAY_ICON_PNG)
        .map_err(|e| e.to_string())?
        .into_rgba8();
    let (width, height) = img.dimensions();
    let mut raw = img.into_raw();

    if needs_count > 0 {
        // Overlay a bright magenta/hot-pink circular notification badge in bottom-right
        let cx = (width as i32) - 8;
        let cy = (height as i32) - 8;
        let outer_r = 7i32;
        let inner_r = 5i32;
        for y in 0..(height as i32) {
            for x in 0..(width as i32) {
                let dx = x - cx;
                let dy = y - cy;
                let dist_sq = dx * dx + dy * dy;
                if dist_sq <= outer_r * outer_r {
                    let idx = ((y as u32 * width + x as u32) * 4) as usize;
                    if dist_sq <= inner_r * inner_r {
                        // Bright neon magenta (#ff2a85) with a subtle top-left highlight
                        if dx < -1 && dy < -1 {
                            raw[idx] = 0xff;
                            raw[idx + 1] = 0x7a;
                            raw[idx + 2] = 0xb5;
                            raw[idx + 3] = 0xff;
                        } else {
                            raw[idx] = 0xff;
                            raw[idx + 1] = 0x2a;
                            raw[idx + 2] = 0x85;
                            raw[idx + 3] = 0xff;
                        }
                    } else {
                        // Dark border ring (#0c0b14)
                        raw[idx] = 0x0c;
                        raw[idx + 1] = 0x0b;
                        raw[idx + 2] = 0x14;
                        raw[idx + 3] = 0xff;
                    }
                }
            }
        }
    }

    Ok(Image::new_owned(raw, width, height))
}

/// Root CAs to trust besides the public roots: the embedded one (if the build had it),
/// any remote CAs pinned during pairing in `config_dir()/trusted-cas/`, and the locally
/// generated `~/.vibesquad/tls/ca.crt`.
fn trusted_cas_dir() -> PathBuf {
    config_dir().join("trusted-cas")
}

fn load_ca_pems() -> Vec<Vec<u8>> {
    let mut pems: Vec<Vec<u8>> = Vec::new();
    if !PINNED_CA_PEM.is_empty() {
        pems.push(PINNED_CA_PEM.to_vec());
    }
    let cas_dir = trusted_cas_dir();
    if let Ok(entries) = fs::read_dir(&cas_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("crt") {
                if let Ok(bytes) = fs::read(&p) {
                    if !bytes.is_empty() && !pems.contains(&bytes) {
                        pems.push(bytes);
                    }
                }
            }
        }
    }
    let home = std::env::var("VIBESQUAD_HOME")
        .map(PathBuf::from)
        .ok()
        .or_else(|| {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .ok()
                .map(|h| PathBuf::from(h).join(".vibesquad"))
        });
    if let Some(home) = home {
        if let Ok(bytes) = fs::read(home.join("tls").join("ca.crt")) {
            if !bytes.is_empty() && !pems.contains(&bytes) {
                pems.push(bytes);
            }
        }
    }
    pems
}

/// Fetches `http://{host}/ca.crt` from the server's HTTP/HTTPS mux during pairing, validates it as a
/// PEM certificate, saves it under `config_dir()/trusted-cas/`, and reloads the shared TLS clients.
async fn fetch_and_pin_remote_ca(state: &Arc<SharedAppState>, host: &str) -> bool {
    if is_local_host(host) {
        return false;
    }
    let url = format!("http://{}/ca.crt", host);
    let resp = match state
        .client()
        .get(&url)
        .timeout(Duration::from_millis(2000))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return false,
    };
    let bytes = match resp.bytes().await {
        Ok(b) if !b.is_empty() && b.len() <= 64 * 1024 => b.to_vec(),
        _ => return false,
    };
    let mut reader = BufReader::new(bytes.as_slice());
    let mut valid_cert = false;
    for cert in rustls_pemfile::certs(&mut reader) {
        if cert.is_ok() {
            valid_cert = true;
            break;
        }
    }
    if !valid_cert {
        return false;
    }
    let safe_name: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    let dir = trusted_cas_dir();
    if fs::create_dir_all(&dir).is_ok() {
        let file = dir.join(format!("{}.crt", safe_name));
        if fs::write(&file, &bytes).is_ok() {
            state.reload_tls();
            return true;
        }
    }
    false
}

fn build_http_and_ws_clients() -> Result<(reqwest::Client, Connector), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let ca_pems = load_ca_pems();
    let mut http_builder = reqwest::Client::builder().use_rustls_tls();
    for pem in &ca_pems {
        let cert = reqwest::Certificate::from_pem(pem).map_err(|e| format!("CA PEM err: {}", e))?;
        http_builder = http_builder.add_root_certificate(cert);
    }

    let http_client = http_builder
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(1500))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("reqwest build err: {}", e))?;

    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for pem in &ca_pems {
        let mut reader = BufReader::new(pem.as_slice());
        for cert in rustls_pemfile::certs(&mut reader) {
            let cert_der = cert.map_err(|e| format!("rustls cert parse err: {}", e))?;
            root_store
                .add(cert_der)
                .map_err(|e| format!("rustls add root err: {}", e))?;
        }
    }

    let tls_config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    let ws_connector = Connector::Rustls(Arc::new(tls_config));
    Ok((http_client, ws_connector))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PairSubmission {
    #[serde(default)]
    server_host: String,
    #[serde(default)]
    code: String,
}

fn extract_cookie_token(headers: &reqwest::header::HeaderMap, cookie_name: &str) -> Option<String> {
    let prefix = format!("{}=", cookie_name);
    for val in headers.get_all(reqwest::header::SET_COOKIE) {
        if let Ok(s) = val.to_str() {
            for part in s.split(';') {
                let trimmed = part.trim();
                if let Some(rest) = trimmed.strip_prefix(&prefix) {
                    if !rest.is_empty() {
                        return Some(rest.to_string());
                    }
                }
            }
        }
    }
    None
}

async fn handle_desktop_status(State(state): State<Arc<SharedAppState>>) -> impl IntoResponse {
    let cfg = state.config.read().unwrap().clone();
    let active = state.active_upstream.read().unwrap().clone();
    let is_local = cfg.server_mode == "local" || (cfg.server_mode != "remote" && is_local_host(&cfg.server_host));
    let paired = if cfg.server_mode.trim().is_empty() {
        false
    } else if is_local {
        check_local_server_healthy(&state.client(), &cfg.server_host)
            .await
            .is_ok()
    } else {
        !cfg.device_token.trim().is_empty()
    };
    Json(json!({
        "ok": true,
        "serverMode": cfg.server_mode,
        "serverHost": cfg.server_host,
        "fallbackHost": cfg.fallback_host,
        "lastLanHost": cfg.last_lan_host,
        "lastMeshnetHost": cfg.last_meshnet_host,
        "activeHost": active,
        "paired": paired,
        "setupMode": state.setup_mode.load(Ordering::SeqCst),
        "needsCount": state.needs_count.load(Ordering::SeqCst),
        "startAtLogin": cfg.start_at_login,
        "updateChannel": cfg.update_channel,
        "localPort": state.local_port.load(Ordering::SeqCst),
        "configDir": config_dir().to_string_lossy(),
        "configWarning": get_config_warning(),
    }))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ChooseModePayload {
    #[serde(default)]
    mode: String,
}

async fn handle_desktop_choose_mode(
    State(state): State<Arc<SharedAppState>>,
    Json(payload): Json<ChooseModePayload>,
) -> Response {
    let mode = payload.mode.trim().to_lowercase();
    if mode == "local" {
        {
            let mut cfg = state.config.write().unwrap();
            cfg.server_mode = "local".to_string();
            cfg.server_host = default_server_host();
            let _ = save_config(&cfg);
        }
        state.setup_mode.store(false, Ordering::SeqCst);
        ensure_local_server_running(&state).await;
        *state.active_upstream.write().unwrap() = Some(default_server_host());
        return Json(json!({
            "ok": true,
            "serverMode": "local",
            "redirect": "/"
        }))
        .into_response();
    }
    if mode == "remote" {
        stop_managed_server(&state);
        {
            let mut cfg = state.config.write().unwrap();
            cfg.server_mode = "remote".to_string();
            if is_local_host(&cfg.server_host) {
                cfg.server_host = if !cfg.last_lan_host.trim().is_empty() {
                    cfg.last_lan_host.trim().to_string()
                } else if !cfg.last_meshnet_host.trim().is_empty() {
                    cfg.last_meshnet_host.trim().to_string()
                } else {
                    String::new()
                };
            }
            let _ = save_config(&cfg);
        }
        *state.active_upstream.write().unwrap() = None;
        state.setup_mode.store(true, Ordering::SeqCst);
        return Json(json!({
            "ok": true,
            "serverMode": "remote",
            "redirect": "/__desktop/setup"
        }))
        .into_response();
    }
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": "mode must be 'local' or 'remote'" })),
    )
        .into_response()
}

async fn handle_desktop_ping(
    State(state): State<Arc<SharedAppState>>,
    req: Request,
) -> impl IntoResponse {
    let want_all = req
        .uri()
        .query()
        .map(|q| q.contains("probe=all"))
        .unwrap_or(false);

    let cfg = state.config.read().unwrap().clone();
    let lan_target = if !cfg.last_lan_host.trim().is_empty() {
        cfg.last_lan_host.trim().to_string()
    } else {
        DEFAULT_LAN_HOST.to_string()
    };
    let mesh_target = if !cfg.last_meshnet_host.trim().is_empty() {
        cfg.last_meshnet_host.trim().to_string()
    } else if !cfg.fallback_host.trim().is_empty() {
        cfg.fallback_host.trim().to_string()
    } else {
        DEFAULT_MESHNET_HOST.to_string()
    };

    let mut lan_ok = false;
    let mut mesh_ok = false;
    let mut local_ok = false;

    if want_all {
        let c1 = state.client();
        let c2 = state.client();
        let c3 = state.client();
        let lan_t = lan_target.clone();
        let mesh_t = mesh_target.clone();
        let (r_lan, r_mesh, r_loc) = tokio::join!(
            async move {
                if lan_t.is_empty() {
                    return false;
                }
                c1.get(format!("http://{}/ca.crt", lan_t))
                    .timeout(Duration::from_millis(1200))
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false)
            },
            async move {
                if mesh_t.is_empty() {
                    return false;
                }
                if c2
                    .get(format!("http://{}/ca.crt", mesh_t))
                    .timeout(Duration::from_millis(1200))
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false)
                {
                    true
                } else if !DEFAULT_MESHNET_IP_HOST.is_empty() {
                    c2.get(format!("http://{}/ca.crt", DEFAULT_MESHNET_IP_HOST))
                        .timeout(Duration::from_millis(1200))
                        .send()
                        .await
                        .map(|r| r.status().is_success())
                        .unwrap_or(false)
                } else {
                    false
                }
            },
            async move { check_local_server_healthy(&c3, "127.0.0.1:4180").await.is_ok() }
        );
        lan_ok = r_lan;
        mesh_ok = r_mesh;
        local_ok = r_loc;
    }

    let candidates = state.candidate_hosts();
    for host in candidates {
        if is_local_host(&host) {
            if check_local_server_healthy(&state.client(), &host)
                .await
                .is_ok()
            {
                *state.active_upstream.write().unwrap() = Some(host.clone());
                return Json(json!({
                    "ok": true,
                    "reachable": true,
                    "status": 200,
                    "activeHost": host,
                    "lanHost": lan_target,
                    "meshnetHost": mesh_target,
                    "probes": {
                        "lan": lan_ok,
                        "meshnet": mesh_ok,
                        "local": true,
                    }
                }));
            }
            continue;
        }
        let url = format!("https://{}/ca.crt", host);
        if let Ok(resp) = state
            .client()
            .get(&url)
            .timeout(Duration::from_millis(1500))
            .send()
            .await
        {
            *state.active_upstream.write().unwrap() = Some(host.clone());
            return Json(json!({
                "ok": true,
                "reachable": true,
                "status": resp.status().as_u16(),
                "activeHost": host,
                "lanHost": lan_target,
                "meshnetHost": mesh_target,
                "probes": {
                    "lan": lan_ok || host == lan_target,
                    "meshnet": mesh_ok || host == mesh_target || host == DEFAULT_MESHNET_IP_HOST,
                    "local": local_ok,
                }
            }));
        }
    }
    Json(json!({
        "ok": true,
        "reachable": false,
        "lanHost": lan_target,
        "meshnetHost": mesh_target,
        "probes": {
            "lan": lan_ok,
            "meshnet": mesh_ok,
            "local": local_ok,
        }
    }))
}

async fn handle_desktop_setup(State(state): State<Arc<SharedAppState>>) -> Response {
    *state.active_upstream.write().unwrap() = None;
    state.setup_mode.store(true, Ordering::SeqCst);
    let cfg = state.config.read().unwrap().clone();
    html_no_store_response(StatusCode::OK, ui_pages::render_pair_page(&cfg, None))
}

async fn handle_desktop_unpair(State(state): State<Arc<SharedAppState>>) -> impl IntoResponse {
    {
        let mut cfg = state.config.write().unwrap();
        cfg.device_token.clear();
        let _ = save_config(&cfg);
    }
    *state.active_upstream.write().unwrap() = None;
    state.setup_mode.store(true, Ordering::SeqCst);
    Json(json!({ "ok": true }))
}

async fn handle_desktop_pair(
    State(state): State<Arc<SharedAppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let clean_body = strip_bom_bytes(&body);
    let submission: PairSubmission = if content_type.contains("application/json") {
        serde_json::from_slice(clean_body).unwrap_or_default()
    } else if let Ok(sub) = serde_json::from_slice::<PairSubmission>(clean_body) {
        sub
    } else {
        let mut sub = PairSubmission::default();
        if let Ok(form_str) = std::str::from_utf8(clean_body) {
            for pair in url::form_urlencoded::parse(form_str.as_bytes()) {
                match pair.0.as_ref() {
                    "serverHost" => sub.server_host = pair.1.into_owned(),
                    "code" => sub.code = pair.1.into_owned(),
                    _ => {}
                }
            }
        }
        sub
    };

    let mut raw_host = submission.server_host.trim().to_string();
    let mut raw_code = submission.code.trim().to_string();

    // If user pasted a full https://.../pair?code=... URL into either field, extract both!
    for candidate in [&submission.code, &submission.server_host] {
        let trimmed = candidate.trim();
        if (trimmed.starts_with("https://") || trimmed.starts_with("http://"))
            && trimmed.contains("code=")
        {
            if let Ok(parsed) = url::Url::parse(trimmed) {
                if let Some(h) = parsed.host_str() {
                    let port = parsed.port().unwrap_or(4180);
                    raw_host = format!("{}:{}", h, port);
                }
                for (k, v) in parsed.query_pairs() {
                    if k == "code" && !v.is_empty() {
                        raw_code = v.into_owned();
                    }
                }
            }
        }
    }

    let server_host = if raw_host.is_empty() {
        state.config.read().unwrap().server_host.clone()
    } else {
        normalize_host(&raw_host)
    };

    if server_host.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": "Please enter your server PC's address (shown in its Pair a device dialog)."
            })),
        )
            .into_response();
    }

    // Localhost mode: start or verify health & dist/index.html BEFORE saving or treating as paired!
    if is_local_host(&server_host) {
        {
            let mut cfg = state.config.write().unwrap();
            cfg.server_mode = "local".to_string();
            cfg.server_host = server_host.clone();
            let _ = save_config(&cfg);
        }
        ensure_local_server_running(&state).await;
        if let Err(_reason) = check_local_server_healthy(&state.client(), &server_host).await {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "error": "127.0.0.1:4180 does not have a built VibeSquad server (dist/index.html missing). Connect to a remote VibeSquad server instead."
                })),
            )
                .into_response();
        }
        *state.active_upstream.write().unwrap() = Some(server_host.clone());
        state.setup_mode.store(false, Ordering::SeqCst);
        return (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "redirect": "/",
                "serverHost": server_host,
                "local": true
            })),
        )
            .into_response();
    }

    // Remote server mode: stop any local managed server and clean 6-digit code
    stop_managed_server(&state);
    let clean_code = {
        let compact: String = raw_code
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect();
        if compact.len() == 6 && compact.chars().all(|c| c.is_ascii_digit()) {
            compact
        } else {
            raw_code.clone()
        }
    };

    if clean_code.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": "Please enter the 6-digit pairing code from the server's PAIR DEVICE dialog."
            })),
        )
            .into_response();
    }

    // Build ordered candidate list: configured server_host, then saved/default Home LAN and Meshnet hosts
    let (fallback_host, last_lan, last_mesh) = {
        let cfg = state.config.read().unwrap();
        (
            cfg.fallback_host.clone(),
            cfg.last_lan_host.clone(),
            cfg.last_meshnet_host.clone(),
        )
    };
    let mut try_hosts = Vec::new();
    let push_unique = |vec: &mut Vec<String>, h: String| {
        let trimmed = h.trim().to_string();
        if !trimmed.is_empty() && !is_local_host(&trimmed) && !vec.contains(&trimmed) {
            vec.push(trimmed);
        }
    };
    push_unique(&mut try_hosts, server_host.clone());
    push_unique(&mut try_hosts, last_lan);
    push_unique(&mut try_hosts, DEFAULT_LAN_HOST.to_string());
    if !fallback_host.trim().is_empty() {
        push_unique(&mut try_hosts, normalize_host(&fallback_host));
    }
    push_unique(&mut try_hosts, last_mesh);
    push_unique(&mut try_hosts, DEFAULT_MESHNET_HOST.to_string());
    push_unique(&mut try_hosts, DEFAULT_MESHNET_IP_HOST.to_string());

    let mut last_conn_err = String::new();
    for host in &try_hosts {
        // Auto-fetch and pin the server's Root CA (`http://{host}/ca.crt`) before the HTTPS pair request.
        let _ = fetch_and_pin_remote_ca(&state, host).await;

        let mut pair_url = match url::Url::parse(&format!("https://{}/pair", host)) {
            Ok(u) => u,
            Err(e) => {
                last_conn_err = e.to_string();
                continue;
            }
        };
        pair_url
            .query_pairs_mut()
            .append_pair("code", &clean_code)
            .append_pair("name", "Windows · VibeSquad App");

        match state
            .client()
            .get(pair_url.as_str())
            .header("User-Agent", "VibeSquad-Desktop/0.1.1 (Windows)")
            .timeout(Duration::from_millis(2500))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if let Some(token) = extract_cookie_token(resp.headers(), "vs_device") {
                    {
                        let mut cfg = state.config.write().unwrap();
                        cfg.server_mode = "remote".to_string();
                        cfg.server_host = host.clone();
                        if is_lan_host(host) {
                            cfg.last_lan_host = host.clone();
                        } else {
                            cfg.last_meshnet_host = host.clone();
                        }
                        cfg.device_token = token;
                        let _ = save_config(&cfg);
                    }
                    *state.active_upstream.write().unwrap() = Some(host.clone());
                    state.setup_mode.store(false, Ordering::SeqCst);
                    return (
                        StatusCode::OK,
                        Json(json!({
                            "ok": true,
                            "redirect": "/",
                            "serverHost": host,
                            "activeHost": host,
                            "deviceTokenSaved": true
                        })),
                    )
                        .into_response();
                }

                if status == reqwest::StatusCode::UNAUTHORIZED {
                    return (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({
                            "ok": false,
                            "error": "Pairing code is invalid, expired, or already used. Click 'New Code' in Pair Device on your server PC."
                        })),
                    )
                        .into_response();
                }

                last_conn_err = format!("Unexpected response HTTP {} from {}", status, host);
            }
            Err(e) => {
                last_conn_err = format!("{}: {}", host, e);
            }
        }
    }

    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "ok": false,
            "error": format!("Could not reach VibeSquad server ({}). Check your server host configuration.", last_conn_err)
        })),
    )
        .into_response()
}

#[derive(Deserialize, Default)]
struct HashUpdate {
    #[serde(default)]
    hash: String,
}

async fn handle_desktop_hash(
    State(state): State<Arc<SharedAppState>>,
    Json(payload): Json<HashUpdate>,
) -> impl IntoResponse {
    {
        let mut cfg = state.config.write().unwrap();
        cfg.last_hash = payload.hash;
        let _ = save_config(&cfg);
    }
    Json(json!({ "ok": true }))
}

#[derive(Deserialize, Default)]
struct BadgeUpdate {
    #[serde(default)]
    count: usize,
}

async fn handle_desktop_badge(
    State(state): State<Arc<SharedAppState>>,
    Json(payload): Json<BadgeUpdate>,
) -> impl IntoResponse {
    state.set_needs_count(payload.count);
    Json(json!({ "ok": true, "needsCount": payload.count }))
}

#[derive(Deserialize, Default)]
struct NotifyPayload {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
}

async fn handle_desktop_notify(
    State(state): State<Arc<SharedAppState>>,
    Json(payload): Json<NotifyPayload>,
) -> impl IntoResponse {
    let title = if payload.title.trim().is_empty() {
        "VibeSquad"
    } else {
        payload.title.trim()
    };
    state.fire_native_notification(title, payload.body.trim());
    Json(json!({ "ok": true }))
}

/// Inspects Paseo `/ws` JSON frames flowing from upstream to track agents needing attention,
/// update the System Tray badge count, and trigger native Windows notifications.
fn inspect_ws_frame(state: &Arc<SharedAppState>, text: &str) {
    let parsed: Value = match serde_json::from_str(strip_bom(text)) {
        Ok(v) => v,
        Err(_) => return,
    };

    let mut notifications_to_fire: Vec<(String, String)> = Vec::new();
    let mut new_badge_count: Option<usize> = None;

    {
        let mut tracker = match state.tracker.lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        let process_agent = |agent: &Value,
                             is_seed: bool,
                             tracker: &mut AgentAlertTracker,
                             notes: &mut Vec<(String, String)>| {
            let id = match agent.get("id").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => return,
            };
            let archived = agent
                .get("archivedAt")
                .map(|v| !v.is_null() && v.as_str().unwrap_or("") != "")
                .unwrap_or(false);
            let status = agent
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("idle");
            if archived || status == "closed" {
                tracker.needs_by_agent.remove(&id);
                tracker.running_agents.remove(&id);
                return;
            }
            if status == "running" {
                tracker.running_agents.insert(id.clone());
            } else {
                tracker.running_agents.remove(&id);
            }

            let title = agent
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(&id)
                .to_string();

            let mut reason: Option<String> = None;

            // 1. Check pendingPermissions
            if let Some(perms) = agent.get("pendingPermissions").and_then(|v| v.as_array()) {
                if let Some(first) = perms.first() {
                    let tool = first
                        .get("toolName")
                        .or_else(|| first.get("title"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Approval requested");
                    let pid = first
                        .get("id")
                        .or_else(|| first.get("requestId"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(tool);
                    reason = Some(format!("perm:{}:{}", pid, tool));
                    let dedupe_key = format!("{}::perm:{}", id, pid);
                    if !tracker.dedupe.contains(&dedupe_key) {
                        tracker.dedupe.insert(dedupe_key);
                        if !is_seed {
                            notes.push((
                                "VibeSquad · Permission Needed".to_string(),
                                format!("{}: {}", title, tool),
                            ));
                        }
                    }
                }
            }

            // 2. Check labels["needs-you"] (legacy alias still read)
            if let Some(labels) = agent.get("labels").and_then(|v| v.as_object()) {
                if let Some(na) = labels.get("needs-you").or_else(|| labels.get(concat!("needs-", "au", "b"))).and_then(|v| v.as_str()) {
                    let trimmed = na.trim();
                    if !trimmed.is_empty() && trimmed != "cleared" {
                        if reason.is_none() {
                            reason = Some(format!("needs-you:{}", trimmed));
                        }
                        let dedupe_key = format!("{}::needs-you:{}", id, trimmed);
                        if !tracker.dedupe.contains(&dedupe_key) {
                            tracker.dedupe.insert(dedupe_key);
                            if !is_seed {
                                notes.push((
                                    "VibeSquad · Needs You".to_string(),
                                    format!("{}: {}", title, trimmed),
                                ));
                            }
                        }
                    }
                }
            }

            // 3. Check requiresAttention / status == waiting
            if reason.is_none() {
                let req_attn = agent
                    .get("requiresAttention")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if req_attn || status == "waiting" {
                    reason = Some("attention".to_string());
                }
            }

            if let Some(r) = reason {
                tracker.needs_by_agent.insert(id, r);
            } else {
                tracker.needs_by_agent.remove(&id);
            }
        };

        let mut changed = false;

        // Snapshot response containing entries: [{ agent: {...} }, ...]
        if let Some(entries) = parsed
            .get("entries")
            .or_else(|| parsed.get("payload").and_then(|p| p.get("entries")))
            .or_else(|| parsed.get("result").and_then(|r| r.get("entries")))
            .and_then(|v| v.as_array())
        {
            let is_seed = !tracker.seeded;
            if is_seed {
                tracker.needs_by_agent.clear();
            }
            for entry in entries {
                let ag = entry.get("agent").unwrap_or(entry);
                process_agent(ag, is_seed, &mut tracker, &mut notifications_to_fire);
            }
            tracker.seeded = true;
            changed = true;
        }

        // Single agent update event
        if let Some(ag) = parsed
            .get("agent")
            .or_else(|| parsed.get("payload").and_then(|p| p.get("agent")))
        {
            if ag.is_object() {
                let is_seed = false;
                process_agent(ag, is_seed, &mut tracker, &mut notifications_to_fire);
                changed = true;
            }
        }

        // Explicit permission request event
        if parsed.get("type").and_then(|v| v.as_str()) == Some("agent_permission_request") {
            if let Some(aid) = parsed.get("agentId").and_then(|v| v.as_str()) {
                let tool = parsed
                    .get("request")
                    .and_then(|r| r.get("toolName"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Approval requested");
                let pid = parsed
                    .get("request")
                    .and_then(|r| r.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(tool);
                let dedupe_key = format!("{}::perm:{}", aid, pid);
                tracker
                    .needs_by_agent
                    .insert(aid.to_string(), format!("perm:{}", pid));
                if !tracker.dedupe.contains(&dedupe_key) {
                    tracker.dedupe.insert(dedupe_key);
                    notifications_to_fire.push((
                        "VibeSquad · Permission Needed".to_string(),
                        format!("{}: {}", aid, tool),
                    ));
                }
                changed = true;
            }
        }

        if parsed.get("type").and_then(|v| v.as_str()) == Some("agent_deleted") {
            if let Some(aid) = parsed.get("agentId").and_then(|v| v.as_str()) {
                tracker.needs_by_agent.remove(aid);
                changed = true;
            }
        }

        if changed {
            new_badge_count = Some(tracker.needs_by_agent.len());
        }
    }

    if let Some(count) = new_badge_count {
        state.set_needs_count(count);
    }
    for (title, body) in notifications_to_fire {
        state.fire_native_notification(&title, &body);
    }
}

async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<SharedAppState>>,
    req: Request,
) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/ws".to_string());

    ws.on_upgrade(move |socket| proxy_websocket(socket, state, path_and_query))
}

async fn proxy_websocket(
    client_ws: WebSocket,
    state: Arc<SharedAppState>,
    path_and_query: String,
) {
    let cfg = state.config.read().unwrap().clone();
    let candidates = state.candidate_hosts();

    let mut upstream_stream = None;
    for host in candidates {
        let is_local = is_local_host(&host);
        let ws_scheme = if is_local { "ws" } else { "wss" };
        let url_str = format!("{}://{}{}", ws_scheme, host, path_and_query);
        let mut ws_req = match url_str.into_client_request() {
            Ok(r) => r,
            Err(_) => continue,
        };
        if is_local {
            if let Ok(hv) = HeaderValue::from_str(&format!("http://{}", host)) {
                ws_req.headers_mut().insert("Origin", hv);
            }
        }
        if !cfg.device_token.is_empty() {
            if let Ok(hv) = HeaderValue::from_str(&format!("vs_device={}", cfg.device_token)) {
                ws_req.headers_mut().insert("Cookie", hv);
            }
        }
        let conn_res = if is_local {
            tokio::time::timeout(
                Duration::from_millis(2000),
                connect_async_tls_with_config(ws_req, None, false, None),
            )
            .await
        } else {
            tokio::time::timeout(
                Duration::from_millis(2000),
                connect_async_tls_with_config(
                    ws_req,
                    None,
                    false,
                    Some(state.ws_connector()),
                ),
            )
            .await
        };

        if let Ok(Ok((stream, _resp))) = conn_res {
            *state.active_upstream.write().unwrap() = Some(host);
            upstream_stream = Some(stream);
            break;
        }
    }

    let upstream_ws = match upstream_stream {
        Some(s) => s,
        None => {
            let _ = client_ws.close().await;
            return;
        }
    };

    let (mut up_sink, mut up_stream) = upstream_ws.split();
    let (mut cl_sink, mut cl_stream) = client_ws.split();

    let state_for_up = state.clone();
    let up_to_cl = async move {
        while let Some(Ok(msg)) = up_stream.next().await {
            let out = match msg {
                TungMessage::Text(t) => {
                    let s = t.to_string();
                    inspect_ws_frame(&state_for_up, &s);
                    AxumWsMessage::Text(s)
                }
                TungMessage::Binary(b) => AxumWsMessage::Binary(b.to_vec()),
                TungMessage::Ping(p) => AxumWsMessage::Ping(p.to_vec()),
                TungMessage::Pong(p) => AxumWsMessage::Pong(p.to_vec()),
                TungMessage::Close(_) => break,
                TungMessage::Frame(_) => continue,
            };
            if cl_sink.send(out).await.is_err() {
                break;
            }
        }
    };

    let cl_to_up = async move {
        while let Some(Ok(msg)) = cl_stream.next().await {
            let out = match msg {
                AxumWsMessage::Text(t) => TungMessage::Text(t.into()),
                AxumWsMessage::Binary(b) => TungMessage::Binary(b.into()),
                AxumWsMessage::Ping(p) => TungMessage::Ping(p.into()),
                AxumWsMessage::Pong(p) => TungMessage::Pong(p.into()),
                AxumWsMessage::Close(_) => break,
            };
            if up_sink.send(out).await.is_err() {
                break;
            }
        }
    };

    tokio::select! {
        _ = up_to_cl => {},
        _ = cl_to_up => {},
    }
}

/// Locates `(node_exe, runtime_dir)`: installed runtime first, then the per-user copy, then a dev checkout.
fn find_bundled_runtime() -> Option<(PathBuf, PathBuf)> {
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut roots: Vec<PathBuf> = Vec::new();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    if let Some(dir) = &exe_dir {
        roots.push(dir.join("runtime"));
        roots.push(dir.join("resources").join("runtime"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if !local.trim().is_empty() {
            roots.push(PathBuf::from(local).join("com.vibesquad.desktop").join("runtime"));
        }
    }
    for root in roots {
        let node = root.join(node_name);
        if node.is_file() && root.join("server").join("serve.mjs").is_file() {
            return Some((node, root));
        }
    }
    // Dev fallback: target/<profile>/vibesquad.exe -> repo root, node from PATH.
    let repo = exe_dir?.join("..").join("..").join("..");
    if repo.join("server").join("serve.mjs").is_file() && repo.join("dist").join("index.html").is_file() {
        let repo = repo.canonicalize().unwrap_or(repo);
        return Some((PathBuf::from("node"), repo));
    }
    None
}

fn server_pid_path() -> PathBuf {
    config_dir().join("server.pid")
}

/// Starts the bundled VibeSquad server when the configured local host is not healthy. Reuses a healthy one.
async fn ensure_local_server_running(state: &Arc<SharedAppState>) {
    let (mode, host) = {
        let cfg = state.config.read().unwrap();
        (cfg.server_mode.clone(), cfg.server_host.clone())
    };
    if mode != "local" || !is_local_host(&host) {
        return;
    }
    if check_local_server_healthy(&state.client(), &host).await.is_ok() {
        return;
    }
    // Already spawned by us and still alive: just wait for it below.
    let spawned_alive = {
        let mut guard = state.managed_server.lock().unwrap();
        match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    };
    if !spawned_alive {
        // Anything left in server.pid belongs to a previous run that is no longer serving: forget it.
        let _ = fs::remove_file(server_pid_path());
        let Some((node, runtime_dir)) = find_bundled_runtime() else {
            return;
        };
        let mut cmd = std::process::Command::new(&node);
        cmd.arg("server/serve.mjs")
            .current_dir(&runtime_dir)
            .env("VIBESQUAD_RUNTIME_DIR", &runtime_dir)
            .env("VIBESQUAD_BUNDLED_NODE", &node)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        match cmd.spawn() {
            Ok(child) => {
                let _ = fs::create_dir_all(config_dir());
                let _ = fs::write(server_pid_path(), child.id().to_string());
                *state.managed_server.lock().unwrap() = Some(child);
            }
            Err(_) => return,
        }
    }
    for _ in 0..25 {
        if check_local_server_healthy(&state.client(), &host).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Kills the server we spawned (never one we merely reused) so quitting leaves no orphan node.exe.
fn stop_managed_server(state: &Arc<SharedAppState>) {
    let child = state.managed_server.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_file(server_pid_path());
    }
}

async fn proxy_http_handler(
    State(state): State<Arc<SharedAppState>>,
    req: Request,
) -> Response {
    let method: Method = req.method().clone();
    let uri = req.uri().clone();
    let path = uri.path().to_string();
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    let cfg = state.config.read().unwrap().clone();
    let is_local = cfg.server_mode == "local" || (cfg.server_mode != "remote" && is_local_host(&cfg.server_host));
    let is_root_nav = method == Method::GET && (path == "/" || path == "/index.html");
    let query_setup = uri.query().map(|q| q.contains("setup=1")).unwrap_or(false);

    // First launch: if no mode choice has been saved yet and setup=1 wasn't explicitly requested, show the mode choice screen before spawning anything!
    if is_root_nav && cfg.server_mode.trim().is_empty() && !query_setup && !state.setup_mode.load(Ordering::SeqCst) {
        return html_no_store_response(StatusCode::OK, ui_pages::render_mode_choice_page(&cfg, None));
    }

    // If setup mode is requested or remote server has no deviceToken yet, show Connect & Pair screen on GET /
    if is_root_nav && (query_setup || state.setup_mode.load(Ordering::SeqCst) || (!is_local && cfg.device_token.trim().is_empty())) {
        return html_no_store_response(StatusCode::OK, ui_pages::render_pair_page(&cfg, None));
    }

    // If configured for localhost, verify localhost is actually healthy before proxying root navigation
    if is_root_nav && is_local {
        ensure_local_server_running(&state).await;
        if check_local_server_healthy(&state.client(), &cfg.server_host)
            .await
            .is_err()
        {
            return html_no_store_response(
                StatusCode::OK,
                ui_pages::render_pair_page(
                    &cfg,
                    Some("Localhost (127.0.0.1:4180) does not have a healthy VibeSquad server (dist/index.html missing). Select a remote server below."),
                ),
            );
        }
    }

    let req_headers = req.headers().clone();
    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };

    let candidates = state.candidate_hosts();
    let mut last_err = String::new();

    for host in candidates {
        let host_is_local = is_local_host(&host);
        let scheme = if host_is_local { "http" } else { "https" };
        let target_url = format!("{}://{}{}", scheme, host, path_and_query);

        let req_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
            Ok(m) => m,
            Err(_) => reqwest::Method::GET,
        };

        let mut builder = state.client().request(req_method, &target_url);

        for (k, v) in req_headers.iter() {
            let name_lower = k.as_str().to_lowercase();
            if name_lower == "host"
                || name_lower == "connection"
                || name_lower == "content-length"
                || name_lower == "origin"
                || name_lower == "referer"
            {
                continue;
            }
            if let Ok(val_str) = v.to_str() {
                builder = builder.header(k.as_str(), val_str);
            }
        }

        if host_is_local {
            builder = builder
                .header("Host", &host)
                .header("Origin", format!("http://{}", host));
        }

        if !cfg.device_token.is_empty() {
            let existing_cookie = req_headers
                .get(axum::http::header::COOKIE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            let merged = if existing_cookie.is_empty() {
                format!("vs_device={}", cfg.device_token)
            } else if existing_cookie.contains("vs_device=") {
                existing_cookie.to_string()
            } else {
                format!("{}; vs_device={}", existing_cookie, cfg.device_token)
            };
            builder = builder.header("Cookie", merged);
        }

        if !body_bytes.is_empty() {
            builder = builder.body(body_bytes.clone());
        }

        match builder.send().await {
            Ok(up_resp) => {
                *state.active_upstream.write().unwrap() = Some(host.clone());
                let up_status = up_resp.status();

                // If upstream rejects our token on root navigation (401 or redirect to /pair), show Connect & Pair screen
                if is_root_nav
                    && (up_status == reqwest::StatusCode::UNAUTHORIZED
                        || up_status == reqwest::StatusCode::FOUND)
                {
                    if !host_is_local {
                        let mut wcfg = state.config.write().unwrap();
                        wcfg.device_token.clear();
                        let _ = save_config(&wcfg);
                        return html_no_store_response(
                            StatusCode::OK,
                            ui_pages::render_pair_page(
                                &wcfg,
                                Some("Device is unpaired or session was revoked. Enter a 6-digit pairing code to reconnect."),
                            ),
                        );
                    }
                }

                let up_headers = up_resp.headers().clone();
                let is_html = up_headers
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|ct| ct.contains("text/html"))
                    .unwrap_or(false);

                let resp_bytes = match up_resp.bytes().await {
                    Ok(b) => b,
                    Err(e) => {
                        return (
                            StatusCode::BAD_GATEWAY,
                            Json(json!({ "error": e.to_string() })),
                        )
                            .into_response();
                    }
                };

                // Guard root navigation: NEVER render a raw 500/404/error text or missing dist/index.html as a dead end!
                if is_root_nav {
                    let body_str = String::from_utf8_lossy(&resp_bytes);
                    let broken_root = up_status != reqwest::StatusCode::OK
                        || body_str.contains("dist/index.html missing")
                        || !body_str.contains("<div id=\"root\">");
                    if broken_root {
                        let err_msg = format!(
                            "Upstream {} returned HTTP {} (dist/index.html missing or server rebuilding). Select a remote server below.",
                            host,
                            up_status.as_u16()
                        );
                        if host_is_local {
                            return html_no_store_response(
                                StatusCode::OK,
                                ui_pages::render_pair_page(&cfg, Some(&err_msg)),
                            );
                        } else {
                            return html_no_store_response(
                                StatusCode::OK,
                                ui_pages::render_unreachable_page(&cfg, &err_msg),
                            );
                        }
                    }
                }

                let final_bytes = if is_root_nav && is_html && up_status == reqwest::StatusCode::OK {
                    let html_str = String::from_utf8_lossy(&resp_bytes);
                    let bridge = ui_pages::desktop_bridge_script(&cfg.last_hash);
                    let injected = if html_str.contains("</body>") {
                        html_str.replacen("</body>", &format!("{}\n</body>", bridge), 1)
                    } else {
                        format!("{}\n{}", html_str, bridge)
                    };
                    axum::body::Bytes::from(injected.into_bytes())
                } else {
                    resp_bytes
                };

                let status_code =
                    StatusCode::from_u16(up_status.as_u16()).unwrap_or(StatusCode::OK);
                let mut res_builder = Response::builder().status(status_code);
                for (k, v) in up_headers.iter() {
                    let name_lower = k.as_str().to_lowercase();
                    if name_lower == "transfer-encoding"
                        || name_lower == "content-length"
                        || name_lower == "content-encoding"
                        || ((is_root_nav || status_code.is_client_error() || status_code.is_server_error())
                            && name_lower == "cache-control")
                    {
                        continue;
                    }
                    if let (Ok(hn), Ok(hv)) = (
                        HeaderName::from_bytes(k.as_str().as_bytes()),
                        HeaderValue::from_bytes(v.as_bytes()),
                    ) {
                        res_builder = res_builder.header(hn, hv);
                    }
                }

                if is_root_nav || status_code.is_client_error() || status_code.is_server_error() {
                    res_builder = res_builder.header(
                        axum::http::header::CACHE_CONTROL,
                        "no-store, no-cache, must-revalidate",
                    );
                }

                return res_builder
                    .body(Body::from(final_bytes))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
            }
            Err(e) => {
                last_err = format!("{}: {}", host, e);
            }
        }
    }

    // Upstream unreachable!
    if is_root_nav {
        return html_no_store_response(
            StatusCode::OK,
            ui_pages::render_unreachable_page(&cfg, &last_err),
        );
    }

    (
        StatusCode::BAD_GATEWAY,
        [
            (
                axum::http::header::CACHE_CONTROL,
                "no-store, no-cache, must-revalidate",
            ),
        ],
        Json(json!({
            "error": "VibeSquad server unreachable",
            "detail": last_err
        })),
    )
        .into_response()
}

fn focus_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

async fn bind_loopback_listener() -> (TcpListener, u16) {
    let preferred_port = std::env::var("VIBESQUAD_DESKTOP_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(4189);

    let preferred_addr = SocketAddr::from(([127, 0, 0, 1], preferred_port));
    if let Ok(listener) = TcpListener::bind(preferred_addr).await {
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(preferred_port);
        return (listener, port);
    }

    let fallback_addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let listener = TcpListener::bind(fallback_addr)
        .await
        .expect("failed to bind loopback port");
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

/// Rejects DNS-rebinding (foreign Host) and cross-site browser calls (foreign Origin) against the
/// loopback proxy, so a random web page cannot hit /__desktop/pair, /__desktop/pick-folder or /ws.
async fn guard_local_request(
    State(state): State<Arc<SharedAppState>>,
    req: Request,
    next: Next,
) -> Response {
    let port = state.local_port.load(Ordering::SeqCst);
    let host_ok = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(|h| h == format!("127.0.0.1:{}", port) || h == format!("localhost:{}", port))
        .unwrap_or(false);
    if !host_ok {
        return (StatusCode::FORBIDDEN, "forbidden host").into_response();
    }
    let path = req.uri().path();
    if path.starts_with("/__desktop/") || path == "/ws" {
        if let Some(origin) = req.headers().get("origin") {
            let allowed = [
                format!("http://127.0.0.1:{}", port),
                format!("http://localhost:{}", port),
                "tauri://localhost".to_string(),
                "http://tauri.localhost".to_string(),
                "https://tauri.localhost".to_string(),
            ];
            let ok = origin
                .to_str()
                .map(|o| allowed.iter().any(|a| a == o))
                .unwrap_or(false);
            if !ok {
                return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
            }
        }
    }
    next.run(req).await
}

fn build_router(state: Arc<SharedAppState>) -> Router {
    Router::new()
        .route("/__desktop/status", get(handle_desktop_status))
        .route("/__desktop/choose-mode", post(handle_desktop_choose_mode))
        .route("/__desktop/ping", get(handle_desktop_ping))
        .route("/__desktop/setup", get(handle_desktop_setup))
        .route("/__desktop/unpair", post(handle_desktop_unpair))
        .route("/__desktop/pair", post(handle_desktop_pair))
        .route("/__desktop/hash", post(handle_desktop_hash))
        .route("/__desktop/badge", post(handle_desktop_badge))
        .route("/__desktop/notify", post(handle_desktop_notify))
        .route("/__desktop/updater/status", get(updater::handle_updater_status))
        .route("/__desktop/updater/channel", post(updater::handle_updater_channel))
        .route("/__desktop/updater/check", post(updater::handle_updater_check))
        .route("/__desktop/updater/install", post(updater::handle_updater_install))
        .route("/__desktop/updater/busy", post(updater::handle_updater_busy))
        .route("/ws", get(handle_ws_upgrade))
        .fallback(proxy_http_handler)
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard_local_request))
        .with_state(state)
}

fn main() {
    let initial_cfg = load_config();
    if initial_cfg.start_at_login {
        let _ = set_start_at_login_registry(true);
    }

    let (http_client, ws_tls_connector) =
        build_http_and_ws_clients().expect("Failed to initialize TLS clients with pinned CA");

    let shared_state = Arc::new(SharedAppState {
        config: RwLock::new(initial_cfg),
        active_upstream: RwLock::new(None),
        setup_mode: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
        needs_count: AtomicUsize::new(0),
        local_port: AtomicUsize::new(4189),
        http_client: RwLock::new(http_client),
        ws_tls_connector: RwLock::new(ws_tls_connector),
        app_handle: RwLock::new(None),
        tray_needs_item: RwLock::new(None),
        tracker: Mutex::new(AgentAlertTracker::default()),
        updater: Mutex::new(updater::UpdaterState::default()),
        managed_server: Mutex::new(None),
    });

    // Start background Tokio runtime and bind loopback server BEFORE Tauri opens the window
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build Tokio runtime");

    let state_for_server = shared_state.clone();
    let local_port = rt.block_on(async move {
        let (listener, port) = bind_loopback_listener().await;
        state_for_server.local_port.store(port as usize, Ordering::SeqCst);
        updater::spawn_updater_loop(state_for_server.clone());
        let router = build_router(state_for_server);
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        port
    });

    // Headless proxy mode for automated CLI verification if requested
    let args: Vec<String> = std::env::args().collect();
    let headless = args.iter().any(|a| a == "--headless-proxy")
        || std::env::var("VIBESQUAD_HEADLESS_PROXY").as_deref() == Ok("1");
    // Own the server process: start the bundled one (or reuse a healthy :4180) before the window opens.
    // Headless test mode only does this when a runtime is actually bundled next to the exe.
    if !headless || find_bundled_runtime().is_some() {
        let st = shared_state.clone();
        rt.block_on(async move { ensure_local_server_running(&st).await });
    }
    if headless {
        println!("VIBESQUAD_PROXY_LISTENING=http://127.0.0.1:{}", local_port);
        rt.block_on(async {
            loop {
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        });
        return;
    }

    let state_for_setup = shared_state.clone();
    let state_for_window = shared_state.clone();
    let state_for_exit = shared_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let handle = app.handle().clone();
            *state_for_setup.app_handle.write().unwrap() = Some(handle.clone());

            // Navigate main window if ephemeral port was used or if lastHash is saved
            if let Some(main_win) = app.get_webview_window("main") {
                let last_hash = state_for_setup.config.read().unwrap().last_hash.clone();
                if local_port != 4189 || !last_hash.is_empty() {
                    let hash_suffix = if last_hash.starts_with('#') {
                        last_hash
                    } else if !last_hash.is_empty() {
                        format!("#{}", last_hash)
                    } else {
                        String::new()
                    };
                    if let Ok(target_url) =
                        url::Url::parse(&format!("http://127.0.0.1:{}/{}", local_port, hash_suffix))
                    {
                        let _ = main_win.navigate(target_url);
                    }
                }
            }

            // Build System Tray Menu — keep "Change Server / Re-pair..." right below "Open VibeSquad"
            let open_item = MenuItem::with_id(app, "open", "Open VibeSquad", true, None::<&str>)?;
            let switch_server_item = MenuItem::with_id(
                app,
                "switch_server",
                "Change Server / Re-pair...",
                true,
                None::<&str>,
            )?;
            let needs_item = MenuItem::with_id(app, "needs", "Needs You: 0", true, None::<&str>)?;
            let start_login_checked = state_for_setup.config.read().unwrap().start_at_login;
            let start_login_item = CheckMenuItem::with_id(
                app,
                "start_at_login",
                "Start at Login",
                true,
                start_login_checked,
                None::<&str>,
            )?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit VibeSquad", true, None::<&str>)?;

            *state_for_setup.tray_needs_item.write().unwrap() = Some(needs_item.clone());

            let menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &switch_server_item,
                    &needs_item,
                    &sep1,
                    &start_login_item,
                    &sep2,
                    &quit_item,
                ],
            )?;

            let tray_icon = render_tray_icon(0).unwrap_or_else(|_| {
                app.default_window_icon()
                    .cloned()
                    .expect("default window icon")
            });

            let state_for_menu = state_for_setup.clone();
            let start_login_item_clone = start_login_item.clone();

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .tooltip("VibeSquad — Connected")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" | "needs" => {
                        focus_main_window(app);
                    }
                    "start_at_login" => {
                        let enabled = start_login_item_clone.is_checked().unwrap_or(false);
                        let _ = set_start_at_login_registry(enabled);
                        let mut cfg = state_for_menu.config.write().unwrap();
                        cfg.start_at_login = enabled;
                        let _ = save_config(&cfg);
                    }
                    "switch_server" => {
                        *state_for_menu.active_upstream.write().unwrap() = None;
                        state_for_menu.setup_mode.store(true, Ordering::SeqCst);
                        let port = state_for_menu.local_port.load(Ordering::SeqCst);
                        if let Some(w) = app.get_webview_window("main") {
                            if let Ok(u) =
                                url::Url::parse(&format!("http://127.0.0.1:{}/__desktop/setup", port))
                            {
                                let _ = w.navigate(u);
                            }
                        }
                        focus_main_window(app);
                    }
                    "quit" => {
                        state_for_menu.quitting.store(true, Ordering::SeqCst);
                        stop_managed_server(&state_for_menu);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        focus_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let exit_on_close =
                    std::env::var("VIBESQUAD_EXIT_ON_CLOSE").as_deref() == Ok("1");
                if exit_on_close {
                    stop_managed_server(&state_for_window);
                } else if !state_for_window.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building VibeSquad desktop application")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                stop_managed_server(&state_for_exit);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_bom_handles_utf8_bom_and_preserves_corrupt_config() {
        assert_eq!(strip_bom("\u{feff}{\"updateChannel\":\"beta\"}"), "{\"updateChannel\":\"beta\"}");
        assert_eq!(strip_bom_bytes(&[0xEF, 0xBB, 0xBF, b'{', b'}']), b"{}");

        let tmp = std::env::temp_dir().join(format!("vs-bom-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("VIBESQUAD_DESKTOP_CONFIG_DIR", &tmp);

        let cfg_path = tmp.join("desktop-config.json");
        // Write UTF-8 BOM + valid JSON
        let mut bom_bytes = vec![0xEF, 0xBB, 0xBF];
        bom_bytes.extend_from_slice(b"{\n  \"serverMode\": \"local\",\n  \"updateChannel\": \"beta\"\n}");
        fs::write(&cfg_path, &bom_bytes).unwrap();

        let loaded = load_config();
        assert_eq!(loaded.server_mode, "local");
        assert_eq!(loaded.update_channel, "beta");
        assert!(get_config_warning().is_none());

        // File on disk should have had its BOM scrubbed
        let rewritten = fs::read(&cfg_path).unwrap();
        assert!(!rewritten.starts_with(&[0xEF, 0xBB, 0xBF]));

        // Corrupt JSON should record a warning and NEVER overwrite the file on disk
        let corrupt = b"{broken json";
        fs::write(&cfg_path, corrupt).unwrap();
        let fallback = load_config();
        assert_eq!(fallback.update_channel, "stable");
        assert!(get_config_warning().unwrap_or_default().contains("Invalid JSON in desktop-config.json"));
        assert_eq!(fs::read(&cfg_path).unwrap(), corrupt);

        let _ = fs::remove_dir_all(&tmp);
    }
}
