mod resume;
use resume::Checkpoint;
use std::sync::atomic::Ordering;
use crate::{
    error,
    ssh::{file_name, remote_path, require_success, Session},
    Workspace,
};
use russh::{client, Channel};
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession, SftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

async fn sftp_channel(session: &Session) -> Result<Channel<client::Msg>, String> {
    let client = session.client.get().ok_or("请先连接 SSH。")?;
    if session.cancel.is_cancelled() {
        return Err("SSH 会话已断开。".into());
    }
    let mut channel = client.channel_open_session().await.map_err(error)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(error)?;
    require_success(&mut channel, "SFTP").await?;
    Ok(channel)
}

async fn open(session: &Session) -> Result<SftpSession, String> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let channel = sftp_channel(session).await?;
        SftpSession::new(channel.into_stream()).await.map_err(error)
    })
    .await
    .map_err(|_| "打开 SFTP 会话超时。")?
}

pub async fn list(session: &Session, path: &str) -> Result<Value, String> {
    let sftp = open(session).await?;
    let path = if path.is_empty() {
        ".".into()
    } else {
        remote_path(path)?
    };
    let directory = remote_path(&sftp.canonicalize(path).await.map_err(error)?)?;
    let mut entries = Vec::new();
    for entry in sftp.read_dir(&directory).await.map_err(error)? {
        let name = entry.file_name();
        if file_name(&name).is_err() {
            continue;
        }
        let metadata = entry.metadata();
        let kind = if metadata.file_type().is_dir() {
            "directory"
        } else if metadata.file_type().is_file() {
            "file"
        } else {
            "other"
        };
        entries.push((kind != "directory", name, metadata.size.unwrap_or(0), kind));
    }
    entries.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });
    let entries: Vec<_> = entries
        .into_iter()
        .map(|(_, name, size, kind)| json!({"name":name,"size":size,"kind":kind}))
        .collect();
    Ok(json!({"directory":directory,"entries":entries}))
}
pub async fn mkdir(session: &Session, directory: &str, name: &str) -> Result<(), String> {
    let path = remote_join(&remote_path(directory)?, file_name(name)?);
    open(session).await?.create_dir(path).await.map_err(error)
}

pub async fn create_file(session: &Session, directory: &str, name: &str) -> Result<(), String> {
    let path = remote_join(&remote_path(directory)?, file_name(name)?);
    let sftp = open(session).await?;
    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(0o600);
    sftp.open_with_flags_and_attributes(
        path,
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
        attrs,
    )
    .await
    .map_err(error)?
    .close()
    .await
    .map_err(error)
}

pub async fn inspect_path(session: &Session, path: &str) -> Result<Value, String> {
    let path = remote_path(path)?;
    let sftp = open(session).await?;
    let attrs = sftp.symlink_metadata(&path).await.map_err(error)?;
    let kind_on_disk = attrs.file_type();
    let directory = kind_on_disk.is_dir()
        || (kind_on_disk.is_symlink()
            && sftp
                .metadata(&path)
                .await
                .is_ok_and(|target| target.file_type().is_dir()));
    let kind = if directory {
        "directory"
    } else if kind_on_disk.is_file() {
        "file"
    } else {
        "other"
    };
    Ok(
        json!({ "kind": kind, "path": path, "downloadable": kind_on_disk.is_dir() || kind_on_disk.is_file() }),
    )
}

fn remote_join(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

fn local_name(name: &str) -> Result<&str, String> {
    file_name(name)?;
    #[cfg(windows)]
    crate::platform::windows_file_name(name)?;
    let mut parts = Path::new(name).components();
    if !matches!(parts.next(), Some(Component::Normal(part)) if part == name)
        || parts.next().is_some()
    {
        return Err("文件名不能用作本机路径。".into());
    }
    Ok(name)
}

#[derive(Deserialize)]
pub struct PrepareRequest {
    pub id: Uuid,
    direction: String,
    directory: String,
    #[serde(default)]
    names: Option<Vec<String>>,
    #[serde(rename = "dropTicket")]
    drop_ticket: Option<Uuid>,
    #[serde(default)]
    folder: bool,
    #[serde(default, rename = "chooseDirectory")]
    choose_directory: bool,
}

fn writable_download_directory(path: &Path) -> bool {
    // Recheck the canonical path so a moved folder replaced by a symlink
    // cannot silently redirect a remembered download.
    path.is_absolute() && std::fs::canonicalize(path).is_ok_and(|actual| actual == path)
        && tempfile::Builder::new().prefix(".termlume-check-").tempfile_in(path).is_ok()
}
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Skip,
    Keep,
    Replace,
}

#[derive(Clone)]
struct File {
    session: Arc<Session>,
    upload: bool,
    local: PathBuf,
    remote: String,
    size: u64,
    original: Option<Stat>,
    permissions: Option<u32>,
    editor_upload: bool,
    folder: Option<Arc<DownloadFolder>>,
}
impl File {
    fn target(&self) -> String {
        if self.upload {
            self.remote.clone()
        } else {
            self.local.to_string_lossy().into_owned()
        }
    }
}

#[derive(Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
struct DownloadFolder {
    root: String,
    entries: Vec<FolderEntry>,
    skipped: usize,
}

#[derive(Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
struct FolderEntry {
    local: PathBuf,
    remote: String,
    size: Option<u64>,
    source: Option<Stat>,
}

