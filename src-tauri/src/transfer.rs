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
    path::{Path, PathBuf},
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
        let kind = if metadata.is_dir() {
            "directory"
        } else if metadata.is_regular() {
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
fn remote_join(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

#[derive(Deserialize)]
pub struct PrepareRequest {
    pub id: Uuid,
    direction: String,
    directory: String,
    #[serde(default)]
    names: Option<Vec<String>>,
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
struct Stat {
    regular: bool,
    size: u64,
    version: String,
}
fn remote_stat(attrs: FileAttributes) -> Stat {
    Stat {
        regular: attrs.is_regular(),
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
    queue: Mutex<Queue>,
}
impl Transfers {
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
        let dialog = rfd::AsyncFileDialog::new();
        let selections = if upload {
            let Some(files) = dialog.set_title("选择要上传的文件").pick_files().await
            else {
                return Ok(Value::Null);
            };
            files
                .into_iter()
                .map(|file| {
                    let local = file.path().to_path_buf();
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
                return Err("每次可选择 1 至 100 个普通文件。".into());
            }
            let Some(folder) = dialog.set_title("选择下载目录").pick_folder().await else {
                return Ok(Value::Null);
            };
            names
                .into_iter()
                .map(|name| {
                    let name = file_name(&name)?;
                    Ok((remote_join(&directory, name), folder.path().join(name)))
                })
                .collect::<Result<Vec<_>, String>>()?
        };
        if selections.len() > 100 {
            return Err("每次可选择最多 100 个普通文件。".into());
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
        for (remote, local) in selections {
            let source = if upload {
                local_stat(fs::metadata(&local).await.map_err(error)?)
            } else {
                remote_target(&sftp, &remote)
                    .await?
                    .ok_or("远端文件不存在。")?
            };
            if !source.regular {
                return Err("请选择普通文件。".into());
            }
            let mut file = File {
                session: session.clone(),
                upload,
                local,
                remote,
                size: source.size,
                original: None,
            };
            file.original = target(&sftp, &file).await?;
            files.push(file);
        }
        let ticket = Uuid::new_v4();
        let summaries: Vec<_> = files.iter().map(|f| json!({"target":f.target(),"exists":f.original.is_some(),"canReplace":f.original.as_ref().is_some_and(|s| s.regular)})).collect();
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
        ws.emit(json!({"type":"transfer","id":self.id,"sessionId":file.session.id,"host":file.session.host.name,
            "direction":if file.upload {"up"} else {"down"},"local":file.local,"remote":file.remote,
            "size":file.size,"bytes":bytes,"status":status,"message":message}));
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
        let replace = self.policy == Policy::Replace
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
                publish_remote(file, &sftp, &remote_temp, replace).await?;
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
        attrs.permissions = Some(0o600);
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
async fn publish_remote(
    file: &File,
    sftp: &SftpSession,
    temp: &str,
    replace: bool,
) -> Result<(), String> {
    let result = if replace {
        let channel = tokio::time::timeout(Duration::from_secs(15), sftp_channel(&file.session))
            .await
            .map_err(|_| "打开 SFTP 会话超时。")??;
        let raw = RawSftpSession::new(channel.into_stream());
        let info = raw.init().await.map_err(error)?;
        let extension = "posix-rename@openssh.com";
        if info.extensions.get(extension).map(String::as_str) != Some("1") {
            return Err("服务器不支持原子覆盖，请改用另存。".into());
        }
        let mut args = Vec::new();
        for value in [temp, file.remote.as_str()] {
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
        sftp.rename(temp, &file.remote).await
    };
    result.map_err(|e| match e {
        SftpError::Status(_) => error(e),
        _ => format!("提交未确认，请检查目标文件。{e}"),
    })
}
