use base64::{engine::general_purpose::STANDARD, Engine};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

mod assets;
mod forwarding;
mod git;
mod git_https;
mod imports;
mod keys;
mod session_logs;
mod ssh;
mod startup_unlock;
mod store;
#[cfg(test)]
mod tests;
mod touch_id;
#[cfg(desktop)]
mod transfer;
mod vault;

use store::{checked, Binding, Data, Host, LocalPassword, Store};

#[derive(Clone)]
struct Workspace(Arc<Inner>);
impl std::ops::Deref for Workspace {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

struct Inner {
    store: Mutex<Store>,
    events: Mutex<Option<Channel<Value>>>,
    acks: Mutex<HashMap<Uuid, oneshot::Sender<()>>>,
    connections: ssh::Connections,
    logs: session_logs::Logs,
    forwards: forwarding::Forwards,
    #[cfg(desktop)]
    transfers: transfer::Transfers,
    #[cfg(desktop)]
    editors: transfer::Editors,
    sync_gate: tokio::sync::Mutex<()>,
    unlock_gate: tokio::sync::Mutex<()>,
    sync_cancel: Mutex<Option<CancellationToken>>,
    conflict: Mutex<Option<git::Conflict>>,
    last_activity: Mutex<Instant>,
    key_directories: Mutex<HashSet<PathBuf>>,
    home: PathBuf,
    _profile_lock: std::fs::File,
}
impl Workspace {
    fn new(directory: PathBuf, home: PathBuf, legacy: Option<PathBuf>) -> Result<Self, String> {
        std::fs::create_dir_all(&directory).map_err(error)?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(directory.join(".workspace.lock"))
            .map_err(error)?;
        lock.try_lock()
            .map_err(|_| "此工作区已在另一个 Termlume 窗口打开。")?;
        let store = Store::open(&directory, legacy.as_deref())?;
        Ok(Self(Arc::new(Inner {
            store: Mutex::new(store),
            events: Mutex::default(),
            acks: Mutex::default(),
            logs: session_logs::Logs::new(directory.join("session-logs"))?,
            connections: Default::default(),
            forwards: Default::default(),
            #[cfg(desktop)]
            transfers: Default::default(),
            #[cfg(desktop)]
            editors: Default::default(),
            sync_gate: Default::default(),
            unlock_gate: Default::default(),
            sync_cancel: Mutex::default(),
            conflict: Mutex::default(),
            last_activity: Mutex::new(Instant::now()),
            key_directories: Mutex::new(HashSet::from([home.join(".ssh")])),
            home,
            _profile_lock: lock,
        })))
    }
    fn emit(&self, event: Value) -> bool {
        self.events
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|channel| channel.send(event).is_ok())
    }
    async fn output(&self, id: Uuid, bytes: &[u8]) -> bool {
        if let Some((session, message)) = self.logs.record(id, bytes) {
            self.emit(json!({"type":"log","id":session,"active":false,"message":message}));
        }
        let ack = Uuid::new_v4();
        let (send, recv) = oneshot::channel();
        self.acks.lock().unwrap().insert(ack, send);
        // Dropping an interrupted read/command also releases the outstanding acknowledgement.
        struct Pending<'a>(&'a Mutex<HashMap<Uuid, oneshot::Sender<()>>>, Uuid);
        impl Drop for Pending<'_> {
            fn drop(&mut self) {
                self.0.lock().unwrap().remove(&self.1);
            }
        }
        let _pending = Pending(&self.acks, ack);
        self.emit(json!({"type":"output","id":id,"ack":ack,"bytes":STANDARD.encode(bytes)}))
            && matches!(
                tokio::time::timeout(Duration::from_secs(60), recv).await,
                Ok(Ok(()))
            )
    }
    fn lock(&self, idle_only: bool) -> Value {
        let mut store = self.store.lock().unwrap();
        if idle_only {
            let Some(minutes) = store
                .data
                .as_ref()
                .and_then(|data| data.lock_settings.auto_lock_minutes)
            else {
                return store.status();
            };
            if self.last_activity.lock().unwrap().elapsed()
                < Duration::from_secs(u64::from(minutes) * 60)
            {
                return store.status();
            }
        }
        if store.lock() {
            #[cfg(desktop)]
            self.transfers.clear_drop();
            if let Some(task) = self.sync_cancel.lock().unwrap().as_ref() {
                task.cancel();
            }
            self.conflict.lock().unwrap().take();
            self.connections.close_pending();
            self.forwards.stop_all();
            self.logs.stop_all();
            self.emit(json!({"type":"vault","state":store.status()}));
        }
        store.status()
    }
    fn key_directory(&self, value: &Value) -> Result<PathBuf, String> {
        let dir = value
            .as_str()
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join(".ssh"));
        if !self.key_directories.lock().unwrap().contains(&dir) {
            return Err("请先选择密钥目录。".into());
        }
        Ok(dir)
    }
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn parse<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|_| "工作台请求参数无效。".into())
}
fn string(value: &Value) -> Result<&str, String> {
    value.as_str().ok_or("工作台请求参数无效。".into())
}
fn id(value: &Value) -> Result<Uuid, String> {
    Uuid::parse_str(string(value)?).map_err(|_| "会话标识无效。".into())
}
fn flag(value: &Value, name: &str) -> bool {
    value[name] == true
}
fn ensure_epoch(store: &Store, epoch: u64) -> Result<(), String> {
    if store.epoch != epoch || store.data.is_none() {
        return Err("保险库已锁定或变化，请重试。".into());
    }
    Ok(())
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(error)?
}
fn verified(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" || !window.url().is_ok_and(|url| local_url(&url)) {
        return Err("工作台请求来源无效。".into());
    }
    Ok(())
}
fn local_url(url: &url::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost"))
            | ("http", Some("tauri.localhost"))
            | ("https", Some("tauri.localhost"))
    )
}