async fn scan_folder(
    sftp: &SftpSession,
    path: &str,
    remaining: &mut usize,
    cancel: &CancellationToken,
) -> Result<(DownloadFolder, u64), String> {
    if !cfg!(any(target_os = "macos", target_os = "linux", windows)) {
        return Err("此平台暂不支持下载整个目录。".into());
    }
    let root = remote_path(&sftp.canonicalize(path).await.map_err(error)?)?;
    let mut pending = vec![(root.clone(), PathBuf::new())];
    let mut entries = Vec::new();
    let mut skipped = 0;
    let mut total = 0_u64;
    while let Some((remote, local)) = pending.pop() {
        if cancel.is_cancelled() {
            return Err("SSH 会话已断开。".into());
        }
        if sftp.canonicalize(&remote).await.map_err(error)? != remote {
            return Err("远端目录已变化，请重新选择。".into());
        }
        for entry in sftp.read_dir(&remote).await.map_err(error)? {
            *remaining = remaining
                .checked_sub(1)
                .ok_or("每次最多可扫描 1000 个目录项目。")?;
            let name = entry.file_name();
            let metadata = entry.metadata();
            let kind = metadata.file_type();
            if local_name(&name).is_err() || (!kind.is_dir() && !kind.is_file()) {
                skipped += 1;
                continue;
            }
            let child = remote_path(&remote_join(&remote, &name))?;
            let relative = local.join(name);
            let size = if kind.is_dir() {
                pending.push((child.clone(), relative.clone()));
                None
            } else {
                let size = metadata.size.unwrap_or(0);
                total = total.checked_add(size).ok_or("目录内容超出可传输大小。")?;
                Some(size)
            };
            entries.push(FolderEntry {
                source: size.map(|_| remote_stat(metadata)),
                local: relative,
                remote: child,
                size,
            });
        }
    }
    entries.sort_by(|a, b| a.local.cmp(&b.local));
    Ok((
        DownloadFolder {
            root,
            entries,
            skipped,
        },
        total,
    ))
}
async fn scan_upload_folder(
    root: &Path,
    remaining: &mut usize,
    cancel: &CancellationToken,
) -> Result<(DownloadFolder, u64), String> {
    let canonical = fs::canonicalize(root).await.map_err(error)?;
    if !fs::symlink_metadata(root).await.map_err(error)?.is_dir() {
        return Err("请选择普通目录。".into());
    }
    let mut pending = vec![(root.to_path_buf(), PathBuf::new(), 0usize)];
    let mut entries = Vec::new();
    let mut total = 0u64;
    let mut skipped = 0;
    while let Some((directory, relative, depth)) = pending.pop() {
        if cancel.is_cancelled() {
            return Err("SSH 会话已断开。".into());
        }
        if depth > 32
            || fs::canonicalize(&directory).await.map_err(error)? != canonical.join(&relative)
        {
            return Err("目录层数过深或路径已变化。".into());
        }
        let mut read = fs::read_dir(&directory).await.map_err(error)?;
        let mut children = Vec::new();
        while let Some(entry) = read.next_entry().await.map_err(error)? {
            children.push(entry.path());
        }
        children.sort();
        let mut subdirs = Vec::new();
        for path in children {
            if *remaining == 0 {
                return Err("目录超过 1000 项，请拆分上传。".into());
            }
            *remaining -= 1;
            let name = path
                .file_name()
                .and_then(|p| p.to_str())
                .ok_or("文件名不是有效 Unicode。")?;
            file_name(name)?;
            let child = relative.join(name);
            let attrs = fs::symlink_metadata(&path).await.map_err(error)?;
            if attrs.is_symlink() {
                skipped += 1;
                continue;
            }
            if attrs.is_dir() {
                entries.push(FolderEntry {
                    local: child.clone(),
                    remote: String::new(),
                    size: None,
                    source: None,
                });
                subdirs.push((path, child, depth + 1));
            } else if attrs.is_file() {
                let stat = local_stat(attrs);
                total = total.checked_add(stat.size).ok_or("目录过大。")?;
                entries.push(FolderEntry {
                    local: child,
                    remote: String::new(),
                    size: Some(stat.size),
                    source: Some(stat),
                });
            } else {
                skipped += 1;
            }
        }
        pending.extend(subdirs.into_iter().rev());
    }
    entries.sort_by(|a, b| a.local.cmp(&b.local));
    Ok((
        DownloadFolder {
            root: canonical.to_string_lossy().into_owned(),
            entries,
            skipped,
        },
        total,
    ))
}

#[derive(Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
struct Stat {
    regular: bool,
    size: u64,
    version: String,
}
fn remote_stat(attrs: FileAttributes) -> Stat {
    Stat {
        regular: attrs.file_type().is_file(),
        size: attrs.size.unwrap_or(0),
        version: format!("{:?}:{:?}", attrs.permissions, attrs.mtime),
    }
}
fn local_stat(attrs: std::fs::Metadata) -> Stat {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Stat {
            regular: attrs.is_file(),
            size: attrs.len(),
            version: format!(
                "{}:{}:{}:{}:{}",
                attrs.dev(),
                attrs.ino(),
                attrs.mode(),
                attrs.mtime(),
                attrs.mtime_nsec()
            ),
        }
    }
    #[cfg(not(unix))]
    {
        Stat {
            regular: attrs.is_file(),
            size: attrs.len(),
            version: format!("{:?}", attrs.modified()),
        }
    }
}
async fn local_target(path: &Path) -> Result<Option<Stat>, String> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(local_stat(metadata))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(error(e)),
    }
}
async fn remote_target(sftp: &SftpSession, path: &str) -> Result<Option<Stat>, String> {
    match sftp.symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(remote_stat(metadata))),
        Err(SftpError::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(e) => Err(error(e)),
    }
}
async fn target(sftp: &SftpSession, file: &File) -> Result<Option<Stat>, String> {
    if file.upload {
        remote_target(sftp, &file.remote).await
    } else {
        local_target(&file.local).await
    }
}

struct Ticket {
    files: Vec<File>,
    time: Instant,
    chosen_directory: Option<PathBuf>,
}
struct DroppedFiles {
    ticket: Uuid,
    paths: Vec<PathBuf>,
    time: Instant,
}
struct Job {
    id: Uuid,
    file: File,
    policy: Policy,
    cancel: CancellationToken,
    done: Notify,
    pause: CancellationToken,
    checkpoint: Option<Checkpoint>,
    discard: bool,
    last_event: Mutex<Value>,
    status: Mutex<&'static str>,
}
#[derive(Default)]
struct Queue {
    jobs: HashMap<Uuid, Arc<Job>>,
    order: VecDeque<Arc<Job>>,
    cleaning: std::collections::HashSet<Uuid>,
    draining: bool,
}
#[derive(Default)]
pub struct Transfers {
    tickets: Mutex<HashMap<Uuid, Ticket>>,
    drop: Mutex<Option<DroppedFiles>>,
    queue: Mutex<Queue>,
    pending_history: Mutex<Vec<Value>>,
}

const HISTORY_LIMIT: usize = 200;

impl Transfers {
    pub fn has_active(&self) -> bool {
        self.queue.lock().unwrap().jobs.values().any(|j| matches!(*j.status.lock().unwrap(), "queued" | "running" | "verifying" | "committing"))
    }
    pub fn active_session(&self, id: Uuid) -> bool {
        self.queue.lock().unwrap().jobs.values().any(|j| {
            j.file.session.id == id
                && matches!(
                    *j.status.lock().unwrap(),
                    "queued" | "running" | "verifying" | "committing"
                )
        })
    }
    pub fn history(&self, ws: &Workspace) -> Result<Vec<Value>, String> {
        self.edit_history(ws, |_| ())
    }

