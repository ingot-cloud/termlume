use std::path::PathBuf;

#[cfg(any(target_os = "macos", windows))]
pub fn reveal_download(path: &std::path::Path) -> Result<(), String> {
    std::fs::symlink_metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "本机文件已移动或删除。".to_owned(),
        _ => format!("无法访问下载位置：{error}"),
    })?;
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open").arg("-R").arg(path)
            .status().map_err(crate::error)?;
        if !status.success() { return Err("无法在访达中显示下载文件。".into()); }
        Ok(())
    }
    #[cfg(windows)]
    windows::select_in_explorer(path)
}

pub struct GitTools {
    pub git: PathBuf,
    pub ssh: PathBuf,
    exec_path: Option<PathBuf>,
    search_path: Vec<PathBuf>,
}

#[cfg(any(windows, target_os = "macos"))]
static BUNDLED_RESOURCES: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

#[cfg(any(windows, target_os = "macos"))]
pub fn initialize_resources(directory: PathBuf) {
    let _ = BUNDLED_RESOURCES.set(directory);
}

#[cfg(any(windows, test))]
fn bundled_git_tools(resources: &std::path::Path) -> Result<GitTools, String> {
    let lock: serde_json::Value = serde_json::from_str(include_str!("../../scripts/windows-tools.lock.json")).map_err(crate::error)?;
    let root = resources.join("tools/windows");
    let missing = || "内置 Git/OpenSSH 组件缺失，请重新安装 Termlume。".to_owned();
    for package in lock["packages"].as_array().ok_or_else(missing)? {
        let id = package["id"].as_str().ok_or_else(missing)?;
        for required in package["required"].as_array().ok_or_else(missing)? {
            if !root.join(id).join(required.as_str().ok_or_else(missing)?).is_file() { return Err(missing()); }
        }
    }
    if !root.join("manifest.json").is_file() { return Err(missing()); }
    let layout = &lock["layout"];
    Ok(GitTools {
        git: root.join(layout["git"].as_str().ok_or_else(missing)?),
        ssh: root.join(layout["ssh"].as_str().ok_or_else(missing)?),
        exec_path: Some(root.join(layout["gitExec"].as_str().ok_or_else(missing)?)),
        search_path: layout["path"].as_array().ok_or_else(missing)?.iter()
            .map(|part| part.as_str().map(|part| root.join(part)).ok_or_else(missing)).collect::<Result<_, _>>()?,
    })
}

pub fn git_tools() -> Result<GitTools, String> {
    #[cfg(windows)]
    return bundled_git_tools(BUNDLED_RESOURCES.get().ok_or("内置工具路径尚未初始化。")?);
    #[cfg(target_os = "macos")]
    {
        #[cfg(test)]
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/macos");
        #[cfg(not(test))]
        let root = BUNDLED_RESOURCES.get().ok_or("内置工具路径尚未初始化。")?.join("tools/macos");
        if !root.join("bin/git").is_file() || !root.join("manifest.json").is_file() {
            return Err("内置 Git 组件缺失，请重新安装 Termlume。".into());
        }
        return Ok(GitTools { git: root.join("bin/git"), ssh: "/usr/bin/ssh".into(), exec_path: Some(root.join("bin")), search_path: vec![root.join("bin")] });
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    Ok(GitTools { git: "/usr/bin/git".into(), ssh: "/usr/bin/ssh".into(), exec_path: None, search_path: Vec::new() })
}

impl GitTools {
    pub fn configure(&self, command: &mut tokio::process::Command) -> Result<(), String> {
        if let Some(exec) = &self.exec_path {
            command.env("GIT_EXEC_PATH", exec).env("GIT_SSH_VARIANT", "ssh");
            let mut paths = self.search_path.clone();
            if let Some(existing) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&existing)); }
            command.env("PATH", std::env::join_paths(paths).map_err(crate::error)?);
        }
        Ok(())
    }
}

// GIT_SSH_COMMAND is interpreted by Git's shell, including Git for Windows.
// Quote the program path rather than interpolating it as shell code.
pub fn ssh_command(path: &std::path::Path) -> String {
    let program = path.to_string_lossy();
    #[cfg(windows)]
    let program = program.replace('\\', "/");
    let program = program.strip_prefix("//?/").unwrap_or(&program);
    let quoted = format!("'{}'", program.replace('\'', "'\"'\"'"));
    let options = if cfg!(target_os = "macos") { " -o UseKeychain=no -o AddKeysToAgent=no" } else { "" };
    format!("{quoted}{options} -o BatchMode=yes -o ForwardAgent=no -o StrictHostKeyChecking=yes -o ConnectTimeout=12")
}

#[cfg(any(windows, test))]
pub fn windows_file_name(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches([' ', '.']).to_uppercase();
    let device = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(prefix)
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")));
    if name.is_empty() || matches!(name, "." | "..") || name.ends_with([' ', '.']) || device
        || name.encode_utf16().count() > 255
        || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return Err("文件名不适用于 Windows 本机路径。".into());
    }
    Ok(())
}

