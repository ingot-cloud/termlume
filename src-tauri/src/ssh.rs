use russh::{
    client,
    keys::{key::PrivateKeyWithHashAlg, HashAlg, PublicKeyOrCertificate},
    Channel, ChannelMsg, Disconnect,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    error, keys,
    store::{Data, Fingerprint, Host, LocalPassword, Password},
    vault::bounded_read,
    Workspace,
};

pub type Client = client::Handle<Verifier>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub id: Uuid,
    expected: Host,
    secret: String,
    #[serde(default)]
    use_saved: bool,
    #[serde(default)]
    remember: bool,
    #[serde(default)]
    share_password: bool,
    #[serde(default)]
    dimensions: Size,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(default)]
pub struct Size {
    cols: u32,
    rows: u32,
}
impl Default for Size {
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}
impl Size {
    fn dimensions(self) -> (u32, u32) {
        (self.cols.clamp(2, 1000), self.rows.clamp(2, 500))
    }
}

pub struct Session {
    pub id: Uuid,
    pub host: Host,
    pub fingerprint: OnceLock<String>,
    pub client: OnceLock<Arc<Client>>,
    pub cancel: CancellationToken,
    trust: Mutex<Option<oneshot::Sender<bool>>>,
    input: OnceLock<mpsc::Sender<TerminalControl>>,
}
pub struct CommandJob {
    pub follow: bool,
    pub stop: CancellationToken,
    pub close: CancellationToken,
}
#[derive(Default)]
pub struct Connections {
    sessions: Mutex<HashMap<Uuid, Arc<Session>>>,
    commands: Mutex<HashMap<Uuid, Arc<CommandJob>>>,
}
pub enum TerminalControl {
    Input(String),
    Resize(Size),
}

impl Connections {
    pub fn get(&self, id: Uuid) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(&id).cloned()
    }
    pub fn connected(&self, id: Uuid) -> Result<Arc<Session>, String> {
        self.get(id)
            .filter(|s| s.client.get().is_some() && !s.cancel.is_cancelled())
            .ok_or("请先连接该主机。".into())
    }
    pub fn begin(&self, id: Uuid, host: Host) -> Result<Arc<Session>, String> {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(&id) || sessions.len() >= 64 {
            return Err("此标签已在连接，或会话数量已达上限。".into());
        }
        let session = Arc::new(Session {
            id,
            host,
            fingerprint: OnceLock::new(),
            client: OnceLock::new(),
            cancel: CancellationToken::new(),
            trust: Mutex::default(),
            input: OnceLock::new(),
        });
        sessions.insert(id, session.clone());
        Ok(session)
    }
    pub fn remove(&self, session: &Arc<Session>) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions
            .get(&session.id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            sessions.remove(&session.id);
            true
        } else {
            false
        }
    }
    pub fn close_pending(&self) {
        for session in self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.client.get().is_none())
        {
            session.cancel.cancel();
        }
    }
    pub fn close_all(&self) {
        for session in self.sessions.lock().unwrap().drain().map(|(_, s)| s) {
            session.cancel.cancel();
        }
        for command in self.commands.lock().unwrap().drain().map(|(_, c)| c) {
            command.close.cancel();
        }
    }
    pub fn trust(&self, id: Uuid, accepted: bool) {
        if let Some(session) = self.get(id) {
            if let Some(reply) = session.trust.lock().unwrap().take() {
                let _ = reply.send(accepted);
            }
        }
    }
    pub async fn send(&self, id: Uuid, input: TerminalControl) {
        if let Some(session) = self.get(id) {
            if let Some(channel) = session.input.get() {
                tokio::select! {
                    _ = session.cancel.cancelled() => {},
                    _ = channel.send(input) => {},
                }
            }
        }
    }
    pub fn stop_command(&self, id: Uuid, close: bool) {
        if let Some(job) = self.commands.lock().unwrap().get(&id) {
            if job.follow {
                job.stop.cancel();
            }
            if close && !job.follow {
                job.close.cancel();
            }
        }
    }
}

