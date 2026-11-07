use crate::{
    error, ssh, startup_unlock,
    vault::{self, Envelope, Header, Key, MAX_DOCUMENT},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{self, Write},
    net::Ipv6Addr,
    path::{Path, PathBuf},
};
use uuid::Uuid;
use zeroize::Zeroize;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Host {
    pub id: Uuid,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<PathBuf>,
    pub group: String,
    pub tags: Vec<String>,
    pub note: String,
    pub log_path: String,
    pub service: String,
}
impl Default for Host {
    fn default() -> Self {
        Self {
            id: Uuid::nil(),
            name: String::new(),
            address: String::new(),
            port: 22,
            username: String::new(),
            auth: "agent".into(),
            key_path: None,
            group: String::new(),
            tags: vec![],
            note: String::new(),
            log_path: String::new(),
            service: String::new(),
        }
    }
}
impl Host {
    pub fn same_endpoint(&self, other: &Host) -> bool {
        self.port == other.port && self.address.eq_ignore_ascii_case(&other.address)
    }
    pub fn same_connection(&self, other: &Host) -> bool {
        self.same_endpoint(other)
            && self.username == other.username
            && self.auth == other.auth
            && self.key_path == other.key_path
    }
    pub fn normalized(mut self, allow_missing_key: bool) -> Result<Self, String> {
        self.address = checked(&self.address, "主机地址", 255)?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .into();
        if self.address.is_empty()
            || self.address.contains(['/', '@', '\\'])
            || self.address.contains(char::is_whitespace)
            || (self.address.contains(':') && self.address.parse::<Ipv6Addr>().is_err())
        {
            return Err("请输入主机名或 IP 地址。".into());
        }
        if self.port == 0 {
            return Err("端口须在 1 至 65535 之间。".into());
        }
        self.username = checked(&self.username, "SSH 用户名", 120)?;
        self.name = if self.name.trim().is_empty() {
            self.address.clone()
        } else {
            checked(&self.name, "主机名称", 120)?
        };
        self.group = optional(&self.group, "分组", 120)?;
        self.note = optional(&self.note, "备注", 1024)?;
        self.log_path = optional(&self.log_path, "日志路径", 4096)?;
        self.service = optional(&self.service, "服务名", 255)?;
        if !self.log_path.is_empty() {
            ssh::command_for("tail", &self.log_path, 100)?;
        }
        if !self.service.is_empty() {
            ssh::command_for("journal", &self.service, 100)?;
        }
        let mut seen = HashSet::new();
        self.tags = self
            .tags
            .iter()
            .map(|tag| checked(tag, "标签", 40))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|tag| seen.insert(tag.clone()))
            .take(20)
            .collect();
        match self.auth.as_str() {
            "key" => match &self.key_path {
                Some(path)
                    if path.is_absolute()
                        && path
                            .to_str()
                            .is_some_and(|p| checked(p, "私钥文件路径", 4096).is_ok()) => {}
                None if allow_missing_key => {}
                _ => return Err("请选择本机私钥文件。".into()),
            },
            "password" | "agent" => self.key_path = None,
            _ => return Err("请选择认证方式。".into()),
        }
        Ok(self)
    }
}