#[tauri::command]
fn workspace_subscribe(
    window: WebviewWindow,
    workspace: State<'_, Workspace>,
    events: Channel<Value>,
) -> Result<(), String> {
    verified(&window)?;
    *workspace.events.lock().unwrap() = Some(events);
    Ok(())
}
#[tauri::command]
async fn workspace_request(
    window: WebviewWindow,
    workspace: State<'_, Workspace>,
    name: String,
    value: Value,
) -> Result<Value, String> {
    verified(&window)?;
    dispatch(&workspace, &name, value).await
}
async fn dispatch(ws: &Workspace, name: &str, value: Value) -> Result<Value, String> {
    if name == "ssh:ack" {
        if let Some(tx) = ws.acks.lock().unwrap().remove(&id(&value)?) {
            let _ = tx.send(());
        }
        return Ok(Value::Null);
    }
    if name == "vault:state" {
        return Ok(ws.store.lock().unwrap().status());
    }
    if name == "vault:unlock" {
        return unlock(ws, value).await;
    }
    if name == "vault:touch-id-available" {
        return blocking(|| Ok(json!(touch_id::available()))).await;
    }
    ws.store.lock().unwrap().data()?;
    if !matches!(name, "ssh:resize" | "ssh:input") {
        *ws.last_activity.lock().unwrap() = Instant::now();
    }
    match name {
        "vault:activity" => {}
        "vault:lock" => return Ok(ws.lock(false)),
        "vault:recovery-code" => return Ok(json!(vault::recovery_code())),
        "vault:copy-recovery" => {
            let code = string(&value)?.to_owned();
            vault::recovery_key(&code)?;
            blocking(move || keys::copy(&code)).await?;
        }
        "vault:enable" => return enable(ws, value).await,
        "vault:set-touch-id" => return set_touch_id(ws, parse(value)?).await,
        "vault:set-startup-unlock" => return set_startup_unlock(ws, parse(value)?).await,
        "vault:set-auto-lock" => {
            let minutes: Option<u32> = parse(value)?;
            if minutes.is_some_and(|minutes| !(1..=1440).contains(&minutes)) {
                return Err("自动锁定时间须为 1–1440 分钟，或关闭自动锁定。".into());
            }
            let mut store = ws.store.lock().unwrap();
            if store.key.is_none() {
                return Err("请先启用并解锁保险库。".into());
            }
            let mut data = store.data()?.clone();
            data.lock_settings.auto_lock_minutes = minutes;
            store.update(data)?;
            return Ok(store.status());
        }
        #[cfg(desktop)]
        "vault:export" => return export(ws).await,
        #[cfg(desktop)]
        "vault:restore-file" => return restore(ws, value, false).await,
        "vault:restore-git" => return restore(ws, value, true).await,
        "vault:sync" => return git::synchronize(ws, parse(value)?).await,
        "vault:migrate-git" => return git::migrate(ws, parse(value)?).await,
        "trust:list" => {
            let store = ws.store.lock().unwrap();
            let data = store.data()?;
            let hosts = data.connection_hosts();
            return Ok(json!(data.fingerprints.iter().map(|f|json!({"address":f.address,"port":f.port,"fingerprint":f.fingerprint,"hosts":hosts.iter().filter(|h|h.port==f.port&&h.address.eq_ignore_ascii_case(&f.address)).map(|h|h.name.clone()).collect::<Vec<_>>()})).collect::<Vec<_>>()));
        }
        "trust:forget" => {
            let mut store = ws.store.lock().unwrap();
            let mut data = store.data()?.clone();
            let address = string(&value["address"])?;
            let port = value["port"].as_u64().ok_or("端口无效。")?;
            let expected = string(&value["fingerprint"])?;
            let f = data
                .fingerprints
                .iter()
                .find(|f| f.address == address && u64::from(f.port) == port)
                .ok_or("信任记录已移除。")?;
            if f.fingerprint != expected {
                return Err("信任记录已变化，请刷新。".into());
            }
            data.fingerprints
                .retain(|f| !(f.address == address && u64::from(f.port) == port));
            store.update(data)?;
        }
        "trust:import" => {
            let rows: Vec<store::Fingerprint> = parse(value)?;
            if rows.len() > 5000 {
                return Err("记录过多。".into());
            }
            let mut store = ws.store.lock().unwrap();
            let mut data = store.data()?.clone();
            for f in rows {
                Host {
                    address: f.address.clone(),
                    port: f.port,
                    username: "validation".into(),
                    ..Default::default()
                }
                .normalized(true)?;
                if !ssh::valid_fingerprint(&f.fingerprint) {
                    return Err("指纹无效。".into());
                }
                if let Some(existing) = data
                    .fingerprints
                    .iter()
                    .find(|e| e.address.eq_ignore_ascii_case(&f.address) && e.port == f.port)
                {
                    if existing.fingerprint != f.fingerprint {
                        return Err("已有不同指纹，请先独立核验并移除旧记录。".into());
                    }
                } else {
                    data.fingerprints.push(f);
                }
            }
            store.update(data)?;
        }
        #[cfg(desktop)]
        "trust:import-preview" | "hosts:csv-preview" => {
            let Some(file) = rfd::AsyncFileDialog::new()
                .set_title(if name == "trust:import-preview" {
                    "选择 known_hosts"
                } else {
                    "选择主机 CSV"
                })
                .pick_file()
                .await
            else {
                return Ok(Value::Null);
            };
            let path = file.path().to_path_buf();
            let text = blocking(move || {
                String::from_utf8(vault::bounded_read(&path, 1024 * 1024)?).map_err(error)
            })
            .await?;
            return if name == "trust:import-preview" {
                imports::known_preview(&text)
            } else {
                imports::csv_preview(&text)
            };
        }
        "preferences:get" => return assets::preferences_request(ws, Value::Null),
        "preferences:save" => return assets::preferences_request(ws, value),
        "history:list" => return Ok(json!(ws.store.lock().unwrap().data()?.command_history)),
        "history:clear" => {
            let mut store = ws.store.lock().unwrap();
            let mut data = store.data()?.clone();
            data.command_history.clear();
            store.update(data)?;
        }
        "logs:list" => {
            ws.store.lock().unwrap().data()?;
            return Ok(ws.logs.list());
        }
        "logs:start" => {
            ws.store.lock().unwrap().data()?;
            let session = ws.connections.connected(id(&value)?)?;
            return ws.logs.start(&session);
        }
        "logs:stop" => ws.logs.stop(id(&value)?),
        "logs:read" => {
            ws.store.lock().unwrap().data()?;
            return Ok(json!(ws.logs.read(id(&value)?)?));
        }
        "logs:delete" => {
            ws.store.lock().unwrap().data()?;
            ws.logs.remove(id(&value)?)?;
        }
        #[cfg(desktop)]
        "logs:export" => {
            ws.store.lock().unwrap().data()?;
            let data = ws.logs.read(id(&value)?)?;
            if let Some(file) = rfd::AsyncFileDialog::new()
                .set_title("导出会话日志")
                .set_file_name("termlume-session.txt")
                .save_file()
                .await
            {
                tokio::fs::write(file.path(), data).await.map_err(error)?;
            }
        }
        "layouts:list" | "layouts:save" | "layouts:delete" => {
            return assets::layout_request(ws, name, value)
        }
        "snippets:list" | "snippets:save" | "snippets:delete" => {
            return assets::snippet_request(ws, name, value)
        }
        "snippets:run" => {
            let request = {
                let store = ws.store.lock().unwrap();
                let data = store.data()?;
                let sid = id(&value["snippetId"])?;
                let snippet = data
                    .snippets
                    .iter()
                    .find(|s| s.id == sid)
                    .ok_or("命令已删除。")?;
                if json!(snippet) != value["expected"] {
                    return Err("命令已变化，请重新预览。".into());
                }
                ssh::CommandRequest {
                    action: "custom".into(),
                    argument: snippet.command.clone(),
                    lines: 100,
                }
            };
            ssh::command(ws, id(&value["id"])?, id(&value["sessionId"])?, request)?;
        }
        "groups:list" | "groups:save" | "groups:delete" => {
            return assets::group_request(ws, name, value)
        }
        "identities:list" => return Ok(assets::list(ws.store.lock().unwrap().data()?)),
        "identities:save" => {
            let mut value = value;
            if flag(&value, "copySavedPassword") {
                let secret = ssh::reveal_saved_password(ws, id(&value["sourceHostId"])?).await?;
                value["localPassword"] = json!(&*secret);
            }
            let ws = ws.clone();
            return blocking(move || assets::save_identity(&ws, value)).await;
        }
        "identities:delete" => return assets::delete_identity(ws, value),
        "hosts:save" => {
            let ws = ws.clone();
            return blocking(move || save_host(&ws, value)).await;
        }
        "hosts:reveal-password" => {
            return Ok(json!(&*ssh::reveal_saved_password(ws, id(&value)?).await?));
        }
        "hosts:list"
        | "hosts:recent"
        | "hosts:touch"
        | "hosts:delete"
        | "hosts:forget"
        | "hosts:has-password"
        | "hosts:has-key-passphrase"
        | "hosts:clear-password"
        | "hosts:remove-group"
        | "hosts:import" => {
            return hosts(ws, name, value);
        }
        #[cfg(desktop)]
        "hosts:key-picker" => {
            return Ok(json!(rfd::AsyncFileDialog::new()
                .set_title("选择 SSH 私钥")
                .set_directory(ws.home.join(".ssh"))
                .pick_file()
                .await
                .map(|file| file.path().to_path_buf())))
        }
        #[cfg(desktop)]
        "hosts:import-preview" => {
            let dialog = rfd::AsyncFileDialog::new()
                .set_title("选择 OpenSSH 配置")
                .set_directory(ws.home.join(".ssh"))
                .set_file_name("config");
            let Some(file) = dialog.pick_file().await else {
                return Ok(Value::Null);
            };
            let home = ws.home.clone();
            let path = file.path().to_path_buf();
            return blocking(move || {
                let bytes = vault::bounded_read(&path, 1024 * 1024)?;
                Ok(keys::import_config(&String::from_utf8_lossy(&bytes), &home))
            })
            .await;
        }
        "keys:agent" => return Ok(keys::agent_keys().await),
        "keys:scan" => {
            let directory = ws.key_directory(&value)?;
            return blocking(move || keys::scan(&directory)).await;
        }
        #[cfg(desktop)]
        "keys:directory" => {
            let folder = rfd::AsyncFileDialog::new()
                .set_title("选择 SSH 密钥目录")
                .set_directory(ws.home.join(".ssh"))
                .pick_folder()
                .await
                .map(|file| file.path().to_path_buf());
            if let Some(folder) = &folder {
                ws.key_directories.lock().unwrap().insert(folder.clone());
            }
            return Ok(json!(folder));
        }
        "keys:generate" => {
            let directory = ws.key_directory(&value["directory"])?;
            let name = string(&value["name"])?.to_owned();
            let passphrase = Zeroizing::new(string(&value["passphrase"])?.to_owned());
            let is_default = directory == ws.home.join(".ssh");
            return blocking(move || {
                if is_default {
                    let mut dirs = std::fs::DirBuilder::new();
                    dirs.recursive(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::DirBuilderExt;
                        dirs.mode(0o700);
                    }
                    dirs.create(&directory).map_err(error)?;
                }
                keys::generate(&directory, &name, &passphrase)
            })
            .await;
        }
        "keys:copy" => {
            let key = string(&value)?.to_owned();
            if key.len() > 32768
                || key.contains(['\r', '\n', '\0'])
                || russh::keys::PublicKey::from_openssh(&key).is_err()
            {
                return Err("公钥格式无效。".into());
            }
            blocking(move || keys::copy(&key)).await?;
        }
        "ssh:connect" => ssh::connect(ws, parse(value)?)?,
        "forwards:list" => {
            ws.store.lock().unwrap().data()?;
            return Ok(ws.forwards.list());
        }
        "forwards:save" | "forwards:delete" => return forwarding::save_rule(ws, name, value),
        "forwards:start" => return forwarding::start(ws, parse(value)?).await,
        "forwards:stop" => ws.forwards.stop(id(&value)?).await?,
        "ssh:trust" => ws.connections.trust(
            id(&value["id"])?,
            flag(&value, "accepted"),
            value.get("challenge").map(id).transpose()?,
        ),
        "ssh:close" => {
            if let Some(session) = ws.connections.get(id(&value)?) {
                #[cfg(desktop)]
                ws.transfers.cancel_session(&session).await;
                ws.logs.stop(session.id);
                ws.connections.remove(&session);
                session.cancel.cancel();
            }
        }
        "ssh:input" => {
            let data = string(&value["data"])?;
            if data.len() > 1_048_576 {
                return Err("终端输入过长。".into());
            }
            ws.connections
                .send(id(&value["id"])?, ssh::TerminalControl::Input(data.into()))
                .await;
        }
        "ssh:resize" => {
            let size = parse(value["size"].clone())?;
            ws.connections
                .send(id(&value["id"])?, ssh::TerminalControl::Resize(size))
                .await;
        }
        "commands:preview" => return Ok(json!(parse::<ssh::CommandRequest>(value)?.preview()?)),
        "commands:start" => ssh::command(
            ws,
            id(&value["id"])?,
            id(&value["sessionId"])?,
            parse(value["request"].clone())?,
        )?,
        "commands:stop" | "commands:close" => ws
            .connections
            .stop_command(id(&value)?, name == "commands:close"),
        "ssh:directory" => {
            let session = ws.connections.connected(id(&value)?)?;
            return Ok(json!(ssh::terminal_directory(&session).await));
        }
        #[cfg(desktop)]
        "files:list" => {
            let session = ws.connections.connected(id(&value["id"])?)?;
            return transfer::list(&session, value["directory"].as_str().unwrap_or("")).await;
        }
        #[cfg(desktop)]
        "files:inspect" => {
            let session = ws.connections.connected(id(&value["id"])?)?;
            return transfer::inspect_path(&session, string(&value["path"])?).await;
        }
        #[cfg(desktop)]
        "files:read-text" | "files:save-text" => {
            ws.store.lock().unwrap().data()?;
            let session = ws.connections.connected(id(&value["id"])?)?;
            let path = string(&value["path"])?;
            return if name == "files:read-text" {
                transfer::read_text(&session, path).await
            } else {
                transfer::save_text(
                    ws,
                    &session,
                    path,
                    string(&value["text"])?,
                    string(&value["revision"])?,
                )
                .await
            };
        }
        #[cfg(desktop)]
        "files:mkdir" => {
            let session = ws.connections.connected(id(&value["id"])?)?;
            transfer::mkdir(
                &session,
                string(&value["directory"])?,
                string(&value["name"])?,
            )
            .await?;
        }
        #[cfg(desktop)]
        "files:history" => return Ok(json!(ws.transfers.history(ws)?)),
        #[cfg(desktop)]
        "files:remove-history" => {
            let id = (!value.is_null()).then(|| id(&value)).transpose()?;
            return Ok(json!(ws.transfers.remove_history(ws, id)?));
        }
        #[cfg(desktop)]
        "files:create-file" => {
            let session = ws.connections.connected(id(&value["id"])?)?;
            transfer::create_file(
                &session,
                string(&value["directory"])?,
                string(&value["name"])?,
            )
            .await?;
        }
        #[cfg(desktop)]
        "files:mutation-preview" => {
            let session = ws.connections.connected(id(&value["id"])?)?;
            return transfer::mutation_preview(&session, parse(value["paths"].clone())?).await;
        }
        #[cfg(desktop)]
        "files:rename" => {
            let session = ws.connections.connected(id(&value["id"])?)?;
            let _mutation = transfer::mutation_guard(ws, &session)?;
            transfer::rename_remote(
                &session,
                string(&value["source"])?,
                string(&value["destination"])?,
                parse(value["expected"].clone())?,
            )
            .await?;
        }
        #[cfg(desktop)]
        "files:remove" => {
            let session = ws.connections.connected(id(&value["id"])?)?;
            let _mutation = transfer::mutation_guard(ws, &session)?;
            return transfer::remove_remote(
                &session,
                parse(value["roots"].clone())?,
                parse(value["expected"].clone())?,
            )
            .await;
        }
        #[cfg(desktop)]
        "editors:list" => {
            ws.store.lock().unwrap().data()?;
            return Ok(ws.editors.list());
        }
        #[cfg(desktop)]
        "editors:open" => {
            let session = ws.connections.connected(id(&value["id"])?)?;
            return transfer::open_editor(ws, session, string(&value["path"])?, true).await;
        }
        #[cfg(desktop)]
        "editors:prepare" => return transfer::prepare_edited_upload(ws, id(&value)?).await,
        #[cfg(desktop)]
        "editors:close" => ws.editors.close(ws, id(&value)?)?,
        #[cfg(desktop)]
        "files:prepare" => {
            let request: transfer::PrepareRequest = parse(value)?;
            return ws
                .transfers
                .prepare(ws.connections.connected(request.id)?, request)
                .await;
        }
        #[cfg(desktop)]
        "files:enqueue" => {
            ws.transfers
                .accept(ws, id(&value["ticket"])?, parse(value["policy"].clone())?)?
        }
        #[cfg(desktop)]
        "files:discard" => ws.transfers.discard(id(&value)?),
        #[cfg(desktop)]
        "files:cancel" => ws.transfers.cancel(id(&value)?),
        #[cfg(desktop)]
        "files:retry" => ws.transfers.retry(ws, id(&value)?)?,
        _ => return Err("工作台请求未定义。".into()),
    }
    Ok(Value::Null)
}

