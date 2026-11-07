use crate::{
    error,
    git_https::HttpsRepo,
    keys, now,
    store::{portable_rows, Binding, GitMigration, Row},
    vault::{self, GitEnvelope, Key, MAX_GIT_DOCUMENT},
    Workspace,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    process::Stdio,
    sync::LazyLock,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroize;

const DEFAULT_BRANCH: &str = "termlume-vault";

pub fn default_branch() -> String {
    DEFAULT_BRANCH.into()
}

pub fn branch_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() {
        return Ok(default_branch());
    }
    // Validate a short branch name without Git's @{-n} checkout expansion.
    if name.len() > 240
        || matches!(name, "HEAD" | "@")
        || name.starts_with('-')
        || name.starts_with("refs/heads/")
        || name.ends_with('.')
        || name.contains("..")
        || name.contains("@{")
        || name
            .bytes()
            .any(|b| b <= b' ' || b == 127 || b"~^:?*[\\".contains(&b))
        || name
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"))
    {
        return Err("请输入有效的 Git 分支名称，例如 termlume-vault 或 vault/personal。".into());
    }
    Ok(name.into())
}

pub fn remote_url(value: &str) -> Result<String, String> {
    static SCP: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[a-zA-Z0-9_./~-]+$").unwrap()
    });
    static SSH: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^ssh://(?:[a-z0-9_.-]+@)?(?:[a-z0-9_.-]+|\[[a-f0-9:]+\])(?::[0-9]{1,5})?/[a-z0-9_./~-]+$").unwrap()
    });
    let value = value.trim();
    if value.len() <= 1024 {
        if let Ok(url) = url::Url::parse(value) {
            if url.scheme() == "https"
                && url.host().is_some()
                && value
                    .get(..8)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
                && !value.chars().any(char::is_whitespace)
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && !url.path().trim_matches('/').is_empty()
                && !value.contains('\\')
            {
                return Ok(url.into());
            }
        }
        if SCP.is_match(value) {
            return Ok(value.into());
        }
        if SSH.is_match(value) {
            if let Ok(url) = url::Url::parse(value) {
                return Ok(url.into());
            }
        }
    }
    Err("请输入 SSH 或 HTTPS 仓库地址，地址中请勿包含用户名、密码或 Token。".into())
}

#[derive(Clone, Deserialize, Serialize)]
pub struct GitAuth {
    pub username: String,
    pub token: String,
}

impl Drop for GitAuth {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

pub fn resolve_auth(
    remote: &str,
    input: Option<GitAuth>,
    saved: Option<GitAuth>,
) -> Result<Option<GitAuth>, String> {
    if !remote.starts_with("https://") {
        return Ok(None);
    }
    let mut auth = input
        .or(saved)
        .ok_or("请输入 HTTPS 仓库的用户名和访问 Token。")?;
    auth.username = auth.username.trim().into();
    auth.token = auth.token.trim().into();
    if auth.username.is_empty()
        || auth.username.len() > 256
        || auth.username.contains(':')
        || auth.username.chars().any(char::is_control)
        || auth.token.is_empty()
        || auth.token.len() > 4096
        || auth
            .token
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("HTTPS 仓库的用户名或访问 Token 格式无效。".into());
    }
    Ok(Some(auth))
}

enum Transport {
    System(tempfile::TempDir),
    Https(HttpsRepo),
}

pub struct Repo {
    transport: Transport,
    remote: String,
    reference: String,
    cancel: CancellationToken,
}
pub struct Tip {
    pub commit: String,
    pub parent: Option<String>,
    pub envelope: GitEnvelope,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub hosts: Vec<Row>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_commit: Option<String>,
}
#[derive(Clone)]
pub struct GitError {
    code: Option<i32>,
    detail: String,
    pub(crate) concurrent: bool,
}
impl From<GitError> for String {
    fn from(e: GitError) -> Self {
        e.detail
    }
}
impl GitError {
    pub(crate) fn message(detail: impl Into<String>) -> Self {
        Self {
            code: None,
            detail: detail.into(),
            concurrent: false,
        }
    }
}

