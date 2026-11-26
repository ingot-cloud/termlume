use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tokio::io::{AsyncSeek, AsyncSeekExt, SeekFrom};

#[derive(Clone, Serialize, Deserialize, Default)]
struct Prefix {
    length: u64,
    digest: String,
}

// Stored only in the local encrypted workspace. The renderer receives a display
// record, never the staging location, file manifest, or a caller-chosen offset.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Checkpoint {
    session: Uuid,
    host: String,
    route: Value,
    upload: bool,
    local: PathBuf,
    remote: String,
    size: u64,
    original: Option<Stat>,
    source: Stat,
    folder: Option<DownloadFolder>,
    permissions: Option<u32>,
    editor_upload: bool,
    local_parent: PathBuf,
    remote_parent: String,
    prefixes: BTreeMap<usize, Prefix>,
    publishing: bool,
    pub(super) message: String,
}

impl Checkpoint {
    pub(super) fn bytes(&self) -> u64 {
        self.prefixes.values().map(|p| p.length).sum()
    }

    pub(super) fn persist(&self, ws: &Workspace, id: Uuid) -> Result<(), String> {
        let mut store = ws.store.lock().unwrap();
        let mut data = store.data()?.clone();
        data.transfer_checkpoints
            .insert(id, serde_json::to_value(self).map_err(error)?);
        store.update(data)
    }

    fn display(&self, id: Uuid) -> Value {
        json!({"type":"transfer","id":id,"sessionId":self.session,"host":self.host,"route":self.route,
            "direction": if self.upload { "up" } else { "down" }, "remote":self.remote,
            "local":self.local,"size":self.size,"bytes":self.bytes(),"status":"paused","message":self.message,
            "editorUpload":self.editor_upload})
    }

    fn file(&self, session: Arc<Session>) -> File {
        File {
            session,
            upload: self.upload,
            local: self.local.clone(),
            remote: self.remote.clone(),
            size: self.size,
            original: self.original.clone(),
            permissions: self.permissions,
            editor_upload: self.editor_upload,
            folder: self.folder.clone().map(Arc::new),
        }
    }
}

impl Transfers {
    pub(crate) fn pending(&self, ws: &Workspace) -> Result<Value, String> {
        let queue = self.queue.lock().unwrap();
        let mut store = ws.store.lock().unwrap();
        let data = store.data()?;
        let mut rows = BTreeMap::new();
        let mut interrupted_commits = Vec::new();
        for (id, value) in &data.transfer_checkpoints {
            if queue.jobs.contains_key(id) {
                continue;
            }
            let cp: Checkpoint = serde_json::from_value(value.clone()).map_err(error)?;
            let mut row = cp.display(*id);
            if cp.publishing {
                row["status"] = json!("unverified");
                row["finishedAt"] = json!(crate::now());
                row["message"] = json!("应用在提交文件时退出，请核对目标文件。");
                interrupted_commits.push((*id, row.clone()));
            }
            rows.insert(*id, row);
        }
        if !interrupted_commits.is_empty() {
            let mut next = data.clone();
            for (id, row) in interrupted_commits {
                next.transfer_checkpoints.remove(&id);
                next.transfer_history.push(row);
            }
            let excess = next.transfer_history.len().saturating_sub(HISTORY_LIMIT);
            next.transfer_history.drain(..excess);
            store.update(next)?;
        }
        for job in queue.jobs.values() {
            let event = job.last_event.lock().unwrap();
            if !event.is_null() && event.get("finishedAt").is_none() {
                rows.insert(job.id, event.clone());
            }
        }
        Ok(json!(rows.into_values().collect::<Vec<_>>()))
    }

    pub(crate) fn pause(&self, id: Uuid) -> Result<(), String> {
        let queue = self.queue.lock().unwrap();
        let job = queue.jobs.get(&id).ok_or("找不到传输任务。")?;
        if matches!(*job.status.lock().unwrap(), "running" | "verifying") {
            job.pause.cancel();
        }
        Ok(())
    }