#[cfg(windows)]
pub mod windows {
    use std::{os::windows::ffi::OsStrExt, path::Path, ptr};
    use windows_sys::Win32::{
        Foundation::{GlobalFree, HWND},
        Graphics::Gdi::*,
        Storage::FileSystem::MoveFileExW,
        System::{Com::*, DataExchange::*, Memory::*},
        UI::{Shell::ShellExecuteW, WindowsAndMessaging::*},
    };

    fn wide(value: &std::ffi::OsStr) -> Result<Vec<u16>, String> {
        let mut units: Vec<_> = value.encode_wide().collect();
        if units.contains(&0) { return Err("本机路径无效。".into()); }
        units.push(0);
        Ok(units)
    }

    pub fn publish_folder(source: &Path, target: &Path) -> Result<(), String> {
        // Canonical parents support extended-length Unicode paths. Flags=0
        // keeps publication on the same volume and refuses existing targets.
        let source = source.canonicalize().map_err(crate::error)?;
        let parent = target.parent().ok_or("下载目标路径无效。")?.canonicalize().map_err(crate::error)?;
        let target = parent.join(target.file_name().ok_or("下载目标路径无效。")?);
        let source = wide(source.as_os_str())?;
        let target = wide(target.as_os_str())?;
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
            return Err(crate::error(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    pub fn copy_text(value: &str) -> Result<(), String> {
        let text: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
        struct Clipboard { window: HWND, open: bool }
        impl Drop for Clipboard {
            fn drop(&mut self) { unsafe {
                if self.open { CloseClipboard(); }
                if !self.window.is_null() { DestroyWindow(self.window); }
            } }
        }
        // A real owner is required after EmptyClipboard; a message-only STATIC
        // window avoids opening a visible window or depending on the UI thread.
        let class = windows_sys::core::w!("STATIC");
        let window = unsafe { CreateWindowExW(0, class, ptr::null(), 0, 0, 0, 0, 0,
            HWND_MESSAGE, ptr::null_mut(), ptr::null_mut(), ptr::null()) };
        if window.is_null() { return Err("无法创建剪贴板所有者。".into()); }
        let mut owner = Clipboard { window, open: false };
        for _ in 0..10 {
            if unsafe { OpenClipboard(window) } != 0 { owner.open = true; break; }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !owner.open { return Err("系统剪贴板正忙，请重试。".into()); }
        let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, text.len() * 2) };
        if memory.is_null() { return Err("无法分配剪贴板内存。".into()); }
        let output = unsafe { GlobalLock(memory) }.cast::<u16>();
        if output.is_null() {
            unsafe { GlobalFree(memory); }
            return Err("无法写入系统剪贴板。".into());
        }
        unsafe {
            ptr::copy_nonoverlapping(text.as_ptr(), output, text.len());
            GlobalUnlock(memory);
            if EmptyClipboard() == 0 || SetClipboardData(13 /* CF_UNICODETEXT */, memory).is_null() {
                GlobalFree(memory);
                return Err("无法写入系统剪贴板。".into());
            }
        }
        // The system owns memory after successful SetClipboardData.
        Ok(())
    }

    pub fn font_families() -> Vec<String> {
        unsafe extern "system" fn collect(font: *const LOGFONTW, metrics: *const TEXTMETRICW, _: u32, context: isize) -> i32 {
            if font.is_null() || metrics.is_null() { return 1; }
            // GDI's FIXED_PITCH bit is inverted: set means variable pitch.
            if (*metrics).tmPitchAndFamily & TMPF_FIXED_PITCH != 0 { return 1; }
            let face = &(*font).lfFaceName;
            let end = face.iter().position(|c| *c == 0).unwrap_or(face.len());
            if let Ok(name) = String::from_utf16(&face[..end]) {
                if !name.starts_with('@') {
                    if let Ok(name) = crate::store::checked(&name, "字体", 240) {
                        (&mut *(context as *mut Vec<String>)).push(name);
                    }
                }
            }
            1
        }
        let mut names = Vec::new();
        unsafe {
            let dc = CreateCompatibleDC(ptr::null_mut());
            if dc.is_null() { return names; }
            let mut font: LOGFONTW = std::mem::zeroed();
            font.lfCharSet = DEFAULT_CHARSET;
            EnumFontFamiliesExW(dc, &font, Some(collect), &mut names as *mut Vec<String> as isize, 0);
            DeleteDC(dc);
        }
        names.sort_unstable(); names.dedup(); names
    }

    pub fn open_text_editor(file: &Path) -> Result<(), String> {
        let path = wide(file.as_os_str())?;
        let initialized = unsafe { CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32 | COINIT_DISABLE_OLE1DDE as u32) };
        let edited = if initialized >= 0 || initialized == -2147417850 /* RPC_E_CHANGED_MODE */ {
            // Only "edit": never "open", which could execute a .bat/.ps1 file.
            unsafe { ShellExecuteW(ptr::null_mut(), windows_sys::core::w!("edit"), path.as_ptr(),
                ptr::null(), ptr::null(), SW_SHOWNORMAL) as isize > 32 }
        } else { false };
        if initialized >= 0 { unsafe { CoUninitialize(); } }
        if edited { return Ok(()); }
        let system = std::env::var_os("SystemRoot").ok_or("无法找到记事本。")?;
        std::process::Command::new(Path::new(&system).join("System32/notepad.exe"))
            .arg(file).spawn().map_err(|_| "无法启动文本编辑器，请检查系统编辑器或记事本。".to_owned())?;
        Ok(())
    }

    pub fn select_in_explorer(file: &Path) -> Result<(), String> {
        use windows_sys::Win32::UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName};
        let path = wide(file.as_os_str())?;
        unsafe {
            let initialized = CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32);
            if initialized < 0 && initialized != windows_sys::Win32::Foundation::RPC_E_CHANGED_MODE {
                return Err("无法初始化资源管理器。".into());
            }
            let mut item = ptr::null_mut();
            let mut result = SHParseDisplayName(path.as_ptr(), ptr::null_mut(), &mut item, 0, ptr::null_mut());
            if result >= 0 {
                result = SHOpenFolderAndSelectItems(item, 0, ptr::null(), 0);
                CoTaskMemFree(item.cast());
            }
            if initialized >= 0 { CoUninitialize(); }
            if result < 0 { return Err("无法在资源管理器中显示下载文件。".into()); }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(target_os = "macos")]
    fn macos_git_does_not_require_xcode_command_line_tools() {
        let tools = git_tools().unwrap();
        assert!(tools.git.ends_with("vendor/macos/bin/git"));
        assert_ne!(tools.git, PathBuf::from("/usr/bin/git"));
        assert_eq!(tools.ssh, PathBuf::from("/usr/bin/ssh"));
        assert!(std::process::Command::new(tools.git).arg("--version").output().unwrap().status.success());
    }
    #[test]
    fn bundled_tools_resolve_from_resources_and_refuse_incomplete_bundles() {
        let directory = tempfile::tempdir().unwrap();
        let resources = directory.path().join("Termlume 中文 path with spaces");
        let runtime = resources.join("tools/windows");
        assert!(bundled_git_tools(&resources).is_err());
        let lock: serde_json::Value = serde_json::from_str(include_str!("../../scripts/windows-tools.lock.json")).unwrap();
        for package in lock["packages"].as_array().unwrap() {
            for name in package["required"].as_array().unwrap() {
                let path = runtime.join(package["id"].as_str().unwrap()).join(name.as_str().unwrap());
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, []).unwrap();
            }
        }
        std::fs::write(runtime.join("manifest.json"), "{}").unwrap();
        let tools = bundled_git_tools(&resources).unwrap();
        assert_eq!(tools.git, runtime.join("git/cmd/git.exe"));
        assert_eq!(tools.ssh, runtime.join("openssh/ssh.exe"));
        let mut command = tokio::process::Command::new(&tools.git);
        tools.configure(&mut command).unwrap();
        let env: std::collections::HashMap<_, _> = command.as_std().get_envs().map(|(k,v)| (k.to_owned(),v.unwrap().to_owned())).collect();
        let search: Vec<_> = std::env::split_paths(&env[std::ffi::OsStr::new("PATH")]).collect();
        assert_eq!(&search[..tools.search_path.len()], &tools.search_path);
        assert_eq!(env[std::ffi::OsStr::new("GIT_SSH_VARIANT")], "ssh");
        std::fs::remove_file(&tools.ssh).unwrap();
        assert!(bundled_git_tools(&resources).is_err());
    }
    #[test]
    fn windows_download_names_cannot_escape_or_address_devices() {
        for name in ["", ".", "..", "CON", "con.txt", "COM1.log", "Lpt²", "AUX .txt", "file:stream", "a\\b", "a/b", "trailing.", "trailing ", "a?b", "a\0b"] {
            assert!(windows_file_name(name).is_err(), "{name:?}");
        }
        for name in ["中文配置.json", "config.env", ".env", "COM10.txt", "console.log", "hello world.txt"] {
            assert!(windows_file_name(name).is_ok(), "{name:?}");
        }
    }
    #[test]
    #[cfg(unix)]
    fn git_ssh_program_paths_are_shell_quoted() {
        let command = ssh_command(std::path::Path::new("/tools/a b/'$(echo bad)`x`/ssh"));
        let output = std::process::Command::new("/bin/sh").args(["-c", &format!("set -- {command}; printf '%s' \"$1\"")]).output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "/tools/a b/'$(echo bad)`x`/ssh");
    }
    #[test]
    #[cfg(windows)]
    fn windows_folder_publication_keeps_existing_data_and_handles_unicode() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("临时副本");
        let target = dir.path().join("目标目录");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(source.join("中文.txt"), "new").unwrap();
        std::fs::write(target.join("keep.txt"), "keep").unwrap();
        assert!(windows::publish_folder(&source, &target).is_err());
        assert_eq!(std::fs::read_to_string(target.join("keep.txt")).unwrap(), "keep");
        assert!(source.join("中文.txt").exists());
        std::fs::remove_dir_all(&target).unwrap();
        windows::publish_folder(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read_to_string(target.join("中文.txt")).unwrap(), "new");
    }
}