pub fn checked(value: &str, label: &str, max: usize) -> Result<String, String> {
    if value.trim().is_empty()
        || value.encode_utf16().count() > max
        || value.chars().any(char::is_control)
    {
        return Err(format!("请输入有效的{label}。"));
    }
    Ok(value.trim().into())
}
fn optional(value: &str, label: &str, max: usize) -> Result<String, String> {
    if value.trim().is_empty() {
        Ok(String::new())
    } else {
        checked(value, label, max)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Password {
    pub password: String,
    pub fingerprint: String,
}
impl Drop for Password {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Row {
    #[serde(flatten)]
    pub host: Host,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<Password>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Fingerprint {
    pub address: String,
    pub port: u16,
    pub fingerprint: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum LocalPassword {
    Native {
        token: Uuid,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
    },
    Legacy(String),
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub remote: String,
    #[serde(default = "crate::git::default_branch")]
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<crate::git::GitAuth>,
    pub commit: Option<String>,
    pub base: Vec<Row>,
    pub last_synced: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMigration {
    pub remote: String,
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<crate::git::GitAuth>,
    pub commit: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LockSettings {
    pub auto_lock_minutes: Option<u32>,
}
impl Default for LockSettings {
    fn default() -> Self {
        Self {
            auto_lock_minutes: Some(15),
        }
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Data {
    pub hosts: Vec<Host>,
    pub fingerprints: Vec<Fingerprint>,
    pub recent: BTreeMap<Uuid, u64>,
    pub local_passwords: BTreeMap<Uuid, LocalPassword>,
    pub portable_passwords: BTreeMap<Uuid, Password>,
    pub lock_settings: LockSettings,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub transfer_history: Vec<Value>,
    pub sync: Option<Binding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_migration: Option<GitMigration>,
}
impl Data {
    pub fn host(&self, id: Uuid) -> Result<&Host, String> {
        self.hosts
            .iter()
            .find(|host| host.id == id)
            .ok_or("主机已删除，请重新选择。".into())
    }
    pub fn fingerprint(&self, host: &Host) -> Option<&str> {
        self.fingerprints
            .iter()
            .find(|f| f.port == host.port && f.address.eq_ignore_ascii_case(&host.address))
            .map(|f| f.fingerprint.as_str())
    }
    pub fn snapshot(&self) -> Vec<Row> {
        let mut rows: Vec<_> = self
            .hosts
            .iter()
            .map(|host| Row {
                host: Host {
                    key_path: None,
                    ..host.clone()
                },
                password: self.portable_passwords.get(&host.id).cloned(),
            })
            .collect();
        rows.sort_by_key(|row| row.host.id);
        rows
    }
    pub fn apply(&mut self, rows: Vec<Row>, sync: Option<Binding>) {
        let mut next = Vec::new();
        self.local_passwords.retain(|id, _| {
            rows.iter().any(|row| {
                row.host.id == *id
                    && self.hosts.iter().any(|old| {
                        old.id == *id
                            && old.same_endpoint(&row.host)
                            && old.username == row.host.username
                            && old.auth == row.host.auth
                    })
                    && self.portable_passwords.get(id) == row.password.as_ref()
            })
        });
        self.portable_passwords.clear();
        for Row { mut host, password } in rows {
            if let Some(old) = self.hosts.iter().find(|old| {
                old.id == host.id
                    && old.same_endpoint(&host)
                    && old.username == host.username
                    && old.auth == host.auth
            }) {
                host.key_path.clone_from(&old.key_path);
            }
            if let Some(password) = password {
                self.portable_passwords.insert(host.id, password);
            }
            next.push(host);
        }
        self.hosts = next;
        self.sync = sync;
    }
}
pub fn portable_rows(mut rows: Vec<Row>) -> Result<Vec<Row>, String> {
    if rows.len() > 5000 {
        return Err("保险库主机列表无效。".into());
    }
    let mut seen = HashSet::new();
    for row in &mut rows {
        if row.host.id.is_nil() || !seen.insert(row.host.id) {
            return Err("保险库主机标识无效。".into());
        }
        row.host.key_path = None;
        row.host = row.host.clone().normalized(true)?;
        if let Some(secret) = &row.password {
            if row.host.auth != "password"
                || secret.password.is_empty()
                || secret.password.len() > 4096
                || !ssh::valid_fingerprint(&secret.fingerprint)
            {
                return Err("保险库凭据格式无效。".into());
            }
        }
    }
    rows.sort_by_key(|row| row.host.id);
    Ok(rows)
}

pub struct Store {
    file: PathBuf,
    pub data: Option<Data>,
    pub envelope: Option<Envelope>,
    pub key: Option<Key>,
    pub startup_unlock: Option<startup_unlock::Credential>,
    startup_unlock_error: Option<String>,
    pub epoch: u64,
    pub revision: u64,
}
impl Store {
    pub fn open(dir: &Path, legacy: Option<&Path>) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(error)?;
        let file = dir.join("workspace.json");
        let mut store = Self {
            file,
            data: None,
            envelope: None,
            key: None,
            startup_unlock: None,
            startup_unlock_error: None,
            epoch: 0,
            revision: 0,
        };
        let original = if store.file.exists() {
            Some(store.file.as_path())
        } else {
            legacy.filter(|p| p.exists())
        };
        if let Some(original) = original {
            let bytes = vault::bounded_read(original, MAX_DOCUMENT)?;
            let parsed: Value = serde_json::from_slice(&bytes).map_err(error)?;
            if parsed["format"] == "termlume-vault" {
                let envelope: Envelope = serde_json::from_value(parsed).map_err(error)?;
                envelope.validate("local")?;
                store.envelope = Some(envelope);
            } else {
                store.data = Some(serde_json::from_value(parsed).map_err(error)?);
            }
            if original != &store.file {
                store.write(&bytes)?;
            }
        } else {
            store.data = Some(Data::default());
        }
        if let Some(envelope) = store.envelope.as_ref() {
            store.startup_unlock = vault::bounded_read(&store.startup_unlock_path(), 4096)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<startup_unlock::Credential>(&bytes).ok())
                .filter(|credential| credential.vault_id == envelope.header.id);
            if let Some(credential) = &store.startup_unlock {
                let unlocked = credential
                    .account(&store.startup_unlock_path())
                    .and_then(|account| startup_unlock::read(&account))
                    .and_then(|key| {
                        envelope
                            .decode::<Data>(&key, "local")
                            .map(|data| (key, data))
                    });
                match unlocked {
                    Ok((key, data)) => store.unlock(key, data),
                    Err(_) => store.startup_unlock_error = Some(startup_unlock::FAILED.into()),
                }
            }
        }
        Ok(store)
    }
    pub fn data(&self) -> Result<&Data, String> {
        self.data.as_ref().ok_or("请先解锁保险库。".into())
    }
    pub fn touch_id_path(&self) -> Option<PathBuf> {
        let id = self.envelope.as_ref()?.header.id;
        Some(self.file.with_file_name(format!("touch-id-{id}.json")))
    }
    pub fn startup_unlock_path(&self) -> PathBuf {
        self.file.with_file_name("startup-unlock.json")
    }
    pub fn set_startup_unlock(
        &mut self,
        credential: Option<startup_unlock::Credential>,
    ) -> Result<(), String> {
        let path = self.startup_unlock_path();
        if let Some(credential) = &credential {
            write_atomic(&path, &serde_json::to_vec(credential).map_err(error)?)?;
        } else if let Err(err) = fs::remove_file(&path) {
            if err.kind() != io::ErrorKind::NotFound {
                return Err(error(err));
            }
        }
        self.startup_unlock = credential;
        self.startup_unlock_error = None;
        Ok(())
    }
    pub fn status(&self) -> Value {
        let sync = self.data.as_ref().and_then(|data| data.sync.as_ref());
        let migration = self
            .data
            .as_ref()
            .and_then(|data| data.git_migration.as_ref());
        json!({
            "enabled": self.envelope.is_some(),
            "locked": self.data.is_none(),
            "touchIdEnabled": cfg!(target_os = "macos") && self.touch_id_path().is_some_and(|path| path.is_file()),
            "startupUnlockSupported": cfg!(target_os = "macos"),
            "startupUnlockRequired": self.startup_unlock.is_none(),
            "startupUnlockError": self.startup_unlock_error,
            "autoLockMinutes": self.data.as_ref().map(|data| data.lock_settings.auto_lock_minutes).unwrap_or(Some(15)),
            "remote": sync.map(|s| s.remote.as_str()).unwrap_or(""),
            "branch": sync.map(|s| s.branch.as_str()),
            "gitSsh": cfg!(desktop),
            "gitMigration": migration.map(|m| json!({"remote": m.remote, "branch": m.branch})),
            "lastSynced": sync.and_then(|s| s.last_synced),
            "fileTransfers": cfg!(desktop)
        })
    }
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() as u64 > MAX_DOCUMENT {
            return Err("工作区文件超过大小上限。".into());
        }
        write_atomic(&self.file, bytes)
    }
    fn forget_removed_passwords(&self, new: &Data) {
        if let Some(old) = &self.data {
            for (id, entry) in &old.local_passwords {
                if let LocalPassword::Native { token, .. } = entry {
                    if !matches!(new.local_passwords.get(id), Some(LocalPassword::Native { token: kept, .. }) if kept == token)
                    {
                        crate::keys::delete_password(*token);
                    }
                }
            }
        }
    }
    pub fn update(&mut self, data: Data) -> Result<(), String> {
        self.data()?;
        if let Some(envelope) = &self.envelope {
            let encoded = vault::encode(
                self.key.as_ref().ok_or("请先解锁保险库。")?,
                &envelope.header,
                "local",
                &data,
            )?;
            self.write(&serde_json::to_vec(&encoded).map_err(error)?)?;
            self.envelope = Some(encoded);
        } else {
            self.write(&serde_json::to_vec(&data).map_err(error)?)?;
        }
        self.forget_removed_passwords(&data);
        self.data = Some(data);
        self.revision += 1;
        Ok(())
    }
    pub fn install(&mut self, key: Key, header: &Header, data: Data) -> Result<(), String> {
        let envelope = vault::encode(&key, header, "local", &data)?;
        self.write(&serde_json::to_vec(&envelope).map_err(error)?)?;
        self.envelope = Some(envelope);
        self.unlock(key, data);
        self.revision += 1;
        Ok(())
    }
    pub fn unlock(&mut self, key: Key, data: Data) {
        self.key = Some(key);
        self.data = Some(data);
        self.startup_unlock_error = None;
        self.epoch += 1;
    }
    pub fn lock(&mut self) -> bool {
        if self.key.take().is_none() {
            return false;
        }
        self.data = None;
        self.epoch += 1;
        true
    }
    pub fn ensure_empty(&self) -> Result<(), String> {
        if self.envelope.is_some() || !self.data()?.hosts.is_empty() {
            return Err("恢复需要空工作区。".into());
        }
        Ok(())
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("工作区路径无效。")?).map_err(error)?;
    tmp.write_all(bytes)
        .and_then(|()| tmp.as_file().sync_all())
        .map_err(error)?;
    tmp.persist(path).map_err(error)?;
    Ok(())
}

pub fn write_exclusive(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    let mut file = options.open(path)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    if written.is_err() {
        drop(file);
        let _ = fs::remove_file(path);
    }
    written
}
