use crate::{error, verified, Workspace};
use semver::Version;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio_util::sync::CancellationToken;

const LATEST: &str = "https://github.com/ingot-cloud/termlume/releases/latest";
const MAX_DOWNLOAD: u64 = 600 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    revision: u64,
    current_version: String,
    phase: String,
    version: Option<String>,
    notes: String,
    message: String,
    downloaded: u64,
    total: Option<u64>,
    can_download: bool,
    checked_at: Option<u64>,
}
struct Inner {
    status: Snapshot,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    cancel: CancellationToken,
}
pub struct Updates {
    inner: Mutex<Inner>,
    operation: tokio::sync::Mutex<()>,
    installing: AtomicBool,
}
impl Updates {
    pub fn new(version: String) -> Self {
        // reqwest 0.13 deliberately does not pick a provider for rustls-no-provider.
        // Both release discovery and Tauri's downloader use this explicit provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
        Self {
            inner: Mutex::new(Inner {
                status: Snapshot {
                    revision: 0,
                    current_version: version,
                    phase: "idle".into(),
                    version: None,
                    notes: String::new(),
                    message: "从 GitHub Release 获取正式版本。".into(),
                    downloaded: 0,
                    total: None,
                    can_download: false,
                    checked_at: None,
                },
                update: None,
                bytes: None,
                cancel: CancellationToken::new(),
            }),
            operation: Default::default(),
            installing: AtomicBool::new(false),
        }
    }
    pub fn installing(&self) -> bool {
        self.installing.load(Ordering::SeqCst)
    }
    fn snapshot(&self) -> Value {
        json!(self.inner.lock().unwrap().status)
    }
    fn change(&self, ws: &Workspace, phase: &str, message: &str) {
        let state = {
            let mut inner = self.inner.lock().unwrap();
            inner.status.phase = phase.into();
            inner.status.message = message.into();
            inner.status.revision += 1;
            json!(inner.status)
        };
        ws.emit(json!({"type":"update","state":state}));
    }
}

fn release_version(url: &url::Url) -> Result<Version, String> {
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("更新地址无效。".into());
    }
    let tag = url
        .path()
        .strip_prefix("/ingot-cloud/termlume/releases/tag/v")
        .ok_or("无法读取 GitHub 最新版本。")?;
    let version = Version::parse(tag).map_err(|_| "GitHub 版本号无效。")?;
    if !version.pre.is_empty() || !version.build.is_empty() || version.to_string() != tag {
        return Err("更新地址不是正式版本。".into());
    }
    Ok(version)
}
fn target() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("macos-arm64"),
        ("windows", "x86_64") => Ok("windows-x64"),
        _ => Err("当前平台暂无自动更新安装包。".into()),
    }
}
fn asset_url(url: &url::Url, version: &str, platform: &str) -> bool {
    let suffix = if platform == "macos-arm64" {
        "macOS-arm64.app.tar.gz"
    } else {
        "Windows-x64-setup.exe"
    };
    url.as_str() == format!("https://github.com/ingot-cloud/termlume/releases/download/v{version}/Termlume-{version}-{suffix}")
}