pub struct Verifier {
    workspace: Workspace,
    session: Arc<Session>,
    fingerprint: Option<String>,
    failure: Arc<Mutex<Option<String>>>,
    epoch: u64,
}
impl Verifier {
    async fn verify(&self, actual: &str) -> Result<(), String> {
        if self.session.client.get().is_some() {
            return if self
                .session
                .fingerprint
                .get()
                .is_some_and(|fp| fp == actual)
            {
                Ok(())
            } else {
                Err("会话的服务器指纹已变化。".into())
            };
        }
        let current = || -> Result<Option<String>, String> {
            let store = self.workspace.store.lock().unwrap();
            crate::ensure_epoch(&store, self.epoch)?;
            let data = store.data()?;
            if !data
                .host(self.session.host.id)?
                .same_connection(&self.session.host)
            {
                return Err("主机配置已变更，请重新连接。".into());
            }
            Ok(data.fingerprint(&self.session.host).map(str::to_owned))
        };
        let saved = current()?;
        for expected in self.fingerprint.iter().chain(saved.iter()) {
            if expected != actual {
                return Err(format!(
                    "主机指纹已变化，连接已阻断。预期 {expected}，当前 {actual}。"
                ));
            }
        }
        if saved.is_none() {
            let (sender, receiver) = oneshot::channel();
            *self.session.trust.lock().unwrap() = Some(sender);
            self.workspace
                .emit(json!({"type":"trust","id":self.session.id,"fingerprint":actual}));
            if !receiver.await.unwrap_or(false) || self.session.cancel.is_cancelled() {
                return Err("已取消主机信任。".into());
            }
            let mut store = self.workspace.store.lock().unwrap();
            crate::ensure_epoch(&store, self.epoch)?;
            let mut data = store.data()?.clone();
            let host = &self.session.host;
            if !data.host(host.id)?.same_connection(host) {
                return Err("主机配置已变更，请重新连接。".into());
            }
            match data.fingerprint(host) {
                Some(fp) if fp != actual => {
                    return Err("另一条连接已信任不同指纹，请重新核对。".into())
                }
                Some(_) => {}
                None => {
                    data.fingerprints.push(Fingerprint {
                        address: host.address.clone(),
                        port: host.port,
                        fingerprint: actual.into(),
                    });
                    store.update(data)?;
                }
            }
        }
        let _ = self.session.fingerprint.set(actual.into());
        Ok(())
    }
}
impl client::Handler for Verifier {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Ok(false);
        };
        let actual = key.fingerprint(HashAlg::Sha256).to_string();
        match self.verify(&actual).await {
            Ok(()) => Ok(true),
            Err(message) => {
                *self.failure.lock().unwrap() = Some(message);
                Ok(false)
            }
        }
    }
}

pub fn valid_fingerprint(fp: &str) -> bool {
    fp.strip_prefix("SHA256:").is_some_and(|hash| {
        hash.len() == 43
            && hash
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
    })
}

pub fn connect(ws: &Workspace, req: ConnectRequest) -> Result<(), String> {
    let (host, epoch, previous_password) = {
        let store = ws.store.lock().unwrap();
        let data = store.data()?;
        let host = data.host(req.expected.id)?.clone();
        if !host.same_connection(&req.expected) {
            return Err("主机配置已变更，请从主机列表新建会话。".into());
        }
        let previous = if req.remember {
            password_source(data, &host)
        } else {
            None
        };
        (host, store.epoch, previous)
    };
    if req.secret.len() > 16384
        || (host.auth == "password" && !req.use_saved && req.secret.is_empty())
    {
        return Err("SSH 凭据无效。".into());
    }
    let session = ws.connections.begin(req.id, host)?;
    let ws = ws.clone();
    tauri::async_runtime::spawn(async move {
        let use_saved = req.use_saved;
        let result = run_session(&ws, &session, req, epoch, previous_password).await;
        let canceled = session.cancel.is_cancelled();
        session.cancel.cancel();
        session.trust.lock().unwrap().take();
        if ws.connections.remove(&session) && !canceled {
            let failed = result.is_err();
            ws.emit(json!({"type":"session","id":session.id,"status":"closed",
                "message":result.err().unwrap_or_else(|| "远端会话已退出。".into()),"retryWithPassword":use_saved && failed}));
        }
    });
    Ok(())
}

