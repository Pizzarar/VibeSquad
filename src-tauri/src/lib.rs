#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    {
        tauri::Builder::default()
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_deep_link::init())
            .run(tauri::generate_context!())
            .expect("error while running VibeSquad Android application");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn android_config_uses_dist_remote_without_local_proxy_url_or_windows_runtime() {
        let raw = include_str!("../tauri.android.conf.json");
        let val: serde_json::Value = serde_json::from_str(raw).expect("valid tauri.android.conf.json");
        assert_eq!(val["build"]["frontendDist"], "../dist-remote");
        assert_eq!(val["build"]["beforeBuildCommand"], "npm run build:remote");
        assert_eq!(val["bundle"]["resources"], serde_json::json!([]));
        let win = &val["app"]["windows"][0];
        assert_eq!(win["label"], "main");
        assert!(win.get("url").is_none(), "Android window must not point to 127.0.0.1:4189");
    }
}
