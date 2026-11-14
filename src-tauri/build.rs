fn main() {
    println!("cargo:rerun-if-env-changed=TERMLUME_TEST_WINDOWS_MANIFEST");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && std::env::var("TERMLUME_TEST_WINDOWS_MANIFEST").as_deref() == Ok("1")
    {
        // tauri-build embeds the app manifest in binaries, but not lib unit tests.
        // MockRuntime also links Tauri's Common Controls v6 imports.
        // Limit these flags to test invocations; the app keeps its normal resources.
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-test-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_macos_bridge();
    }
    tauri_build::build();
}

fn build_macos_bridge() {
    use std::{env, path::PathBuf, process::Command};

    let sources = ["src/touch_id.swift", "src/terminal_fonts.swift"];
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let target = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64-apple-macosx11.0",
        Ok("x86_64") => "x86_64-apple-macosx10.15",
        _ => panic!("Unsupported macOS architecture"),
    };
    for source in sources {
        println!("cargo:rerun-if-changed={source}");
    }
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
            "TermlumeMacOS",
        ])
        .arg("-module-cache-path")
        .arg(out.join("swift-cache"))
        .arg("-o")
        .arg(out.join("libtermlume_macos.a"))
        .args(sources)
        .status()
        .expect("Compile the macOS Swift bridge");
    assert!(status.success(), "Could not compile the macOS Swift bridge");
    let swift_libs = compiler.parent().unwrap().join("../lib/swift/macosx");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-search=native={}", swift_libs.display());
    println!("cargo:rustc-link-lib=static=termlume_macos");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
