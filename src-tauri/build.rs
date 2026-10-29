fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");

    // Stage the CLI binary so tauri_build can validate it and NSIS bundles it.
    // During `tauri build`, `beforeBuildCommand` runs `cargo build --release --bin paperlike`
    // first, so target/release/paperlike.exe is already built when this script runs in the
    // subsequent main-binary build and gets copied into resources/.
    // For `cargo check`, neither exists yet; a zero-byte placeholder satisfies tauri_build.
    let res = std::path::Path::new("resources");
    std::fs::create_dir_all(res).ok();
    let staged = res.join("paperlike.exe");
    let release = std::path::Path::new("target/release/paperlike.exe");
    if release.exists() {
        let _ = std::fs::copy(release, &staged);
    } else if !staged.exists() {
        let _ = std::fs::write(&staged, b"");
    }

    tauri_build::build()
}