    pub(crate) async fn cancel_download(&self, ws: &Workspace, id: Uuid) -> Result<(), String> {
        let cp: Checkpoint = {
            let mut queue = self.queue.lock().unwrap();
            if queue
                .jobs
                .get(&id)
                .is_some_and(|j| *j.status.lock().unwrap() != "paused")
            {
                return Err("请先暂停传输。".into());
            }
            let store = ws.store.lock().unwrap();
            let cp: Checkpoint = serde_json::from_value(
                store
                    .data()?
                    .transfer_checkpoints
                    .get(&id)
                    .cloned()
                    .ok_or("找不到传输断点。")?,
            )
            .map_err(error)?;
            if cp.upload || cp.publishing || !queue.cleaning.insert(id) {
                return Err("当前任务无法清理。".into());
            }
            cp
        };
        let result = async {
            let path = cp.local_parent.join(format!(".termlume-{id}.part"));
            if local_target(&path).await?.is_some() {
                if fs::canonicalize(&cp.local_parent).await.map_err(error)? != cp.local_parent {
                    return Err("临时文件所在目录已变化。".into());
                }
                if let Some(folder) = &cp.folder {
                    let (tree, _) =
                        scan_upload_folder(&path, &mut 1000, &CancellationToken::new()).await?;
                    validate_tree(tree, folder, false)?;
                    for entry in folder.entries.iter().rev() {
                        let child = path.join(&entry.local);
                        if local_target(&child).await?.is_some() {
                            if entry.size.is_some() {
                                fs::remove_file(child).await.map_err(error)?;
                            } else {
                                fs::remove_dir(child).await.map_err(error)?;
                            }
                        }
                    }
                    fs::remove_dir(path).await.map_err(error)?;
                } else {
                    fs::remove_file(path).await.map_err(error)?;
                }
            }
            let mut event = cp.display(id);
            event["status"] = json!("canceled");
            event["message"] = json!("");
            event["finishedAt"] = json!(crate::now());
            self.record(ws, &event);
            self.queue.lock().unwrap().jobs.remove(&id);
            ws.emit(event);
            Ok(())
        }
        .await;
        self.queue.lock().unwrap().cleaning.remove(&id);
        result
    }

    pub(crate) fn resume(
        &self,
        ws: &Workspace,
        id: Uuid,
        session: Arc<Session>,
        discard: bool,
    ) -> Result<(), String> {
        let mut queue = self.queue.lock().unwrap();
        if queue.cleaning.contains(&id) {
            return Err("正在清理这项传输。".into());
        }
        if let Some(job) = queue.jobs.get(&id) {
            if *job.status.lock().unwrap() != "paused" {
                return Err("任务状态已改变。".into());
            }
        }
        let cp: Checkpoint = {
            let store = ws.store.lock().unwrap();
            let data = store.data()?;
            session.check_route(data)?;
            serde_json::from_value(
                data.transfer_checkpoints
                    .get(&id)
                    .cloned()
                    .ok_or("找不到传输断点。")?,
            )
            .map_err(error)?
        };
        if cp.route != session.transfer_route() || cp.publishing {
            return Err("原主机或提交状态已变化，请核对传输记录。".into());
        }
        if session.mutating.load(Ordering::SeqCst) || queue.order.len() >= 500 {
            return Err("文件操作繁忙，请稍后再试。".into());
        }
        let bytes = cp.bytes();
        let job = Arc::new(Job {
            id,
            file: cp.file(session),
            policy: Policy::Skip,
            checkpoint: Some(cp),
            discard,
            cancel: CancellationToken::new(),
            pause: CancellationToken::new(),
            done: Notify::new(),
            status: Mutex::new("queued"),
            last_event: Mutex::new(Value::Null),
        });
        job.emit(ws, &job.file, "queued", bytes, "");
        queue.jobs.insert(id, job.clone());
        queue.order.push_back(job);
        self.start_drain(ws, &mut queue);
        Ok(())
    }
}

enum Place {
    Local(PathBuf),
    Remote(String),
}