#[derive(PartialEq, Eq)]
enum PasswordSource {
    Local {
        token: Uuid,
        fingerprint: Option<String>,
    },
    Portable(Password),
}

impl PasswordSource {
    fn fingerprint(&self) -> Option<&str> {
        match self {
            Self::Local { fingerprint, .. } => fingerprint.as_deref(),
            Self::Portable(password) => Some(&password.fingerprint),
        }
    }
}

fn password_source(data: &Data, host: &Host) -> Option<PasswordSource> {
    if host.auth != "password" {
        return None;
    }
    let portable = data.portable_passwords.get(&host.id);
    if let Some(password) =
        portable.filter(|p| data.fingerprint(host).is_none_or(|fp| fp == p.fingerprint))
    {
        return Some(PasswordSource::Portable(password.clone()));
    }
    if let Some(LocalPassword::Native { token, fingerprint }) = data.local_passwords.get(&host.id) {
        return Some(PasswordSource::Local {
            token: *token,
            fingerprint: fingerprint.clone(),
        });
    }
    portable.cloned().map(PasswordSource::Portable)
}

async fn read_password(source: &PasswordSource) -> Result<Zeroizing<String>, String> {
    let secret = match source {
        PasswordSource::Portable(password) => password.password.clone(),
        PasswordSource::Local { token, .. } => {
            let token = *token;
            crate::blocking(move || keys::get_password(token))
                .await
                .map_err(|_| "无法读取已保存的密码，请重新输入。")?
        }
    };
    Ok(Zeroizing::new(secret))
}

fn check_password(data: &Data, host: &Host, source: &PasswordSource) -> Result<(), String> {
    if !data.host(host.id)?.same_connection(host)
        || password_source(data, host).as_ref() != Some(source)
    {
        return Err("主机或已保存的密码已变化，请重试。".into());
    }
    Ok(())
}

pub async fn reveal_saved_password(ws: &Workspace, id: Uuid) -> Result<Zeroizing<String>, String> {
    let (epoch, host, source) = {
        let store = ws.store.lock().unwrap();
        let data = store.data()?;
        let host = data.host(id)?;
        let source = password_source(data, host).ok_or("此主机没有已保存的密码。")?;
        (store.epoch, host.clone(), source)
    };
    let secret = read_password(&source).await?;
    let store = ws.store.lock().unwrap();
    crate::ensure_epoch(&store, epoch)?;
    check_password(store.data()?, &host, &source)?;
    Ok(secret)
}

fn bind_password(
    ws: &Workspace,
    host: &Host,
    epoch: u64,
    source: &PasswordSource,
    fingerprint: &str,
) -> Result<(), String> {
    let PasswordSource::Local {
        token,
        fingerprint: None,
    } = source
    else {
        return Ok(());
    };
    let mut store = ws.store.lock().unwrap();
    crate::ensure_epoch(&store, epoch)?;
    let mut data = store.data()?.clone();
    check_password(&data, host, source)?;
    if data.fingerprint(host) != Some(fingerprint) {
        return Err("主机的信任记录已变化，请重试。".into());
    }
    data.local_passwords.insert(
        host.id,
        LocalPassword::Native {
            token: *token,
            fingerprint: Some(fingerprint.into()),
        },
    );
    store.update(data)
}

async fn remember(
    ws: &Workspace,
    session: &Session,
    password: Zeroizing<String>,
    share: bool,
    epoch: u64,
    previous_password: Option<PasswordSource>,
) -> Result<(), String> {
    let token = Uuid::new_v4();
    let fingerprint = session
        .fingerprint
        .get()
        .cloned()
        .ok_or("主机指纹不可用。")?;
    let host = session.host.clone();
    let ws = ws.clone();
    let cancel = session.cancel.clone();
    crate::blocking(move || {
        keys::set_password(token, &password)?;
        let result = (|| {
            let mut store = ws.store.lock().unwrap();
            crate::ensure_epoch(&store, epoch)?;
            let mut data = store.data()?.clone();
            if cancel.is_cancelled()
                || !data.host(host.id)?.same_connection(&host)
                || data.fingerprint(&host) != Some(&fingerprint)
                || password_source(&data, &host) != previous_password
            {
                return Err("主机或保险库已变化。".into());
            }
            data.local_passwords.insert(
                host.id,
                LocalPassword::Native {
                    token,
                    fingerprint: Some(fingerprint.clone()),
                },
            );
            data.portable_passwords.remove(&host.id);
            if share && store.key.is_some() {
                data.portable_passwords.insert(
                    host.id,
                    Password {
                        password: password.to_string(),
                        fingerprint,
                    },
                );
            }
            store.update(data)
        })();
        if result.is_err() {
            keys::delete_password(token);
        }
        result
    })
    .await
}