    pub fn record_for_location(&self, ws: &Workspace, id: Uuid) -> Result<Value, String> {
        {
            let queue = self.queue.lock().unwrap();
            let store = ws.store.lock().unwrap();
            let data = store.data()?;
            if let Some(job) = queue.jobs.get(&id) {
                let event = job.last_event.lock().unwrap();
                if !event.is_null() && event.get("finishedAt").is_none() {
                    return Ok(event.clone());
                }
            }
            if let Some(point) = data.transfer_checkpoints.get(&id) {
                return Ok(json!({"local":point["local"], "remote":point["remote"], "route":point["route"]}));
            }
        }
        self.history(ws)?.into_iter().find(|row| row["id"] == json!(id))
            .ok_or_else(|| "找不到这条传输记录。".into())
    }

    fn check_record_host(ws: &Workspace, record: &Value, session: &Session, legacy_host: Option<Uuid>) -> Result<(), String> {
        session.check_route(ws.store.lock().unwrap().data()?)?;
        if let Some(route) = record.get("route") {
            if route != &session.transfer_route() {
                return Err("原主机的连接目标或指纹已变化，请核对主机配置。".into());
            }
        } else if legacy_host != Some(session.host.id) {
            return Err("请为旧记录明确选择此次要连接的主机。".into());
        }
        Ok(())
    }

    pub fn remote_location(&self, ws: &Workspace, id: Uuid, session: &Session, legacy_host: Option<Uuid>) -> Result<Value, String> {
        let mut record = self.record_for_location(ws, id)?;
        Self::check_record_host(ws, &record, session, legacy_host)?;
        let path = remote_path(record["remote"].as_str().ok_or("记录缺少远端路径。")?)?;
        if record.get("route").is_none() {
            let id = json!(id);
            let records = self.edit_history(ws, |records| {
                if let Some(row) = records.iter_mut().find(|row| row["id"] == id && row.get("route").is_none()) {
                    row["route"] = session.transfer_route();
                }
            })?;
            record = records.into_iter().find(|row| row["id"] == id).ok_or("这条传输记录已删除。")?;
            Self::check_record_host(ws, &record, session, None)?;
        }
        Ok(json!({"path":path, "route":record["route"]}))
    }

