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
}
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
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

#[derive(Clone, PartialEq, Eq)]
struct DownloadFolder {
    root: String,
    entries: Vec<FolderEntry>,
    skipped: usize,
}

#[derive(Clone, PartialEq, Eq)]
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
                source: None,
                local: relative,
                remote: child,
                size,
            });
        }
    }
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
    Ok((
        DownloadFolder {
            root: canonical.to_string_lossy().into_owned(),
            entries,
            skipped,
        },
        total,
    ))
}

#[derive(Clone, PartialEq, Eq)]
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
    status: Mutex<&'static str>,
}
#[derive(Default)]
struct Queue {
    jobs: HashMap<Uuid, Arc<Job>>,
    order: VecDeque<Arc<Job>>,
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
        self.queue.lock().unwrap().jobs.values().any(|j| matches!(*j.status.lock().unwrap(), "queued" | "running" | "committing"))
    }
    pub fn active_session(&self, id: Uuid) -> bool {
        self.queue.lock().unwrap().jobs.values().any(|j| {
            j.file.session.id == id
                && matches!(
                    *j.status.lock().unwrap(),
                    "queued" | "running" | "committing"
                )
        })
    }
    pub fn history(&self, ws: &Workspace) -> Result<Vec<Value>, String> {
        self.edit_history(ws, |_| ())
    }

    pub fn remove_history(&self, ws: &Workspace, id: Option<Uuid>) -> Result<Vec<Value>, String> {
        let id = id.map(|id| json!(id));
        let mut removed = Vec::new();
        self.edit_history(ws, |records| {
            records.retain(|record| {
                let remove = record["direction"] == "down"
                    && id.as_ref().is_none_or(|id| id == &record["id"]);
                if remove {
                    removed.push(record["id"].clone());
                }
                !remove
            });
        })?;
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
        if records != data.transfer_history {
            let mut data = data.clone();
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
            let Some(folder) = dialog.set_title("选择下载目录").pick_folder().await else {
                return Ok(Value::Null);
            };
            names
                .into_iter()
                .map(|name| {
                    let name = local_name(&name)?;
                    Ok((remote_join(&directory, name), folder.path().join(name)))
                })
                .collect::<Result<Vec<_>, String>>()?
        };
        if selections.is_empty() || selections.len() > 100 {
            return Err("每次可传输 1 至 100 个选中的项目。".into());
        }
        self.stage(session, upload, selections).await
    }
    pub(crate) async fn stage(
        &self,
        session: Arc<Session>,
        upload: bool,
        selections: Vec<(String, PathBuf)>,
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
        pending.retain(|_, t| t.time.elapsed() < Duration::from_secs(300));
        pending.insert(
            ticket,
            Ticket {
                files,
                time: Instant::now(),
            },
        );
        Ok(json!({"ticket":ticket,"files":summaries}))
    }
    pub fn discard(&self, ticket: Uuid) {
        self.tickets.lock().unwrap().remove(&ticket);
    }
    pub fn accept(&self, ws: &Workspace, ticket: Uuid, policy: Policy) -> Result<(), String> {
        let ticket = self
            .tickets
            .lock()
            .unwrap()
            .remove(&ticket)
            .filter(|t| t.time.elapsed() < Duration::from_secs(300))
            .ok_or("传输确认已过期，请重新选择文件。")?;
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
                cancel: file.session.cancel.child_token(),
                file,
                policy,
                done: Notify::new(),
                status: Mutex::new("queued"),
            });
            job.emit(ws, &job.file, "queued", 0, "");
            queue.jobs.insert(job.id, job.clone());
            queue.order.push_back(job);
        }
        if !queue.draining {
            queue.draining = true;
            let ws = ws.clone();
            tauri::async_runtime::spawn(async move {
                ws.transfers.drain(&ws).await;
            });
        }
        Ok(())
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
            let mut bytes = 0;
            let mut committing = false;
            let result = if job.cancel.is_cancelled() {
                Err("传输已取消。".into())
            } else {
                job.emit(ws, &file, "running", 0, "");
                job.run(ws, &mut file, &mut bytes, &mut committing).await
            };
            let (status, message) = match result {
                Ok(status) => (status, String::new()),
                Err(message) if committing && file.upload && message.starts_with("提交未确认") => {
                    ("unverified", message)
                }
                Err(message) if job.cancel.is_cancelled() && !committing => ("canceled", message),
                Err(message) => ("failed", message),
            };
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
            job.cancel.cancel();
        }
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            for job in jobs {
                let notified = job.done.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if matches!(*job.status.lock().unwrap(), "running" | "committing") {
                    notified.await;
                }
            }
        })
        .await;
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
        *self.status.lock().unwrap() = status;
        let mut event = json!({"type":"transfer","id":self.id,"sessionId":file.session.id,"host":file.session.host.name,
            "direction":if file.upload {"up"} else {"down"},"local":file.local,"remote":file.remote,
            "size":file.size,"bytes":bytes,"status":status,"message":message});
        if !matches!(status, "queued" | "running" | "committing") {
            event["finishedAt"] = json!(crate::now());
            ws.transfers.record(ws, &event);
        }
        ws.emit(event);
    }
    async fn run(
        &self,
        ws: &Workspace,
        file: &mut File,
        bytes: &mut u64,
        committing: &mut bool,
    ) -> Result<&'static str, String> {
        let sftp = open(&file.session).await?;
        let existing = target(&sftp, file).await?;
        let replace = file.folder.is_none()
            && self.policy == Policy::Replace
            && existing.as_ref().is_some_and(|s| s.regular)
            && file.original.as_ref().is_some_and(|s| s.regular);
        if replace && existing != file.original {
            return Err("目标文件已变化，请重新确认后传输。".into());
        }
        if existing.is_some() && !replace {
            if self.policy != Policy::Keep {
                return Ok("skipped");
            }
            self.choose_new_name(&sftp, file).await?;
        }
        if let Some(folder) = &file.folder {
            if file.upload {
                return self
                    .upload_folder(ws, file, folder, &sftp, bytes, committing)
                    .await;
            }
            return self
                .download_folder(ws, file, folder, &sftp, bytes, committing)
                .await;
        }
        let part_name = format!(".termlume-{}.part", self.id);
        let local_temp = file.local.with_file_name(&part_name);
        let remote_temp = remote_join(
            file.remote
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or(""),
            &part_name,
        );
        let mut created = false;
        let copied = if file.upload {
            self.upload(ws, file, &sftp, &remote_temp, bytes, &mut created)
                .await
        } else {
            self.download(ws, file, &sftp, &local_temp, bytes, &mut created)
                .await
        };
        let result = async {
            copied?;
            if *bytes != file.size {
                return Err("源文件大小已改变，请重新选择文件。".into());
            }
            if replace && target(&sftp, file).await? != existing {
                return Err("目标文件已变化，请重新确认。".into());
            }
            if self.cancel.is_cancelled() {
                return Err("传输已取消。".into());
            }
            *committing = true;
            self.emit(ws, file, "committing", *bytes, "");
            if file.upload {
                publish_remote(&file.session, &sftp, &remote_temp, &file.remote, replace).await?;
                created = false;
            } else if replace {
                fs::rename(&local_temp, &file.local).await.map_err(error)?;
                created = false;
            } else {
                fs::hard_link(&local_temp, &file.local)
                    .await
                    .map_err(error)?;
            }
            Ok("done")
        }
        .await;
        if created {
            let cleanup = if file.upload {
                sftp.remove_file(&remote_temp).await.map_err(error)
            } else {
                fs::remove_file(&local_temp).await.map_err(error)
            };
            if cleanup.is_err() {
                let temp = if file.upload {
                    remote_temp
                } else {
                    local_temp.to_string_lossy().into_owned()
                };
                if let Err(e) = result {
                    return Err(format!("{e} 请检查传输临时文件 {temp}"));
                }
                return Err(format!("目标已提交，请清理传输临时文件 {temp}"));
            }
        }
        result
    }

    async fn upload_folder(
        &self,
        ws: &Workspace,
        file: &File,
        folder: &DownloadFolder,
        sftp: &SftpSession,
        bytes: &mut u64,
        committing: &mut bool,
    ) -> Result<&'static str, String> {
        let parent = file
            .remote
            .rsplit_once('/')
            .map(|(p, _)| p)
            .ok_or("远端目录无效。")?;
        let temp = remote_join(parent, &format!(".termlume-{}.part", self.id));
        sftp.create_dir(&temp).await.map_err(error)?;
        let mut created = Vec::new();
        let result = async {
            let (current, _) = scan_upload_folder(&file.local, &mut 1000, &self.cancel).await?;
            if current != *folder {
                return Err("本机目录已变化，请重新选择上传。".into());
            }
            for entry in &folder.entries {
                if self.cancel.is_cancelled() {
                    return Err("上传已取消。".into());
                }
                let relative = entry
                    .local
                    .to_str()
                    .ok_or("文件名不是有效 Unicode。")?
                    .replace('\\', "/");
                let destination = remote_join(&temp, &relative);
                if let Some(size) = entry.size {
                    let source_path = file.local.join(&entry.local);
                    let attrs = fs::symlink_metadata(&source_path).await.map_err(error)?;
                    if !attrs.is_file() || Some(local_stat(attrs)) != entry.source {
                        return Err("本机文件已变化。".into());
                    }
                    let mut source = fs::File::open(&source_path).await.map_err(error)?;
                    let mut attrs = FileAttributes::empty();
                    attrs.permissions = Some(0o600);
                    let mut output = sftp
                        .open_with_flags_and_attributes(
                            &destination,
                            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                            attrs,
                        )
                        .await
                        .map_err(error)?;
                    created.push((destination.clone(), false));
                    let before = *bytes;
                    let copied = self.copy(ws, file, &mut source, &mut output, bytes).await;
                    let closed = output.close().await.map_err(error);
                    copied?;
                    closed?;
                    if *bytes - before != size
                        || Some(local_stat(
                            fs::symlink_metadata(&source_path).await.map_err(error)?,
                        )) != entry.source
                    {
                        return Err("上传期间源文件已变化。".into());
                    }
                } else {
                    sftp.create_dir(&destination).await.map_err(error)?;
                    created.push((destination, true));
                }
            }
            if self.cancel.is_cancelled() {
                return Err("上传已取消。".into());
            }
            let (current, _) = scan_upload_folder(&file.local, &mut 1000, &self.cancel).await?;
            if current != *folder {
                return Err("本机目录内容已变化，未提交。".into());
            }
            if remote_target(sftp, &file.remote).await?.is_some() {
                return Err("远端目标已出现，未覆盖。".into());
            }
            *committing = true;
            self.emit(ws, file, "committing", *bytes, "");
            sftp.rename(&temp, &file.remote).await.map_err(error)?;
            Ok("done")
        }
        .await;
        if result.is_err() {
            for (path, directory) in created.into_iter().rev() {
                let _ = if directory {
                    sftp.remove_dir(path).await
                } else {
                    sftp.remove_file(path).await
                };
            }
            let _ = sftp.remove_dir(temp).await;
        }
        result
    }
    async fn download_folder(
        &self,
        ws: &Workspace,
        file: &File,
        folder: &DownloadFolder,
        sftp: &SftpSession,
        bytes: &mut u64,
        committing: &mut bool,
    ) -> Result<&'static str, String> {
        if sftp.canonicalize(&file.remote).await.map_err(error)? != folder.root
            || !sftp
                .symlink_metadata(&file.remote)
                .await
                .map_err(error)?
                .file_type()
                .is_dir()
        {
            return Err("远端目录已变化，请重新选择。".into());
        }
        let parent = file.local.parent().ok_or("本机保存路径无效。")?;
        let temp = tempfile::Builder::new()
            .prefix(".termlume-")
            .suffix(".part")
            .tempdir_in(parent)
            .map_err(error)?;
        let result = async {
            for entry in &folder.entries {
                if self.cancel.is_cancelled() {
                    return Err("传输已取消。".into());
                }
                let attrs = sftp.symlink_metadata(&entry.remote).await.map_err(error)?;
                if sftp.canonicalize(&entry.remote).await.map_err(error)? != entry.remote {
                    return Err("目录中的项目已变化，请重新选择。".into());
                }
                let destination = temp.path().join(&entry.local);
                if let Some(size) = entry.size {
                    if !attrs.file_type().is_file() || attrs.size != Some(size) {
                        return Err("目录中的文件已变化，请重新选择。".into());
                    }
                    let mut source = sftp.open(&entry.remote).await.map_err(error)?;
                    let mut options = fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    options.mode(0o600);
                    let mut output = options.open(&destination).await.map_err(error)?;
                    let before = *bytes;
                    let copied = self.copy(ws, file, &mut source, &mut output, bytes).await;
                    let _ = source.close().await;
                    copied?;
                    if *bytes - before != size {
                        return Err("目录中的文件大小已变化，请重新选择。".into());
                    }
                    output.sync_all().await.map_err(error)?;
                } else if attrs.file_type().is_dir() {
                    fs::create_dir(&destination).await.map_err(error)?;
                } else {
                    return Err("目录中的项目已变化，请重新选择。".into());
                }
            }
            if self.cancel.is_cancelled() {
                return Err("传输已取消。".into());
            }
            *committing = true;
            self.emit(ws, file, "committing", *bytes, "");
            publish_folder(temp.path(), &file.local)
        }
        .await;
        match result {
            Ok(()) => {
                let _ = temp.keep();
                Ok("done")
            }
            Err(message) => {
                let staging = temp.path().display().to_string();
                if temp.close().is_err() {
                    return Err(format!("{message} 请检查传输临时目录 {staging}"));
                }
                Err(message)
            }
        }
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
    async fn upload(
        &self,
        ws: &Workspace,
        file: &File,
        sftp: &SftpSession,
        temp: &str,
        bytes: &mut u64,
        created: &mut bool,
    ) -> Result<(), String> {
        let mut source = fs::File::open(&file.local).await.map_err(error)?;
        if !source.metadata().await.map_err(error)?.is_file() {
            return Err("请选择普通文件。".into());
        }
        if self.cancel.is_cancelled() {
            return Err("传输已取消。".into());
        }
        let mut attrs = FileAttributes::empty();
        attrs.permissions = file.permissions.or(Some(0o600));
        let mut destination = sftp
            .open_with_flags_and_attributes(
                temp,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                attrs,
            )
            .await
            .map_err(error)?;
        *created = true;
        let result = self
            .copy(ws, file, &mut source, &mut destination, bytes)
            .await;
        let closed = destination.close().await.map_err(error);
        result.and(closed)
    }
    async fn download(
        &self,
        ws: &Workspace,
        file: &File,
        sftp: &SftpSession,
        temp: &Path,
        bytes: &mut u64,
        created: &mut bool,
    ) -> Result<(), String> {
        if !remote_target(sftp, &file.remote)
            .await?
            .is_some_and(|m| m.regular)
        {
            return Err("远端文件不再是普通文件。".into());
        }
        let mut source = sftp.open(&file.remote).await.map_err(error)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut destination = options.open(temp).await.map_err(error)?;
        *created = true;
        let result = self
            .copy(ws, file, &mut source, &mut destination, bytes)
            .await;
        let _ = source.close().await;
        result?;
        destination.sync_all().await.map_err(error)
    }
    async fn copy(
        &self,
        ws: &Workspace,
        file: &File,
        source: &mut (impl AsyncRead + Unpin),
        target: &mut (impl AsyncWrite + Unpin),
        bytes: &mut u64,
    ) -> Result<(), String> {
        let mut buffer = vec![0; 128 * 1024];
        let mut update = Instant::now();
        loop {
            let count = tokio::select! {
                _ = self.cancel.cancelled() => return Err("传输已取消。".into()),
                result = source.read(&mut buffer) => result.map_err(error)?,
            };
            if count == 0 {
                break;
            }
            tokio::select! {
                _ = self.cancel.cancelled() => return Err("传输已取消。".into()),
                result = target.write_all(&buffer[..count]) => result.map_err(error)?,
            }
            *bytes += count as u64;
            if update.elapsed() >= Duration::from_millis(125) {
                self.emit(ws, file, "running", *bytes, "");
                update = Instant::now();
            }
        }
        target.flush().await.map_err(error)
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

async fn read_editor_file(
    sftp: &SftpSession,
    path: &str,
) -> Result<(Vec<u8>, FileAttributes), String> {
    let attrs = sftp.symlink_metadata(path).await.map_err(error)?;
    if !attrs.file_type().is_file() || attrs.size.is_some_and(|size| size > EDITOR_LIMIT as u64) {
        return Err("编辑器支持不超过 4 MiB 的普通 UTF-8 文本文件。".into());
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
    if bytes.len() > EDITOR_LIMIT || std::str::from_utf8(&bytes).is_err() || bytes.contains(&0) {
        return Err("编辑器支持不超过 4 MiB 的普通 UTF-8 文本文件。".into());
    }
    Ok((bytes, attrs))
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
    let (bytes, attrs) = read_editor_file(&sftp, &path).await?;
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
    let conflict = "远端文件已改变。请重新打开并合并修改。";
    let (original, attrs) = read_editor_file(&sftp, &path).await?;
    if text_revision(&original, &attrs) != expected {
        return Err(conflict.into());
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
        Ok(json!({"revision": text_revision(text.as_bytes(), &staged)}))
    }
    .await;
    if let Err(failure) = result {
        if remote_target(&sftp, &temporary)
            .await
            .is_ok_and(|entry| entry.is_none())
            || sftp.remove_file(&temporary).await.is_ok()
        {
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
    }
    Ok(ticket)
}