impl Place {
    fn child(&self, relative: &Path) -> Result<Self, String> {
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("目录项目包含无效路径。".into());
        }
        Ok(match self {
            Self::Local(root) => Self::Local(root.join(relative)),
            Self::Remote(root) => {
                let mut path = root.clone();
                for part in relative.iter() {
                    path = remote_join(&path, file_name(part.to_str().ok_or("文件名无效。")?)?);
                }
                Self::Remote(path)
            }
        })
    }

    async fn stat(&self, sftp: &SftpSession) -> Result<Option<Stat>, String> {
        match self {
            Self::Local(path) => local_target(path).await,
            Self::Remote(path) => remote_target(sftp, path).await,
        }
    }

    async fn directory(&self, sftp: &SftpSession) -> Result<bool, String> {
        match self {
            Self::Local(path) => Ok(fs::symlink_metadata(path).await.map_err(error)?.is_dir()),
            Self::Remote(path) => Ok(sftp
                .symlink_metadata(path)
                .await
                .map_err(error)?
                .file_type()
                .is_dir()),
        }
    }

    async fn mkdir(&self, sftp: &SftpSession) -> Result<(), String> {
        match self {
            Self::Local(path) => fs::create_dir(path).await.map_err(error),
            Self::Remote(path) => sftp.create_dir(path).await.map_err(error),
        }
    }

    async fn remove(&self, sftp: &SftpSession, directory: bool) -> Result<(), String> {
        if self.stat(sftp).await?.is_none() {
            return Ok(());
        }
        match self {
            Self::Local(p) if directory => fs::remove_dir(p).await.map_err(error),
            Self::Local(p) => fs::remove_file(p).await.map_err(error),
            Self::Remote(p) if directory => sftp.remove_dir(p).await.map_err(error),
            Self::Remote(p) => sftp.remove_file(p).await.map_err(error),
        }
    }

    async fn create(&self, sftp: &SftpSession) -> Result<(), String> {
        match self {
            Self::Local(path) => {
                let mut options = fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                options.mode(0o600);
                options.open(path).await.map_err(error)?;
                Ok(())
            }
            Self::Remote(path) => {
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
        }
    }
}

async fn manifest(file: &File, sftp: &SftpSession) -> Result<DownloadFolder, String> {
    let mut limit = 1000;
    let result = if file.upload {
        scan_upload_folder(&file.local, &mut limit, &file.session.cancel).await?
    } else {
        scan_folder(sftp, &file.remote, &mut limit, &file.session.cancel).await?
    };
    Ok(result.0)
}

async fn parents(file: &File, sftp: &SftpSession) -> Result<(PathBuf, String), String> {
    let local = fs::canonicalize(file.local.parent().ok_or("本机路径无效。")?)
        .await
        .map_err(error)?;
    let remote = file.remote.rsplit_once('/').ok_or("远端路径无效。")?.0;
    let remote = sftp
        .canonicalize(if remote.is_empty() { "/" } else { remote })
        .await
        .map_err(error)?;
    Ok((local, remote))
}

async fn check_tree(
    stage: &Place,
    folder: &DownloadFolder,
    sftp: &SftpSession,
    cancel: &CancellationToken,
    complete: bool,
) -> Result<(), String> {
    if !stage.directory(sftp).await? {
        return Err("临时目录已变化。".into());
    }
    let (tree, _) = match stage {
        Place::Local(path) => scan_upload_folder(path, &mut 1000, cancel).await?,
        Place::Remote(path) => scan_folder(sftp, path, &mut 1000, cancel).await?,
    };
    validate_tree(tree, folder, complete)
}

fn validate_tree(
    tree: DownloadFolder,
    folder: &DownloadFolder,
    complete: bool,
) -> Result<(), String> {
    if tree.skipped != 0 || (complete && tree.entries.len() != folder.entries.len()) {
        return Err("临时目录中有未确认的项目。".into());
    }
    for item in tree.entries {
        let expected = folder
            .entries
            .binary_search_by(|e| e.local.cmp(&item.local))
            .ok()
            .map(|i| &folder.entries[i])
            .ok_or("临时目录内容已变化。")?;
        if item.size.is_some() != expected.size.is_some()
            || item.size > expected.size
            || (complete && item.size != expected.size)
        {
            return Err("临时目录项目类型或大小已变化。".into());
        }
    }
    Ok(())
}