async fn check(window: &WebviewWindow, ws: &Workspace, state: &Updates) -> Result<(), String> {
    target()?;
    {
        let mut inner = state.inner.lock().unwrap();
        if inner.bytes.is_some() {
            return Ok(());
        }
        inner.update = None;
        inner.status.can_download = false;
        inner.status.version = None;
        inner.status.notes.clear();
        inner.status.downloaded = 0;
        inner.status.total = None;
    }
    state.change(ws, "checking", "正在检查 GitHub Release…");
    // HEAD avoids the unauthenticated GitHub API's small hourly quota. Older
    // releases without latest.json can still be identified correctly.
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("Termlume/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(error)?
        .head(LATEST)
        .send()
        .await
        .map_err(|_| "无法连接 GitHub，请检查网络后重试。")?
        .error_for_status()
        .map_err(|_| "GitHub 暂时无法提供版本信息，请稍后重试。")?;
    let latest = release_version(response.url())?;
    let current =
        Version::parse(&state.inner.lock().unwrap().status.current_version).map_err(error)?;
    {
        let mut inner = state.inner.lock().unwrap();
        inner.status.version = Some(latest.to_string());
        inner.status.checked_at = Some(crate::now());
    }
    if latest <= current {
        state.change(ws, "current", "当前已是最新版本。");
        return Ok(());
    }
    let candidate = window
        .app_handle()
        .updater_builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(error)?
        .check()
        .await;
    let mut update = match candidate {
        Ok(Some(update)) => update,
        Ok(None) | Err(_) => {
            state.change(ws, "pending", "发现新版本，更新包尚未就绪，请稍后重试。");
            return Ok(());
        }
    };
    let version = Version::parse(&update.version).map_err(error)?;
    if version < latest
        || version <= current
        || !version.pre.is_empty()
        || !version.build.is_empty()
        || !asset_url(&update.download_url, &update.version, target()?)
    {
        return Err("发布的更新信息不匹配，已停止更新。".into());
    }
    update.timeout = Some(Duration::from_secs(30 * 60));
    {
        let mut inner = state.inner.lock().unwrap();
        inner.status.version = Some(update.version.clone());
        inner.status.notes = update.body.clone().unwrap_or_default();
        inner.status.can_download = true;
        inner.update = Some(update);
    }
    state.change(ws, "available", "发现新版本，可以下载更新。");
    Ok(())
}

async fn download(ws: &Workspace, state: &Updates) -> Result<(), String> {
    let (update, cancel) = {
        let mut inner = state.inner.lock().unwrap();
        if inner.bytes.is_some() {
            return Ok(());
        }
        let update = inner.update.clone().ok_or("请先检查更新。")?;
        inner.cancel = CancellationToken::new();
        inner.status.downloaded = 0;
        inner.status.total = None;
        (update, inner.cancel.clone())
    };
    state.change(ws, "downloading", "正在下载更新…");
    let mut last = Instant::now();
    let mut too_large = false;
    let transfer = update.download(
        |chunk, total| {
            let mut inner = state.inner.lock().unwrap();
            inner.status.downloaded += chunk as u64;
            inner.status.total = total;
            inner.status.revision += 1;
            if total.is_some_and(|size| size > MAX_DOWNLOAD)
                || inner.status.downloaded > MAX_DOWNLOAD
            {
                too_large = true;
                cancel.cancel();
            }
            if last.elapsed() >= Duration::from_millis(150) {
                ws.emit(json!({"type":"update","state":inner.status}));
                last = Instant::now();
            }
        },
        || state.change(ws, "verifying", "下载完成，正在验证更新签名…"),
    );
    let result = tokio::select! { biased;
        _ = cancel.cancelled() => None,
        result = transfer => Some(result),
    };
    match result {
        None => {
            if too_large {
                return Err("更新包大小超过允许范围，已停止下载。".into());
            }
            state.change(ws, "available", "下载已取消，可以重新下载。");
        }
        Some(Ok(bytes)) => {
            state.inner.lock().unwrap().bytes = Some(bytes);
            state.change(
                ws,
                "ready",
                "签名验证通过。关闭 SSH 会话和文件编辑器后即可重启安装。",
            );
        }
        Some(Err(_)) => return Err("下载或签名验证失败，未修改当前 App。请重试。".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn update_request(
    window: WebviewWindow,
    workspace: State<'_, Workspace>,
    updates: State<'_, Updates>,
    action: String,
) -> Result<Value, String> {
    verified(&window)?;
    let state = &*updates;
    let ws = &*workspace;
    if action == "status" {
        return Ok(state.snapshot());
    }
    if action == "cancel" {
        state.inner.lock().unwrap().cancel.cancel();
        return Ok(state.snapshot());
    }
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "更新操作正在进行，请稍候。")?;
    let result = match action.as_str() {
        "check" => check(&window, ws, state).await,
        "download" => download(ws, state).await,
        "install" => {
            let _requests = ws
                .request_gate
                .try_write()
                .map_err(|_| "有操作正在进行，请完成后再安装更新。")?;
            let _sync = ws
                .sync_gate
                .try_lock()
                .map_err(|_| "Git 同步正在进行，请稍后安装更新。")?;
            if ws.connections.has_active()
                || ws.transfers.has_active()
                || ws.editors.list().as_array().is_some_and(|v| !v.is_empty())
                || ws.forwards.list().as_array().is_some_and(|v| !v.is_empty())
            {
                return Err(
                    "请先关闭 SSH 会话、文件编辑器和端口转发，并等待传输完成，再安装更新。".into(),
                );
            }
            let (update, bytes) = {
                let mut inner = state.inner.lock().unwrap();
                let update = inner.update.clone().ok_or("请先下载更新。")?;
                let bytes = inner.bytes.take().ok_or("请先下载更新。")?;
                (update, bytes)
            };
            state.installing.store(true, Ordering::SeqCst);
            state.change(ws, "installing", "正在安装更新，Termlume 将自动重启…");
            let result =
                match tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await {
                    Ok(result) => result.map_err(error),
                    Err(join) => Err(error(join)),
                };
            if result.is_ok() {
                window.app_handle().restart();
            }
            state.installing.store(false, Ordering::SeqCst);
            result
        }
        _ => Err("更新操作无效。".into()),
    };
    if let Err(ref message) = result {
        state.change(ws, "error", message);
    }
    result.map(|_| state.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_release_redirect_must_identify_a_canonical_stable_release_in_our_repository() {
        assert_eq!(
            release_version(&LATEST.parse().unwrap()).unwrap_err(),
            "无法读取 GitHub 最新版本。"
        );
        assert_eq!(
            release_version(
                &"https://github.com/ingot-cloud/termlume/releases/tag/v0.2.2"
                    .parse()
                    .unwrap()
            )
            .unwrap(),
            Version::new(0, 2, 2)
        );
        for value in [
            "http://github.com/ingot-cloud/termlume/releases/tag/v1.0.0",
            "https://evil.com/ingot-cloud/termlume/releases/tag/v1.0.0",
            "https://github.com/other/repo/releases/tag/v1.0.0",
            "https://github.com/ingot-cloud/termlume/releases/tag/v1.0.0-beta.1",
            "https://github.com/ingot-cloud/termlume/releases/tag/v1.0.0?source=evil",
            "https://user@github.com/ingot-cloud/termlume/releases/tag/v1.0.0",
            "https://github.com/ingot-cloud/termlume/releases/tag/v01.0.0",
        ] {
            assert!(release_version(&value.parse().unwrap()).is_err(), "{value}");
        }
    }
    #[test]
    fn only_the_versioned_native_installer_from_our_release_is_accepted() {
        let url = "https://github.com/ingot-cloud/termlume/releases/download/v0.2.3/Termlume-0.2.3-macOS-arm64.app.tar.gz";
        assert!(asset_url(&url.parse().unwrap(), "0.2.3", "macos-arm64"));
        assert!(!asset_url(&url.parse().unwrap(), "0.2.4", "macos-arm64"));
        assert!(!asset_url(&url.parse().unwrap(), "0.2.3", "windows-x64"));
        assert!(!asset_url(
            &format!("{url}?redirect=evil").parse().unwrap(),
            "0.2.3",
            "macos-arm64"
        ));
    }

    fn fixture() -> (
        tauri::App<tauri::test::MockRuntime>,
        tempfile::TempDir,
        Update,
        Vec<u8>,
    ) {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let fixture: Value =
            serde_json::from_str(include_str!("../../test/fixtures/signed-update.json")).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("Fixture.app/Contents/MacOS/termlume");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, "previous fixture executable").unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.package_info_mut().version = Version::new(0, 2, 2);
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({
                "pubkey":fixture["publicKey"], "requireSignedVersion":true,
                "dangerousInsecureTransportProtocol":true,
                "endpoints":["https://example.invalid/latest.json"]
            }),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app
            .updater_builder()
            .executable_path(&executable)
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let update = updater.restore_update(json!({"version":"0.2.3","url":"https://example.invalid/fixture.tar.gz","signature":fixture["signature"]})).unwrap().unwrap();
        let bytes = STANDARD
            .decode(fixture["archive"].as_str().unwrap())
            .unwrap();
        (app, directory, update, bytes)
    }

    #[test]
    fn signed_fixture_is_verified_and_a_forged_version_or_payload_is_rejected() {
        let (_app, _directory, mut update, bytes) = fixture();
        update.verify(&bytes).unwrap();
        assert!(update.install(b"tampered update").is_err());
        update.version = "9.9.9".into();
        assert!(update.verify(&bytes).is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn signed_update_replaces_only_the_isolated_app_and_preserves_executable_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (_app, directory, update, bytes) = fixture();
        std::fs::write(directory.path().join("user-workspace"), "preserved").unwrap();
        update.install(&bytes).unwrap();
        let executable = directory.path().join("Fixture.app/Contents/MacOS/termlume");
        assert_eq!(
            std::fs::read_to_string(&executable).unwrap(),
            "updated fixture executable\n"
        );
        assert_ne!(
            std::fs::metadata(&executable).unwrap().permissions().mode() & 0o111,
            0
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("user-workspace")).unwrap(),
            "preserved"
        );
    }

    #[tokio::test]
    async fn downloading_verifies_bytes_before_the_update_becomes_installable() {
        use std::io::{Read, Write};
        let (_app, directory, mut update, bytes) = fixture();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        update.download_url = format!("http://{}/fixture.tar.gz", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let expected = bytes.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            stream.write_all(&bytes).unwrap();
        });
        let ws = Workspace::new(
            directory.path().join("workspace"),
            directory.path().join("home"),
            None,
        )
        .unwrap();
        let state = Updates::new("0.2.2".into());
        state.inner.lock().unwrap().update = Some(update);
        download(&ws, &state).await.unwrap();
        server.join().unwrap();
        assert_eq!(state.snapshot()["phase"], "ready");
        assert_eq!(state.inner.lock().unwrap().bytes.as_ref(), Some(&expected));
    }

    #[tokio::test]
    async fn cancelling_an_actual_download_keeps_the_current_app_and_allows_retry() {
        use std::io::{Read, Write};
        let (_app, directory, mut update, bytes) = fixture();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        update.download_url = format!("http://{}/fixture.tar.gz", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(150));
            let _ = stream.write_all(&bytes);
        });
        let ws = Workspace::new(
            directory.path().join("workspace"),
            directory.path().join("home"),
            None,
        )
        .unwrap();
        let state = std::sync::Arc::new(Updates::new("0.2.2".into()));
        state.inner.lock().unwrap().update = Some(update);
        let cancellation = state.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancellation.inner.lock().unwrap().cancel.cancel();
        });
        download(&ws, &state).await.unwrap();
        task.await.unwrap();
        server.join().unwrap();
        assert_eq!(state.snapshot()["phase"], "available");
        assert!(state.inner.lock().unwrap().bytes.is_none());
        assert!(state.inner.lock().unwrap().update.is_some());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("Fixture.app/Contents/MacOS/termlume"))
                .unwrap(),
            "previous fixture executable"
        );
    }
}
