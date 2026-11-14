use crate::{
    assets::{Asset, Group, Identity, Layout, Preferences, Secret, Snippet},
    error,
    forwarding::LocalForward,
    ssh, startup_unlock,
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
    pub identity_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_version: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_host_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub local_forwards: Vec<LocalForward>,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    #[serde(default)]
    pub inherit_port: bool,
    #[serde(default)]
    pub inherit_identity: bool,
    pub tags: Vec<String>,
    pub note: String,
    pub log_path: String,
    pub service: String,
    #[serde(default)]
    pub startup_command: String,
    #[serde(default)]
    pub startup_enabled: bool,
    #[serde(default)]
    pub auto_reconnect: bool,
    pub keepalive_interval: u16,
    pub connect_timeout: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_theme: Option<String>,
    pub inherit_theme: bool,
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
            identity_id: None,
            identity_version: None,
            key_path: None,
            jump_host_id: None,
            local_forwards: vec![],
            group: String::new(),
            group_id: None,
            inherit_port: false,
            inherit_identity: false,
            tags: vec![],
            note: String::new(),
            log_path: String::new(),
            service: String::new(),
            startup_command: String::new(),
            startup_enabled: false,
            auto_reconnect: false,
            keepalive_interval: 15,
            connect_timeout: 65,
            terminal_theme: None,
            inherit_theme: false,
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
            && self.keepalive_interval == other.keepalive_interval
            && self.connect_timeout == other.connect_timeout
            && self.jump_host_id == other.jump_host_id
            && self.identity_id == other.identity_id
            && self.identity_version == other.identity_version
            && self.group_id == other.group_id
            && self.inherit_port == other.inherit_port
            && self.inherit_identity == other.inherit_identity
    }
    pub fn jump_host<'a>(&self, hosts: &'a [Host]) -> Result<Option<&'a Host>, String> {
        let Some(id) = self.jump_host_id else {
            return Ok(None);
        };
        if id == self.id {
            return Err("不能使用主机自身作为跳板机。".into());
        }
        let jump = hosts
            .iter()
            .find(|h| h.id == id)
            .ok_or("跳板机不存在，请编辑主机并重新选择连接路径。")?;
        if jump.jump_host_id.is_some() {
            return Err("当前仅支持单跳，请选择一台直连主机作为跳板机。".into());
        }
        if self.same_endpoint(jump) {
            return Err("跳板机与目标主机不能使用相同地址和端口。".into());
        }
        Ok(Some(jump))
    }
    pub fn normalized(mut self, allow_missing_key: bool) -> Result<Self, String> {
        crate::forwarding::normalize_rules(&mut self.local_forwards)?;
        if self.keepalive_interval > 300
            || !(5..=180).contains(&self.connect_timeout)
            || self
                .terminal_theme
                .as_ref()
                .is_some_and(|t| !matches!(t.as_str(), "dark" | "light"))
        {
            return Err("连接超时须为 5–180 秒，保活为 0–300 秒，配色须有效。".into());
        }
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
        if self.startup_enabled || !self.startup_command.is_empty() {
            self.startup_command = crate::assets::command_text(&self.startup_command)?;
        }
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
pub struct HostRow {
    #[serde(flatten)]
    pub host: Host,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<Password>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Row {
    Asset { asset: Asset },
    Host(HostRow),
}
impl Row {
    pub fn id(&self) -> Uuid {
        match self {
            Self::Host(h) => h.host.id,
            Self::Asset { asset } => asset.id(),
        }
    }
    pub fn summary(&self) -> Value {
        match self {
            Self::Host(h) => {
                let mut v = json!(h.host);
                v["passwordSaved"] = json!(h.password.is_some());
                v
            }
            Self::Asset { asset } => asset.summary(),
        }
    }
    #[cfg(test)]
    pub fn password_saved(&self) -> bool {
        matches!(self,Self::Host(h) if h.password.is_some())
    }
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
    Saved {
        token: Uuid,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
    },
    Legacy(String),
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyPassphrase {
    pub token: Uuid,
    pub key_path: PathBuf,
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct GitSettings {
    pub paused: bool,
    pub on_unlock: bool,
    pub after_changes: bool,
    pub interval_minutes: u32,
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub identities: Vec<Identity>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<Group>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub snippets: Vec<Snippet>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub layouts: Vec<Layout>,
    pub preferences: Preferences,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub command_history: Vec<Value>,
    pub fingerprints: Vec<Fingerprint>,
    pub recent: BTreeMap<Uuid, u64>,
    pub local_passwords: BTreeMap<Uuid, LocalPassword>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub local_secrets: BTreeMap<Uuid, Secret>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub key_passphrases: BTreeMap<Uuid, KeyPassphrase>,
    pub portable_passwords: BTreeMap<Uuid, Password>,
    pub lock_settings: LockSettings,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub transfer_history: Vec<Value>,
    pub sync: Option<Binding>,
    pub git_settings: GitSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_fetched: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_migration: Option<GitMigration>,
}
impl Data {
    pub fn has_local_password(&self, id: Uuid) -> bool {
        matches!(self.local_passwords.get(&id), Some(LocalPassword::Saved { token, .. }) if self.local_secrets.contains_key(token))
    }
    pub fn save_secret(&mut self, secret: &str) -> Uuid {
        let token = Uuid::new_v4();
        self.local_secrets.insert(token, Secret { secret: secret.into() });
        token
    }
    fn credential_tokens(&self) -> HashSet<Uuid> {
        self.local_passwords.values().filter_map(|saved| match saved {
            LocalPassword::Saved { token, .. } => Some(*token),
            LocalPassword::Legacy(_) => None,
        }).chain(self.key_passphrases.values().map(|saved| saved.token)).collect()
    }
    pub fn host(&self, id: Uuid) -> Result<&Host, String> {
        self.hosts
            .iter()
            .find(|host| host.id == id)
            .ok_or("主机已删除，请重新选择。".into())
    }
    pub fn connection_host(&self, id: Uuid) -> Result<Host, String> {
        let mut host = self.host(id)?.clone();
        if let Some(id) = host.group_id {
            host.group = crate::assets::group_path(self, id)?;
            let mut current = Some(id);
            let mut port = None;
            let mut theme = None;
            let mut identity = None;
            let mut seen = HashSet::new();
            while let Some(id) = current {
                if !seen.insert(id) {
                    return Err("分组循环引用。".into());
                }
                let g = self
                    .groups
                    .iter()
                    .find(|g| g.id == id)
                    .ok_or("分组不存在。")?;
                port = port.or(g.port);
                theme = theme.or(g.terminal_theme.clone());
                identity = identity.or(g.identity_id);
                current = g.parent_id;
            }
            if host.inherit_theme {
                host.terminal_theme = theme;
            }
            if host.inherit_port {
                host.port = port.unwrap_or(22);
            }
            if host.inherit_identity {
                host.identity_id =
                    Some(identity.ok_or("分组没有可用的登录配置，请设置分组默认登录配置或单独配置此主机。")?);
            }
        } else if host.inherit_port || host.inherit_identity || host.inherit_theme {
            return Err("请先选择分组后再继承设置。".into());
        }
        if let Some(id) = host.identity_id {
            let identity = self
                .identities
                .iter()
                .find(|i| i.id == id)
                .ok_or("关联登录配置不存在，请重新选择。")?;
            host.username = identity.username.clone();
            host.auth = identity.auth.clone();
            host.key_path = identity.key_path.clone();
            host.identity_version = Some(identity.version);
        } else {
            host.identity_version = None;
        }
        Ok(host)
    }
    pub fn connection_hosts(&self) -> Vec<Host> {
        self.hosts
            .iter()
            .map(|h| self.connection_host(h.id).unwrap_or_else(|_| h.clone()))
            .collect()
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
            .map(|host| {
                Row::Host(HostRow {
                    host: Host {
                        key_path: None,
                        identity_version: None,
                        ..host.clone()
                    },
                    password: self.portable_passwords.get(&host.id).cloned(),
                })
            })
            .collect();
        rows.extend(self.identities.iter().map(|i| Row::Asset {
            asset: Asset::Identity(i.clone()).portable(),
        }));
        rows.extend(self.groups.iter().map(|g| Row::Asset {
            asset: Asset::Group(g.clone()),
        }));
        rows.extend(self.snippets.iter().map(|s| Row::Asset {
            asset: Asset::Snippet(s.clone()),
        }));
        rows.extend(self.layouts.iter().map(|l| Row::Asset {
            asset: Asset::Layout(l.clone()),
        }));
        rows.sort_by_key(Row::id);
        rows
    }
    pub fn apply(&mut self, rows: Vec<Row>, sync: Option<Binding>) {
        let mut hosts = Vec::new();
        let mut identities = Vec::new();
        let mut groups = Vec::new();
        let mut snippets = Vec::new();
        let mut layouts = Vec::new();
        for row in rows {
            match row {
                Row::Host(h) => hosts.push(h),
                Row::Asset {
                    asset: Asset::Layout(l),
                } => layouts.push(l),
                Row::Asset {
                    asset: Asset::Snippet(s),
                } => snippets.push(s),
                Row::Asset {
                    asset: Asset::Group(g),
                } => groups.push(g),
                Row::Asset {
                    asset: Asset::Identity(mut i),
                } => {
                    if let Some(old) = self.identities.iter().find(|old| {
                        old.id == i.id && old.username == i.username && old.auth == i.auth
                    }) {
                        i.key_path = old.key_path.clone();
                    }
                    identities.push(i);
                }
            }
        }
        let identity_ids: HashSet<_> = identities
            .iter()
            .filter(|i| {
                self.identities.iter().any(|old| {
                    old.id == i.id && old.version == i.version && old.password == i.password
                })
            })
            .map(|i| i.id)
            .collect();
        let rows = hosts;
        let mut next = Vec::new();
        self.local_passwords.retain(|id, _| {
            identity_ids.contains(id)
                || rows.iter().any(|row| {
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
        for HostRow { mut host, password } in rows {
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
        self.identities = identities;
        self.groups = groups;
        self.snippets = snippets;
        self.layouts = layouts;
        crate::assets::migrate_groups(self);
        let valid_keys: HashSet<_> = self
            .key_passphrases
            .iter()
            .filter_map(|(id, saved)| {
                self.connection_host(*id)
                    .ok()
                    .filter(|host| {
                        host.auth == "key" && host.key_path.as_ref() == Some(&saved.key_path)
                    })
                    .map(|_| *id)
            })
            .collect();
        self.key_passphrases.retain(|id, _| valid_keys.contains(id));
        self.sync = sync;
    }
}
pub fn portable_rows(mut rows: Vec<Row>) -> Result<Vec<Row>, String> {
    if rows.len() > 5000 {
        return Err("保险库主机列表无效。".into());
    }
    let mut seen = HashSet::new();
    for row in &mut rows {
        if row.id().is_nil() || !seen.insert(row.id()) {
            return Err("保险库记录标识无效。".into());
        }
        match row {
            Row::Host(row) => {
                row.host.key_path = None;
                row.host.identity_version = None;
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
            Row::Asset { asset } => {
                *asset = asset.clone().normalized()?.portable();
            }
        }
    }
    rows.sort_by_key(Row::id);
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
            } else if parsed["format"] == "termlume-local-workspace" {
                store.data = Some(vault::decode_local(&store.local_key(false)?, &bytes)?);
            } else if parsed.get("format").is_some() {
                return Err("工作区格式或版本无效。".into());
            } else {
                store.data = Some(serde_json::from_value(parsed).map_err(error)?);
                // Upgrade plaintext workspaces before allowing further operations.
                let encoded = vault::encode_local(&store.local_key(true)?, store.data()?)?;
                store.write(&encoded)?;
            }
            if original != &store.file && store.envelope.is_some() {
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
                // Old OS-only credentials require manual unlock. Never query the
                // system credential store, even for migration or cleanup.
                let unlocked = store.local_key(false).and_then(|device_key| {
                    credential.open(&store.startup_unlock_path(), &device_key)
                })
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
    fn local_key(&self, create: bool) -> Result<Key, String> {
        let path = self.file.with_file_name("workspace.key");
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => return Err("本机工作区密钥必须是普通文件。".into()),
            Err(err) if err.kind() == io::ErrorKind::NotFound && create => {
                let key = zeroize::Zeroizing::new(rand::random::<[u8; 32]>());
                let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(error)?;
                temp.write_all(&key[..]).and_then(|()| temp.as_file().sync_all()).map_err(error)?;
                temp.persist_noclobber(&path).map_err(error)?;
                return Ok(key);
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                return Err("本机工作区密钥缺失，请恢复 workspace.key，不能重新生成密钥读取已有数据。".into());
            }
            Err(err) => return Err(error(err)),
        }
        let bytes = zeroize::Zeroizing::new(vault::bounded_read(&path, 32)?);
        let mut key = Key::default();
        if bytes.len() != key.len() {
            return Err("本机工作区密钥格式无效。".into());
        }
        key.copy_from_slice(&bytes);
        Ok(key)
    }
    pub fn read_secret(&mut self, token: Uuid) -> Result<zeroize::Zeroizing<String>, String> {
        let data = self.data()?;
        if !data.credential_tokens().contains(&token) {
            return Err("已保存的凭据不存在。".into());
        }
        if let Some(secret) = data.local_secrets.get(&token) {
            return Ok(zeroize::Zeroizing::new(secret.secret.clone()));
        }
        Err("旧版本机凭据已停止读取，请重新输入并保存。".into())
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
    pub fn enable_startup_unlock(&mut self) -> Result<(), String> {
        let key = self.key.as_ref().ok_or("请先启用并解锁保险库。")?;
        let vault_id = self.envelope.as_ref().ok_or("保险库不存在。")?.header.id;
        let previous = self.startup_unlock.clone();
        let credential = previous.clone().filter(|c| c.vault_id == vault_id)
            .unwrap_or_else(|| startup_unlock::Credential::new(vault_id));
        let path = self.startup_unlock_path();
        let protected = credential.protect(&path, &self.local_key(true)?, key)?;
        self.set_startup_unlock(Some(protected))?;
        Ok(())
    }
    pub fn clear_startup_unlock(&mut self) -> Result<(), String> {
        self.set_startup_unlock(None)
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
            "startupUnlockSupported": true,
            "startupUnlockRequired": self.startup_unlock.is_none(),
            "startupUnlockError": self.startup_unlock_error,
            "autoLockMinutes": self.data.as_ref().map(|data| data.lock_settings.auto_lock_minutes).unwrap_or(Some(15)),
            "remote": sync.map(|s| s.remote.as_str()).unwrap_or(""),
            "branch": sync.map(|s| s.branch.as_str()),
            "gitSsh": cfg!(desktop),
            "gitMigration": migration.map(|m| json!({"remote": m.remote, "branch": m.branch})),
            "lastSynced": sync.and_then(|s| s.last_synced),
            "lastFetched": self.data.as_ref().and_then(|data| data.last_fetched),
            "gitSettings": self.data.as_ref().map(|data| data.git_settings),
            "fileTransfers": cfg!(desktop)
        })
    }
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() as u64 > MAX_DOCUMENT {
            return Err("工作区文件超过大小上限。".into());
        }
        write_atomic(&self.file, bytes)
    }
    pub fn update(&mut self, mut data: Data) -> Result<(), String> {
        self.data()?;
        let valid_keys: HashSet<_> = data
            .key_passphrases
            .iter()
            .filter_map(|(id, saved)| {
                data.connection_host(*id)
                    .ok()
                    .filter(|host| {
                        host.auth == "key" && host.key_path.as_ref() == Some(&saved.key_path)
                    })
                    .map(|_| *id)
            })
            .collect();
        data.key_passphrases.retain(|id, _| valid_keys.contains(id));
        let tokens = data.credential_tokens();
        data.local_secrets.retain(|token, _| tokens.contains(token));
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
            self.write(&vault::encode_local(&self.local_key(true)?, &data)?)?;
        }
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
    pub fn remove_protection(&mut self) -> Result<(), String> {
        let mut data = self.data()?.clone();
        // Keep locally saved credentials; only explicitly shared, vault-only copies are removed.
        data.portable_passwords.clear();
        for identity in &mut data.identities {
            identity.password = None;
        }
        data.sync = None;
        data.git_migration = None;
        data.git_settings = GitSettings::default();
        data.last_fetched = None;
        data.lock_settings = LockSettings::default();
        if let Some(path) = self.touch_id_path() {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(error(err)),
            }
        }
        self.write(&vault::encode_local(&self.local_key(true)?, &data)?)?;
        self.data = Some(data);
        self.envelope = None;
        self.key = None;
        self.epoch += 1;
        self.revision += 1;
        Ok(())
    }
    pub fn unlock(&mut self, key: Key, data: Data) {
        let refresh_startup = self.startup_unlock.as_ref().is_some_and(|c| c.is_legacy())
            || (self.startup_unlock.is_some() && self.startup_unlock_error.is_some());
        self.key = Some(key);
        self.data = Some(data);
        self.startup_unlock_error = None;
        self.epoch += 1;
        if refresh_startup && self.enable_startup_unlock().is_err() {
            self.startup_unlock_error = Some("自动解锁凭据更新失败，请检查工作区写入权限或重新设置应用锁。".into());
        }
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
        if self.envelope.is_some() || !self.data()?.snapshot().is_empty() {
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