async fn run_session(
    ws: &Workspace,
    session: &Arc<Session>,
    req: ConnectRequest,
    epoch: u64,
    previous_password: Option<PasswordSource>,
) -> Result<(), String> {
    let secret = Zeroizing::new(req.secret);
    let handshake = async {
        let saved = if req.use_saved {
            let source = {
                let store = ws.store.lock().unwrap();
                crate::ensure_epoch(&store, epoch)?;
                password_source(store.data()?, &session.host).ok_or("此主机没有已保存的密码。")?
            };
            let password = read_password(&source).await?;
            Some((source, password))
        } else {
            None
        };
        let failure = Arc::new(Mutex::new(None));
        let verifier = Verifier {
            workspace: ws.clone(),
            session: session.clone(),
            fingerprint: saved
                .as_ref()
                .and_then(|(source, _)| source.fingerprint())
                .map(str::to_owned),
            failure: failure.clone(),
            epoch,
        };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(15)),
            ..Default::default()
        });
        let mut client = client::connect(
            config,
            (session.host.address.as_str(), session.host.port),
            verifier,
        )
        .await
        .map_err(|err| {
            failure
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| format!("SSH 握手失败：{err}"))
        })?;
        let fingerprint = session.fingerprint.get().ok_or("主机指纹不可用。")?;
        if let Some((source, _)) = &saved {
            let store = ws.store.lock().unwrap();
            crate::ensure_epoch(&store, epoch)?;
            let data = store.data()?;
            check_password(data, &session.host, source)?;
            if data.fingerprint(&session.host) != Some(fingerprint) {
                return Err("主机的信任记录已变化，请重试。".into());
            }
        }
        authenticate(
            &mut client,
            &session.host,
            saved
                .as_ref()
                .map(|(_, password)| password.as_str())
                .unwrap_or(&secret),
        )
        .await?;
        if let Some((source, _)) = &saved {
            bind_password(ws, &session.host, epoch, source, fingerprint)?;
        }
        let mut channel = client.channel_open_session().await.map_err(error)?;
        let (cols, rows) = req.dimensions.dimensions();
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(error)?;
        require_success(&mut channel, "PTY").await?;
        channel.request_shell(true).await.map_err(error)?;
        require_success(&mut channel, "Shell").await?;
        Ok::<_, String>((Arc::new(client), channel))
    };
    let (client, channel) = tokio::select! {
        _ = session.cancel.cancelled() => return Err("连接已取消。".into()),
        result = tokio::time::timeout(Duration::from_secs(65), handshake) => result.map_err(|_| "SSH 连接超时。")??,
    };
    if session.cancel.is_cancelled() {
        return Err("连接已取消。".into());
    }
    let (send, mut input) = mpsc::channel(32);
    let _ = session.input.set(send);
    let _ = session.client.set(client.clone());
    ws.emit(json!({"type":"session","id":session.id,"status":"ready"}));
    if req.remember && !req.use_saved && session.host.auth == "password" {
        let ws = ws.clone();
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            let failed = remember(
                &ws,
                &session,
                secret,
                req.share_password,
                epoch,
                previous_password,
            )
            .await
            .is_err();
            if !session.cancel.is_cancelled() {
                ws.emit(json!({"type":"password","id":session.id,"failed":failed,"message":if failed {"SSH 已连接，密码保存失败，请检查 macOS 钥匙串。"} else {"已加密保存 SSH 密码。"}}));
            }
        });
    }
    let (mut reader, writer) = channel.split();
    let read = async {
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if !ws.output(session.id, &data).await {
                        break;
                    }
                }
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => {}
            }
        }
    };
    let write = async {
        while let Some(control) = input.recv().await {
            match control {
                TerminalControl::Input(data) => {
                    writer.data_bytes(data.into_bytes()).await.map_err(error)?
                }
                TerminalControl::Resize(size) => {
                    let (cols, rows) = size.dimensions();
                    writer
                        .window_change(cols, rows, 0, 0)
                        .await
                        .map_err(error)?;
                }
            }
        }
        Ok::<_, String>(())
    };
    let result = tokio::select! {
        _ = session.cancel.cancelled() => Ok(()),
        _ = read => Ok(()),
        result = write => result,
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        client.disconnect(Disconnect::ByApplication, "", ""),
    )
    .await;
    result
}

