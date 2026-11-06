use crate::{
    error, keys, now,
    store::{portable_rows, Binding, Row},
    vault::{self, Envelope, MAX_DOCUMENT},
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

const BRANCH: &str = "refs/heads/termlume-vault";

pub fn remote_url(value: &str) -> Result<String, String> {
    static SCP: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[a-zA-Z0-9_./~-]+$").unwrap()
    });
    static SSH: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^ssh://(?:[a-z0-9_.-]+@)?(?:[a-z0-9_.-]+|\[[a-f0-9:]+\])(?::[0-9]{1,5})?/[a-z0-9_./~-]+$").unwrap()
    });
    let value = value.trim();
    if value.len() <= 1024 {
        if SCP.is_match(value) {
            return Ok(value.into());
        }
        if SSH.is_match(value) {
            if let Ok(url) = url::Url::parse(value) {
                return Ok(url.into());
            }
        }
    }
    Err("请输入 Git 仓库的 SSH 地址，例如 git@github.com:owner/repo.git。".into())
}

pub struct Repo {
    dir: tempfile::TempDir,
    remote: String,
    cancel: CancellationToken,
}
pub struct Tip {
    pub commit: String,
    pub parent: Option<String>,
    pub envelope: Envelope,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub hosts: Vec<Row>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_commit: Option<String>,
}
struct GitError {
    code: Option<i32>,
    detail: String,
    concurrent: bool,
}
impl From<GitError> for String {
    fn from(e: GitError) -> Self {
        e.detail
    }
}
impl GitError {
    fn message(detail: impl Into<String>) -> Self {
        Self {
            code: None,
            detail: detail.into(),
            concurrent: false,
        }
    }
}

impl Repo {
    pub async fn open(remote: String, cancel: CancellationToken) -> Result<Self, String> {
        let repo = Self {
            dir: tempfile::tempdir().map_err(error)?,
            remote,
            cancel,
        };
        repo.run(&["init", "--bare", "--quiet", "--template="], None)
            .await?;
        Ok(repo)
    }
    async fn run(&self, args: &[&str], input: Option<&[u8]>) -> Result<String, GitError> {
        let mut cmd = Command::new("/usr/bin/git");
        cmd.args(["-c", "core.hooksPath=/dev/null"])
            .args(args)
            .current_dir(self.dir.path())
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
            let mut stdout = stdout.take(MAX_DOCUMENT + 4097);
            let mut stderr = stderr.take(MAX_DOCUMENT + 4097);
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
            if out.len() as u64 > MAX_DOCUMENT + 4096 || err.len() as u64 > MAX_DOCUMENT + 4096 {
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
    pub async fn fetch(&self) -> Result<Option<Tip>, String> {
        if let Err(e) = self
            .run(
                &["ls-remote", "--refs", "--exit-code", &self.remote, BRANCH],
                None,
            )
            .await
        {
            if e.code == Some(2) {
                return Ok(None);
            }
            return Err(e.into());
        }
        self.run(
            &["fetch", "--quiet", "--no-tags", "--", &self.remote, BRANCH],
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
        if size == 0 || size > MAX_DOCUMENT {
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
        match self
            .run(&["merge-base", "--is-ancestor", base, tip], None)
            .await
        {
            Ok(_) => Ok(true),
            Err(e) if matches!(e.code, Some(1 | 128)) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
    async fn push(&self, envelope: &Envelope, parent: Option<&str>) -> Result<String, GitError> {
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
        let commit = self.run(&args, None).await?.trim().to_string();
        self.run(
            &[
                "push",
                "--porcelain",
                "--",
                &self.remote,
                &format!("{commit}:{BRANCH}"),
            ],
            None,
        )
        .await?;
        Ok(commit)
    }
}
fn valid_commit(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub struct Conflict {
    ticket: Uuid,
    remote: String,
    commit: Option<String>,
    local: Vec<Row>,
}
#[derive(Deserialize)]
pub struct SyncRequest {
    #[serde(default)]
    address: String,
    ticket: Option<Uuid>,
    #[serde(default)]
    choices: BTreeMap<Uuid, String>,
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
    let (remote, key, header, epoch) = {
        let store = ws.store.lock().unwrap();
        let data = store.data()?;
        let saved = data.sync.as_ref().map(|s| s.remote.as_str()).unwrap_or("");
        let remote = remote_url(if input.address.trim().is_empty() {
            saved
        } else {
            &input.address
        })?;
        if !saved.is_empty() && saved != remote {
            return Err("此保险库已绑定另一仓库。".into());
        }
        let key = store.key.clone().ok_or("请先启用并解锁保险库。")?;
        let header = store
            .envelope
            .as_ref()
            .ok_or("请先启用并解锁保险库。")?
            .header
            .clone();
        *ws.sync_cancel.lock().unwrap() = Some(cancel.clone());
        (remote, key, header, store.epoch)
    };
    let result = async {
        let repo = Repo::open(remote.clone(), cancel).await?;
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
                    return Err("远端同步分支已删除或历史已重写，同步已暂停。".into());
                }
            }
            let theirs = if let Some(tip) = &tip {
                if tip.envelope.header.id != header.id {
                    return Err("仓库中是另一套保险库。".into());
                }
                let data: Snapshot = tip.envelope.decode(&key, "portable")?;
                if data.parent_commit != tip.parent {
                    return Err("快照与仓库提交历史不一致。".into());
                }
                portable_rows(data.hosts)?
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
                        && c.commit == tip_commit
                        && c.local == ours
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
                        commit: tip_commit.clone(),
                        local: ours,
                    });
                    return Ok(json!({"ticket": ticket, "conflicts": conflicts}));
                }
                (ours, records)
            };
            let commit = if tip_commit.is_none() || records != theirs {
                let envelope = vault::encode(
                    &key,
                    &header,
                    "portable",
                    &json!({"hosts": records, "parentCommit": tip_commit}),
                )?;
                match repo.push(&envelope, tip_commit.as_deref()).await {
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