fn hosts(ws: &Workspace, name: &str, value: Value) -> Result<Value, String> {
    let mut store = ws.store.lock().unwrap();
    let current = store.data()?;
    match name {
        "hosts:list" => return Ok(json!(current.connection_hosts())),
        "hosts:recent" => return Ok(json!(current.recent)),
        "hosts:has-password" => {
            let host = current.connection_host(id(&value)?)?;
            return Ok(json!(ssh::has_saved_password(current, &host)));
        }
        "hosts:has-key-passphrase" => {
            let host = current.connection_host(id(&value)?)?;
            return Ok(json!(ssh::saved_key_passphrase(current, &host).is_some()));
        }
        _ => {}
    }
    let mut data = current.clone();
    let result = match name {
        "hosts:touch" => {
            data.host(id(&value)?)?;
            data.recent.insert(id(&value)?, now());
            Value::Null
        }
        "hosts:delete" => {
            let id = id(&value)?;
            if data.hosts.iter().any(|h| h.jump_host_id == Some(id)) {
                return Err("该主机仍被用作跳板机，请先修改相关主机的连接路径。".into());
            }
            data.hosts.retain(|host| host.id != id);
            data.local_passwords.remove(&id);
            data.key_passphrases.remove(&id);
            data.portable_passwords.remove(&id);
            data.recent.remove(&id);
            json!(data.hosts)
        }
        "hosts:forget" => {
            let host = data.connection_host(id(&value)?)?;
            let resolved = data.connection_hosts();
            data.fingerprints
                .retain(|f| f.port != host.port || !f.address.eq_ignore_ascii_case(&host.address));
            data.local_passwords.retain(|id, _| {
                !resolved
                    .iter()
                    .any(|h| h.id == *id && h.same_endpoint(&host))
            });
            Value::Null
        }
        "hosts:clear-password" => {
            let id = id(&value)?;
            if data.connection_host(id)?.identity_id.is_some() {
                return Err("共享身份密码请到身份管理中修改，操作会影响所有引用主机。".into());
            }
            data.host(id)?;
            data.local_passwords.remove(&id);
            data.portable_passwords.remove(&id);
            Value::Null
        }
        "hosts:remove-group" => {
            let name = checked(string(&value)?, "分组", 1000)?;
            let group = data
                .groups
                .iter()
                .find(|g| assets::group_path(&data, g.id).ok().as_deref() == Some(&name))
                .map(|g| g.id);
            if group.is_some_and(|id| data.groups.iter().any(|g| g.parent_id == Some(id))) {
                return Err("请先移动子分组，再移除此分组。".into());
            }
            let resolved = data.connection_hosts();
            for host in &mut data.hosts {
                if let Some(effective) =
                    resolved.iter().find(|h| h.id == host.id && h.group == name)
                {
                    host.group.clear();
                    host.group_id = None;
                    host.port = effective.port;
                    host.identity_id = effective.identity_id;
                    host.username = effective.username.clone();
                    host.auth = effective.auth.clone();
                    host.key_path = effective.key_path.clone();
                    host.inherit_identity = false;
                    host.inherit_port = false;
                    host.terminal_theme = effective.terminal_theme.clone();
                    host.inherit_theme = false;
                }
            }
            data.groups.retain(|g| Some(g.id) != group);
            json!(data.connection_hosts())
        }
        "hosts:import" => {
            let mut rows: Vec<Host> = parse(value["rows"].clone())?;
            if rows.len() > 1000 {
                return Err("导入数量过多。".into());
            }
            let previous = data.hosts.len();
            for mut host in rows.drain(..) {
                host.id = Uuid::new_v4();
                let host = host.normalized(false)?;
                if flag(&value, "keepDuplicates")
                    || !data
                        .hosts
                        .iter()
                        .any(|h| h.same_endpoint(&host) && h.username == host.username)
                {
                    data.hosts.push(host);
                }
            }
            json!({"hosts":data.hosts,"count":data.hosts.len()-previous})
        }
        _ => return Err("工作台请求未定义。".into()),
    };
    store.update(data)?;
    Ok(result)
}