    #[cfg(any(target_os = "macos", windows))]
    pub fn download_location(&self, ws: &Workspace, id: Uuid) -> Result<PathBuf, String> {
        let id = json!(id);
        self.history(ws)?.iter()
            .find(|record| record["id"] == id && record["direction"] == "down" && record["status"] == "done")
            .and_then(|record| record["local"].as_str())
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| "找不到这条已完成的下载记录。".into())
    }

    pub fn remove_history(&self, ws: &Workspace, id: Option<Uuid>) -> Result<Vec<Value>, String> {
        let id = id.map(|id| json!(id));
        let mut removed = Vec::new();
        self.edit_history(ws, |records| {
            records.retain(|record| {
                let remove = id.as_ref().is_none_or(|id| id == &record["id"]);
                if remove {
                    removed.push(record["id"].clone());
                }
                !remove
            });
        })?;
        let mut queue = self.queue.lock().unwrap();
        for row in &removed {
            if let Ok(id) = crate::id(row) { queue.jobs.remove(&id); }
        }
        Ok(removed)
    }

    fn edit_history(
        &self,
        ws: &Workspace,
        edit: impl FnOnce(&mut Vec<Value>),
    ) -> Result<Vec<Value>, String> {
        let mut store = ws.store.lock().unwrap();
        let mut pending = self.pending_history.lock().unwrap();
        let data = store.data()?;
        let mut records = data.transfer_history.clone();
        records.extend(pending.iter().cloned());
        edit(&mut records);
        records.drain(..records.len().saturating_sub(HISTORY_LIMIT));
        if records != data.transfer_history || pending.iter().any(|row| crate::id(&row["id"]).is_ok_and(|id| data.transfer_checkpoints.contains_key(&id))) {
            let mut data = data.clone();
            for event in pending.iter() {
                if let Ok(id) = crate::id(&event["id"]) { data.transfer_checkpoints.remove(&id); }
            }
            data.transfer_history = records.clone();
            store.update(data)?;
        }
        pending.clear();
        Ok(records)
    }

    fn record(&self, ws: &Workspace, event: &Value) {
        {
            let mut pending = self.pending_history.lock().unwrap();
            if pending.len() == HISTORY_LIMIT {
                pending.remove(0);
            }
            pending.push(event.clone());
        }
        // A transfer can finish while the vault is locked. Retry on the next history read.
        let _ = self.history(ws);
    }

    pub fn capture_drop(&self, paths: Vec<PathBuf>) -> Uuid {
        let ticket = Uuid::new_v4();
        *self.drop.lock().unwrap() = Some(DroppedFiles {
            ticket,
            paths,
            time: Instant::now(),
        });
        ticket
    }

    pub fn clear_drop(&self) {
        self.drop.lock().unwrap().take();
    }

    pub async fn prepare(
        &self,
        ws: &Workspace,
        session: Arc<Session>,
        request: PrepareRequest,
    ) -> Result<Value, String> {
        let upload = match request.direction.as_str() {
            "up" => true,
            "down" => false,
            _ => return Err("请选择上传或下载。".into()),
        };
        let directory = remote_path(&request.directory)?;
        if !upload && request.drop_ticket.is_some() {
            return Err("拖入的本机文件只能用于上传。".into());
        }
        let dialog = rfd::AsyncFileDialog::new();
        let mut chosen_directory = None;
        let mut quick = false;
        let mut invalid_directory = false;
        let selections = if upload {
            let paths = if let Some(ticket) = request.drop_ticket {
                let mut drop = self.drop.lock().unwrap();
                if !drop.as_ref().is_some_and(|drop| {
                    drop.ticket == ticket && drop.time.elapsed() < Duration::from_secs(300)
                }) {
                    return Err("拖入的文件已失效，请重新拖入。".into());
                }
                drop.take().unwrap().paths
            } else if request.folder {
                let Some(folder) = dialog.set_title("选择要上传的目录").pick_folder().await
                else {
                    return Ok(Value::Null);
                };
                vec![folder.path().to_path_buf()]
            } else {
                let Some(files) = dialog.set_title("选择要上传的文件").pick_files().await
                else {
                    return Ok(Value::Null);
                };
                files
                    .into_iter()
                    .map(|file| file.path().to_path_buf())
                    .collect()
            };
            paths
                .into_iter()
                .map(|local| {
                    let name = file_name(
                        local
                            .file_name()
                            .and_then(|n| n.to_str())
                            .ok_or("本机文件名无效。")?,
                    )?;
                    Ok((remote_join(&directory, name), local))
                })
                .collect::<Result<Vec<_>, String>>()?
        } else {
            let names = request.names.ok_or("请选择要下载的文件。")?;
            if names.is_empty() || names.len() > 100 {
                return Err("每次可选择 1 至 100 个文件或目录。".into());
            }
            let remembered = {
                let store = ws.store.lock().unwrap();
                let data = store.data()?;
                session.check_route(data)?;
                session.places(data).download_directory
            };
            let folder = match remembered {
                Some(path) if !request.choose_directory && writable_download_directory(&path) => {
                    quick = true;
                    path
                }
                other => {
                    invalid_directory = !request.choose_directory && other.is_some();
                    let title = if invalid_directory { "原下载目录已不可用，请重新选择" } else { "选择下载目录" };
                    let Some(folder) = dialog.set_title(title).pick_folder().await else { return Ok(Value::Null); };
                    let path = std::fs::canonicalize(folder.path()).map_err(error)?;
                    if !writable_download_directory(&path) { return Err("所选下载目录不可写，请重新选择。".into()); }
                    chosen_directory = Some(path.clone());
                    path
                }
            };
            names
                .into_iter()
                .map(|name| {
                    let name = local_name(&name)?;
                    Ok((remote_join(&directory, name), folder.join(name)))
                })
                .collect::<Result<Vec<_>, String>>()?
        };
        if selections.is_empty() || selections.len() > 100 {
            return Err("每次可传输 1 至 100 个选中的项目。".into());
        }
        let mut result = self.stage_with_directory(session, upload, selections, chosen_directory).await?;
        result["quickDownload"] = json!(quick);
        result["replaceInvalidDirectory"] = json!(invalid_directory);
        Ok(result)
    }
    pub(crate) async fn stage(
        &self,
        session: Arc<Session>,
        upload: bool,
        selections: Vec<(String, PathBuf)>,
    ) -> Result<Value, String> {
        self.stage_with_directory(session, upload, selections, None).await
    }
    async fn stage_with_directory(
        &self,
        session: Arc<Session>,
        upload: bool,
        selections: Vec<(String, PathBuf)>,
        chosen_directory: Option<PathBuf>,
    ) -> Result<Value, String> {
        let sftp = open(&session).await?;
        let mut files = Vec::new();
        let mut remaining = 1000;
        for (remote, local) in selections {
            let (size, folder) = if upload {
                let metadata = fs::symlink_metadata(&local).await.map_err(error)?;
                if metadata.is_dir() {
                    let (folder, size) =
                        scan_upload_folder(&local, &mut remaining, &session.cancel).await?;
                    (size, Some(Arc::new(folder)))
                } else {
                    let source = local_stat(metadata);
                    if !source.regular {
                        return Err("请选择普通文件或目录，不支持符号链接。".into());
                    }
                    (source.size, None)
                }
            } else {
                let attrs = sftp.symlink_metadata(&remote).await.map_err(error)?;
                if attrs.file_type().is_dir() {
                    let (folder, size) =
                        scan_folder(&sftp, &remote, &mut remaining, &session.cancel).await?;
                    (size, Some(Arc::new(folder)))
                } else if attrs.file_type().is_file() {
                    (attrs.size.unwrap_or(0), None)
                } else {
                    return Err("请选择普通文件或目录。".into());
                }
            };
            let mut file = File {
                session: session.clone(),
                upload,
                local,
                remote,
                size,
                original: None,
                permissions: None,
                editor_upload: false,
                folder,
            };
            file.original = target(&sftp, &file).await?;
            if file.upload && file.original.as_ref().is_some_and(|s| s.regular) {
                file.permissions = sftp
                    .symlink_metadata(&file.remote)
                    .await
                    .map_err(error)?
                    .permissions;
            }
            files.push(file);
        }
        let ticket = Uuid::new_v4();
        let summaries: Vec<_> = files.iter().map(|f| json!({
            "target": f.target(),
            "exists": f.original.is_some(),
            "canReplace": f.folder.is_none() && f.original.as_ref().is_some_and(|s| s.regular),
            "kind": if f.folder.is_some() { "directory" } else { "file" },
            "skipped": f.folder.as_ref().map_or(0, |folder| folder.skipped)
        })).collect();
        let mut pending = self.tickets.lock().unwrap();
        let can_remember_directory = chosen_directory.is_some();
        pending.retain(|_, t| t.time.elapsed() < Duration::from_secs(300));
        pending.insert(
            ticket,
            Ticket {
                files,
                time: Instant::now(),
                chosen_directory,
            },
        );
        Ok(json!({"ticket":ticket,"files":summaries,"canRememberDirectory":can_remember_directory}))
    }
    pub fn discard(&self, ticket: Uuid) {
        self.tickets.lock().unwrap().remove(&ticket);
    }
    pub fn accept(&self, ws: &Workspace, ticket: Uuid, policy: Policy, remember_directory: bool) -> Result<(), String> {
        let ticket = self
            .tickets
            .lock()
            .unwrap()
            .remove(&ticket)
            .filter(|t| t.time.elapsed() < Duration::from_secs(300))
            .ok_or("传输确认已过期，请重新选择文件。")?;
        if remember_directory {
            let path = ticket.chosen_directory.ok_or("请先选择本机下载目录。")?;
            let session = &ticket.files.first().ok_or("未选择文件。")?.session;
            let mut store = ws.store.lock().unwrap();
            let data = store.data()?;
            session.check_route(data)?;
            let mut places = session.places(data);
            places.download_directory = Some(path);
            session.set_places(&mut store, places)?;
        }
        self.enqueue(ws, ticket.files, policy)
    }
    fn enqueue(&self, ws: &Workspace, files: Vec<File>, policy: Policy) -> Result<(), String> {
        if files.iter().any(|f| f.session.cancel.is_cancelled()) {
            return Err("原 SSH 会话已断开。".into());
        }
        let mut queue = self.queue.lock().unwrap();
        if files
            .iter()
            .any(|f| f.session.mutating.load(std::sync::atomic::Ordering::SeqCst))
        {
            return Err("远端文件操作进行中，请稍后重新提交传输。".into());
        }
        if queue.order.len() + files.len() > 500 {
            return Err("传输队列已满。".into());
        }
        for file in files {
            let job = Arc::new(Job {
                id: Uuid::new_v4(),
                cancel: CancellationToken::new(),
                pause: CancellationToken::new(),
                checkpoint: None, discard: false, last_event: Mutex::new(Value::Null),
                file,
                policy,
                done: Notify::new(),
                status: Mutex::new("queued"),
            });
            job.emit(ws, &job.file, "queued", 0, "");
            queue.jobs.insert(job.id, job.clone());
            queue.order.push_back(job);
        }
        self.start_drain(ws, &mut queue);
        Ok(())
    }
    fn start_drain(&self, ws: &Workspace, queue: &mut Queue) {
        if !queue.draining {
            queue.draining = true;
            let ws = ws.clone();
            tauri::async_runtime::spawn(async move {
                ws.transfers.drain(&ws).await;
            });
        }
    }
    async fn drain(&self, ws: &Workspace) {
        loop {
            let job = {
                let mut queue = self.queue.lock().unwrap();
                let Some(job) = queue.order.pop_front() else {
                    queue.draining = false;
                    return;
                };
                job
            };
            let mut file = job.file.clone();
            let mut point = job.checkpoint.clone();
            let mut bytes = point.as_ref().map_or(0, Checkpoint::bytes);
            let mut committing = false;
            job.emit(ws, &file, if point.is_some() { "verifying" } else { "running" }, bytes, "");
            let result = job.transfer(ws, &mut file, &mut point, &mut bytes, &mut committing).await;
            let (status, mut message) = match result {
                Ok(status) => (status, String::new()),
                Err(e) if committing && e.starts_with("提交未确认") => ("unverified", e),
                Err(e) if !committing && point.is_some() => ("paused", e),
                Err(e) if job.cancel.is_cancelled() => ("canceled", e),
                Err(e) => ("failed", e),
            };
            if status == "paused" {
                let checkpoint = point.as_mut().unwrap();
                checkpoint.message = message.clone();
                bytes = checkpoint.bytes();
                if let Err(e) = checkpoint.persist(ws, job.id) {
                    message = format!("{message} 上次已记录的断点仍可用：{e}");
                }
            }
            job.emit(ws, &file, status, bytes, &message);
            job.done.notify_waiters();
        }
    }
    pub fn cancel(&self, id: Uuid) {
        if let Some(job) = self.queue.lock().unwrap().jobs.get(&id) {
            job.cancel.cancel();
        }
    }
    pub async fn cancel_session(&self, session: &Arc<Session>) {
        let jobs: Vec<_> = self
            .queue
            .lock()
            .unwrap()
            .jobs
            .values()
            .filter(|j| Arc::ptr_eq(&j.file.session, session))
            .cloned()
            .collect();
        for job in &jobs {
            job.pause.cancel();
        }
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            for job in jobs {
                let notified = job.done.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if matches!(*job.status.lock().unwrap(), "running" | "verifying" | "committing") {
                    notified.await;
                }
            }
        })
        .await;
    }
    pub async fn prepare_retry(&self, ws: &Workspace, record_id: Uuid, session: Arc<Session>, legacy_host: Option<Uuid>) -> Result<Value, String> {
        let record = self.history(ws)?.into_iter().find(|row| row["id"] == json!(record_id))
            .ok_or("找不到这条传输记录。")?;
        if !matches!(record["status"].as_str(), Some("failed" | "canceled")) {
            return Err("仅失败或已取消的传输可以重试。".into());
        }
        Self::check_record_host(ws, &record, &session, legacy_host)?;
        let remote = remote_path(record["remote"].as_str().ok_or("记录缺少远端路径。")?)?;
        let local = PathBuf::from(record["local"].as_str().ok_or("记录缺少本机路径。")?);
        if !local.is_absolute() || local.file_name().is_none() || remote == "/" {
            return Err("记录中的文件路径无效，请重新选择。".into());
        }
        let upload = match record["direction"].as_str() {
            Some("up") => true,
            Some("down") => false,
            _ => return Err("记录缺少传输方向。".into()),
        };
        let legacy_editor = record.get("editorUpload").is_none() && upload
            && local.parent().and_then(Path::file_name).and_then(|s| s.to_str())
                .is_some_and(|name| name.starts_with("termlume-edit-"));
        if record["editorUpload"] == true || legacy_editor {
            return Err("请从外部编辑任务重新核对远端版本后回传。".into());
        }
        self.stage(session, upload, vec![(remote, local)]).await
    }

    pub fn retry(&self, ws: &Workspace, id: Uuid) -> Result<(), String> {
        let job = self
            .queue
            .lock()
            .unwrap()
            .jobs
            .get(&id)
            .cloned()
            .ok_or("传输任务已不存在。")?;
        if !matches!(*job.status.lock().unwrap(), "canceled" | "failed") {
            return Ok(());
        }
        let current = ws.connections.connected(job.file.session.id)?;
        if !job.file.session.host.same_connection(&current.host)
            || job.file.session.fingerprint.get() != current.fingerprint.get()
        {
            return Err("原会话的连接目标已改变，请重新发起传输。".into());
        }
        self.enqueue(
            ws,
            vec![File {
                session: current,
                ..job.file.clone()
            }],
            Policy::Skip,
        )
    }
}