impl Repo {
    pub async fn open(
        remote: String,
        branch: &str,
        auth: Option<GitAuth>,
        cancel: CancellationToken,
    ) -> Result<Self, String> {
        let transport = if remote.starts_with("https://") {
            let auth = resolve_auth(&remote, auth, None)?.unwrap();
            Transport::Https(HttpsRepo::open(remote.clone(), auth, cancel.clone()).await?)
        } else {
            if cfg!(mobile) {
                return Err("手机端请使用 HTTPS 仓库地址和访问 Token。".into());
            }
            Transport::System(tempfile::tempdir().map_err(error)?)
        };
        let repo = Self {
            transport,
            remote,
            reference: format!("refs/heads/{branch}"),
            cancel,
        };
        if matches!(&repo.transport, Transport::System(_)) {
            repo.run(&["init", "--bare", "--quiet", "--template="], None)
                .await?;
        }
        Ok(repo)
    }
    async fn run(&self, args: &[&str], input: Option<&[u8]>) -> Result<String, GitError> {
        if self.cancel.is_cancelled() {
            return Err(GitError::message("同步已取消。"));
        }
        let Transport::System(dir) = &self.transport else {
            return Err(GitError::message("系统 Git 仅用于 SSH 连接。"));
        };
        let mut cmd = Command::new("/usr/bin/git");
        cmd.args(["-c", "core.hooksPath=/dev/null"])
            .args(args)
            .current_dir(dir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, _) in
            std::env::vars_os().filter(|(key, _)| key.to_string_lossy().starts_with("GIT_"))
        {
            cmd.env_remove(key);
        }
        cmd.env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_SSH_COMMAND", "/usr/bin/ssh -o BatchMode=yes -o ForwardAgent=no -o StrictHostKeyChecking=yes -o ConnectTimeout=12")
            .env("GIT_AUTHOR_NAME", "Termlume").env("GIT_COMMITTER_NAME", "Termlume")
            .env("GIT_AUTHOR_EMAIL", "vault@termlume.invalid").env("GIT_COMMITTER_EMAIL", "vault@termlume.invalid");
        if let Some(socket) = keys::agent_socket() {
            cmd.env("SSH_AUTH_SOCK", socket);
        }
        #[cfg(test)]
        if let Some(fixture) = std::env::var_os("TERMLUME_TEST_FIXTURE") {
            let known_hosts = std::path::Path::new(&fixture).join("known_hosts");
            cmd.env("GIT_SSH_COMMAND", format!("/usr/bin/ssh -F /dev/null -o BatchMode=yes -o ForwardAgent=no -o StrictHostKeyChecking=yes -o UserKnownHostsFile={}", known_hosts.display()));
        }
        let mut child = cmd.spawn().map_err(|e| GitError::message(error(e)))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or(GitError::message("Git 输入不可用。"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(GitError::message("Git 输出不可用。"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or(GitError::message("Git 输出不可用。"))?;
        let io = async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let mut stdout = stdout.take(MAX_GIT_DOCUMENT + 4097);
            let mut stderr = stderr.take(MAX_GIT_DOCUMENT + 4097);
            let ((), _, _, status) = tokio::try_join!(
                async move {
                    if let Some(bytes) = input {
                        stdin.write_all(bytes).await?;
                    }
                    drop(stdin);
                    Ok::<_, std::io::Error>(())
                },
                stdout.read_to_end(&mut out),
                stderr.read_to_end(&mut err),
                child.wait()
            )
            .map_err(|e| GitError::message(error(e)))?;
            if out.len() as u64 > MAX_GIT_DOCUMENT + 4096
                || err.len() as u64 > MAX_GIT_DOCUMENT + 4096
            {
                return Err(GitError::message("Git 输出超出限制。"));
            }
            if status.success() {
                return String::from_utf8(out).map_err(|e| GitError::message(error(e)));
            }
            let detail = String::from_utf8_lossy(&err);
            let summary = format!("{detail}\n{}", String::from_utf8_lossy(&out)).to_lowercase();
            let concurrent = [
                "non-fast-forward",
                "fetch first",
                "cannot lock ref",
                "stale info",
            ]
            .iter()
            .any(|s| summary.contains(s));
            let detail: String = detail.trim().chars().take(1500).collect();
            Err(GitError {
                code: status.code(),
                concurrent,
                detail: if detail.is_empty() {
                    "Git 操作失败，请检查仓库及 SSH 授权。".into()
                } else {
                    detail
                },
            })
        };
        tokio::select! {
            _ = self.cancel.cancelled() => Err(GitError::message("同步已取消。")),
            result = tokio::time::timeout(Duration::from_secs(45), io) => result.map_err(|_| GitError::message("Git 操作超时。"))?
        }
    }
    async fn refs(&self) -> Result<String, String> {
        if let Transport::Https(repo) = &self.transport {
            return Ok(repo.refs().await?);
        }
        Ok(self
            .run(&["ls-remote", "--refs", "--", &self.remote], None)
            .await?)
    }

    fn advertised_commit<'a>(&self, refs: &'a str) -> Option<&'a str> {
        refs.lines()
            .filter_map(|line| line.split_once('\t'))
            .find_map(|(commit, name)| (name == self.reference).then_some(commit))
    }

    pub async fn fetch(&self) -> Result<Option<Tip>, String> {
        if let Transport::Https(repo) = &self.transport {
            if self.advertised_commit(&repo.refs().await?).is_none() {
                return Ok(None);
            }
            return Ok(Some(repo.fetch(&self.reference).await?));
        }
        let refs = match self
            .run(
                &[
                    "ls-remote",
                    "--refs",
                    "--exit-code",
                    "--",
                    &self.remote,
                    &self.reference,
                ],
                None,
            )
            .await
        {
            Ok(refs) => refs,
            Err(e) if e.code == Some(2) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if self.advertised_commit(&refs).is_none() {
            return Ok(None);
        }
        self.run(
            &[
                "fetch",
                "--quiet",
                "--no-tags",
                "--",
                &self.remote,
                &self.reference,
            ],
            None,
        )
        .await?;
        let row = self
            .run(&["rev-list", "--parents", "-n", "1", "FETCH_HEAD"], None)
            .await?;
        let ids: Vec<_> = row.split_whitespace().collect();
        if ids.is_empty() || ids.len() > 2 {
            return Err("同步分支提交历史无效。".into());
        }
        let spec = format!("{}:vault.json", ids[0]);
        let size = self
            .run(&["cat-file", "-s", &spec], None)
            .await?
            .trim()
            .parse::<u64>()
            .map_err(error)?;
        if size == 0 || size > MAX_GIT_DOCUMENT {
            return Err("仓库中的保险库大小无效。".into());
        }
        let json = self.run(&["cat-file", "blob", &spec], None).await?;
        Ok(Some(Tip {
            commit: ids[0].into(),
            parent: ids.get(1).map(|s| s.to_string()),
            envelope: serde_json::from_str(&json).map_err(error)?,
        }))
    }
    async fn descendant(&self, base: &str, tip: &str) -> Result<bool, String> {
        if !valid_commit(base) || !valid_commit(tip) {
            return Err("同步提交标识无效。".into());
        }
        if let Transport::Https(repo) = &self.transport {
            return Ok(repo.descendant(base.into(), tip.into()).await?);
        }
        match self
            .run(&["merge-base", "--is-ancestor", base, tip], None)
            .await
        {
            Ok(_) => Ok(true),
            Err(e) if matches!(e.code, Some(1 | 128)) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
    async fn create_commit(
        &self,
        envelope: &GitEnvelope,
        parent: Option<&str>,
    ) -> Result<String, GitError> {
        if let Transport::Https(repo) = &self.transport {
            return repo.create_commit(envelope, parent).await;
        }
        let bytes = serde_json::to_vec(envelope).map_err(|e| GitError::message(error(e)))?;
        let blob = self
            .run(&["hash-object", "-w", "--stdin"], Some(&bytes))
            .await?;
        let line = format!("100644 blob {}\tvault.json\n", blob.trim());
        let tree = self.run(&["mktree"], Some(line.as_bytes())).await?;
        let mut args = vec!["commit-tree", tree.trim()];
        if let Some(parent) = parent {
            args.extend(["-p", parent]);
        }
        args.extend(["-m", "Update encrypted Termlume vault"]);
        Ok(self.run(&args, None).await?.trim().to_string())
    }

    async fn push_commit(&self, commit: &str, create_only: bool) -> Result<(), GitError> {
        if let Transport::Https(repo) = &self.transport {
            return repo.push(commit, &self.reference, create_only).await;
        }
        let lease = format!("--force-with-lease={}:", self.reference);
        let refspec = format!("{commit}:{}", self.reference);
        let mut args = vec!["push", "--porcelain"];
        if create_only {
            args.push(&lease);
        }
        args.extend(["--", &self.remote, &refspec]);
        self.run(&args, None).await?;
        Ok(())
    }

    async fn push(&self, envelope: &GitEnvelope, parent: Option<&str>) -> Result<String, GitError> {
        let commit = self.create_commit(envelope, parent).await?;
        self.push_commit(&commit, false).await?;
        Ok(commit)
    }
}
fn valid_commit(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub struct Conflict {
    ticket: Uuid,
    remote: String,
    branch: String,
    commit: Option<String>,
    local: Vec<Row>,
    migration: Option<(String, String)>,
}
#[derive(Deserialize)]
pub struct SyncRequest {
    #[serde(default)]
    address: String,
    branch: Option<String>,
    #[serde(rename = "syncKey")]
    sync_key: Option<String>,
    auth: Option<GitAuth>,
    #[serde(default, rename = "changeConnection")]
    change_connection: bool,
    ticket: Option<Uuid>,
    #[serde(default)]
    choices: BTreeMap<Uuid, String>,
}

#[derive(Deserialize)]
pub struct MigrationRequest {
    #[serde(flatten)]
    target: SyncRequest,
    #[serde(default)]
    abandon: bool,
}

fn snapshot_at(
    tip: &Tip,
    key: &Key,
    vault_id: Uuid,
    sync_key: Option<&Key>,
) -> Result<Vec<Row>, String> {
    let envelope = tip.envelope.open(sync_key)?;
    if envelope.header.id != vault_id {
        return Err("仓库中是另一套保险库。".into());
    }
    let data: Snapshot = envelope.decode(key, "portable")?;
    if data.parent_commit != tip.parent {
        return Err("快照与仓库提交历史不一致。".into());
    }
    portable_rows(data.hosts)
}

fn merge(
    base: &[Row],
    local: &[Row],
    remote: &[Row],
    choices: &BTreeMap<Uuid, String>,
) -> (Vec<Row>, Vec<Value>) {
    let index = |rows: &[Row]| {
        rows.iter()
            .map(|row| (row.host.id, row.clone()))
            .collect::<BTreeMap<_, _>>()
    };
    let (base, local, remote) = (index(base), index(local), index(remote));
    let mut rows = Vec::new();
    let mut conflicts = Vec::new();
    for id in base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .copied()
        .collect::<BTreeSet<_>>()
    {
        let (before, ours, theirs) = (base.get(&id), local.get(&id), remote.get(&id));
        let picked = if ours == theirs || theirs == before {
            ours
        } else if ours == before {
            theirs
        } else {
            match choices.get(&id).map(String::as_str) {
                Some("local") => ours,
                Some("remote") => theirs,
                _ => {
                    conflicts
                        .push(json!({"id": id, "local": summary(ours), "remote": summary(theirs)}));
                    None
                }
            }
        };
        if let Some(row) = picked {
            rows.push(row.clone());
        }
    }
    (rows, conflicts)
}
fn summary(row: Option<&Row>) -> Value {
    row.map(|row| {
        let mut result = json!(row.host);
        result["passwordSaved"] = json!(row.password.is_some());
        result
    })
    .unwrap_or(json!({"deleted":true}))
}

pub async fn synchronize(ws: &Workspace, input: SyncRequest) -> Result<Value, String> {
    let _permit = ws
        .sync_gate
        .try_lock()
        .map_err(|_| "已有同步任务正在运行。")?;
    let cancel = CancellationToken::new();
    let (remote, branch, auth, sync_secret, key, header, epoch) = {
        let store = ws.store.lock().unwrap();
        let data = store.data()?;
        if data.git_migration.is_some() {
            return Err("请先继续或放弃待完成的 Git 迁移。".into());
        }
        let saved = data.sync.as_ref().map(|s| s.remote.as_str()).unwrap_or("");
        let remote = remote_url(if input.address.trim().is_empty() {
            saved
        } else {
            &input.address
        })?;
        if !saved.is_empty() && saved != remote && !input.change_connection {
            return Err("请在同步设置中更改仓库连接。".into());
        }
        let prior = data.sync.as_ref();
        let branch = branch_name(
            input
                .branch
                .as_deref()
                .or(prior.map(|s| s.branch.as_str()))
                .unwrap_or(""),
        )?;
        if prior.is_some_and(|s| (s.branch != branch || s.remote != remote) && s.commit.is_none()) {
            return Err("请先完成当前分支的首次同步。".into());
        }
        let saved_key = prior.and_then(|s| s.sync_key.as_deref());
        let entered_key = input
            .sync_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let auth = resolve_auth(
            &remote,
            input.auth.clone(),
            prior
                .filter(|p| p.remote == remote)
                .and_then(|p| p.auth.clone()),
        )?;
        let sync_secret = entered_key.or(saved_key).map(str::to_owned);
        let key = store.key.clone().ok_or("请先启用并解锁保险库。")?;
        let header = store
            .envelope
            .as_ref()
            .ok_or("请先启用并解锁保险库。")?
            .header
            .clone();
        *ws.sync_cancel.lock().unwrap() = Some(cancel.clone());
        (remote, branch, auth, sync_secret, key, header, store.epoch)
    };
    let result = async {
        let repo = Repo::open(remote.clone(), &branch, auth.clone(), cancel).await?;
        for attempt in 0..3 {
            let tip = repo.fetch().await?;
            let prior = {
                let store = ws.store.lock().unwrap();
                crate::ensure_epoch(&store, epoch)?;
                store.data()?.sync.clone()
            };
            if prior.is_none() && tip.is_some() {
                return Err("仓库的同步分支已有保险库，请用「从 Git 恢复」。".into());
            }
            if let Some(commit) = prior.as_ref().and_then(|s| s.commit.as_deref()) {
                let ok = match &tip {
                    Some(tip) => repo.descendant(commit, &tip.commit).await?,
                    None => false,
                };
                if !ok {
                    if prior.as_ref().is_some_and(|s| s.remote != remote) {
                        return Err("新地址必须指向包含上次同步提交的仓库。换到空仓库请用「迁移到新仓库」。".into());
                    }
                    if prior.as_ref().is_some_and(|s| s.branch != branch) {
                        return Err(
                            "目标分支必须包含上次同步的提交。请先在 Git 服务上创建或重命名分支。"
                                .into(),
                        );
                    }
                    return Err("远端同步分支已删除或历史已重写，同步已暂停。".into());
                }
            }
            let old_format = tip.as_ref().is_some_and(|t| t.envelope.is_protected());
            let sync_key = if old_format {
                sync_secret.as_deref().map(vault::git_key).transpose()?
            } else { None };
            let theirs = if let Some(tip) = &tip {
                snapshot_at(tip, &key, header.id, sync_key.as_ref())?
            } else {
                vec![]
            };
            let tip_commit = tip.as_ref().map(|t| t.commit.clone());
            let (ours, records) = {
                let mut store = ws.store.lock().unwrap();
                crate::ensure_epoch(&store, epoch)?;
                let mut data = store.data()?.clone();
                if data.sync.is_none() {
                    data.sync = Some(Binding {
                        remote: remote.clone(),
                        branch: branch.clone(),
                        sync_key: None,
                        auth: auth.clone(),
                        commit: None,
                        base: vec![],
                        last_synced: None,
                    });
                    store.update(data.clone())?;
                }
                let ours = data.snapshot();
                let mut pending = ws.conflict.lock().unwrap();
                let choices = if pending.as_ref().is_some_and(|c| {
                    Some(c.ticket) == input.ticket
                        && c.remote == remote
                        && c.branch == branch
                        && c.commit == tip_commit
                        && c.local == ours
                        && c.migration.is_none()
                }) {
                    input.choices.clone()
                } else {
                    BTreeMap::new()
                };
                let base = prior.as_ref().map(|p| p.base.as_slice()).unwrap_or(&[]);
                let (records, conflicts) = merge(base, &ours, &theirs, &choices);
                if !conflicts.is_empty() {
                    let ticket = Uuid::new_v4();
                    *pending = Some(Conflict {
                        ticket,
                        remote: remote.clone(),
                        branch: branch.clone(),
                        commit: tip_commit.clone(),
                        local: ours,
                        migration: None,
                    });
                    return Ok(json!({"ticket": ticket, "conflicts": conflicts}));
                }
                (ours, records)
            };
            let commit = if tip_commit.is_none() || old_format || records != theirs {
                let envelope = vault::encode(
                    &key,
                    &header,
                    "portable",
                    &json!({"hosts": records, "parentCommit": tip_commit}),
                )?;
                match repo.push(&GitEnvelope::Legacy(envelope), tip_commit.as_deref()).await {
                    Ok(commit) => Some(commit),
                    Err(e) if e.concurrent && attempt < 2 => continue,
                    Err(e) => return Err(e.into()),
                }
            } else {
                tip_commit
            };
            let mut store = ws.store.lock().unwrap();
            crate::ensure_epoch(&store, epoch)?;
            let mut data = store.data()?.clone();
            let latest = data.snapshot();
            let prefer_newer = ours
                .iter()
                .chain(&latest)
                .map(|r| (r.host.id, "local".into()))
                .collect();
            let (local, _) = merge(&ours, &latest, &records, &prefer_newer);
            let pending = local != records;
            data.apply(
                local,
                Some(Binding {
                    remote: remote.clone(),
                    branch: branch.clone(),
                    sync_key: None,
                    auth: auth.clone(),
                    commit,
                    base: records,
                    last_synced: Some(now()),
                }),
            );
            store.update(data)?;
            *ws.conflict.lock().unwrap() = None;
            return Ok(json!({"state": store.status(), "pending": pending}));
        }
        Err("远端同步分支持续更新，请稍后重试。".into())
    }
    .await;
    ws.sync_cancel.lock().unwrap().take();
    result
}

pub async fn migrate(ws: &Workspace, input: MigrationRequest) -> Result<Value, String> {
    let _permit = ws
        .sync_gate
        .try_lock()
        .map_err(|_| "已有同步任务正在运行。")?;
    let cancel = CancellationToken::new();
    let (prior, target, pending, key, header, epoch) = {
        let mut store = ws.store.lock().unwrap();
        let data = store.data()?;
        if input.abandon {
            if data.git_migration.is_some() {
                let mut data = data.clone();
                data.git_migration = None;
                store.update(data)?;
                *ws.conflict.lock().unwrap() = None;
            }
            return Ok(json!({"state": store.status()}));
        }
        let prior = data.sync.clone().ok_or("请先绑定旧 Git 仓库。")?;
        if prior.commit.is_none() {
            return Err("请先完成旧仓库的首次同步。".into());
        }
        let pending = data.git_migration.clone();
        let remote = remote_url(if input.target.address.trim().is_empty() {
            pending.as_ref().map(|m| m.remote.as_str()).unwrap_or("")
        } else {
            &input.target.address
        })?;
        let branch = branch_name(
            input
                .target
                .branch
                .as_deref()
                .or(pending.as_ref().map(|m| m.branch.as_str()))
                .unwrap_or(""),
        )?;
        if remote == prior.remote {
            return Err("请选择一个新的空仓库。".into());
        }
        if pending
            .as_ref()
            .is_some_and(|m| m.remote != remote || m.branch != branch)
        {
            return Err("请继续或放弃待完成的 Git 迁移后，再更改目标。".into());
        }
        let auth = resolve_auth(
            &remote,
            input.target.auth.clone(),
            pending.as_ref().and_then(|m| m.auth.clone()),
        )?;
        let target = GitMigration {
            remote,
            branch,
            sync_key: pending.as_ref().and_then(|m| m.sync_key.clone()),
            auth,
            commit: String::new(),
        };
        let key = store.key.clone().ok_or("请先启用并解锁保险库。")?;
        let header = store
            .envelope
            .as_ref()
            .ok_or("请先启用并解锁保险库。")?
            .header
            .clone();
        *ws.sync_cancel.lock().unwrap() = Some(cancel.clone());
        (prior, target, pending, key, header, store.epoch)
    };
    let result = async {
        let mut target = target;
        let destination = Repo::open(
            target.remote.clone(),
            &target.branch,
            target.auth.clone(),
            cancel.clone(),
        )
        .await?;
        let refs = destination.refs().await?;
        let records = if let Some(saved) =
            pending.filter(|m| destination.advertised_commit(&refs) == Some(m.commit.as_str()))
        {
            // The push succeeded before the local binding could be committed.
            let tip = destination
                .fetch()
                .await?
                .filter(|tip| tip.commit == saved.commit && tip.parent.is_none())
                .ok_or("新仓库刚有更新，请核对目标仓库。")?;
            target.commit = saved.commit;
            let target_key = target.sync_key.as_deref().map(vault::git_key).transpose()?;
            snapshot_at(&tip, &key, header.id, target_key.as_ref())?
        } else {
            if !refs.is_empty() {
                return Err("目标仓库必须为空，请创建不含分支或标签的新仓库。".into());
            }
            let source = Repo::open(
                prior.remote.clone(),
                &prior.branch,
                prior.auth.clone(),
                cancel,
            )
            .await?;
            let tip = source.fetch().await?.ok_or("旧同步分支已删除。")?;
            if !source
                .descendant(prior.commit.as_deref().unwrap(), &tip.commit)
                .await?
            {
                return Err("旧同步分支的历史已重写，迁移已暂停。".into());
            }
            let source_key = if tip.envelope.is_protected() {
                input
                    .target
                    .sync_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|key| !key.is_empty())
                    .or(prior.sync_key.as_deref())
                    .map(vault::git_key)
                    .transpose()?
            } else {
                None
            };
            let theirs = snapshot_at(&tip, &key, header.id, source_key.as_ref())?;
            let migration = Some((target.remote.clone(), target.branch.clone()));
            let (ours, records) = {
                let store = ws.store.lock().unwrap();
                crate::ensure_epoch(&store, epoch)?;
                let ours = store.data()?.snapshot();
                let mut pending = ws.conflict.lock().unwrap();
                let choices = if pending.as_ref().is_some_and(|c| {
                    Some(c.ticket) == input.target.ticket
                        && c.remote == prior.remote
                        && c.branch == prior.branch
                        && c.commit.as_deref() == Some(&tip.commit)
                        && c.local == ours
                        && c.migration == migration
                }) {
                    input.target.choices
                } else {
                    BTreeMap::new()
                };
                let (records, conflicts) = merge(&prior.base, &ours, &theirs, &choices);
                if !conflicts.is_empty() {
                    let ticket = Uuid::new_v4();
                    *pending = Some(Conflict {
                        ticket,
                        remote: prior.remote.clone(),
                        branch: prior.branch.clone(),
                        commit: Some(tip.commit),
                        local: ours,
                        migration,
                    });
                    return Ok(json!({"ticket": ticket, "conflicts": conflicts}));
                }
                (ours, records)
            };
            let envelope = vault::encode(
                &key,
                &header,
                "portable",
                &json!({"hosts": records, "parentCommit": null}),
            )?;
            target.sync_key = None;
            target.commit = destination
                .create_commit(&GitEnvelope::Legacy(envelope), None)
                .await?;
            if source.advertised_commit(&source.refs().await?) != Some(&tip.commit) {
                return Err("旧仓库刚有更新，请重试迁移。".into());
            }
            if !destination.refs().await?.is_empty() {
                return Err("目标仓库已出现提交，请更换空仓库。".into());
            }
            {
                let mut store = ws.store.lock().unwrap();
                crate::ensure_epoch(&store, epoch)?;
                let mut data = store.data()?.clone();
                let latest = data.snapshot();
                let prefer_newer = ours
                    .iter()
                    .chain(&latest)
                    .map(|r| (r.host.id, "local".into()))
                    .collect();
                let (local, _) = merge(&ours, &latest, &records, &prefer_newer);
                // Persist the integrated rows and expected root before any remote write.
                data.apply(
                    local,
                    Some(Binding {
                        commit: Some(tip.commit),
                        base: theirs,
                        ..prior
                    }),
                );
                data.git_migration = Some(target.clone());
                store.update(data)?;
            }
            destination.push_commit(&target.commit, true).await?;
            records
        };
        let mut store = ws.store.lock().unwrap();
        crate::ensure_epoch(&store, epoch)?;
        let mut data = store.data()?.clone();
        let pending = data.snapshot() != records;
        data.sync = Some(Binding {
            remote: target.remote,
            branch: target.branch,
            sync_key: target.sync_key,
            auth: target.auth,
            commit: Some(target.commit),
            base: records,
            last_synced: Some(now()),
        });
        data.git_migration = None;
        store.update(data)?;
        *ws.conflict.lock().unwrap() = None;
        Ok(json!({"state": store.status(), "pending": pending}))
    }
    .await;
    ws.sync_cancel.lock().unwrap().take();
    result
}
