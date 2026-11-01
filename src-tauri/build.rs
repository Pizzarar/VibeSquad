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
    println!("cargo:rerun-if-changed=certs/vibesquad-ca.crt");
    tauri_build::build()
}