fn save_host(ws: &Workspace, mut request: Value) -> Result<Value, String> {
    let key_passphrase = match request
        .as_object_mut()
        .and_then(|obj| obj.remove("localKeyPassphrase"))
    {
        None | Some(Value::Null) => None,
        Some(Value::String(secret))
            if !secret.is_empty() && secret.len() <= 4096 && !secret.contains('\0') =>
        {
            Some(Zeroizing::new(secret))
        }
        _ => return Err("私钥口令格式无效。".into()),
    };
    let clear_key_passphrase = flag(&request, "clearKeyPassphrase");
    let password = match request
        .as_object_mut()
        .and_then(|obj| obj.remove("localPassword"))
    {
        None | Some(Value::Null) => None,
        Some(Value::String(password)) => Some(Zeroizing::new(password)),
        _ => return Err("SSH 密码格式无效。".into()),
    };
    let mut host: Host = parse(request)?;
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    let previous = if host.id.is_nil() {
        host.id = Uuid::new_v4();
        None
    } else {
        Some(data.host(host.id)?.clone())
    };
    // Rules have their own versioned editor; saving general host fields must preserve them.
    if let Some(previous) = previous.as_ref() {
        host.local_forwards.clone_from(&previous.local_forwards);
    }
    host.identity_version = None;
    if host.group_id.is_none() && !host.group.is_empty() {
        let mut probe = host.clone();
        probe.id = Uuid::new_v4();
        let mut temporary = data.clone();
        temporary.hosts.push(probe);
        assets::migrate_groups(&mut temporary);
        host.group_id = temporary.hosts.last().unwrap().group_id;
        data.groups = temporary.groups;
    }
    if let Some(id) = host.group_id {
        host.group = assets::group_path(&data, id)?;
    }
    if host.inherit_identity || host.inherit_port {
        let mut probe = data.clone();
        probe.hosts.retain(|h| h.id != host.id);
        probe.hosts.push(host.clone());
        let effective = probe.connection_host(host.id)?;
        // Fill required legacy fields; the explicit inheritance flags remain authoritative.
        host.username = effective.username;
        host.auth = effective.auth;
        host.key_path = effective.key_path;
    }
    if let Some(id) = host.identity_id.filter(|_| !host.inherit_identity) {
        let i = data
            .identities
            .iter()
            .find(|i| i.id == id)
            .ok_or("身份不存在。")?;
        host.username = i.username.clone();
        host.auth = i.auth.clone();
        host.key_path = i.key_path.clone();
    }
    let host = host.normalized(
        previous
            .as_ref()
            .is_some_and(|p| p.auth == "key" && p.key_path.is_none()),
    )?;
    let mut routed_hosts = data.hosts.clone();
    routed_hosts.retain(|h| h.id != host.id);
    routed_hosts.push(host.clone());
    host.jump_host(&routed_hosts)?;
    for dependent in routed_hosts
        .iter()
        .filter(|h| h.jump_host_id == Some(host.id))
    {
        dependent.jump_host(&routed_hosts)?;
    }
    if previous
        .as_ref()
        .is_some_and(|p| host.auth != "password" || !p.same_connection(&host))
    {
        data.local_passwords.remove(&host.id);
        data.portable_passwords.remove(&host.id);
    }
    if clear_key_passphrase
        || data.key_passphrases.get(&host.id).is_some_and(|saved| {
            host.auth != "key" || host.key_path.as_ref() != Some(&saved.key_path)
        })
    {
        data.key_passphrases.remove(&host.id);
    }
    if key_passphrase.is_some() && (host.auth != "key" || host.key_path.is_none()) {
        return Err("请先选择本机私钥，再保存私钥口令。".into());
    }
    let new_token = if let Some(password) = password {
        if host.auth != "password" || password.is_empty() || password.encode_utf16().count() > 4096
        {
            return Err("SSH 密码格式无效。".into());
        }
        let token = Uuid::new_v4();
        keys::set_password(token, &password)
            .map_err(|_| "无法保存 SSH 密码，请检查 macOS 钥匙串。")?;
        let fingerprint = data.fingerprint(&host).map(str::to_owned);
        data.local_passwords
            .insert(host.id, LocalPassword::Native { token, fingerprint });
        data.portable_passwords.remove(&host.id);
        Some(token)
    } else {
        None
    };
    let new_key_token = if let Some(secret) = key_passphrase {
        let token = Uuid::new_v4();
        if keys::set_password(token, &secret).is_err() {
            if let Some(token) = new_token {
                keys::delete_password(token);
            }
            return Err("无法保存私钥口令，请检查 macOS 钥匙串。".into());
        }
        data.key_passphrases.insert(
            host.id,
            store::KeyPassphrase {
                token,
                key_path: host.key_path.clone().unwrap(),
            },
        );
        Some(token)
    } else {
        None
    };
    data.hosts.retain(|item| item.id != host.id);
    data.hosts.push(host);
    let result = json!(data.connection_hosts());
    if let Err(err) = store.update(data) {
        if let Some(token) = new_token {
            keys::delete_password(token);
        }
        if let Some(token) = new_key_token {
            keys::delete_password(token);
        }
        return Err(err);
    }
    Ok(result)
}