impl Job {
    fn emit(&self, ws: &Workspace, file: &File, status: &'static str, bytes: u64, message: &str) {
        let mut event = json!({"type":"transfer","id":self.id,"sessionId":file.session.id,"host":file.session.host.name,
            "direction":if file.upload {"up"} else {"down"},"local":file.local,"remote":file.remote,
            "size":file.size,"bytes":bytes,"status":status,"message":message});
        event["route"] = file.session.transfer_route();
        if !matches!(status, "queued" | "running" | "verifying" | "paused" | "committing") {
            if matches!(status, "failed" | "canceled") {
                event["editorUpload"] = json!(file.editor_upload);
            }
            event["finishedAt"] = json!(crate::now());
            ws.transfers.record(ws, &event);
        }
        *self.last_event.lock().unwrap() = event.clone();
        *self.status.lock().unwrap() = status;
        ws.emit(event);
    }
    async fn choose_new_name(&self, sftp: &SftpSession, file: &mut File) -> Result<(), String> {
        let old = file.clone();
        let target = old.target();
        let path = Path::new(&target);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("文件名无效。")?;
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{s}"))
            .unwrap_or_default();
        for n in 2..=100 {
            let name = format!("{stem} ({n}){ext}");
            if file.upload {
                file.remote = remote_join(
                    old.remote.rsplit_once('/').map(|(p, _)| p).unwrap_or(""),
                    &name,
                );
            } else {
                file.local = old.local.with_file_name(&name);
            }
            if crate::transfer::target(sftp, file).await?.is_none() {
                return Ok(());
            }
        }
        Err("找不到可用的另存文件名。".into())
    }

}