async fn cleanup(
    stage: &Place,
    cp: &Checkpoint,
    sftp: &SftpSession,
    session: &Session,
) -> Result<(), String> {
    if stage.stat(sftp).await?.is_none() {
        return Ok(());
    }
    if let Some(folder) = &cp.folder {
        check_tree(stage, folder, sftp, &session.cancel, false).await?;
        for entry in folder.entries.iter().rev() {
            stage
                .child(&entry.local)?
                .remove(sftp, entry.size.is_none())
                .await?;
        }
    }
    stage.remove(sftp, cp.folder.is_some()).await
}

async fn remote_prefix_digest(session: &Session, path: &str, length: u64) -> Option<String> {
    use russh::ChannelMsg;
    let path = path.replace('\'', "'\\''");
    let command = format!("if command -v sha256sum >/dev/null 2>&1; then head -c {length} < '{path}' | sha256sum; elif command -v shasum >/dev/null 2>&1; then head -c {length} < '{path}' | shasum -a 256; else exit 1; fi");
    let read = async {
        let mut channel = session.client.get()?.channel_open_session().await.ok()?;
        channel.exec(true, command.into_bytes()).await.ok()?;
        let mut output = Vec::new();
        let mut success = false;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } if output.len() + data.len() < 256 => {
                    output.extend_from_slice(&data)
                }
                ChannelMsg::ExitStatus { exit_status } => success = exit_status == 0,
                ChannelMsg::Close => break,
                ChannelMsg::Failure | ChannelMsg::Data { .. } => return None,
                _ => {}
            }
        }
        let hash = std::str::from_utf8(&output)
            .ok()?
            .split_whitespace()
            .next()?;
        (success && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    };
    tokio::select! {
        _ = session.cancel.cancelled() => None,
        result = tokio::time::timeout(Duration::from_secs(60), read) => result.ok().flatten()
    }
}

