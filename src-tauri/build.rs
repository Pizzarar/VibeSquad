use std::{fs, path::Path};

fn main() {
    // certs/vibesquad-ca.crt is generated locally (git-ignored); a clean checkout builds with an empty
    // placeholder and the app loads ~/.vibesquad/tls/ca.crt at runtime instead.
    let certs = Path::new("certs");
    let ca = certs.join("vibesquad-ca.crt");
    if !ca.exists() {
        let _ = fs::create_dir_all(certs);
        let _ = fs::write(&ca, b"");
    }
    // runtime/ is staged by server/build-desktop.mjs (git-ignored); tauri.conf.json bundles it as a resource,
    // so a clean checkout needs the directory to exist for cargo check / cargo test.
    let runtime = Path::new("runtime");
    if !runtime.exists() {
        let _ = fs::create_dir_all(runtime);
    }
    let has_entries = fs::read_dir(runtime).map(|mut d| d.next().is_some()).unwrap_or(false);
    if !has_entries {
        let _ = fs::write(runtime.join(".placeholder"), b"populated by server/build-desktop.mjs
");
    }
    println!("cargo:rerun-if-changed=certs/vibesquad-ca.crt");
    tauri_build::build()
}