fn publish_folder(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    return crate::platform::windows::publish_folder(source, target);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use rustix::fs::{renameat_with, RenameFlags, CWD};
        renameat_with(CWD, source, CWD, target, RenameFlags::NOREPLACE).map_err(error)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = (source, target);
        Err("此平台暂不支持下载整个目录。".into())
    }
}

async fn publish_remote(
    session: &Session,
    sftp: &SftpSession,
    temp: &str,
    path: &str,
    replace: bool,
) -> Result<(), String> {
    let result = if replace {
        let channel = tokio::time::timeout(Duration::from_secs(15), sftp_channel(session))
            .await
            .map_err(|_| "打开 SFTP 会话超时。")??;
        let raw = RawSftpSession::new(channel.into_stream());
        let info = raw.init().await.map_err(error)?;
        let extension = "posix-rename@openssh.com";
        if info.extensions.get(extension).map(String::as_str) != Some("1") {
            return Err("服务器不支持原子覆盖，请改用另存。".into());
        }
        let mut args = Vec::new();
        for value in [temp, path] {
            args.extend((value.len() as u32).to_be_bytes());
            args.extend(value.as_bytes());
        }
        match raw.extended(extension, args).await {
            Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok => Ok(()),
            Ok(Packet::Status(status)) => Err(SftpError::Status(status)),
            Ok(_) => Err(SftpError::UnexpectedPacket),
            Err(e) => Err(e),
        }
    } else {
        sftp.rename(temp, path).await
    };
    result.map_err(|e| match e {
        SftpError::Status(_) => error(e),
        _ => format!("提交未确认，请检查目标文件。{e}"),
    })
}