impl Job {
    fn interrupted(&self) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            return Err("传输已取消。".into());
        }
        if self.file.session.cancel.is_cancelled() {
            return Err("SSH 已断开，重新连接后可以继续。".into());
        }
        if self.pause.is_cancelled() {
            return Err("已保留传输断点。".into());
        }
        Ok(())
    }

    pub(super) async fn transfer(
        &self,
        ws: &Workspace,
        file: &mut File,
        point: &mut Option<Checkpoint>,
        bytes: &mut u64,
        committing: &mut bool,
    ) -> Result<&'static str, String> {
        let sftp = open(&file.session).await?;
        let resuming = point.is_some();
        if !resuming {
            if self.cancel.is_cancelled() {
                return Ok("canceled");
            }
            let existing = target(&sftp, file).await?;
            let replace = self.policy == Policy::Replace
                && file.folder.is_none()
                && file.original.as_ref().is_some_and(|s| s.regular);
            if replace && existing != file.original {
                return Err("目标文件已变化，请重新确认。".into());
            }
            if existing.is_some() && !replace {
                if self.policy != Policy::Keep {
                    return Ok("skipped");
                }
                self.choose_new_name(&sftp, file).await?;
            }
            if !replace {
                file.original = None;
            }
        }
        if self.discard {
            let cp = point.as_ref().ok_or("找不到传输断点。")?;
            let stage = if cp.upload {
                if sftp.canonicalize(&cp.remote_parent).await.map_err(error)? != cp.remote_parent {
                    return Err("临时文件所在目录已变化。".into());
                }
                Place::Remote(remote_join(
                    &cp.remote_parent,
                    &format!(".termlume-{}.part", self.id),
                ))
            } else {
                Place::Local(cp.local_parent.join(format!(".termlume-{}.part", self.id)))
            };
            cleanup(&stage, cp, &sftp, &file.session).await?;
            return Ok("canceled");
        }
        let (local_parent, remote_parent) = parents(file, &sftp).await?;
        let name = format!(".termlume-{}.part", self.id);
        let stage = if file.upload {
            Place::Remote(remote_join(&remote_parent, &name))
        } else {
            Place::Local(local_parent.join(&name))
        };
        let source = if file.upload {
            Place::Local(file.local.clone())
        } else {
            Place::Remote(file.remote.clone())
        };
        if let Some(cp) = point.as_ref() {
            if cp.local_parent != local_parent || cp.remote_parent != remote_parent {
                return Err("原路径指向的位置已变化。".into());
            }
            if self.cancel.is_cancelled() {
                cleanup(&stage, cp, &sftp, &file.session).await?;
                return Ok("canceled");
            }
        }
        let source_stat = source.stat(&sftp).await?.ok_or("找不到源文件或目录。")?;
        if let Some(folder) = &file.folder {
            if !source.directory(&sftp).await? || manifest(file, &sftp).await? != **folder {
                return Err("源目录内容已变化，请重新选择。".into());
            }
        } else if !source_stat.regular || source_stat.size != file.size {
            return Err("源文件类型或大小已变化，请重新选择。".into());
        }
        if let Some(cp) = point.as_ref() {
            if cp.source != source_stat || target(&sftp, file).await? != cp.original {
                return Err("源或目标已变化，无法使用此断点。".into());
            }
            if let Some(folder) = &cp.folder {
                check_tree(&stage, folder, &sftp, &file.session.cancel, false).await?;
            }
        } else {
            let cp = Checkpoint {
                session: file.session.id,
                route: file.session.transfer_route(),
                host: file.session.host.name.clone(),
                upload: file.upload,
                local: file.local.clone(),
                remote: file.remote.clone(),
                size: file.size,
                original: file.original.clone(),
                source: source_stat.clone(),
                folder: file.folder.as_deref().cloned(),
                permissions: file.permissions,
                editor_upload: file.editor_upload,
                local_parent,
                remote_parent,
                prefixes: BTreeMap::new(),
                publishing: false,
                message: String::new(),
            };
            if file.folder.is_some() {
                stage.mkdir(&sftp).await?;
            } else {
                stage.create(&sftp).await?;
            }
            if let Err(e) = cp.persist(ws, self.id) {
                stage.remove(&sftp, file.folder.is_some()).await?;
                return Err(e);
            }
            *point = Some(cp);
        }
        let cp = point.as_mut().unwrap();
        cp.session = file.session.id;
        let result = async {
            let mut last_save = Instant::now();
            if let Some(folder) = &file.folder {
                for (index, entry) in folder.entries.iter().enumerate() {
                    self.interrupted()?;
                    let part = stage.child(&entry.local)?;
                    let prior = part.stat(&sftp).await?;
                    if let Some(size) = entry.size {
                        if prior.is_none() {
                            if cp.prefixes.contains_key(&index) {
                                return Err("临时文件已丢失。".into());
                            }
                            part.create(&sftp).await?;
                        }
                        self.copy_entry(
                            ws,
                            file,
                            cp,
                            index,
                            &source.child(&entry.local)?,
                            &part,
                            &sftp,
                            size,
                            bytes,
                            &mut last_save,
                        )
                        .await?;
                    } else if prior.is_none() {
                        part.mkdir(&sftp).await?;
                    } else if !part.directory(&sftp).await? {
                        return Err("临时目录已变化。".into());
                    }
                }
                if manifest(file, &sftp).await? != **folder {
                    return Err("传输期间源目录已变化。".into());
                }
                check_tree(&stage, folder, &sftp, &file.session.cancel, true).await?;
            } else {
                self.copy_entry(
                    ws,
                    file,
                    cp,
                    0,
                    &source,
                    &stage,
                    &sftp,
                    file.size,
                    bytes,
                    &mut last_save,
                )
                .await?;
                if source.stat(&sftp).await?.as_ref() != Some(&cp.source) {
                    return Err("传输期间源文件已变化。".into());
                }
            }
            self.interrupted()?;
            if *bytes != file.size || target(&sftp, file).await? != cp.original {
                return Err("源或目标已变化，未提交。".into());
            }
            cp.publishing = true;
            cp.persist(ws, self.id)?;
            *committing = true;
            self.emit(ws, file, "committing", *bytes, "");
            match &stage {
                Place::Remote(path) if file.folder.is_some() => {
                    publish_remote(&file.session, &sftp, path, &file.remote, false).await?
                }
                Place::Remote(path) => {
                    if let Some(mode) = file.permissions {
                        let mut attrs = FileAttributes::empty();
                        attrs.permissions = Some(mode & 0o7777);
                        sftp.set_metadata(path, attrs).await.map_err(error)?;
                    }
                    publish_remote(
                        &file.session,
                        &sftp,
                        path,
                        &file.remote,
                        cp.original.is_some(),
                    )
                    .await?;
                }
                Place::Local(path) if file.folder.is_some() => publish_folder(path, &file.local)?,
                Place::Local(path) if cp.original.is_some() => {
                    fs::rename(path, &file.local).await.map_err(error)?
                }
                Place::Local(path) => {
                    fs::hard_link(path, &file.local).await.map_err(error)?;
                    fs::remove_file(path)
                        .await
                        .map_err(|e| format!("提交未确认，请核对目标和临时文件：{e}"))?;
                }
            }
            Ok("done")
        }
        .await;
        if result.is_err() && (self.cancel.is_cancelled() || *committing) {
            if let Err(e) = cleanup(&stage, cp, &sftp, &file.session).await {
                return Err(format!(
                    "{} 请检查临时文件 {name}：{e}",
                    result.unwrap_err()
                ));
            }
            if self.cancel.is_cancelled() {
                return Ok("canceled");
            }
        }
        result
    }

    async fn copy_entry(
        &self,
        ws: &Workspace,
        file: &File,
        cp: &mut Checkpoint,
        index: usize,
        source: &Place,
        part: &Place,
        sftp: &SftpSession,
        size: u64,
        bytes: &mut u64,
        last_save: &mut Instant,
    ) -> Result<(), String> {
        let prior = cp.prefixes.get(&index).cloned().unwrap_or_default();
        let expected_source = cp
            .folder
            .as_ref()
            .and_then(|f| f.entries[index].source.as_ref())
            .unwrap_or(&cp.source);
        if source.stat(sftp).await?.as_ref() != Some(expected_source) {
            return Err("源文件已变化，请重新选择。".into());
        }
        let staged = part.stat(sftp).await?.ok_or("找不到传输临时文件。")?;
        if !staged.regular
            || staged.size < prior.length
            || staged.size > size
            || prior.length > size
        {
            return Err("临时文件的类型或长度与断点不匹配。".into());
        }
        // Hash the remote prefix on the host when shell tools are available.
        // SFTP-only servers fall back to reading the prefix for verification.
        let remote_digest = match (source, part, prior.length) {
            (_, _, 0) => None,
            (_, Place::Remote(path), length) | (Place::Remote(path), _, length) => tokio::select! {
                digest = remote_prefix_digest(&file.session, path, length) => digest,
                _ = self.pause.cancelled() => return Err("已保留传输断点。".into()),
                _ = self.cancel.cancelled() => return Err("传输已取消。".into()),
            },
            _ => unreachable!(),
        };
        if remote_digest
            .as_ref()
            .is_some_and(|value| *value != prior.digest)
        {
            return Err("远端文件与断点校验不一致，请取消后重新传输。".into());
        }
        match (source, part) {
            (Place::Local(src), Place::Remote(dst)) => {
                let mut reader = fs::File::open(src).await.map_err(error)?;
                let mut writer = sftp
                    .open_with_flags(dst, OpenFlags::READ | OpenFlags::WRITE)
                    .await
                    .map_err(error)?;
                let result = self
                    .stream(
                        ws,
                        file,
                        cp,
                        index,
                        &prior,
                        remote_digest.is_some(),
                        &mut reader,
                        &mut writer,
                        size,
                        bytes,
                        last_save,
                    )
                    .await;
                let closed = writer.close().await.map_err(error);
                result.and(closed)
            }
            (Place::Remote(src), Place::Local(dst)) => {
                let mut reader = sftp.open(src).await.map_err(error)?;
                let mut writer = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(dst)
                    .await
                    .map_err(error)?;
                self.stream(
                    ws,
                    file,
                    cp,
                    index,
                    &prior,
                    remote_digest.is_some(),
                    &mut reader,
                    &mut writer,
                    size,
                    bytes,
                    last_save,
                )
                .await?;
                writer.sync_all().await.map_err(error)
            }
            _ => unreachable!(),
        }
    }

    async fn stream(
        &self,
        ws: &Workspace,
        file: &File,
        cp: &mut Checkpoint,
        index: usize,
        prefix: &Prefix,
        remote_verified: bool,
        source: &mut (impl AsyncRead + AsyncSeek + Unpin),
        dest: &mut (impl AsyncRead + AsyncWrite + AsyncSeek + Unpin),
        size: u64,
        bytes: &mut u64,
        last_save: &mut Instant,
    ) -> Result<(), String> {
        let mut buf = vec![0u8; 128 * 1024];
        let mut sha = Sha256::new();
        let mut offset = 0;
        // Restore the hash state from the local prefix. When remote hashing is
        // unavailable, independently verify the other endpoint over SFTP.
        let mut peer_hash = Sha256::new();
        while offset < prefix.length {
            self.interrupted()?;
            let count = (prefix.length - offset).min(buf.len() as u64) as usize;
            if file.upload {
                source.read_exact(&mut buf[..count]).await.map_err(error)?;
            } else {
                dest.read_exact(&mut buf[..count]).await.map_err(error)?;
            }
            sha.update(&buf[..count]);
            if !remote_verified {
                if file.upload {
                    dest.read_exact(&mut buf[..count]).await.map_err(error)?;
                } else {
                    source.read_exact(&mut buf[..count]).await.map_err(error)?;
                }
                peer_hash.update(&buf[..count]);
            }
            offset += count as u64;
        }
        if offset > 0
            && (format!("{:x}", sha.clone().finalize()) != prefix.digest
                || (!remote_verified && format!("{:x}", peer_hash.finalize()) != prefix.digest))
        {
            return Err("文件内容与断点校验不一致，请取消后重新传输。".into());
        }
        source.seek(SeekFrom::Start(offset)).await.map_err(error)?;
        dest.seek(SeekFrom::Start(offset)).await.map_err(error)?;
        let mut last_event = Instant::now();
        let mut last_confirmed = offset;
        loop {
            let stop = self.interrupted();
            let first_chunk = cp.prefixes.is_empty();
            if offset != last_confirmed
                && (stop.is_err()
                    || offset == size
                    || last_save.elapsed() >= Duration::from_secs(2)
                    || first_chunk)
            {
                dest.flush().await.map_err(error)?;
                cp.prefixes.insert(
                    index,
                    Prefix {
                        length: offset,
                        digest: format!("{:x}", sha.clone().finalize()),
                    },
                );
                if last_save.elapsed() >= Duration::from_secs(2) || first_chunk {
                    cp.persist(ws, self.id)?;
                    self.emit(ws, file, "running", *bytes, "");
                    *last_save = Instant::now();
                }
                last_confirmed = offset;
            }
            stop?;
            if offset == size {
                break;
            }
            let limit = (size - offset).min(buf.len() as u64) as usize;
            let n = source.read(&mut buf[..limit]).await.map_err(error)?;
            if n == 0 {
                return Err("源文件提前结束。".into());
            }
            dest.write_all(&buf[..n]).await.map_err(error)?;
            sha.update(&buf[..n]);
            offset += n as u64;
            *bytes += n as u64;
            if last_event.elapsed() >= Duration::from_millis(125) {
                self.emit(ws, file, "running", *bytes, "");
                last_event = Instant::now();
            }
        }
        Ok(())
    }
}
