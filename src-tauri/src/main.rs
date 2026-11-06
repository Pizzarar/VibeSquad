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

fn default_start_at_login() -> bool {
    true
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
    /// Defaults ON (a config with no value counts as on; an explicit `false` stays off): the login entry starts the
    /// server + runner with no window (`--background`), so agents are reachable without opening the app.
    #[serde(default = "default_start_at_login")]
    pub start_at_login: bool,
    #[serde(default)]
    pub last_hash: String,
    /// Full UI route (path + query + hash), e.g. `/?team=x&agent=y`; restored after any reconnect or reload.
    #[serde(default)]
    pub last_route: String,
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
    /// True once the user picked a channel (Settings). Until then a beta build follows beta
    /// (docs/PLAN_BUGS_BATCH1.md block 0d): the "stable" written at first run is only the default.
    #[serde(default)]
    pub update_channel_explicit: bool,
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
            start_at_login: default_start_at_login(),
            last_hash: String::new(),
            last_route: String::new(),
            update_channel: default_update_channel(),
            update_channel_explicit: false,
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
                        // A config that was previously poisoned into "local" mode by a pasted
                        // #offer= link must stop auto-starting the local Paseo daemon on launch.
                        if cfg.server_mode == "local"
                            && (cfg.last_hash.starts_with("#offer=")
                                || cfg.last_route.contains("remote=1"))
                        {
                            cfg.server_mode = "relay".to_string();
                            let _ = save_config(&cfg);
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

/// Exact loopback names only (with or without a port): `localhost.evil.com` or `127.0.0.1.nip.io` are remote.
pub fn is_local_host(host: &str) -> bool {
    let clean = normalize_host(host).to_lowercase();
    let (name, rest) = if clean.starts_with('[') {
        match clean.find(']') {
            Some(i) => clean.split_at(i + 1),
            None => return false,
        }
    } else {
        match clean.find(':') {
            Some(i) => clean.split_at(i),
            None => (clean.as_str(), ""),
        }
    };
    let port_ok = rest.is_empty() || rest.strip_prefix(':').map(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).unwrap_or(false);
    port_ok && matches!(name, "localhost" | "127.0.0.1" | "[::1]")
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

/// CLI flag the login entry passes: start the server + runner, open no window, exit.
pub const BACKGROUND_FLAG: &str = "--background";

pub fn is_background_arg(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == BACKGROUND_FLAG)
}

/// The exact value stored in the Run key: the quoted exe plus the headless flag.
pub fn login_command_line(exe: &std::path::Path) -> String {
    format!("\"{}\" {}", exe.display(), BACKGROUND_FLAG)
}

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE_NAME: &str = "VibeSquad";

/// Writes/removes the per-user Run entry under `subkey` (injectable so tests never touch the real Run key).
#[cfg(windows)]
fn write_run_entry(subkey: &str, enabled: bool, exe: &std::path::Path) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = hkcu.create_subkey(subkey).map_err(|e| e.to_string())?;
    if enabled {
        run_key
            .set_value(RUN_VALUE_NAME, &login_command_line(exe))
            .map_err(|e| e.to_string())?;
    } else {
        let _ = run_key.delete_value(RUN_VALUE_NAME);
    }
    Ok(())
}

#[cfg(windows)]
fn set_start_at_login_registry(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    write_run_entry(RUN_KEY, enabled, &exe)
}

#[cfg(not(windows))]
fn set_start_at_login_registry(_enabled: bool) -> Result<(), String> {
    Ok(())
}

fn port_of_host(host: &str) -> u16 {
    normalize_host(host)
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(4180)
}

/// `--background`: make sure the VibeSquad server (which boots the runner) is up, with no window, then exit.
/// The server is spawned detached (own process group, broken away from this process's job when allowed) so it
/// outlives this launcher and a later app quit never reaches it. A healthy server is reused, never duplicated.
fn run_background(cfg: &DesktopConfig) -> i32 {
    // The off-switch always wins, even if a stale Run value survived.
    if !cfg.start_at_login {
        return 0;
    }
    let mode = cfg.server_mode.as_str();
    // Paired to someone else's server: nothing to run locally. Unset (fresh install) counts as local.
    if (!mode.is_empty() && mode != "local" && mode != "relay") || !is_local_host(&cfg.server_host) {
        return 0;
    }
    let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
        return 1;
    };
    let Ok((client, _)) = build_http_and_ws_clients() else {
        return 1;
    };
    if rt.block_on(check_local_server_healthy(&client, &cfg.server_host)).is_ok() {
        return 0;
    }
    let _ = fs::remove_file(server_pid_path());
    let Some((node, runtime_dir)) = find_bundled_runtime() else {
        return 1;
    };
    let port = port_of_host(&cfg.server_host);
    let child = match spawn_server_process(&node, &runtime_dir, mode, Some(port), true) {
        Ok(c) => c,
        Err(_) => return 1,
    };
    let _ = fs::create_dir_all(config_dir());
    let _ = fs::write(server_pid_path(), child.id().to_string());
    // Dropping `child` does not kill it; wait briefly for health so a failed boot shows in the exit code.
    for _ in 0..50 {
        if rt.block_on(check_local_server_healthy(&client, &cfg.server_host)).is_ok() {
            return 0;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    1
}

#[derive(Debug, Clone, Default)]
pub struct AgentAlertTracker {
    seeded: bool,
    needs_by_agent: HashMap<String, String>,
    pub running_agents: HashSet<String>,
    dedupe: HashSet<String>,
    prev_status: HashMap<String, String>,
    last_reply_line: HashMap<String, String>,
    finished_dedupe: HashSet<String>,
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
    pub tray_login_item: RwLock<Option<CheckMenuItem<tauri::Wry>>>,
    pub tracker: Mutex<AgentAlertTracker>,
    pub updater: Mutex<updater::UpdaterState>,
    /// The `node.exe server/serve.mjs` child we spawned (None when we reused an already-running server).
    pub managed_server: Mutex<Option<std::process::Child>>,
    pub last_notified_agent_id: RwLock<Option<String>>,
    /// Per-launch secret: the webview gets it as the vs_desktop cookie via /__desktop/boot, and every request
    /// to this proxy must carry it, so other local processes can't borrow the proxy's server credentials.
    pub desktop_key: String,
    /// Off only in --headless-proxy (test automation), where no webview exists to hold the cookie.
    pub require_desktop_key: AtomicBool,
    /// `~/.vibesquad/local-token`: sent as x-vibesquad-token to a local VibeSquad server (owner access).
    pub local_token_file: PathBuf,
}

impl SharedAppState {
    /// The local token to send to a local server. None in headless mode: with the desktop key off, any local
    /// process can reach this proxy, so it must not carry owner credentials.
    pub fn local_token(&self) -> Option<String> {
        if !self.require_desktop_key.load(Ordering::SeqCst) {
            return None;
        }
        read_local_token(&self.local_token_file)
    }

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
        if cfg.server_mode == "local"
            || cfg.server_mode == "relay"
            || (cfg.server_mode != "remote" && is_local_host(&primary))
        {
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

    pub fn fire_native_notification(&self, title: &str, body: &str) -> Result<(), String> {
        if let Some(app) = self.app_handle.read().unwrap().as_ref() {
            match app.notification().builder().title(title).body(body).show() {
                Ok(()) => Ok(()),
                Err(e) => {
                    eprintln!("[vibesquad-notify] fire_native_notification failed (title={}): {}", title, e);
                    Err(e.to_string())
                }
            }
        } else {
            Err("app_handle not ready".to_string())
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

fn vibesquad_home_dir() -> Option<PathBuf> {
    std::env::var("VIBESQUAD_HOME").map(PathBuf::from).ok().or_else(|| {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .ok()
            .map(|h| PathBuf::from(h).join(".vibesquad"))
    })
}

pub const DESKTOP_COOKIE: &str = "vs_desktop";
pub const LOCAL_TOKEN_HEADER: &str = "x-vibesquad-token";

pub fn default_local_token_file() -> PathBuf {
    vibesquad_home_dir().unwrap_or_else(|| PathBuf::from(".vibesquad")).join("local-token")
}

/// The server's per-install token (64 lowercase hex chars), or None before the server first ran. Read per
/// request, so a server that created it after this app started is picked up.
pub fn read_local_token(file: &std::path::Path) -> Option<String> {
    let raw = fs::read_to_string(file).ok()?;
    let t = strip_bom(&raw).trim();
    (t.len() == 64 && t.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then(|| t.to_string())
}

pub fn random_hex_key() -> String {
    let mut bytes = [0u8; 32];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut bytes)
        .expect("system RNG unavailable");
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn cookie_value<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    cookie_header.split(';').map(str::trim).find_map(|kv| kv.strip_prefix(name)?.strip_prefix('='))
}

/// The browser's Cookie header minus the cookies that belong to this machine only (never sent upstream).
fn strip_local_cookies(cookie_header: &str) -> String {
    cookie_header
        .split(';')
        .map(str::trim)
        .filter(|kv| !kv.is_empty() && !kv.starts_with("vs_desktop=") && !kv.starts_with("vs_local="))
        .collect::<Vec<_>>()
        .join("; ")
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
    if let Some(home) = vibesquad_home_dir() {
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
        .timeout(Duration::from_secs(120))
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
    let is_local = cfg.server_mode == "local"
        || cfg.server_mode == "relay"
        || (cfg.server_mode != "remote" && is_local_host(&cfg.server_host));
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
        "updateChannel": updater::effective_channel(&cfg.update_channel, cfg.update_channel_explicit, env!("CARGO_PKG_VERSION")),
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
    if mode == "relay" {
        {
            let mut cfg = state.config.write().unwrap();
            cfg.server_mode = "relay".to_string();
            cfg.server_host = default_server_host();
            let _ = save_config(&cfg);
        }
        state.setup_mode.store(false, Ordering::SeqCst);
        ensure_local_server_running(&state).await;
        *state.active_upstream.write().unwrap() = Some(default_server_host());
        return Json(json!({
            "ok": true,
            "serverMode": "relay",
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
        Json(json!({ "ok": false, "error": "mode must be 'local', 'relay' or 'remote'" })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct StartAtLoginPayload {
    enabled: bool,
}

/// One message for whichever of the registry write / config save failed (None when both worked).
fn start_at_login_error(reg: &Result<(), String>, saved: &Result<(), String>) -> Option<String> {
    let mut parts = Vec::new();
    if let Err(e) = reg {
        parts.push(format!("login entry: {}", e));
    }
    if let Err(e) = saved {
        parts.push(format!("saving settings: {}", e));
    }
    if parts.is_empty() { None } else { Some(parts.join("; ")) }
}

async fn handle_start_at_login_get(State(state): State<Arc<SharedAppState>>) -> Response {
    let enabled = state.config.read().unwrap().start_at_login;
    Json(json!({ "ok": true, "enabled": enabled })).into_response()
}

async fn handle_start_at_login_set(
    State(state): State<Arc<SharedAppState>>,
    Json(payload): Json<StartAtLoginPayload>,
) -> Response {
    let reg = set_start_at_login_registry(payload.enabled);
    let saved = {
        let mut cfg = state.config.write().unwrap();
        cfg.start_at_login = payload.enabled;
        save_config(&cfg)
    };
    if let Some(item) = state.tray_login_item.read().unwrap().as_ref() {
        let _ = item.set_checked(payload.enabled);
    }
    match start_at_login_error(&reg, &saved) {
        Some(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "enabled": payload.enabled, "error": error })),
        )
            .into_response(),
        None => Json(json!({ "ok": true, "enabled": payload.enabled })).into_response(),
    }
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
            let mut healthy = check_local_server_healthy(&state.client(), &host)
                .await
                .is_ok();
            if !healthy && cfg.server_mode == "local" {
                ensure_local_server_running(&state).await;
                healthy = check_local_server_healthy(&state.client(), &host)
                    .await
                    .is_ok();
            }
            if healthy {
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
        if check_shell_ready(&state.client(), &host, &cfg.device_token).await {
            *state.active_upstream.write().unwrap() = Some(host.clone());
            return Json(json!({
                "ok": true,
                "reachable": true,
                "status": 200,
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

async fn handle_desktop_mode(State(state): State<Arc<SharedAppState>>) -> Response {
    *state.active_upstream.write().unwrap() = None;
    state.setup_mode.store(false, Ordering::SeqCst);
    let cfg = state.config.read().unwrap().clone();
    html_no_store_response(StatusCode::OK, ui_pages::render_mode_choice_page(&cfg, None))
}

async fn handle_desktop_setup(
    State(state): State<Arc<SharedAppState>>,
    req: Request,
) -> Response {
    let want_mode_choice = req
        .uri()
        .query()
        .map(|q| q.contains("mode=choice") || q.contains("first-run=1"))
        .unwrap_or(false);
    if want_mode_choice {
        return handle_desktop_mode(State(state)).await;
    }
    *state.active_upstream.write().unwrap() = None;
    state.setup_mode.store(true, Ordering::SeqCst);
    let cfg = state.config.read().unwrap().clone();
    html_no_store_response(StatusCode::OK, ui_pages::render_pair_page(&cfg, None))
}

fn extract_offer_hash(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(idx) = s.find("#offer=") {
        let rest = s[idx..].trim();
        if rest.len() > "#offer=".len() {
            return Some(rest.to_string());
        }
    }
    if let Some(rest) = s.strip_prefix("offer=") {
        let clean = rest.trim();
        if !clean.is_empty() {
            return Some(format!("#offer={}", clean));
        }
    }
    for sep in ["?offer=", "&offer="] {
        if let Some(idx) = s.find(sep) {
            let val = s[idx + sep.len()..].split(&['&', '#', ' '][..]).next().unwrap_or("");
            if !val.is_empty() {
                return Some(format!("#offer={}", val));
            }
        }
    }
    None
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

    if let Some(offer_hash) = extract_offer_hash(&submission.server_host)
        .or_else(|| extract_offer_hash(&submission.code))
    {
        // Optional remote daemon password: the code field is only a password when it isn't itself the offer link.
        let pw = if extract_offer_hash(&submission.code).is_none() && !submission.code.trim().is_empty() {
            submission.code.trim().to_string()
        } else {
            String::new()
        };
        let redirect = if pw.is_empty() {
            format!("/?remote=1{}", offer_hash)
        } else {
            format!(
                "/?remote=1&pw={}{}",
                url::form_urlencoded::byte_serialize(pw.as_bytes()).collect::<String>(),
                offer_hash
            )
        };
        {
            let mut cfg = state.config.write().unwrap();
            cfg.server_mode = "relay".to_string();
            cfg.server_host = default_server_host();
            // Never persist the #offer= link in last_hash/last_route: restoring it would re-mount the
            // pairing screen on the next reload and loop `Connecting…` forever.
            cfg.last_hash = String::new();
            cfg.last_route = "/?remote=1".to_string();
            let _ = save_config(&cfg);
        }
        state.setup_mode.store(false, Ordering::SeqCst);
        ensure_local_server_running(&state).await;
        *state.active_upstream.write().unwrap() = Some(default_server_host());
        return (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "redirect": redirect,
                "serverMode": "relay",
                "offer": true
            })),
        )
            .into_response();
    }

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
            .header("User-Agent", concat!("VibeSquad-Desktop/", env!("CARGO_PKG_VERSION"), " (Windows)"))
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
    #[serde(default)]
    route: Option<String>,
}

async fn handle_desktop_hash(
    State(state): State<Arc<SharedAppState>>,
    Json(payload): Json<HashUpdate>,
) -> impl IntoResponse {
    {
        let mut cfg = state.config.write().unwrap();
        // Never persist an #offer= pairing link in last_hash / last_route: restoring it re-mounts the
        // pairing screen on the next reload and loops `Connecting…` forever.
        cfg.last_hash = if payload.hash.contains("offer=") {
            String::new()
        } else {
            payload.hash
        };
        if let Some(route) = payload.route {
            cfg.last_route = route.split("#offer=").next().unwrap_or(&route).to_string();
        }
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
    let res = state.fire_native_notification(title, payload.body.trim());
    Json(json!({ "ok": res.is_ok(), "shown": res.is_ok(), "error": res.err() }))
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
                tracker.prev_status.remove(&id);
                tracker.last_reply_line.remove(&id);
                return;
            }

            let was_running = tracker.running_agents.contains(&id);
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

            // Cache the first line of the agent's latest reply for finished toasts
            if let Some(last_msg) = agent
                .get("lastMessage")
                .and_then(|v| v.as_str())
                .or_else(|| agent.get("summary").and_then(|v| v.as_str()))
            {
                let first_line = last_msg.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
                if !first_line.is_empty() {
                    let truncated = if first_line.len() > 120 {
                        format!("{}…", &first_line[..117])
                    } else {
                        first_line.to_string()
                    };
                    tracker.last_reply_line.insert(id.clone(), truncated);
                }
            }

            // Buddy/Lead finished toast: running -> idle, not seed, not worker
            if !is_seed && was_running && status == "idle" {
                let labels = agent.get("labels").and_then(|v| v.as_object());
                let role_raw = labels
                    .and_then(|l| l.get("role"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let role_lower = role_raw.to_lowercase();
                let title_lower = title.to_lowercase();
                let is_retired = role_lower.starts_with("former-")
                    || role_lower.starts_with("old")
                    || title_lower.starts_with("(old)");

                let role_label = if !is_retired {
                    if role_lower == "brainstorm" || role_lower == "buddy" {
                        Some("Buddy")
                    } else if role_lower == "lead" {
                        Some("Lead")
                    } else {
                        None
                    }
                } else {
                    None
                };

                if let Some(role_label) = role_label {
                    let team_label = labels
                        .and_then(|l| {
                            l.get("lane")
                                .or_else(|| l.get("team"))
                                .and_then(|v| v.as_str())
                        })
                        .filter(|s| !s.is_empty())
                        .map(|s| {
                            let mut c = s.chars();
                            match c.next() {
                                None => String::new(),
                                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                            }
                        })
                        .unwrap_or_else(|| "VibeSquad".to_string());

                    let first_line = tracker
                        .last_reply_line
                        .get(&id)
                        .cloned()
                        .unwrap_or_else(|| "Turn complete".to_string());

                    let updated_at = agent
                        .get("updatedAt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let dedupe_key = format!("{}::finished:{}", id, updated_at);
                    if !tracker.finished_dedupe.contains(&dedupe_key) {
                        tracker.finished_dedupe.insert(dedupe_key);
                        notes.push((
                            format!("VibeSquad · {}", team_label),
                            format!("{} finished: {}", role_label, first_line),
                        ));
                    }
                }
            }

            tracker.prev_status.insert(id.clone(), status.to_string());

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

        // Cap finished_dedupe to prevent unbounded growth
        if tracker.finished_dedupe.len() > 500 {
            tracker.finished_dedupe.clear();
        }

        if changed {
            new_badge_count = Some(tracker.needs_by_agent.len());
        }
    }

    if let Some(count) = new_badge_count {
        state.set_needs_count(count);
    }
    for (title, body) in &notifications_to_fire {
        let _ = state.fire_native_notification(title, body);
    }
    // Store the last notified agent ID for click-to-focus
    if let Some((_, body)) = notifications_to_fire.last() {
        if body.contains(" finished: ") {
            // Extract agent context from the notification for click-to-focus
            // The actual agent ID comes from the ws frame; re-parse to find it
            let agent_id = parsed
                .get("agent")
                .or_else(|| parsed.get("payload").and_then(|p| p.get("agent")))
                .and_then(|a| a.get("id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(id) = agent_id {
                *state.last_notified_agent_id.write().unwrap() = Some(id);
            }
        }
    }
}

fn extract_ws_protocols(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(','))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

async fn handle_ws_upgrade(
    mut ws: WebSocketUpgrade,
    State(state): State<Arc<SharedAppState>>,
    req: Request,
) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/ws".to_string());
    let protocols = extract_ws_protocols(req.headers());
    if !protocols.is_empty() {
        ws = ws.protocols(protocols.clone());
    }

    ws.on_upgrade(move |socket| proxy_websocket(socket, state, path_and_query, protocols))
}

async fn proxy_websocket(
    client_ws: WebSocket,
    state: Arc<SharedAppState>,
    path_and_query: String,
    protocols: Vec<String>,
) {
    let cfg = state.config.read().unwrap().clone();
    let mut candidates = state.candidate_hosts();
    let mut direct_host: Option<String> = None;
    if cfg.server_mode == "local"
        && std::env::var("VIBESQUAD_DESKTOP_PORT").is_err()
        && matches!(candidates.first().map(|s| s.as_str()), Some("127.0.0.1:4180") | Some("localhost:4180"))
    {
        if let Some(direct) = direct_local_paseo_ws_host() {
            direct_host = Some(direct.clone());
            candidates.insert(0, direct);
        }
    }

    let mut upstream_stream = None;
    for host in candidates {
        let is_local = is_local_host(&host);
        let ws_scheme = if is_local { "ws" } else { "wss" };
        let url_str = format!("{}://{}{}", ws_scheme, host, path_and_query);
        let mut ws_req = match url_str.into_client_request() {
            Ok(r) => r,
            Err(_) => continue,
        };
        if !protocols.is_empty() {
            if let Ok(hv) = HeaderValue::from_str(&protocols.join(", ")) {
                ws_req.headers_mut().insert("Sec-WebSocket-Protocol", hv);
            }
        }
        if is_local {
            if let Ok(hv) = HeaderValue::from_str(&format!("http://{}", host)) {
                ws_req.headers_mut().insert("Origin", hv);
            }
            if let Some(hv) = state.local_token().and_then(|t| HeaderValue::from_str(&t).ok()) {
                ws_req.headers_mut().insert(LOCAL_TOKEN_HEADER, hv);
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
            if direct_host.as_deref() != Some(host.as_str()) {
                *state.active_upstream.write().unwrap() = Some(host);
            }
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

    let (inspect_tx, mut inspect_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let state_bg = state.clone();
    let inspect_task = tokio::spawn(async move {
        while let Some(frame) = inspect_rx.recv().await {
            inspect_ws_frame(&state_bg, &frame);
        }
    });
    let up_to_cl = async move {
        while let Some(Ok(msg)) = up_stream.next().await {
            let out = match msg {
                TungMessage::Text(t) => {
                    let s = t.to_string();
                    if s.contains("\"entries\"")
                        || s.contains("\"agent\"")
                        || s.contains("agent_permission_request")
                        || s.contains("agent_deleted")
                    {
                        let _ = inspect_tx.send(s.clone());
                    }
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
    inspect_task.abort();
}

/// Reads `~/.paseo/config.json` and returns the local Paseo daemon `host:port`, or `None` when
/// the daemon uses TLS or no Paseo install is detectable.
fn direct_local_paseo_ws_host() -> Option<String> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    let dir = PathBuf::from(home).join(".paseo");
    let cfg_path = dir.join("config.json");
    let parsed: Option<Value> = fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|raw| serde_json::from_str(strip_bom(&raw)).ok());
    if parsed.is_none() && !dir.join("daemon.pid").exists() {
        return None;
    }
    let daemon = parsed.as_ref().and_then(|v| v.get("daemon"));
    if daemon
        .and_then(|d| d.get("tls"))
        .and_then(|t| t.get("enabled"))
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    let listen = daemon
        .and_then(|d| d.get("listen"))
        .and_then(|l| l.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("127.0.0.1:6767");
    let addr = listen.trim_start_matches("ws://").trim_end_matches("/ws").trim_end_matches('/');
    if addr.is_empty() || !is_local_host(addr) {
        return None;
    }
    Some(addr.to_string())
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
            roots.push(PathBuf::from(&local).join("com.vibesquad.desktop").join("runtime"));
            roots.push(PathBuf::from(&local).join("VibeSquad").join("runtime"));
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

/// Spawns `node server/serve.mjs` without a window. `background` (login entry) additionally asks the server to boot
/// the runner and detaches it from this process (new process group, job breakaway when the job allows it).
fn spawn_server_process(
    node: &std::path::Path,
    runtime_dir: &std::path::Path,
    mode: &str,
    port: Option<u16>,
    background: bool,
) -> Result<std::process::Child, String> {
    let build = |breakaway: bool| {
        let mut cmd = std::process::Command::new(node);
        cmd.arg("server/serve.mjs")
            .current_dir(runtime_dir)
            .env("VIBESQUAD_RUNTIME_DIR", runtime_dir)
            .env("VIBESQUAD_BUNDLED_NODE", node)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if mode == "relay" {
            // In relay mode we only serve the static bundle for a remote #offer= link;
            // never spawn the local Paseo daemon.
            cmd.env("VIBESQUAD_NO_DAEMON", "1");
        }
        if background {
            cmd.env("VIBESQUAD_START_RUNNER", "1");
        }
        if let Some(p) = port {
            cmd.env("VIBESQUAD_PORT", p.to_string());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let mut flags: u32 = 0x0800_0000; // CREATE_NO_WINDOW
            if background {
                flags |= 0x0000_0200; // CREATE_NEW_PROCESS_GROUP
                if breakaway {
                    flags |= 0x0100_0000; // CREATE_BREAKAWAY_FROM_JOB
                }
            }
            cmd.creation_flags(flags);
        }
        #[cfg(not(windows))]
        let _ = breakaway;
        cmd
    };
    match build(true).spawn() {
        Ok(c) => Ok(c),
        // A job without breakaway rights rejects CREATE_BREAKAWAY_FROM_JOB (access denied): retry plainly.
        Err(_) if background => build(false).spawn().map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// Starts the bundled VibeSquad server when the configured local host is not healthy. Reuses a healthy one.
async fn ensure_local_server_running(state: &Arc<SharedAppState>) {
    let (mode, host) = {
        let cfg = state.config.read().unwrap();
        (cfg.server_mode.clone(), cfg.server_host.clone())
    };
    if (mode != "local" && mode != "relay") || !is_local_host(&host) {
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
        match spawn_server_process(&node, &runtime_dir, &mode, Some(port_of_host(&host)), false) {
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
    // Before stopping the local VibeSquad server, ask it to evaluate the Paseo daemon quit policy
    // (stops the daemon only if keepPaseoRunningOnQuit is false, daemon is VibeSquad-managed, and 0 busy agents).
    let (mode, host) = {
        let cfg = state.config.read().unwrap();
        (cfg.server_mode.clone(), cfg.server_host.clone())
    };
    if mode == "local" && is_local_host(&host) {
        let norm = normalize_host(&host);
        if let Ok(addr) = norm.parse::<SocketAddr>() {
            if let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
                use std::io::{Read, Write};
                let _ = stream.set_read_timeout(Some(Duration::from_millis(1200)));
                let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
                let body = b"{\"action\":\"stop\",\"reason\":\"app-quit\"}";
                let token_line = state.local_token()
                    .map(|t| format!("{}: {}\r\n", LOCAL_TOKEN_HEADER, t))
                    .unwrap_or_default();
                let req = format!(
                    "POST /__vibesquad/paseo/daemon HTTP/1.1\r\nHost: {}\r\nOrigin: http://{}\r\n{}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    norm,
                    norm,
                    token_line,
                    body.len()
                );
                let _ = stream.write_all(req.as_bytes());
                let _ = stream.write_all(body);
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
            }
        }
    }
    let child = state.managed_server.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_file(server_pid_path());
    }
}

/// An SPA route (no file extension, not an API/internal prefix) as opposed to a download or endpoint.
fn is_app_route_path(path: &str) -> bool {
    if path.starts_with("/api/") || path.starts_with("/__vibesquad/") || path.starts_with("/__desktop/") || path == "/ws" {
        return false;
    }
    !path.rsplit('/').next().unwrap_or("").contains('.')
}

/// The upstream really serves the app shell: 200 with the React root, not a 401/500/rebuilding page.
async fn check_shell_ready(client: &reqwest::Client, host: &str, token: &str) -> bool {
    let scheme = if is_local_host(host) { "http" } else { "https" };
    let mut req = client.get(format!("{}://{}/", scheme, host)).timeout(Duration::from_millis(1800));
    if !token.is_empty() {
        req = req.header("Cookie", format!("vs_device={}", token));
    }
    match req.send().await {
        Ok(resp) if resp.status() == reqwest::StatusCode::OK => resp
            .text()
            .await
            .map(|b| b.contains("<div id=\"root\">") && !b.contains("dist/index.html missing"))
            .unwrap_or(false),
        _ => false,
    }
}

/// Short in-relay retry for page navigations while the upstream restarts (the page itself keeps polling for ~30 s).
const RELAY_RETRY_BACKOFF_MS: [u64; 3] = [250, 500, 1000];

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
    let is_local = cfg.server_mode == "local"
        || cfg.server_mode == "relay"
        || (cfg.server_mode != "remote" && is_local_host(&cfg.server_host));
    // Any GET document navigation (root, ?team=… deep links, SPA paths) gets the root treatment:
    // broken-root guard, desktop bridge injection, and the Reconnecting page. API fetches don't match.
    let is_doc_nav = req.headers().get("sec-fetch-dest").and_then(|v| v.to_str().ok()) == Some("document")
        || req.headers().get(axum::http::header::ACCEPT).and_then(|v| v.to_str().ok()).map(|a| a.starts_with("text/html")).unwrap_or(false);
    let is_root_nav = method == Method::GET && (path == "/" || path == "/index.html");
    // Other document navigations to app routes (?team=… links, SPA paths) get the bridge and the Reconnecting
    // page, but never the root guard: files, /api/*, /__vibesquad/* and 404s pass through untouched.
    let is_app_route_nav = method == Method::GET && !is_root_nav && is_doc_nav && is_app_route_path(&path);
    let query_setup = uri.query().map(|q| q.contains("setup=1")).unwrap_or(false);
    let query_first_run = uri
        .query()
        .map(|q| q.contains("first-run=1") || q.contains("mode=choice"))
        .unwrap_or(false);

    // First launch (or explicit ?first-run=1 / ?mode=choice): show the mode choice screen before spawning anything!
    if is_root_nav
        && (query_first_run
            || (cfg.server_mode.trim().is_empty()
                && !query_setup
                && !state.setup_mode.load(Ordering::SeqCst)))
    {
        state.setup_mode.store(false, Ordering::SeqCst);
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

    // Browser navigations (root or deep link) ride out a restarting upstream; API calls fail fast.
    let is_html_nav = is_root_nav || is_app_route_nav;
    let mut last_err = String::new();
    let mut attempt = 0usize;

    loop {
    let candidates = state.candidate_hosts();
    for host in candidates {
        let host_is_local = is_local_host(&host);
        let scheme = if host_is_local { "http" } else { "https" };
        let target_url = format!("{}://{}{}", scheme, host, path_and_query);

        let req_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
            Ok(m) => m,
            Err(_) => reqwest::Method::GET,
        };

        let build_req = || {
            let mut builder = state.client().request(req_method.clone(), &target_url);

            for (k, v) in req_headers.iter() {
                let name_lower = k.as_str().to_lowercase();
                if name_lower == "host"
                    || name_lower == "connection"
                    || name_lower == "content-length"
                    || name_lower == "origin"
                    || name_lower == "referer"
                    || name_lower == "cookie"
                    || name_lower == LOCAL_TOKEN_HEADER
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
                if let Some(t) = state.local_token() {
                    builder = builder.header(LOCAL_TOKEN_HEADER, t);
                }
            }

            let existing_cookie = strip_local_cookies(
                req_headers
                    .get(axum::http::header::COOKIE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
            );
            let merged = if cfg.device_token.is_empty() || existing_cookie.contains("vs_device=") {
                existing_cookie
            } else if existing_cookie.is_empty() {
                format!("vs_device={}", cfg.device_token)
            } else {
                format!("{}; vs_device={}", existing_cookie, cfg.device_token)
            };
            if !merged.is_empty() {
                builder = builder.header("Cookie", merged);
            }

            if !body_bytes.is_empty() {
                builder = builder.body(body_bytes.clone());
            }

            builder
        };

        let send_res = match build_req().send().await {
            Ok(resp) => Ok(resp),
            Err(_) if host_is_local && is_local => {
                ensure_local_server_running(&state).await;
                build_req().send().await
            }
            Err(e) => Err(e),
        };

        match send_res {
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

                let is_attachment = up_headers
                    .get(reqwest::header::CONTENT_DISPOSITION)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_ascii_lowercase().contains("attachment"))
                    .unwrap_or(false);
                let needs_html_buffer = is_root_nav
                    || (is_app_route_nav && is_html && !is_attachment && up_status == reqwest::StatusCode::OK);

                if !needs_html_buffer {
                    let status_code =
                        StatusCode::from_u16(up_status.as_u16()).unwrap_or(StatusCode::OK);
                    let mut res_builder = Response::builder().status(status_code);
                    for (k, v) in up_headers.iter() {
                        let name_lower = k.as_str().to_lowercase();
                        // Body is streamed untouched, so content-length / content-encoding stay valid.
                        if name_lower == "transfer-encoding"
                            || name_lower == "connection"
                            || ((status_code.is_client_error() || status_code.is_server_error())
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
                    if status_code.is_client_error() || status_code.is_server_error() {
                        res_builder = res_builder.header(
                            axum::http::header::CACHE_CONTROL,
                            "no-store, no-cache, must-revalidate",
                        );
                    }
                    return res_builder
                        .body(Body::from_stream(up_resp.bytes_stream()))
                        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
                }

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

                let final_bytes = if (is_root_nav || is_app_route_nav) && is_html && !is_attachment && up_status == reqwest::StatusCode::OK {
                    let html_str = String::from_utf8_lossy(&resp_bytes);
                    let bridge = ui_pages::desktop_bridge_script(&cfg.last_hash, &cfg.last_route);
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
    if is_html_nav && attempt < RELAY_RETRY_BACKOFF_MS.len() {
        tokio::time::sleep(std::time::Duration::from_millis(RELAY_RETRY_BACKOFF_MS[attempt])).await;
        attempt += 1;
        continue;
    }
    break;
    }

    // Upstream unreachable! Never let WebView2 show its own error page: serve the Reconnecting card
    // (it polls /__desktop/ping, reloads the same URL when the server is back, and turns into the
    // Retry / Switch server card after ~30 s).
    if is_html_nav {
        return html_no_store_response(
            StatusCode::OK,
            ui_pages::render_reconnecting_page(&cfg, &last_err),
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

fn focus_main_window_with_agent(app: &AppHandle, agent_id: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let js = format!(
            "window.postMessage({{ type: 'vs:select-agent', agentId: '{}' }}, '*');",
            agent_id.replace('\'', "\\'")
        );
        let _ = w.eval(&js);
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

/// The origins the desktop webview loads from (tauri.conf.json window url is http://127.0.0.1:<port>/;
/// the tauri:// and tauri.localhost forms cover the bundled-asset schemes on macOS/Linux and Windows).
fn allowed_local_origins(port: usize) -> [String; 5] {
    [
        format!("http://127.0.0.1:{}", port),
        format!("http://localhost:{}", port),
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
        "https://tauri.localhost".to_string(),
    ]
}

/// Origin/Host policy for every request on the loopback proxy, not just /__desktop and /ws: the proxy
/// attaches the paired device token to /api/* and /__vibesquad/*, so a cross-site request must never
/// reach it. Allowed: a loopback Host plus either an allowlisted Origin, or no Origin with
/// Sec-Fetch-Site absent / none / same-origin, or no Origin with an allowlisted Referer.
fn check_local_request(headers: &HeaderMap, port: usize) -> Result<(), &'static str> {
    // A repeated Host/Origin/Sec-Fetch-Site/Referer is never sent by a browser: refuse it rather than pick one.
    for name in ["host", "origin", "sec-fetch-site", "referer"] {
        if headers.get_all(name).iter().nth(1).is_some() {
            return Err("duplicate header");
        }
    }
    // Non-ASCII values read as "" so they never match anything below.
    let header = |name: &str| headers.get(name).map(|v| v.to_str().unwrap_or(""));
    let host_ok = header("host")
        .map(|h| h.eq_ignore_ascii_case(&format!("127.0.0.1:{}", port)) || h.eq_ignore_ascii_case(&format!("localhost:{}", port)))
        .unwrap_or(false);
    if !host_ok {
        return Err("forbidden host");
    }
    let allowed = allowed_local_origins(port);
    if let Some(origin) = header("origin") {
        // An allowlisted Origin is our own page (tauri:// to 127.0.0.1 reads as cross-site, so this
        // wins over Sec-Fetch-Site). Anything else, including "null", is refused.
        return if allowed.iter().any(|a| a.eq_ignore_ascii_case(origin)) { Ok(()) } else { Err("forbidden origin") };
    }
    match header("sec-fetch-site") {
        None | Some("none") | Some("same-origin") => Ok(()),
        Some(_) => {
            let referer_ok = header("referer")
                .and_then(|r| url::Url::parse(r).ok())
                .map(|u| u.origin().ascii_serialization())
                .map(|o| allowed.iter().any(|a| *a == o))
                .unwrap_or(false);
            if referer_ok { Ok(()) } else { Err("forbidden cross-site request") }
        }
    }
}

/// Rejects DNS-rebinding (foreign Host) and cross-site browser calls (foreign Origin, cross-site
/// Sec-Fetch-Site) before any handler runs, so a random web page cannot hit /__desktop/*, /ws, or the
/// token-bearing /api/* and /__vibesquad/* passthrough.
/// Then, outside headless mode, requires the per-launch vs_desktop cookie: a local process (or another Windows
/// user) that sends no Origin passes the checks above, and must not get the token/cookie this proxy attaches.
async fn guard_local_request(
    State(state): State<Arc<SharedAppState>>,
    req: Request,
    next: Next,
) -> Response {
    let port = state.local_port.load(Ordering::SeqCst);
    if let Err(reason) = check_local_request(req.headers(), port) {
        return (StatusCode::FORBIDDEN, reason).into_response();
    }
    if req.uri().path() == "/__desktop/boot" {
        return handle_desktop_boot(&state, req.uri().query().unwrap_or(""));
    }
    if state.require_desktop_key.load(Ordering::SeqCst) {
        let cookie = req.headers().get(axum::http::header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or("");
        let ok = cookie_value(cookie, DESKTOP_COOKIE).map(|v| ct_eq(v.as_bytes(), state.desktop_key.as_bytes())).unwrap_or(false);
        if !ok {
            return (StatusCode::FORBIDDEN, "VibeSquad desktop: open this from the VibeSquad app window").into_response();
        }
    }
    next.run(req).await
}

/// GET /__desktop/boot?k=<per-launch key>&next=<path>: the app navigates its own window here at startup;
/// sets the vs_desktop cookie and redirects to `next` (same-origin paths only).
fn handle_desktop_boot(state: &SharedAppState, query: &str) -> Response {
    let mut key = String::new();
    let mut next_path = String::from("/");
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "k" => key = v.into_owned(),
            "next" if v.starts_with('/') && !v.starts_with("//") && !v.contains('\\') => next_path = v.into_owned(),
            _ => {}
        }
    }
    if !ct_eq(key.as_bytes(), state.desktop_key.as_bytes()) {
        return (StatusCode::FORBIDDEN, "invalid desktop key").into_response();
    }
    let mut resp = StatusCode::FOUND.into_response();
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&next_path) {
        h.insert(axum::http::header::LOCATION, v);
    }
    if let Ok(v) = HeaderValue::from_str(&format!("{}={}; HttpOnly; SameSite=Strict; Path=/", DESKTOP_COOKIE, state.desktop_key)) {
        h.insert(axum::http::header::SET_COOKIE, v);
    }
    h.insert(axum::http::header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    resp
}

fn build_router(state: Arc<SharedAppState>) -> Router {
    Router::new()
        .route("/__desktop/status", get(handle_desktop_status))
        .route("/__desktop/choose-mode", post(handle_desktop_choose_mode))
        .route("/__desktop/mode", get(handle_desktop_mode))
        .route("/__desktop/ping", get(handle_desktop_ping))
        .route("/__desktop/setup", get(handle_desktop_setup))
        .route("/__desktop/unpair", post(handle_desktop_unpair))
        .route("/__desktop/pair", post(handle_desktop_pair))
        .route("/__desktop/hash", post(handle_desktop_hash))
        .route("/__desktop/start-at-login", get(handle_start_at_login_get).post(handle_start_at_login_set))
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
    if is_background_arg(&std::env::args().collect::<Vec<_>>()) {
        std::process::exit(run_background(&initial_cfg));
    }
    // Keep the Run value in step with the config both ways: an explicit off removes a stale entry.
    let _ = set_start_at_login_registry(initial_cfg.start_at_login);

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
        tray_login_item: RwLock::new(None),
        tracker: Mutex::new(AgentAlertTracker::default()),
        updater: Mutex::new(updater::UpdaterState::default()),
        managed_server: Mutex::new(None),
        last_notified_agent_id: RwLock::new(None),
        desktop_key: random_hex_key(),
        require_desktop_key: AtomicBool::new(true),
        local_token_file: default_local_token_file(),
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
    // Own the server process: start the bundled one (or reuse a healthy :4180). In GUI mode we do
    // NOT spawn it eagerly before the window opens — the proxy handler or clicking "Run agents on
    // this PC" starts it on demand, and only starts the Paseo daemon when server_mode == "local".
    // Headless test mode still starts it when a runtime is actually bundled next to the exe.
    if headless && find_bundled_runtime().is_some() {
        let st = shared_state.clone();
        rt.block_on(async move { ensure_local_server_running(&st).await });
    }
    if headless {
        shared_state.require_desktop_key.store(false, Ordering::SeqCst);
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

            // Always boot through /__desktop/boot (sets the vs_desktop cookie), then the saved route.
            if let Some(main_win) = app.get_webview_window("main") {
                let (last_hash, last_route) = {
                    let c = state_for_setup.config.read().unwrap();
                    (c.last_hash.clone(), c.last_route.clone())
                };
                let restore = ui_pages::restore_path(&last_route, &last_hash);
                let next: String = url::form_urlencoded::byte_serialize(restore.as_bytes()).collect();
                if let Ok(target_url) = url::Url::parse(&format!(
                    "http://127.0.0.1:{}/__desktop/boot?k={}&next={}",
                    local_port, state_for_setup.desktop_key, next
                )) {
                    let _ = main_win.navigate(target_url);
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
            let first_time_setup_item = MenuItem::with_id(
                app,
                "first_time_setup",
                "First-Time Setup (Local / Remote)...",
                true,
                None::<&str>,
            )?;
            let check_updates_item = MenuItem::with_id(
                app,
                "check_updates",
                "Check for Updates...",
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
            *state_for_setup.tray_login_item.write().unwrap() = Some(start_login_item.clone());

            let menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &switch_server_item,
                    &first_time_setup_item,
                    &check_updates_item,
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
            let state_for_tray_click = state_for_setup.clone();
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
                    "first_time_setup" => {
                        *state_for_menu.active_upstream.write().unwrap() = None;
                        state_for_menu.setup_mode.store(false, Ordering::SeqCst);
                        let port = state_for_menu.local_port.load(Ordering::SeqCst);
                        if let Some(w) = app.get_webview_window("main") {
                            if let Ok(u) =
                                url::Url::parse(&format!("http://127.0.0.1:{}/__desktop/mode", port))
                            {
                                let _ = w.navigate(u);
                            }
                        }
                        focus_main_window(app);
                    }
                    "check_updates" => {
                        let st = state_for_menu.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = updater::check_for_updates(&st).await;
                        });
                        focus_main_window(app);
                    }
                    "quit" => {
                        state_for_menu.quitting.store(true, Ordering::SeqCst);
                        stop_managed_server(&state_for_menu);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let agent_id = state_for_tray_click.last_notified_agent_id.write().unwrap().take();
                        if let Some(id) = agent_id {
                            focus_main_window_with_agent(tray.app_handle(), &id);
                        } else {
                            focus_main_window(tray.app_handle());
                        }
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
    fn start_at_login_defaults_on_unless_explicitly_false() {
        assert!(DesktopConfig::default().start_at_login);
        let missing: DesktopConfig = serde_json::from_str(r#"{"serverMode":"local"}"#).unwrap();
        assert!(missing.start_at_login, "an existing config with no value becomes on");
        let off: DesktopConfig = serde_json::from_str(r#"{"startAtLogin":false}"#).unwrap();
        assert!(!off.start_at_login, "an explicit false stays off");
        let on: DesktopConfig = serde_json::from_str(r#"{"startAtLogin":true}"#).unwrap();
        assert!(on.start_at_login);
    }

    #[test]
    fn background_does_nothing_when_start_at_login_is_off() {
        let mut cfg = DesktopConfig::default();
        cfg.start_at_login = false;
        cfg.server_mode = "local".to_string();
        assert_eq!(run_background(&cfg), 0, "off-switch wins before any server lookup or spawn");
    }

    #[test]
    fn start_at_login_errors_are_surfaced() {
        assert_eq!(start_at_login_error(&Ok(()), &Ok(())), None);
        let e = start_at_login_error(&Err("denied".into()), &Ok(())).unwrap();
        assert!(e.contains("login entry") && e.contains("denied"));
        let e = start_at_login_error(&Err("a".into()), &Err("b".into())).unwrap();
        assert!(e.contains("a") && e.contains("saving settings: b"));
    }

    #[test]
    fn background_flag_parsing() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_background_arg(&a(&["vibesquad.exe", "--background"])));
        assert!(!is_background_arg(&a(&["vibesquad.exe"])));
        assert!(!is_background_arg(&a(&["--background"])), "argv[0] is never a flag");
        assert!(!is_background_arg(&a(&["vibesquad.exe", "--headless-proxy"])));
        assert_eq!(port_of_host("127.0.0.1:4391"), 4391);
        assert_eq!(port_of_host("localhost"), 4180);
    }

    #[cfg(windows)]
    #[test]
    fn run_entry_writes_the_background_command_to_an_injected_key() {
        use winreg::enums::*;
        use winreg::RegKey;
        let sub = format!("Software\\VibeSquadTest\\Run{}", std::process::id());
        let exe = std::path::Path::new("C:\\Apps\\VibeSquad\\VibeSquad.exe");
        write_run_entry(&sub, true, exe).unwrap();
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(&sub).unwrap();
        let v: String = key.get_value("VibeSquad").unwrap();
        assert_eq!(v, "\"C:\\Apps\\VibeSquad\\VibeSquad.exe\" --background");
        write_run_entry(&sub, false, exe).unwrap();
        assert!(key.get_value::<String, _>("VibeSquad").is_err());
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all("Software\\VibeSquadTest");
    }

    #[test]
    fn beta_build_follows_beta_until_the_user_picks() {
        // docs/PLAN_BUGS_BATCH1.md 0d: the first-run default "stable" must not pin a beta build to stable.
        assert_eq!(updater::effective_channel("stable", false, "0.1.1-beta.5"), "beta");
        assert_eq!(updater::effective_channel("stable", true, "0.1.1-beta.5"), "stable");
        assert_eq!(updater::effective_channel("stable", false, "0.1.1"), "stable");
        assert_eq!(updater::effective_channel("beta", false, "0.1.1"), "beta");
        assert_eq!(updater::effective_channel("junk", false, "0.1.2-beta.1"), "beta");
        // Old configs have no updateChannelExplicit field: it reads as false.
        let old: DesktopConfig = serde_json::from_str(r#"{"updateChannel":"stable"}"#).unwrap();
        assert!(!old.update_channel_explicit);
        // The beta endpoint is the beta tag's latest.json, never releases/latest (which skips pre-releases).
        assert!(updater::endpoint_for_channel("beta").ends_with("/releases/download/beta/latest.json"));
        // A beta build on the beta channel takes the next beta, not the older same-number stable.
        assert!(updater::is_version_newer_for_channel("0.1.1-beta.5", "0.1.2-beta.1", "beta").unwrap());
    }

    fn make_test_state() -> Arc<SharedAppState> {
        let (http_client, ws_tls_connector) = build_http_and_ws_clients().unwrap();
        Arc::new(SharedAppState {
            config: RwLock::new(DesktopConfig::default()),
            active_upstream: RwLock::new(None),
            setup_mode: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            needs_count: AtomicUsize::new(0),
            local_port: AtomicUsize::new(4189),
            http_client: RwLock::new(http_client),
            ws_tls_connector: RwLock::new(ws_tls_connector),
            app_handle: RwLock::new(None),
            tray_needs_item: RwLock::new(None),
        tray_login_item: RwLock::new(None),
            tracker: Mutex::new(AgentAlertTracker::default()),
            updater: Mutex::new(updater::UpdaterState::default()),
            managed_server: Mutex::new(None),
            last_notified_agent_id: RwLock::new(None),
            desktop_key: "k".repeat(64),
            require_desktop_key: AtomicBool::new(false),
            local_token_file: std::env::temp_dir().join("vs-desktop-test-no-token"),
        })
    }

    #[tokio::test]
    async fn relay_serves_reconnect_page_while_upstream_is_down() {
        let state = make_test_state();
        {
            let mut cfg = state.config.write().unwrap();
            cfg.server_mode = "remote".into();
            cfg.server_host = "127.0.0.1:1".into();
            cfg.fallback_host = "127.0.0.1:2".into();
            cfg.device_token = "t".into();
        }
        for (uri, accept) in [("/", "text/html"), ("/?team=x&agent=y", "text/html"), ("/some/deep/link", "text/html")] {
            let req = Request::builder()
                .method("GET")
                .uri(uri)
                .header("accept", accept)
                .body(Body::empty())
                .unwrap();
            let resp = proxy_http_handler(State(state.clone()), req).await;
            assert_eq!(resp.status(), StatusCode::OK, "{uri}");
            let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            let html = String::from_utf8_lossy(&body);
            assert!(html.contains("Reconnecting"), "{uri}: {html}");
            assert!(html.contains("Switch server"), "{uri}");
        }
        // API calls still fail fast with a JSON 502.
        let req = Request::builder().method("GET").uri("/api/x").body(Body::empty()).unwrap();
        let resp = proxy_http_handler(State(state.clone()), req).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn deep_link_navigation_gets_desktop_bridge() {
        let upstream = Router::new().fallback(|| async {
            Response::builder()
                .header("content-type", "text/html")
                .body(Body::from("<html><body><div id=\"root\"></div></body></html>"))
                .unwrap()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let state = make_test_state();
        {
            let mut cfg = state.config.write().unwrap();
            cfg.server_mode = "direct".into();
            cfg.server_host = addr.to_string();
            cfg.device_token = "t".into();
        }
        for (uri, hdr, val, bridged) in [
            ("/?team=x&agent=y", "accept", "text/html,application/xhtml+xml", true),
            ("/some/spa/path", "sec-fetch-dest", "document", true),
            ("/api/data", "accept", "*/*", false),
        ] {
            let req = Request::builder().method("GET").uri(uri).header(hdr, val).body(Body::empty()).unwrap();
            let resp = proxy_http_handler(State(state.clone()), req).await;
            let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            let html = String::from_utf8_lossy(&body);
            assert_eq!(html.contains("__VIBESQUAD_DESKTOP_BRIDGE__"), bridged, "{uri}: {html}");
        }
    }

    async fn spawn_upstream(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        addr.to_string()
    }

    fn direct_state(host: &str) -> Arc<SharedAppState> {
        let state = make_test_state();
        {
            let mut cfg = state.config.write().unwrap();
            cfg.server_mode = "direct".into();
            cfg.server_host = host.into();
            cfg.device_token = "t".into();
        }
        state
    }

    #[tokio::test]
    async fn downloads_404s_and_json_pass_through_untouched() {
        use axum::routing::get;
        let upstream = Router::new()
            .route("/ca.crt", get(|| async {
                Response::builder().header("content-type", "application/x-x509-ca-cert").body(Body::from("CERT")).unwrap()
            }))
            .route("/setup.exe", get(|| async {
                Response::builder().header("content-type", "text/html").header("content-disposition", "attachment; filename=a.html").body(Body::from("<html><body>dl</body></html>")).unwrap()
            }))
            .route("/api/data", get(|| async { Json(json!({ "ok": true })) }))
            .fallback(|| async {
                Response::builder().status(404).header("content-type", "text/html").body(Body::from("<html><body>nope</body></html>")).unwrap()
            });
        let state = direct_state(&spawn_upstream(upstream).await);
        let cases = [
            ("/ca.crt", "CERT"),
            ("/setup.exe", "dl"),
            ("/api/data", "\"ok\":true"),
            ("/missing.png", "nope"),
        ];
        for (uri, needle) in cases {
            let req = Request::builder().method("GET").uri(uri).header("accept", "text/html").header("sec-fetch-dest", "document").body(Body::empty()).unwrap();
            let resp = proxy_http_handler(State(state.clone()), req).await;
            let status = resp.status();
            let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            let text = String::from_utf8_lossy(&body);
            assert!(text.contains(needle), "{uri}: {text}");
            assert!(!text.contains("__VIBESQUAD_DESKTOP_BRIDGE__") && !text.contains("Reconnecting"), "{uri}: {text}");
            assert_eq!(status == StatusCode::NOT_FOUND, uri == "/missing.png", "{uri}");
        }
    }

    #[tokio::test]
    async fn ping_is_reachable_only_when_the_app_shell_is_served() {
        use axum::routing::get;
        let ok = spawn_upstream(Router::new().route("/", get(|| async { "<html><div id=\"root\"></div></html>" })).route("/api/auth/status", get(|| async { Json(json!({ "distReady": true })) }))).await;
        let unauthorized = spawn_upstream(Router::new().fallback(|| async { (StatusCode::UNAUTHORIZED, "no") })).await;
        let server_error = spawn_upstream(Router::new().fallback(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "<div id=\"root\">") })).await;
        let broken = spawn_upstream(Router::new().fallback(|| async { "dist/index.html missing" })).await;
        let client = make_test_state().client();
        assert!(check_shell_ready(&client, &ok, "").await);
        assert!(!check_shell_ready(&client, &unauthorized, "").await);
        assert!(!check_shell_ready(&client, &server_error, "").await);
        assert!(!check_shell_ready(&client, &broken, "").await);
        for (host, want) in [(&ok, true), (&unauthorized, false), (&server_error, false), (&broken, false)] {
            let state = direct_state(host);
            let resp = handle_desktop_ping(State(state), Request::builder().uri("/__desktop/ping").body(Body::empty()).unwrap()).await.into_response();
            let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            let v: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(v["reachable"].as_bool(), Some(want), "{host}: {v}");
        }
    }

    #[test]
    fn app_route_paths_exclude_files_and_endpoints() {
        for p in ["/some/spa/path", "/team/x"] { assert!(is_app_route_path(p), "{p}"); }
        for p in ["/ca.crt", "/VibeSquad-setup.exe", "/api/x", "/__vibesquad/local-image", "/__desktop/ping", "/ws"] { assert!(!is_app_route_path(p), "{p}"); }
    }

    #[test]
    fn pages_guard_against_reload_loops() {
        let cfg = DesktopConfig::default();
        for html in [ui_pages::render_reconnecting_page(&cfg, ""), ui_pages::render_unreachable_page(&cfg, "")] {
            assert!(html.contains("vs.reconnect.reloads") && html.contains("MAX_RELOADS = 3"));
        }
        let r = ui_pages::render_reconnecting_page(&cfg, "");
        assert!(!r.contains("
    checkNow();
"), "no immediate check on load");
        assert!(ui_pages::desktop_bridge_script("", "").contains("removeItem('vs.reconnect.reloads')"));
    }

    #[test]
    fn restore_path_covers_chat_squad_page_and_squads_home() {
        // Chat, squad page and Squads Home are all query routes; each round-trips exactly.
        for route in ["/?team=vibesquad&agent=abc-123", "/?team=vibesquad", "/?view=squads", "/?team=vibesquad&view=squads#x"] {
            assert_eq!(ui_pages::restore_path(route, ""), route);
        }
        // Nothing saved: plain root (the app's own default), legacy hash still honoured.
        assert_eq!(ui_pages::restore_path("", ""), "/");
        assert_eq!(ui_pages::restore_path("", "#/chat/1"), "/#/chat/1");
        // Unsafe routes are rejected.
        assert_eq!(ui_pages::restore_path("//evil.example/x", ""), "/");
        assert_eq!(ui_pages::restore_path("/\\evil.example", ""), "/");
        assert_eq!(ui_pages::restore_path("/__desktop/setup", ""), "/");
    }

    #[test]
    fn bridge_restores_saved_route_and_saves_on_history_changes() {
        let js = ui_pages::desktop_bridge_script("", "/?team=t&agent=a");
        assert!(js.contains(r#"const savedRoute = "/?team=t&agent=a";"#));
        assert!(js.contains("history[fn]") && js.contains("popstate"));
        assert!(js.contains("route: window.location.pathname"));
    }

    #[test]
    fn buddy_running_to_idle_emits_finished_toast() {
        let state = make_test_state();
        // Seed with a Buddy agent in running state
        let seed = r#"{"entries":[{"agent":{"id":"a1","title":"BRAINSTORM · MyLane","status":"running","labels":{"role":"brainstorm","lane":"deploy","team":"vibesquad"},"lastMessage":"Here is my analysis of the issue."}}]}"#;
        inspect_ws_frame(&state, seed);
        let tracker = state.tracker.lock().unwrap();
        assert!(tracker.running_agents.contains("a1"));
        assert!(tracker.seeded);
        drop(tracker);

        // Transition to idle (non-seed)
        let update = r#"{"agent":{"id":"a1","title":"BRAINSTORM · MyLane","status":"idle","updatedAt":"2026-11-01T10:00:00Z","labels":{"role":"brainstorm","lane":"deploy","team":"vibesquad"},"lastMessage":"Here is my analysis of the issue."}}"#;
        inspect_ws_frame(&state, update);
        let tracker = state.tracker.lock().unwrap();
        assert!(!tracker.running_agents.contains("a1"));
        assert!(tracker.finished_dedupe.iter().any(|k| k.starts_with("a1::finished:")));
        drop(tracker);

        // Repeat idle should NOT add another dedupe entry (already deduped)
        let tracker = state.tracker.lock().unwrap();
        let count = tracker.finished_dedupe.iter().filter(|k| k.starts_with("a1::finished:")).count();
        assert_eq!(count, 1);
    }

    #[test]
    fn lead_running_to_idle_emits_finished_toast() {
        let state = make_test_state();
        // Seed with a Lead agent in running state
        let seed = r#"{"entries":[{"agent":{"id":"lead1","title":"★ LEAD","status":"running","labels":{"role":"lead","lane":"core","team":"vibesquad"},"lastMessage":"Dispatched worker."}}]}"#;
        inspect_ws_frame(&state, seed);

        // Transition to idle
        let update = r#"{"agent":{"id":"lead1","title":"★ LEAD","status":"idle","updatedAt":"2026-11-01T11:00:00Z","labels":{"role":"lead","lane":"core","team":"vibesquad"},"lastMessage":"Dispatched worker."}}"#;
        inspect_ws_frame(&state, update);
        let tracker = state.tracker.lock().unwrap();
        assert!(tracker.finished_dedupe.iter().any(|k| k.starts_with("lead1::finished:")));
    }

    #[test]
    fn worker_running_to_idle_does_not_emit_finished_toast() {
        let state = make_test_state();
        let seed = r#"{"entries":[{"agent":{"id":"w1","title":"Worker","status":"running","labels":{"role":"worker","lane":"deploy"}}}]}"#;
        inspect_ws_frame(&state, seed);

        let update = r#"{"agent":{"id":"w1","title":"Worker","status":"idle","updatedAt":"2026-11-01T12:00:00Z","labels":{"role":"worker","lane":"deploy"}}}"#;
        inspect_ws_frame(&state, update);
        let tracker = state.tracker.lock().unwrap();
        assert!(!tracker.finished_dedupe.iter().any(|k| k.starts_with("w1::finished:")));
    }

    #[test]
    fn seed_does_not_emit_finished_toast() {
        let state = make_test_state();
        // The initial seed has agents going from unknown -> idle, should NOT trigger finished toast
        let seed = r#"{"entries":[{"agent":{"id":"b1","title":"BRAINSTORM","status":"idle","updatedAt":"2026-11-01T08:00:00Z","labels":{"role":"brainstorm","lane":"deploy"},"lastMessage":"Done."}}]}"#;
        inspect_ws_frame(&state, seed);
        let tracker = state.tracker.lock().unwrap();
        assert!(tracker.finished_dedupe.is_empty());
    }

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

    #[test]
    fn local_request_guard_policy() {
        let port = 4189usize;
        let hdrs = |pairs: &[(&str, &str)]| {
            let mut h = HeaderMap::new();
            for (k, v) in pairs {
                h.insert(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
            }
            h
        };
        let host = ("host", "127.0.0.1:4189");
        // Allowed: every app origin, top-level/programmatic navigation, same-origin fetch, no Origin at all.
        for origin in allowed_local_origins(port) {
            assert_eq!(check_local_request(&hdrs(&[host, ("origin", &origin), ("sec-fetch-site", "cross-site")]), port), Ok(()), "{origin}");
        }
        assert_eq!(check_local_request(&hdrs(&[host]), port), Ok(()));
        assert_eq!(check_local_request(&hdrs(&[("host", "localhost:4189")]), port), Ok(()));
        assert_eq!(check_local_request(&hdrs(&[host, ("sec-fetch-site", "none")]), port), Ok(()));
        assert_eq!(check_local_request(&hdrs(&[host, ("sec-fetch-site", "same-origin")]), port), Ok(()));
        assert_eq!(check_local_request(&hdrs(&[host, ("sec-fetch-site", "cross-site"), ("referer", "http://localhost:4189/x")]), port), Ok(()));
        // Refused: foreign/null Origin, foreign Host, cross-site or same-site without an app Origin/Referer.
        for origin in ["https://evil.example", "null", "http://127.0.0.1:4180", "http://127.0.0.1:41890"] {
            assert!(check_local_request(&hdrs(&[host, ("origin", origin), ("sec-fetch-site", "same-origin")]), port).is_err(), "{origin}");
        }
        assert!(check_local_request(&hdrs(&[("host", "evil.example:4189")]), port).is_err());
        assert!(check_local_request(&hdrs(&[]), port).is_err());
        assert!(check_local_request(&hdrs(&[host, ("sec-fetch-site", "cross-site")]), port).is_err());
        assert!(check_local_request(&hdrs(&[host, ("sec-fetch-site", "same-site")]), port).is_err());
        assert!(check_local_request(&hdrs(&[host, ("sec-fetch-site", "cross-site"), ("referer", "https://evil.example/")]), port).is_err());
        // Host/Origin compare case-insensitively (still exact otherwise).
        assert_eq!(check_local_request(&hdrs(&[("host", "LOCALHOST:4189"), ("origin", "HTTP://127.0.0.1:4189")]), port), Ok(()));
        assert!(check_local_request(&hdrs(&[host, ("origin", "HTTP://EVIL.example")]), port).is_err());
        // Duplicate Host / Origin / Sec-Fetch-Site / Referer are refused, even when the first value is allowed.
        for (name, good, bad) in [
            ("host", "127.0.0.1:4189", "evil.example:4189"),
            ("origin", "http://127.0.0.1:4189", "https://evil.example"),
            ("sec-fetch-site", "same-origin", "cross-site"),
            ("referer", "http://127.0.0.1:4189/", "https://evil.example/"),
        ] {
            let mut h = if name == "host" { HeaderMap::new() } else { hdrs(&[host]) };
            h.append(HeaderName::from_bytes(name.as_bytes()).unwrap(), HeaderValue::from_str(good).unwrap());
            h.append(HeaderName::from_bytes(name.as_bytes()).unwrap(), HeaderValue::from_str(bad).unwrap());
            assert_eq!(check_local_request(&h, port), Err("duplicate header"), "{name}");
        }
    }

    #[tokio::test]
    async fn guard_blocks_cross_site_requests_before_the_token_is_attached() {
        use std::sync::atomic::AtomicUsize as Counter;
        // Upstream counts hits and echoes the cookie, so a blocked request provably never left the proxy.
        let hits = Arc::new(Counter::new(0));
        let hits_up = hits.clone();
        let upstream = Router::new().fallback(move |headers: HeaderMap| {
            let hits = hits_up.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                headers.get("cookie").and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
            }
        });
        let state = direct_state(&spawn_upstream(upstream).await);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        state.local_port.store(port as usize, Ordering::SeqCst);
        let app = build_router(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{}", port);
        let send = |method: reqwest::Method, path: &str, hdrs: Vec<(&'static str, String)>| {
            let mut b = client.request(method, format!("{}{}", base, path));
            for (k, v) in hdrs { b = b.header(k, v); }
            b.send()
        };

        for path in ["/api/teams", "/__vibesquad/x", "/__vibesquad/paseo/providers", "/__desktop/status"] {
            for hdrs in [
                vec![("origin", "https://evil.example".to_string())],
                vec![("origin", "null".to_string())],
                vec![("sec-fetch-site", "cross-site".to_string())],
                vec![("host", "evil.example".to_string())],
            ] {
                let resp = send(reqwest::Method::POST, path, hdrs.clone()).await.unwrap();
                assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN, "{path} {hdrs:?}");
            }
        }
        assert_eq!(hits.load(Ordering::SeqCst), 0, "a blocked request reached the upstream");

        // The real app still goes through, with the token attached.
        for hdrs in [
            vec![],
            vec![("origin", base.clone()), ("sec-fetch-site", "same-origin".to_string())],
            vec![("origin", "http://tauri.localhost".to_string()), ("sec-fetch-site", "cross-site".to_string())],
            vec![("sec-fetch-site", "none".to_string())],
        ] {
            let resp = send(reqwest::Method::POST, "/api/teams", hdrs.clone()).await.unwrap();
            assert_eq!(resp.status(), reqwest::StatusCode::OK, "{hdrs:?}");
            assert!(resp.text().await.unwrap().contains("vs_device=t"), "{hdrs:?}");
        }
        assert_eq!(hits.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn is_local_host_is_an_exact_match() {
        for h in ["localhost", "localhost:4180", "127.0.0.1", "127.0.0.1:4180", "http://127.0.0.1:4180/x", "[::1]", "[::1]:4180", "LOCALHOST:1"] {
            assert!(is_local_host(h), "{h}");
        }
        for h in ["localhost.evil.com", "localhost.evil.com:4180", "127.0.0.1.nip.io", "127.0.0.1.nip.io:4180", "127.0.0.10:4180", "[::1].evil", "[::1]:x", "localhost:4180:1", "evil.com", "10.0.0.5:4180"] {
            assert!(!is_local_host(h), "{h}");
        }
    }

    #[test]
    fn local_token_file_must_be_64_lowercase_hex() {
        let dir = std::env::temp_dir().join(format!("vs-desktop-token-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("local-token");
        assert_eq!(read_local_token(&f), None);
        let good = "ab".repeat(32);
        fs::write(&f, format!("\u{feff}{}\n", good)).unwrap();
        assert_eq!(read_local_token(&f).as_deref(), Some(good.as_str()));
        for bad in ["AB".repeat(32), "ab".repeat(31), "zz".repeat(32)] {
            fs::write(&f, bad).unwrap();
            assert_eq!(read_local_token(&f), None);
        }
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(random_hex_key().len(), 64);
        assert_ne!(random_hex_key(), random_hex_key());
        assert_eq!(strip_local_cookies("a=1; vs_desktop=x; vs_local=y;vs_device=z"), "a=1; vs_device=z");
    }

    #[tokio::test]
    async fn desktop_key_gates_the_proxy_and_the_local_token_is_attached() {
        use std::sync::atomic::AtomicUsize as Counter;
        // Upstream echoes the token header and cookie it received.
        let hits = Arc::new(Counter::new(0));
        let hits_up = hits.clone();
        let upstream = Router::new().fallback(move |headers: HeaderMap| {
            let hits = hits_up.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                format!("token={} cookie={}", h(LOCAL_TOKEN_HEADER), h("cookie"))
            }
        });
        let upstream_host = spawn_upstream(upstream).await;
        let dir = std::env::temp_dir().join(format!("vs-desktop-gate-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let token = "cd".repeat(32);
        fs::write(dir.join("local-token"), &token).unwrap();
        let state = {
            let base = make_test_state();
            let st = SharedAppState {
                config: RwLock::new(DesktopConfig { server_mode: "direct".into(), server_host: upstream_host.clone(), ..DesktopConfig::default() }),
                active_upstream: RwLock::new(None),
                setup_mode: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
                needs_count: AtomicUsize::new(0),
                local_port: AtomicUsize::new(0),
                http_client: RwLock::new(base.client()),
                ws_tls_connector: RwLock::new(base.ws_connector()),
                app_handle: RwLock::new(None),
                tray_needs_item: RwLock::new(None),
        tray_login_item: RwLock::new(None),
                tracker: Mutex::new(AgentAlertTracker::default()),
                updater: Mutex::new(updater::UpdaterState::default()),
                managed_server: Mutex::new(None),
                last_notified_agent_id: RwLock::new(None),
                desktop_key: random_hex_key(),
                require_desktop_key: AtomicBool::new(true),
                local_token_file: dir.join("local-token"),
            };
            Arc::new(st)
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        state.local_port.store(port as usize, Ordering::SeqCst);
        let app = build_router(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let base = format!("http://127.0.0.1:{}", port);

        // No cookie (any local process): refused before anything is attached, /__desktop/* included.
        for path in ["/api/teams", "/__vibesquad/x", "/__desktop/status", "/"] {
            let r = client.post(format!("{}{}", base, path)).send().await.unwrap();
            assert_eq!(r.status(), reqwest::StatusCode::FORBIDDEN, "{path}");
        }
        let wrong = format!("{}=nope", DESKTOP_COOKIE);
        assert_eq!(client.get(format!("{}/api/teams", base)).header("cookie", wrong).send().await.unwrap().status(), reqwest::StatusCode::FORBIDDEN);
        assert_eq!(hits.load(Ordering::SeqCst), 0);

        // Boot: a wrong key sets nothing; the right one sets the cookie and redirects to a same-origin path only.
        let bad = client.get(format!("{}/__desktop/boot?k=nope", base)).send().await.unwrap();
        assert_eq!(bad.status(), reqwest::StatusCode::FORBIDDEN);
        assert!(bad.headers().get("set-cookie").is_none());
        let boot = client.get(format!("{}/__desktop/boot?k={}&next=%2F%3Fteam%3Defi", base, state.desktop_key)).send().await.unwrap();
        assert_eq!(boot.status(), reqwest::StatusCode::FOUND);
        assert_eq!(boot.headers().get("location").unwrap(), "/?team=efi");
        let set_cookie = boot.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
        assert!(set_cookie.starts_with(&format!("{}={};", DESKTOP_COOKIE, state.desktop_key)), "{set_cookie}");
        assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Strict"), "{set_cookie}");
        for next in ["%2F%2Fevil.example", "https%3A%2F%2Fevil.example", "%2F%5Cevil.example"] {
            let r = client.get(format!("{}/__desktop/boot?k={}&next={}", base, state.desktop_key, next)).send().await.unwrap();
            assert_eq!(r.headers().get("location").unwrap(), "/", "{next}");
        }

        // With the cookie: proxied, local token attached, machine-only cookies never forwarded.
        let cookie = format!("{}={}; vs_local=abc; other=1", DESKTOP_COOKIE, state.desktop_key);
        let r = client
            .post(format!("{}/api/teams", base))
            .header("cookie", cookie)
            .header(LOCAL_TOKEN_HEADER, "spoofed")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), reqwest::StatusCode::OK);
        assert_eq!(r.text().await.unwrap(), format!("token={} cookie=other=1", token));
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        // Headless (desktop key off): reachable without the cookie, so it carries no local token.
        state.require_desktop_key.store(false, Ordering::SeqCst);
        let r = client.post(format!("{}/api/teams", base)).send().await.unwrap();
        assert_eq!(r.text().await.unwrap(), "token= cookie=");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ws_proxy_echoes_and_forwards_subprotocol_and_mode_routes_render_first_time_screen() {
        use axum::routing::get;

        let upstream = Router::new().route(
            "/ws",
            get(|ws: WebSocketUpgrade, req: Request| async move {
                let protos = extract_ws_protocols(req.headers());
                let chosen = protos.first().cloned().unwrap_or_default();
                let mut ws = ws;
                if !protos.is_empty() {
                    ws = ws.protocols(protos);
                }
                ws.on_upgrade(move |mut socket| async move {
                    let _ = socket.send(AxumWsMessage::Text(format!("proto={}", chosen))).await;
                })
            }),
        );
        let upstream_host = spawn_upstream(upstream).await;
        let state = direct_state(&upstream_host);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        state.local_port.store(port as usize, Ordering::SeqCst);
        let app = build_router(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        // 1. WebSocket upgrade with Sec-WebSocket-Protocol: paseo.bearer.secret123
        let ws_url = format!("ws://127.0.0.1:{}/ws", port);
        let mut ws_req = ws_url.into_client_request().unwrap();
        ws_req
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", HeaderValue::from_static("paseo.bearer.secret123"));
        let (mut ws_stream, ws_resp) = connect_async_tls_with_config(ws_req, None, false, None)
            .await
            .unwrap();
        assert_eq!(
            ws_resp
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|v| v.to_str().ok()),
            Some("paseo.bearer.secret123")
        );
        if let Some(Ok(TungMessage::Text(msg))) = ws_stream.next().await {
            assert_eq!(msg.as_str(), "proto=paseo.bearer.secret123");
        } else {
            panic!("expected text frame from upstream ws");
        }

        // 2. /__desktop/mode, /__desktop/setup?mode=choice, and /?first-run=1 render the mode choice page
        let client = reqwest::Client::new();
        for path in ["/__desktop/mode", "/__desktop/setup?mode=choice", "/?first-run=1"] {
            state.setup_mode.store(true, Ordering::SeqCst);
            let resp = client
                .get(format!("http://127.0.0.1:{}{}", port, path))
                .header("accept", "text/html")
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), reqwest::StatusCode::OK, "{path}");
            let html = resp.text().await.unwrap();
            assert!(html.contains("data-testid=\"desktop-mode-choice\""), "{path}");
            assert!(!state.setup_mode.load(Ordering::SeqCst), "{path}");
        }

        // 3. Reconnecting, Unreachable, Mode Choice, and Pair pages all expose /__desktop/mode and Check for Updates
        let cfg = DesktopConfig::default();
        let mode_html = ui_pages::render_mode_choice_page(&cfg, None);
        let reconnect_html = ui_pages::render_reconnecting_page(&cfg, "");
        let unreachable_html = ui_pages::render_unreachable_page(&cfg, "");
        let pair_html = ui_pages::render_pair_page(&cfg, None);
        assert!(reconnect_html.contains("href=\"/__desktop/mode\""));
        assert!(reconnect_html.contains(".actions { display:flex;"));
        assert!(unreachable_html.contains("href=\"/__desktop/mode\""));
        assert!(pair_html.contains("data-testid=\"back-to-mode-choice\""));
        assert!(!pair_html.contains("id=\"serverHost\"\n          name=\"serverHost\"\n          value=\"\"\n          placeholder=\"server-ip:4180 or meshnet-host:4180\"\n          autocomplete=\"off\"\n          spellcheck=\"false\"\n          required"));
        for html in [&mode_html, &pair_html, &unreachable_html, &reconnect_html] {
            assert!(html.contains("data-testid=\"desktop-check-update-btn\""), "missing desktop-check-update-btn");
        }
    }
}