async fn authenticate(client: &mut Client, host: &Host, secret: &str) -> Result<(), String> {
    let accepted = match host.auth.as_str() {
        "password" => client
            .authenticate_password(&host.username, secret)
            .await
            .map_err(error)?
            .success(),
        "key" => {
            let path = host.key_path.clone().ok_or("请选择本机私钥。")?;
            let pass = Zeroizing::new(secret.to_string());
            let key = crate::blocking(move || {
                let bytes = Zeroizing::new(bounded_read(&path, 256 * 1024)?);
                let text = std::str::from_utf8(&bytes).map_err(error)?;
                russh::keys::decode_secret_key(text, (!pass.is_empty()).then_some(pass.as_str()))
                    .map_err(error)
            })
            .await?;
            let hash = client
                .best_supported_rsa_hash()
                .await
                .map_err(error)?
                .flatten();
            client
                .authenticate_publickey(
                    &host.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(error)?
                .success()
        }
        "agent" => {
            #[cfg(unix)]
            {
                let mut agent = keys::agent().await?;
                let identities = agent.request_identities().await.map_err(error)?;
                let hash = client
                    .best_supported_rsa_hash()
                    .await
                    .map_err(error)?
                    .flatten();
                let mut accepted = false;
                for identity in identities {
                    let key = identity.public_key().into_owned();
                    if client
                        .authenticate_publickey_with(&host.username, key, hash, &mut agent)
                        .await
                        .map_err(error)?
                        .success()
                    {
                        accepted = true;
                        break;
                    }
                }
                accepted
            }
            #[cfg(not(unix))]
            {
                return Err("当前平台的 SSH Agent 暂不可用。".into());
            }
        }
        _ => false,
    };
    if accepted {
        Ok(())
    } else {
        Err("SSH 认证失败，请检查用户名和凭据。".into())
    }
}

pub async fn require_success(
    channel: &mut Channel<client::Msg>,
    request: &str,
) -> Result<(), String> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure | ChannelMsg::Eof | ChannelMsg::Close) | None => {
                return Err(format!("服务器未接受 {request} 请求。"))
            }
            _ => {}
        }
    }
}

pub fn remote_path(value: &str) -> Result<String, String> {
    if !value.starts_with('/') || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("请输入有效的远端绝对路径。".into());
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}
pub async fn terminal_directory(session: &Session) -> Option<String> {
    let script = include_str!("../../src/terminal-directory.sh").replace('\'', "'\\''");
    let command = format!("sh -c '{script}'");
    let client = session.client.get()?;
    let mut channel = tokio::time::timeout(Duration::from_secs(3), client.channel_open_session())
        .await
        .ok()?
        .ok()?;
    let read = async {
        channel.exec(true, command.into_bytes()).await.ok()?;
        let mut output = Vec::new();
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } if output.len() + data.len() <= 4097 => {
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Data { .. } | ChannelMsg::Failure => return None,
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        if exit != Some(0) {
            return None;
        }
        remote_path(std::str::from_utf8(output.strip_suffix(&[0])?).ok()?).ok()
    };
    let directory = tokio::select! {
        _ = session.cancel.cancelled() => None,
        result = tokio::time::timeout(Duration::from_secs(3), read) => result.ok().flatten(),
    };
    let _ = tokio::time::timeout(Duration::from_millis(500), channel.close()).await;
    directory
}

pub fn file_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.chars().any(char::is_control)
    {
        return Err("文件名包含不支持的字符。".into());
    }
    Ok(name)
}