async fn unlock(ws: &Workspace, value: Value) -> Result<Value, String> {
    let use_touch_id = flag(&value, "useTouchId");
    let _prompt = use_touch_id
        .then(|| ws.unlock_gate.try_lock())
        .transpose()
        .map_err(|_| "触控 ID 操作正在进行。")?;
    let (envelope, epoch, touch_id_path) = {
        let store = ws.store.lock().unwrap();
        if store.data.is_some() {
            return Ok(store.status());
        }
        (
            store.envelope.clone().ok_or("保险库不存在。")?,
            store.epoch,
            store.touch_id_path(),
        )
    };
    let (key, data) = if use_touch_id {
        blocking(move || {
            let path = touch_id_path.ok_or(touch_id::UNLOCK_FAILED)?;
            let credential = vault::bounded_read(&path, touch_id::MAX_CREDENTIAL)
                .map_err(|_| touch_id::UNLOCK_FAILED)?;
            let key = touch_id::open(&credential)?;
            let data = envelope
                .decode::<Data>(&key, "local")
                .map_err(|_| touch_id::UNLOCK_FAILED)?;
            Ok((key, data))
        })
        .await?
    } else {
        let secret = Zeroizing::new(string(&value["secret"])?.to_owned());
        let recovery = flag(&value, "useRecovery");
        blocking(move || envelope.unlock::<Data>(&secret, recovery, "local")).await?
    };
    let mut store = ws.store.lock().unwrap();
    if store.epoch == epoch && store.data.is_none() {
        store.unlock(key, data);
    }
    store.data()?;
    *ws.last_activity.lock().unwrap() = Instant::now();
    Ok(store.status())
}
async fn set_touch_id(ws: &Workspace, enabled: bool) -> Result<Value, String> {
    let _prompt = ws
        .unlock_gate
        .try_lock()
        .map_err(|_| "触控 ID 操作正在进行。")?;
    let (path, key, epoch) = {
        let store = ws.store.lock().unwrap();
        let key = store.key.as_ref().ok_or("请先启用并解锁保险库。")?;
        let path = store.touch_id_path().ok_or("保险库不存在。")?;
        (path, enabled.then(|| key.clone()), store.epoch)
    };
    let credential = match key {
        Some(key) => Some(blocking(move || touch_id::enroll(&key)).await?),
        None => None,
    };
    let store = ws.store.lock().unwrap();
    ensure_epoch(&store, epoch)?;
    if let Some(credential) = credential {
        store::write_atomic(&path, &credential)?;
    } else if let Err(err) = std::fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            return Err(error(err));
        }
    }
    Ok(store.status())
}
async fn set_startup_unlock(ws: &Workspace, required: bool) -> Result<Value, String> {
    let _permit = ws
        .unlock_gate
        .try_lock()
        .map_err(|_| "已有解锁设置正在处理，请稍候。")?;
    let (saved, path, key, epoch, vault_id) = {
        let store = ws.store.lock().unwrap();
        let key = store.key.as_ref().ok_or("请先启用并解锁保险库。")?;
        if required == store.startup_unlock.is_none() {
            return Ok(store.status());
        }
        (
            store.startup_unlock.clone(),
            store.startup_unlock_path(),
            (!required).then(|| key.clone()),
            store.epoch,
            store.envelope.as_ref().ok_or("保险库不存在。")?.header.id,
        )
    };
    if let Some(saved) = saved {
        let account = saved.account(&path)?;
        blocking(move || startup_unlock::delete(&account)).await?;
        let mut store = ws.store.lock().unwrap();
        store.set_startup_unlock(None)?;
        return Ok(store.status());
    }
    let credential = startup_unlock::Credential {
        vault_id,
        token: Uuid::new_v4(),
    };
    let account = credential.account(&path)?;
    let saved_account = account.clone();
    let key = key.ok_or("请先解锁保险库。")?;
    blocking(move || startup_unlock::save(&saved_account, &key)).await?;
    let result = {
        let mut store = ws.store.lock().unwrap();
        ensure_epoch(&store, epoch)
            .and_then(|()| store.set_startup_unlock(Some(credential)))
            .map(|()| store.status())
    };
    if result.is_err() {
        let _ = blocking(move || startup_unlock::delete(&account)).await;
    }
    result
}
async fn enable(ws: &Workspace, value: Value) -> Result<Value, String> {
    if ws.store.lock().unwrap().envelope.is_some() {
        return Err("保险库已启用。".into());
    }
    let password = Zeroizing::new(string(&value["password"])?.to_owned());
    let recovery = Zeroizing::new(string(&value["recovery"])?.to_owned());
    let (key, header) = blocking(move || vault::create(&password, &recovery)).await?;
    let mut store = ws.store.lock().unwrap();
    if store.envelope.is_some() {
        return Err("保险库已启用。".into());
    }
    let data = store.data()?.clone();
    store.install(key, &header, data)?;
    Ok(store.status())
}
#[cfg(desktop)]
async fn export(ws: &Workspace) -> Result<Value, String> {
    let epoch = {
        let store = ws.store.lock().unwrap();
        if store.key.is_none() {
            return Err("请先启用并解锁保险库。".into());
        }
        store.epoch
    };
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("导出加密备份")
        .set_file_name("termlume-vault.json")
        .save_file()
        .await
    else {
        return Ok(json!(false));
    };
    let store = ws.store.lock().unwrap();
    ensure_epoch(&store, epoch)?;
    let envelope = vault::encode(
        store.key.as_ref().ok_or("请先解锁保险库。")?,
        &store.envelope.as_ref().ok_or("保险库不存在。")?.header,
        "portable",
        &json!({"hosts":store.data()?.snapshot()}),
    )?;
    store::write_exclusive(
        file.path(),
        &serde_json::to_vec(&envelope).map_err(error)?,
        0o600,
    )
    .map_err(error)?;
    Ok(json!(true))
}
async fn restore(ws: &Workspace, value: Value, from_git: bool) -> Result<Value, String> {
    let revision = {
        let store = ws.store.lock().unwrap();
        store.ensure_empty()?;
        store.revision
    };
    let (envelope, sync) = if from_git {
        let remote = git::remote_url(string(&value["address"])?)?;
        let branch = git::branch_name(value.get("branch").map(string).transpose()?.unwrap_or(""))?;
        let auth = git::resolve_auth(&remote, parse(value["auth"].clone())?, None)?;
        let repo = git::Repo::open(
            remote.clone(),
            &branch,
            auth.clone(),
            CancellationToken::new(),
        )
        .await?;
        let tip = repo
            .fetch()
            .await?
            .ok_or_else(|| format!("仓库的 {branch} 分支尚无备份。"))?;
        let secret = value
            .get("syncKey")
            .map(string)
            .transpose()?
            .unwrap_or("")
            .trim();
        let sync_secret =
            (tip.envelope.is_protected() && !secret.is_empty()).then(|| secret.to_owned());
        let sync_key = sync_secret.as_deref().map(vault::git_key).transpose()?;
        (
            tip.envelope.open(sync_key.as_ref())?,
            Some((remote, branch, sync_secret, auth, tip.commit, tip.parent)),
        )
    } else {
        #[cfg(mobile)]
        return Err("请使用「从 Git 恢复」。".into());
        #[cfg(desktop)]
        {
            let Some(file) = rfd::AsyncFileDialog::new()
                .set_title("选择加密备份")
                .add_filter("保险库", &["json"])
                .pick_file()
                .await
            else {
                return Ok(Value::Null);
            };
            let path = file.path().to_path_buf();
            let envelope = blocking(move || {
                serde_json::from_slice(&vault::bounded_read(&path, vault::MAX_DOCUMENT)?)
                    .map_err(error)
            })
            .await?;
            (envelope, None)
        }
    };
    let secret = Zeroizing::new(string(&value["secret"])?.to_owned());
    let recovery = flag(&value, "useRecovery");
    let header = envelope.header.clone();
    let (key, snapshot) =
        blocking(move || envelope.unlock::<git::Snapshot>(&secret, recovery, "portable")).await?;
    let rows = store::portable_rows(snapshot.hosts)?;
    let binding = if let Some((remote, branch, sync_key, auth, commit, parent)) = sync {
        if snapshot.parent_commit != parent {
            return Err("快照与仓库提交历史不一致。".into());
        }
        Some(Binding {
            remote,
            branch,
            sync_key,
            auth,
            commit: Some(commit),
            base: rows.clone(),
            last_synced: Some(now()),
        })
    } else {
        None
    };
    let mut data = Data::default();
    data.apply(rows, binding);
    let mut store = ws.store.lock().unwrap();
    store.ensure_empty()?;
    if store.revision != revision {
        return Err("工作区已变化，请重试恢复。".into());
    }
    data.transfer_history = store.data()?.transfer_history.clone();
    store.install(key, &header, data)?;
    *ws.last_activity.lock().unwrap() = Instant::now();
    Ok(store.status())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            workspace_request,
            workspace_subscribe
        ])
        .setup(|app| {
            let home = app.path().home_dir()?;
            let custom = std::env::var_os("TERMLUME_DATA_DIR")
                .filter(|s| !s.is_empty())
                .map(PathBuf::from);
            let legacy = custom
                .is_none()
                .then(|| home.join("Library/Application Support/Termlume/workspace.json"));
            let directory = custom.unwrap_or(app.path().app_data_dir()?);
            let workspace =
                Workspace::new(directory, home, legacy).map_err(std::io::Error::other)?;
            app.manage(workspace.clone());
            let idle_workspace = workspace.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    idle_workspace.lock(true);
                }
            });
            let mut window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Termlume")
                    .inner_size(1140.0, 740.0)
                    .min_inner_size(550.0, 490.0)
                    .on_navigation(local_url)
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            #[cfg(target_os = "macos")]
            {
                window = window
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .traffic_light_position(tauri::LogicalPosition::new(14.0, 24.0))
                    .hidden_title(true);
            }
            #[cfg(not(desktop))]
            window.build()?;
            #[cfg(desktop)]
            let window = window.build()?;
            #[cfg(desktop)]
            window.on_window_event(move |event| {
                use tauri::{DragDropEvent, WindowEvent};
                let WindowEvent::DragDrop(event) = event else {
                    return;
                };
                let drag = match event {
                    DragDropEvent::Enter { position, paths } if !paths.is_empty() => {
                        json!({"type":"file-drag","phase":"enter","position":position,"count":paths.len()})
                    }
                    DragDropEvent::Over { position } => {
                        json!({"type":"file-drag","phase":"over","position":position})
                    }
                    DragDropEvent::Drop { paths, position } if !paths.is_empty() => {
                        let store = workspace.store.lock().unwrap();
                        if store.data().is_err() {
                            return;
                        }
                        let ticket = (paths.len() <= 100)
                            .then(|| workspace.transfers.capture_drop(paths.clone()));
                        json!({"type":"file-drag","phase":"drop","position":position,"count":paths.len(),"ticket":ticket})
                    }
                    _ => json!({"type":"file-drag","phase":"leave"}),
                };
                workspace.emit(drag);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let ws = window.state::<Workspace>();
                ws.logs.stop_all();
                ws.connections.close_all();
                ws.forwards.stop_all();
                #[cfg(desktop)] ws.editors.clear();
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("could not start Termlume");
}