#[derive(Clone, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNode {
    path: String,
    directory: bool,
    version: String,
}
fn mutation_node(path: String, attrs: FileAttributes) -> RemoteNode {
    let directory = attrs.file_type().is_dir();
    RemoteNode {
        path,
        directory: attrs.file_type().is_dir(),
        version: if directory {
            format!("{:?}:{:?}:{:?}", attrs.permissions, attrs.uid, attrs.gid)
        } else {
            format!(
                "{:?}:{:?}:{:?}:{:?}:{:?}",
                attrs.size, attrs.permissions, attrs.mtime, attrs.uid, attrs.gid
            )
        },
    }
}
pub struct MutationGuard<'a>(&'a Session);
impl Drop for MutationGuard<'_> {
    fn drop(&mut self) {
        self.0
            .mutating
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
pub fn mutation_guard<'a>(
    ws: &Workspace,
    session: &'a Session,
) -> Result<MutationGuard<'a>, String> {
    if session
        .mutating
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err("已有远端文件操作，请等待完成。".into());
    }
    let guard = MutationGuard(session);
    if ws.transfers.active_session(session.id) {
        return Err("请先完成或取消该会话的文件传输。".into());
    }
    Ok(guard)
}
async fn canonical_entry(sftp: &SftpSession, path: &str) -> Result<String, String> {
    let path = remote_path(path)?;
    if path == "/" {
        return Ok(path);
    }
    let (parent, name) = path.rsplit_once('/').ok_or("路径无效。")?;
    let parent = sftp
        .canonicalize(if parent.is_empty() { "/" } else { parent })
        .await
        .map_err(error)?;
    Ok(remote_join(&parent, file_name(name)?))
}
pub async fn mutation_preview(session: &Session, paths: Vec<String>) -> Result<Value, String> {
    if paths.is_empty() || paths.len() > 100 {
        return Err("请选择 1–100 个项目。".into());
    }
    let sftp = open(session).await?;
    let mut roots = Vec::new();
    for path in paths {
        let path = canonical_entry(&sftp, &path).await?;
        if path == "/" {
            return Err("不能对远端根目录执行此操作。".into());
        }
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
    roots.sort();
    let mut pruned: Vec<String> = Vec::new();
    for root in roots {
        if !pruned.iter().any(|p| root.starts_with(&format!("{p}/"))) {
            pruned.push(root);
        }
    }
    let roots = pruned;
    let mut nodes = Vec::new();
    let mut stack: Vec<_> = roots
        .iter()
        .rev()
        .map(|p| (p.clone(), 0usize, false))
        .collect();
    while let Some((path, depth, visited)) = stack.pop() {
        if session.cancel.is_cancelled() {
            return Err("SSH 会话已断开。".into());
        }
        if depth > 32 || nodes.len() + stack.len() > 10000 {
            return Err("目录超过 32 层或 10000 项，请缩小范围。".into());
        }
        let attrs = sftp.symlink_metadata(&path).await.map_err(error)?;
        let node = mutation_node(path.clone(), attrs);
        if node.directory && !visited {
            if sftp.canonicalize(&path).await.map_err(error)? != path {
                return Err("目录路径已变化，请刷新。".into());
            }
            stack.push((path.clone(), depth, true));
            let mut children = Vec::new();
            for entry in sftp.read_dir(&path).await.map_err(error)? {
                let name = entry.file_name();
                if matches!(name.as_str(), "." | "..") {
                    continue;
                }
                file_name(&name)?;
                children.push(remote_join(&path, &name));
            }
            children.sort();
            for child in children.into_iter().rev() {
                stack.push((child, depth + 1, false));
            }
        } else {
            nodes.push(node);
        }
    }
    Ok(json!({"roots":roots,"nodes":nodes,"count":nodes.len()}))
}
pub async fn rename_remote(
    session: &Session,
    source: &str,
    destination: &str,
    expected: RemoteNode,
) -> Result<(), String> {
    let sftp = open(session).await?;
    let source = canonical_entry(&sftp, source).await?;
    let destination = canonical_entry(&sftp, destination).await?;
    if source == "/" || destination == "/" || source == destination {
        return Err("请指定不同的非根目录路径。".into());
    }
    if remote_target(&sftp, &destination).await?.is_some() {
        return Err("目标已存在，重命名不会覆盖已有项目。".into());
    }
    if mutation_node(
        source.clone(),
        sftp.symlink_metadata(&source).await.map_err(error)?,
    ) != expected
    {
        return Err("源项目已变化，请刷新。".into());
    }
    sftp.rename(source, destination).await.map_err(error)
}
pub async fn remove_remote(
    session: &Session,
    roots: Vec<String>,
    expected: Vec<RemoteNode>,
) -> Result<Value, String> {
    let current = mutation_preview(session, roots).await?;
    let nodes: Vec<RemoteNode> = crate::parse(current["nodes"].clone())?;
    if nodes != expected {
        return Err("项目或目录内容已变化，请重新预览删除范围。".into());
    }
    let sftp = open(session).await?;
    let mut results = Vec::new();
    for node in nodes {
        let result = async {
            if session.cancel.is_cancelled() {
                return Err("SSH 会话已断开，未执行。".to_owned());
            }
            let actual = mutation_node(
                node.path.clone(),
                sftp.symlink_metadata(&node.path).await.map_err(error)?,
            );
            if actual != node {
                return Err("项目在操作期间已变化，未删除。".into());
            }
            if node.directory {
                sftp.remove_dir(&node.path).await.map_err(error)
            } else {
                sftp.remove_file(&node.path).await.map_err(error)
            }
        }
        .await;
        results.push(json!({"path":node.path,"status":if result.is_ok(){"done"}else{"failed"},"message":result.err()}));
    }
    Ok(json!(results))
}

struct EditedFile {
    session: Uuid,
    host: String,
    endpoint: String,
    remote: String,
    original: Stat,
    digest: Vec<u8>,
    path: PathBuf,
    temp: tempfile::TempDir,
}
#[derive(Default)]
pub struct Editors {
    files: Mutex<HashMap<Uuid, Arc<EditedFile>>>,
}
impl Editors {
    pub fn clear(&self) {
        self.files.lock().unwrap().clear();
    }
    pub fn list(&self) -> Value {
        json!(self.files.lock().unwrap().iter().map(|(id,file)|json!({"id":id,"sessionId":file.session,"host":file.host,"endpoint":file.endpoint,"remote":file.remote,"local":file.path})).collect::<Vec<_>>())
    }
    pub fn close(&self, ws: &Workspace, id: Uuid) -> Result<(), String> {
        let mut files = self.files.lock().unwrap();
        if let Some(file) = files.get(&id) {
            if ws.transfers.active_session(file.session) {
                return Err("请先等待或取消此会话传输，再清理编辑副本。".into());
            }
        }
        files.remove(&id);
        Ok(())
    }
}
const EDITOR_LIMIT: usize = 4 * 1024 * 1024;
const EDITOR_FILE_ERROR: &str = "编辑器支持不超过 4 MiB 的普通 UTF-8 文本文件。";

async fn read_bounded_text(
    sftp: &SftpSession,
    path: &str,
) -> Result<(Option<Vec<u8>>, FileAttributes), String> {
    let attrs = sftp.symlink_metadata(path).await.map_err(error)?;
    if !attrs.file_type().is_file() {
        return Err(EDITOR_FILE_ERROR.into());
    }
    if attrs.size.is_some_and(|size| size > EDITOR_LIMIT as u64) {
        return Ok((None, attrs));
    }
    let mut file = sftp.open(path).await.map_err(error)?;
    let mut bytes = Vec::new();
    let read = (&mut file)
        .take(EDITOR_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(error);
    let _ = file.close().await;
    read?;
    if bytes.len() > EDITOR_LIMIT {
        return Ok((None, attrs));
    }
    if std::str::from_utf8(&bytes).is_err() || bytes.contains(&0) {
        return Err(EDITOR_FILE_ERROR.into());
    }
    Ok((Some(bytes), attrs))
}

async fn read_editor_file(sftp: &SftpSession, path: &str) -> Result<(Vec<u8>, FileAttributes), String> {
    let (bytes, attrs) = read_bounded_text(sftp, path).await?;
    Ok((bytes.ok_or(EDITOR_FILE_ERROR)?, attrs))
}

async fn editor_read(sftp: &SftpSession, path: &str) -> Result<(Vec<u8>, Stat), String> {
    let (bytes, attrs) = read_editor_file(sftp, path).await?;
    Ok((bytes, remote_stat(attrs)))
}

fn text_revision(bytes: &[u8], attrs: &FileAttributes) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}:{:?}:{:?}:{:?}:{:?}",
        Sha256::digest(bytes),
        attrs.mtime,
        attrs.permissions,
        attrs.uid,
        attrs.gid
    )
}

pub async fn read_text(session: &Session, path: &str) -> Result<Value, String> {
    let sftp = open(session).await?;
    let path = canonical_entry(&sftp, path).await?;
    let (bytes, attrs) = read_bounded_text(&sftp, &path).await?;
    let Some(bytes) = bytes else {
        return Ok(json!({"path": path, "tooLarge": true}));
    };
    let revision = text_revision(&bytes, &attrs);
    Ok(
        json!({"path": path, "text": String::from_utf8(bytes).map_err(error)?, "revision": revision}),
    )
}