pub fn command_for(action: &str, argument: &str, lines: u32) -> Result<String, String> {
    if action == "disk" {
        return Ok("df -h".into());
    }
    if !(1..=10000).contains(&lines) {
        return Err("行数须在 1 至 10000 之间。".into());
    }
    if action == "journal" {
        if argument.len() > 256
            || !argument
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
            || !argument
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.@-".contains(&b))
        {
            return Err("请输入明确的 systemd 服务名。".into());
        }
        return Ok(format!(
            "journalctl --unit={argument} -n {lines} --no-pager"
        ));
    }
    if !matches!(action, "tail" | "follow") {
        return Err("未知的快捷命令。".into());
    }
    let path = remote_path(argument)?.replace('\'', "'\\''");
    let option = if action == "follow" { " -f" } else { "" };
    Ok(format!("tail -n {lines}{option} '{path}'"))
}

#[derive(Deserialize)]
pub struct CommandRequest {
    pub action: String,
    #[serde(default)]
    pub argument: String,
    #[serde(default = "default_lines")]
    pub lines: u32,
}
fn default_lines() -> u32 {
    100
}
impl CommandRequest {
    pub fn preview(&self) -> Result<String, String> {
        command_for(&self.action, &self.argument, self.lines)
    }
}

pub fn command(
    ws: &Workspace,
    id: Uuid,
    session_id: Uuid,
    request: CommandRequest,
) -> Result<(), String> {
    let session = ws.connections.connected(session_id)?;
    let script = request.preview()?;
    let job = Arc::new(CommandJob {
        follow: request.action == "follow",
        stop: CancellationToken::new(),
        close: session.cancel.child_token(),
    });
    {
        let mut jobs = ws.connections.commands.lock().unwrap();
        if jobs.contains_key(&id) || jobs.len() >= 64 {
            return Err("命令标签数量已达上限。".into());
        }
        jobs.insert(id, job.clone());
    }
    let ws = ws.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_command(&ws, id, &session, &job, &script).await;
        ws.connections.commands.lock().unwrap().remove(&id);
        let (status, message) = if job.stop.is_cancelled() {
            ("stopped", String::new())
        } else {
            match result {
                Ok(()) => ("done", String::new()),
                Err(error) => ("failed", error),
            }
        };
        ws.emit(json!({"type":"command","id":id,"status":status,"message":message}));
    });
    Ok(())
}

async fn run_command(
    ws: &Workspace,
    id: Uuid,
    session: &Session,
    job: &CommandJob,
    script: &str,
) -> Result<(), String> {
    let client = session.client.get().ok_or("会话已断开。")?;
    let start = async {
        let mut channel = client.channel_open_session().await.map_err(error)?;
        if job.follow {
            channel
                .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
                .await
                .map_err(error)?;
            require_success(&mut channel, "PTY").await?;
        }
        channel
            .exec(true, format!("exec {script}").into_bytes())
            .await
            .map_err(error)?;
        require_success(&mut channel, "命令").await?;
        Ok::<_, String>(channel)
    };
    let mut channel = tokio::select! {
        _ = job.close.cancelled() => return Err("SSH 会话已断开。".into()),
        _ = job.stop.cancelled() => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(20),start) => result.map_err(|_|"启动命令超时。")??,
    };
    ws.emit(json!({"type":"command","id":id,"status":"running"}));
    let mut exit = None;
    let deadline = tokio::time::sleep(Duration::from_secs(86400));
    tokio::pin!(deadline);
    let mut stopping = false;
    loop {
        tokio::select! {
            _ = job.close.cancelled() => break,
            _ = job.stop.cancelled(), if !stopping => {
                stopping = true;
                let _ = tokio::time::timeout(Duration::from_millis(500), channel.data_bytes(vec![3])).await;
                deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(1500));
            }
            _ = &mut deadline, if stopping => break,
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                    tokio::select! {
                        _ = job.close.cancelled() => break,
                        _ = job.stop.cancelled(), if !stopping => {},
                        _ = &mut deadline, if stopping => break,
                        ok = ws.output(id, &data) => if !ok { break },
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
    if stopping || exit == Some(0) {
        Ok(())
    } else if let Some(code) = exit {
        Err(format!("远端命令退出码 {code}"))
    } else {
        Err("远端命令已断开。".into())
    }
}
