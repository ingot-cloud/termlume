fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_touch_id();
    }
    tauri_build::build();
}

fn build_touch_id() {
    use std::{env, path::PathBuf, process::Command};

    let source = "src/touch_id.swift";
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let target = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64-apple-macosx11.0",
        Ok("x86_64") => "x86_64-apple-macosx10.15",
        _ => panic!("Unsupported macOS architecture"),
    };
    println!("cargo:rerun-if-changed={source}");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    let compiler = Command::new("xcrun")
        .args(["--sdk", "macosx", "--find", "swiftc"])
        .output()
        .expect("Locate the macOS Swift compiler");
    assert!(
        compiler.status.success(),
        "Install the Xcode Command Line Tools"
    );
    let compiler = PathBuf::from(String::from_utf8(compiler.stdout).unwrap().trim());
    let status = Command::new("xcrun")
        .args(["--sdk", "macosx", "swiftc"])
        .args([
            "-target",
            target,
            "-O",
            "-emit-library",
            "-static",
            "-module-name",
            "TermlumeTouchID",
        ])
        .arg("-module-cache-path")
        .arg(out.join("swift-cache"))
        .arg("-o")
        .arg(out.join("libtermlume_touch_id.a"))
        .arg(source)
        .status()
        .expect("Compile the macOS Touch ID bridge");
    assert!(
        status.success(),
        "Could not compile the macOS Touch ID bridge"
    );
    let swift_libs = compiler.parent().unwrap().join("../lib/swift/macosx");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-search=native={}", swift_libs.display());
    println!("cargo:rustc-link-lib=static=termlume_touch_id");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