pub async fn save_text(
    ws: &Workspace,
    session: &Session,
    path: &str,
    text: &str,
    expected: &str,
) -> Result<Value, String> {
    if text.len() > EDITOR_LIMIT || text.as_bytes().contains(&0) {
        return Err("编辑结果须为不超过 4 MiB 的 UTF-8 文本。".into());
    }
    let _mutation = mutation_guard(ws, session)?;
    let sftp = open(session).await?;
    let path = canonical_entry(&sftp, path).await?;
    let conflict = "远端文件已改变。";
    let (original, attrs) = read_editor_file(&sftp, &path).await?;
    if text_revision(&original, &attrs) != expected {
        return Ok(json!({"conflict":true}));
    }
    // Verify write permission on the original even when its parent is writable.
    sftp.open_with_flags(&path, OpenFlags::WRITE)
        .await
        .map_err(error)?
        .close()
        .await
        .map_err(error)?;
    let parent = path.rsplit_once('/').ok_or("路径无效。")?.0;
    let temporary = remote_join(parent, &format!(".termlume-{}.part", Uuid::new_v4()));
    let mut create = FileAttributes::empty();
    create.permissions = Some(0o600);
    let mut file = sftp
        .open_with_flags_and_attributes(
            &temporary,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            create,
        )
        .await
        .map_err(error)?;
    let result = async {
        file.write_all(text.as_bytes()).await.map_err(error)?;
        file.flush().await.map_err(error)?;
        let mut permissions = FileAttributes::empty();
        permissions.permissions = attrs.permissions.map(|mode| mode & 0o7777);
        let staged = file.metadata().await.map_err(error)?;
        if (staged.uid, staged.gid) != (attrs.uid, attrs.gid) {
            permissions.uid = attrs.uid;
            permissions.gid = attrs.gid;
        }
        file.set_metadata(permissions).await.map_err(error)?;
        file.sync_all().await.map_err(error)?;
        let staged = file.metadata().await.map_err(error)?;
        file.close().await.map_err(error)?;
        if (staged.uid, staged.gid, staged.permissions) != (attrs.uid, attrs.gid, attrs.permissions)
        {
            return Err("无法保留远端文件的权限或所有者。".into());
        }
        let (latest, latest_attrs) = read_editor_file(&sftp, &path).await?;
        if text_revision(&latest, &latest_attrs) != expected {
            return Err(conflict.into());
        }
        ws.store.lock().unwrap().data()?;
        if session.cancel.is_cancelled() {
            return Err("SSH 会话已断开。".into());
        }
        publish_remote(session, &sftp, &temporary, &path, true).await?;
        Ok(json!({"revision": text_revision(text.as_bytes(), &staged), "size": text.len()}))
    }
    .await;
    if let Err(failure) = result {
        if remote_target(&sftp, &temporary)
            .await
            .is_ok_and(|entry| entry.is_none())
            || sftp.remove_file(&temporary).await.is_ok()
        {
            if failure == conflict { return Ok(json!({"conflict":true})); }
            return Err(failure);
        }
        return Err(format!("{failure} 请检查远端临时文件 {temporary}"));
    }
    result
}
pub async fn open_editor(
    ws: &Workspace,
    session: Arc<Session>,
    path: &str,
    launch: bool,
) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    ws.store.lock().unwrap().data()?;
    if ws.editors.files.lock().unwrap().len() >= 16 {
        return Err("最多打开 16 个外部编辑副本，请先清理旧任务。".into());
    }
    let path = remote_path(path)?;
    let sftp = open(&session).await?;
    let (bytes, original) = editor_read(&sftp, &path).await?;
    let temp = tempfile::Builder::new()
        .prefix("termlume-edit-")
        .tempdir()
        .map_err(error)?;
    let name = path.rsplit('/').next().ok_or("文件名无效。")?;
    local_name(name)?;
    let local = temp.path().join(name);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options.open(&local).await.map_err(error)?;
    output.write_all(&bytes).await.map_err(error)?;
    output.sync_all().await.map_err(error)?;
    if launch {
        #[cfg(target_os = "macos")]
        {
            let local = local.clone();
            crate::blocking(move || {
                let result = std::process::Command::new("/usr/bin/open")
                    .arg("-t")
                    .arg(local)
                    .status()
                    .map_err(error)?;
                if result.success() {
                    Ok(())
                } else {
                    Err("无法启动本机文本编辑器。".into())
                }
            })
            .await?;
        }
        #[cfg(windows)]
        {
            let local = local.clone();
            crate::blocking(move || crate::platform::windows::open_text_editor(&local)).await?;
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        return Err("外部编辑暂仅支持 macOS。".into());
    }
    let id = Uuid::new_v4();
    let host = session.host.name.clone();
    let endpoint = format!(
        "{}@{}:{}",
        session.host.username, session.host.address, session.host.port
    );
    let result = json!({"id":id,"sessionId":session.id,"host":host,"endpoint":endpoint,"remote":path,"local":local});
    ws.editors.files.lock().unwrap().insert(
        id,
        Arc::new(EditedFile {
            session: session.id,
            host,
            endpoint,
            remote: path,
            original,
            digest: Sha256::digest(&bytes).to_vec(),
            path: local,
            temp,
        }),
    );
    Ok(result)
}
pub async fn prepare_edited_upload(ws: &Workspace, id: Uuid) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    ws.store.lock().unwrap().data()?;
    let file = ws
        .editors
        .files
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("编辑任务已关闭。")?;
    let session = ws.connections.connected(file.session)?;
    if ws.transfers.active_session(file.session) {
        return Err("请等待此会话传输完成，再上传编辑结果。".into());
    }
    let sftp = open(&session).await?;
    let (remote, current) = editor_read(&sftp, &file.remote).await?;
    if Sha256::digest(&remote).as_slice() != file.digest || current != file.original {
        return Err("远端文件已改变，未覆盖。请重新打开并合并更改。".into());
    }
    let source = fs::File::open(&file.path).await.map_err(error)?;
    let mut bytes = Vec::new();
    source
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(error)?;
    if bytes.len() > 4 * 1024 * 1024 || std::str::from_utf8(&bytes).is_err() || bytes.contains(&0) {
        return Err("编辑结果须为不超过 4 MiB 的 UTF-8 文本。".into());
    }
    let mut count = 0;
    let mut entries = fs::read_dir(file.temp.path()).await.map_err(error)?;
    while entries.next_entry().await.map_err(error)?.is_some() {
        count += 1;
    }
    if count > 32 {
        return Err("此副本上传次数已达上限，请清理后重新打开。".into());
    }
    let snapshot = file
        .temp
        .path()
        .join(format!("upload-{}.txt", Uuid::new_v4()));
    fs::write(&snapshot, &bytes).await.map_err(error)?;
    let ticket = ws
        .transfers
        .stage(session, true, vec![(file.remote.clone(), snapshot)])
        .await?;
    let token = crate::id(&ticket["ticket"])?;
    if let Some(ticket) = ws.transfers.tickets.lock().unwrap().get_mut(&token) {
        ticket.files[0].original = Some(file.original.clone());
        ticket.files[0].editor_upload = true;
    }
    Ok(ticket)
}
