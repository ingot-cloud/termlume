use crate::{
    store::{checked, Data, Host, LocalPassword},
    Workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Secret {
    pub secret: String,
}
impl Drop for Secret {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}
#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Identity {
    pub id: Uuid,
    pub name: String,
    pub username: String,
    pub auth: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<PathBuf>,
    pub version: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<Secret>,
}
impl Identity {
    pub fn normalized(mut self) -> Result<Self, String> {
        self.name = checked(&self.name, "配置名称", 120)?;
        let h = Host {
            address: "identity.test".into(),
            username: self.username.clone(),
            auth: self.auth.clone(),
            key_path: self.key_path.clone(),
            ..Default::default()
        }
        .normalized(true)?;
        self.username = h.username;
        self.key_path = h.key_path;
        if self.version.is_nil() {
            self.version = Uuid::new_v4();
        }
        if self.auth != "password" && self.password.is_some() {
            return Err("仅使用 SSH 密码的登录配置可保存密码。".into());
        }
        if self
            .password
            .as_ref()
            .is_some_and(|p| p.secret.is_empty() || p.secret.len() > 16384)
        {
            return Err("登录配置的密码格式无效。".into());
        }
        Ok(self)
    }
    pub fn summary(&self, data: &Data) -> Value {
        let mut value = json!(self);
        value.as_object_mut().unwrap().remove("password");
        value["passwordSaved"] =
            json!(self.password.is_some() || data.has_local_password(self.id));
        value["groups"] = json!(data
            .groups
            .iter()
            .filter(|g| g.identity_id == Some(self.id))
            .map(|g| g.name.clone())
            .collect::<Vec<_>>());
        value["hosts"] = json!(data
            .hosts
            .iter()
            .filter(|h| data
                .connection_host(h.id)
                .is_ok_and(|h| h.identity_id == Some(self.id)))
            .map(|h| json!({"id":h.id,"name":h.name}))
            .collect::<Vec<_>>());
        value
    }
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Asset {
    Identity(Identity),
    Group(Group),
    Snippet(Snippet),
    Layout(Layout),
}
impl Asset {
    pub fn id(&self) -> Uuid {
        match self {
            Self::Identity(i) => i.id,
            Self::Group(g) => g.id,
            Self::Snippet(s) => s.id,
            Self::Layout(l) => l.id,
        }
    }
    pub fn portable(&self) -> Self {
        match self {
            Self::Group(g) => Self::Group(g.clone()),
            Self::Snippet(s) => Self::Snippet(s.clone()),
            Self::Layout(l) => Self::Layout(l.clone()),
            Self::Identity(i) => {
                let mut i = i.clone();
                i.key_path = None;
                Self::Identity(i)
            }
        }
    }
    pub fn normalized(self) -> Result<Self, String> {
        match self {
            Self::Identity(i) => Ok(Self::Identity(i.normalized()?)),
            Self::Group(g) => Ok(Self::Group(g.normalized()?)),
            Self::Snippet(s) => Ok(Self::Snippet(s.normalized()?)),
            Self::Layout(l) => Ok(Self::Layout(l.normalized()?)),
        }
    }
    pub fn summary(&self) -> Value {
        match self {
            Self::Layout(l) => {
                json!({"id":l.id,"name":l.name,"recordType":"layout","tabs":l.tabs,"split":l.split,"direction":l.direction,"ratio":l.ratio,"rowRatio":l.row_ratio})
            }
            Self::Snippet(s) => {
                json!({"id":s.id,"name":s.name,"recordType":"snippet","command":s.command,"tags":s.tags,"pinned":s.pinned,"order":s.order,"builtin":s.builtin})
            }
            Self::Group(g) => {
                json!({"id":g.id,"name":g.name,"recordType":"group","parentId":g.parent_id,"port":g.port,"identityId":g.identity_id,"terminalTheme":g.terminal_theme})
            }
            Self::Identity(i) => {
                json!({"id":i.id,"name":i.name,"username":i.username,"auth":i.auth,"recordType":"identity","passwordSaved":i.password.is_some()})
            }
        }
    }
}
pub fn list(data: &Data) -> Value {
    json!(data
        .identities
        .iter()
        .map(|i| i.summary(data))
        .collect::<Vec<_>>())
}
pub fn save_identity(ws: &Workspace, mut value: Value) -> Result<Value, String> {
    let secret = value
        .as_object_mut()
        .and_then(|v| v.remove("localPassword"))
        .and_then(|v| v.as_str().map(|s| Zeroizing::new(s.to_owned())));
    let mut identity: Identity = crate::parse(value["identity"].clone())?;
    // Portable secrets can only enter through the explicit share control.
    identity.password = None;
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    let old = data
        .identities
        .iter()
        .find(|i| i.id == identity.id)
        .cloned();
    if !identity.id.is_nil() && old.is_none() {
        return Err("登录配置已删除，请刷新。".into());
    }
    if let Some(old) = &old {
        if old.summary(&data) != value["expected"] {
            return Err("登录配置或关联范围已变化，请刷新后重试。".into());
        }
        identity.version = if old.username == identity.username.trim()
            && old.auth == identity.auth
            && old.key_path == identity.key_path
        {
            old.version
        } else {
            Uuid::new_v4()
        };
        if identity.auth == "password"
            && old.auth == identity.auth
            && old.username == identity.username.trim()
        {
            identity.password = old.password.clone();
        } else {
            data.local_passwords.remove(&identity.id);
        }
    } else {
        identity.id = Uuid::new_v4();
        identity.version = Uuid::new_v4();
    }
    identity = identity.normalized()?;
    if crate::flag(&value, "clearPassword") {
        data.local_passwords.remove(&identity.id);
        identity.password = None;
    }
    if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        if identity.auth != "password" || secret.len() > 16384 {
            return Err("登录配置的密码格式无效。".into());
        }
        if crate::flag(&value, "sharePassword") && store.key.is_none() {
            return Err("共享密码到备份前请先启用保险库。".into());
        }
        let token = data.save_secret(&secret);
        data.local_passwords.insert(
            identity.id,
            LocalPassword::Saved {
                token,
                fingerprint: None,
            },
        );
        identity.password = if crate::flag(&value, "sharePassword") {
            Some(Secret {
                secret: secret.to_string(),
            })
        } else {
            None
        };
    }
    data.identities.retain(|i| i.id != identity.id);
    data.identities.push(identity.clone());
    let result =
        json!({"identities":list(&data),"identityId":identity.id,"hosts":data.connection_hosts()});
    store.update(data)?;
    Ok(result)
}
pub fn delete_identity(ws: &Workspace, value: Value) -> Result<Value, String> {
    let id = crate::id(&value["id"])?;
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    let identity = data
        .identities
        .iter()
        .find(|i| i.id == id)
        .ok_or("登录配置已删除。")?;
    if identity.summary(&data) != value["expected"] {
        return Err("登录配置或关联范围已变化，请刷新。".into());
    }
    if data.hosts.iter().any(|h| h.identity_id == Some(id))
        || data.groups.iter().any(|g| g.identity_id == Some(id))
    {
        return Err("登录配置仍被主机或分组使用，请先解除关联。".into());
    }
    data.identities.retain(|i| i.id != id);
    data.local_passwords.remove(&id);
    let result = list(&data);
    store.update(data)?;
    Ok(result)
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Group {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_theme: Option<String>,
    pub id: Uuid,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_id: Option<Uuid>,
}
impl Group {
    fn normalized(mut self) -> Result<Self, String> {
        self.name = checked(&self.name, "分组名称", 120)?;
        if self
            .terminal_theme
            .as_ref()
            .is_some_and(|t| !matches!(t.as_str(), "dark" | "light"))
        {
            return Err("分组终端配色无效。".into());
        }
        if self.port == Some(0) {
            return Err("分组默认端口须为 1–65535。".into());
        }
        Ok(self)
    }
}
pub fn group_path(data: &Data, id: Uuid) -> Result<String, String> {
    let mut path = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current = Some(id);
    while let Some(id) = current {
        if !seen.insert(id) || seen.len() > 16 {
            return Err("分组存在循环或超过 16 层。".into());
        }
        let group = data
            .groups
            .iter()
            .find(|g| g.id == id)
            .ok_or("分组不存在，请重新选择。")?;
        path.push(group.name.clone());
        current = group.parent_id;
    }
    path.reverse();
    Ok(path.join(" / "))
}
pub fn groups(data: &Data) -> Value {
    json!(data
        .groups
        .iter()
        .map(|g| {
            let mut v = json!(g);
            v["path"] =
                json!(group_path(data, g.id).unwrap_or_else(|_| format!("不可用 / {}", g.name)));
            v["hosts"] = json!(data
                .hosts
                .iter()
                .filter(|h| {
                    let mut current = h.group_id;
                    let mut seen = std::collections::HashSet::new();
                    while let Some(id) = current {
                        if id == g.id {
                            return true;
                        }
                        if !seen.insert(id) {
                            break;
                        }
                        current = data
                            .groups
                            .iter()
                            .find(|p| p.id == id)
                            .and_then(|p| p.parent_id);
                    }
                    false
                })
                .map(|h| json!({"id":h.id,"name":h.name}))
                .collect::<Vec<_>>());
            v
        })
        .collect::<Vec<_>>())
}
pub fn migrate_groups(data: &mut Data) -> bool {
    use sha2::{Digest, Sha256};
    let mut changed = false;
    for host in &mut data.hosts {
        if host.group_id.is_none() && !host.group.is_empty() {
            let id = if let Some(g) = data
                .groups
                .iter()
                .find(|g| g.parent_id.is_none() && g.name == host.group)
            {
                g.id
            } else {
                let digest =
                    Sha256::digest(format!("termlume/group/v1\0{}", host.group).as_bytes());
                let mut bytes = [0; 16];
                bytes.copy_from_slice(&digest[..16]);
                bytes[6] = (bytes[6] & 15) | 128;
                bytes[8] = (bytes[8] & 63) | 128;
                let id = Uuid::from_bytes(bytes);
                data.groups.push(Group {
                    id,
                    name: host.group.clone(),
                    ..Default::default()
                });
                id
            };
            host.group_id = Some(id);
            changed = true;
        }
    }
    changed
}
pub fn validate_groups(data: &Data) -> Result<(), String> {
    let mut paths = std::collections::HashSet::new();
    for group in &data.groups {
        if group.id.is_nil() || !paths.insert(group_path(data, group.id)?) {
            return Err("分组路径重复或标识无效。".into());
        }
        if group
            .identity_id
            .is_some_and(|id| !data.identities.iter().any(|i| i.id == id))
        {
            return Err("分组默认登录配置不存在。".into());
        }
    }
    Ok(())
}
pub fn group_request(ws: &Workspace, action: &str, value: Value) -> Result<Value, String> {
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    let changed = migrate_groups(&mut data);
    if action == "groups:list" {
        let result = groups(&data);
        if changed {
            store.update(data)?;
        }
        return Ok(result);
    }
    let mut group: Group = crate::parse(value["group"].clone())?;
    if !group.id.is_nil() {
        let old = groups(&data)
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["id"] == json!(group.id))
            .cloned()
            .ok_or("分组已删除。")?;
        if old != value["expected"] {
            return Err("分组或引用已变化，请刷新。".into());
        }
    } else {
        group.id = Uuid::new_v4();
    }
    if action == "groups:delete" {
        if data.groups.iter().any(|g| g.parent_id == Some(group.id))
            || data.hosts.iter().any(|h| h.group_id == Some(group.id))
        {
            return Err("请先移走子分组和主机，再删除分组。".into());
        }
        data.groups.retain(|g| g.id != group.id);
    } else {
        group = group.normalized()?;
        data.groups.retain(|g| g.id != group.id);
        data.groups.push(group);
        validate_groups(&data)?;
    }
    let result = json!({"groups":groups(&data),"hosts":data.connection_hosts()});
    store.update(data)?;
    Ok(result)
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Snippet {
    pub id: Uuid,
    pub name: String,
    pub command: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub order: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub builtin: Option<String>,
}

pub fn default_snippets() -> Vec<Snippet> {
    serde_json::from_str(include_str!("../../src/command-defaults.json"))
        .expect("valid built-in commands")
}

pub fn all_snippets(data: &Data) -> Vec<Snippet> {
    let mut snippets = data.snippets.clone();
    for default in default_snippets() {
        if let Some(snippet) = snippets.iter_mut().find(|snippet| snippet.id == default.id) {
            snippet.builtin = default.builtin;
        } else {
            snippets.push(default);
        }
    }
    snippets.sort_by_key(|snippet| snippet.order);
    snippets
}
pub fn command_text(value: &str) -> Result<String, String> {
    if value.trim().is_empty()
        || value.len() > 16384
        || value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t' | '\r'))
    {
        return Err("命令须为 1–16384 字节的文本，不可包含控制字符。".into());
    }
    Ok(value.replace("\r\n", "\n"))
}
impl Snippet {
    pub fn rendered(&self, values: &Value) -> Result<String, String> {
        let pattern = regex::Regex::new(r"\{\{(path|service|lines)\}\}").unwrap();
        let mut error = None;
        let command = pattern
            .replace_all(&self.command, |capture: &regex::Captures<'_>| {
                let key = &capture[1];
                let result = if key == "lines" {
                    values[key]
                        .as_u64()
                        .filter(|n| (1..=10000).contains(n))
                        .map(|n| n.to_string())
                        .ok_or_else(|| "行数须在 1 至 10000 之间。".to_string())
                } else {
                    let value = values[key].as_str().unwrap_or("");
                    let valid = if key == "path" {
                        crate::ssh::remote_path(value).map(|_| ())
                    } else {
                        crate::ssh::command_for("journal", value, 100).map(|_| ())
                    };
                    valid.map(|_| format!("'{}'", value.replace('\'', "'\\''")))
                };
                match result {
                    Ok(value) => value,
                    Err(message) => {
                        error = Some(message);
                        String::new()
                    }
                }
            })
            .into_owned();
        if let Some(error) = error {
            return Err(error);
        }
        command_text(&command)
    }

    fn normalized(mut self) -> Result<Self, String> {
        self.name = checked(&self.name, "命令名称", 120)?;
        self.command = command_text(&self.command)?;
        self.builtin = default_snippets()
            .into_iter()
            .find(|default| default.id == self.id)
            .and_then(|default| default.builtin);
        self.tags = self
            .tags
            .iter()
            .take(20)
            .map(|t| checked(t, "标签", 40))
            .collect::<Result<_, _>>()?;
        Ok(self)
    }
}
pub fn snippet_request(ws: &Workspace, action: &str, value: Value) -> Result<Value, String> {
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    let current = all_snippets(&data);
    if action == "snippets:list" {
        return Ok(json!(current));
    }
    if action == "snippets:reorder" {
        if json!(current) != value["expected"] {
            return Err("命令库已变化，请刷新后重试。".into());
        }
        let ids: Vec<Uuid> = crate::parse(value["ids"].clone())?;
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        if ids.len() != current.len() || unique.len() != current.len() {
            return Err("命令顺序无效，请刷新后重试。".into());
        }
        let mut ordered = Vec::new();
        for (index, id) in ids.into_iter().enumerate() {
            let mut snippet = current
                .iter()
                .find(|snippet| snippet.id == id)
                .ok_or("命令已删除。")?
                .clone();
            snippet.order = (index as u32 + 1) * 10;
            ordered.push(snippet);
        }
        data.snippets = ordered;
        let result = json!(all_snippets(&data));
        store.update(data)?;
        return Ok(result);
    }
    let mut snippet: Snippet = crate::parse(value["snippet"].clone())?;
    if !snippet.id.is_nil() {
        let old = current
            .iter()
            .find(|s| s.id == snippet.id)
            .ok_or("命令已删除。")?;
        if json!(old) != value["expected"] {
            return Err("命令已变化，请刷新后重试。".into());
        }
    } else {
        snippet.id = Uuid::new_v4();
    }
    if action == "snippets:delete" {
        data.snippets.retain(|s| s.id != snippet.id);
    } else {
        let snippet = snippet.normalized()?;
        if let Some(index) = data.snippets.iter().position(|old| old.id == snippet.id) {
            data.snippets[index] = snippet;
        } else {
            data.snippets.push(snippet);
        }
    }
    if data
        .snippets
        .iter()
        .filter(|snippet| snippet.builtin.is_none())
        .count()
        > 1000
    {
        return Err("命令库最多保存 1000 条。".into());
    }
    let result = json!(data.snippets);
    store.update(data)?;
    Ok(result)
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LayoutTab {
    pub host_id: Uuid,
    pub title: String,
}
// Versioned split objects deliberately fail deserialization in older clients,
// whose `split` field accepts only an array. Keep legacy arrays unchanged.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum LayoutSplit {
    Legacy(Vec<usize>),
    Tree(LayoutTree),
}
impl Default for LayoutSplit {
    fn default() -> Self { Self::Legacy(Vec::new()) }
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LayoutTree {
    pub version: u8,
    pub root: LayoutNode,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum LayoutNode {
    Pane { index: usize },
    Split { axis: String, ratio: u8, first: Box<LayoutNode>, second: Box<LayoutNode> },
}
impl LayoutNode {
    fn validate(&self, count: usize, indices: &mut std::collections::HashSet<usize>) -> Result<(), String> {
        let mut pending = vec![self];
        while let Some(node) = pending.pop() {
            match node {
                Self::Pane { index } => {
                    if *index >= count || !indices.insert(*index) {
                        return Err("分屏包含重复或无效的会话。".into());
                    }
                }
                Self::Split { axis, ratio, first, second } => {
                    if !matches!(axis.as_str(), "column" | "row") || !(20..=80).contains(ratio) {
                        return Err("分屏方向或比例无效。".into());
                    }
                    pending.push(first); pending.push(second);
                }
            }
        }
        Ok(())
    }
}
#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub id: Uuid,
    pub name: String,
    pub tabs: Vec<LayoutTab>,
    pub split: LayoutSplit,
    pub direction: String,
    pub ratio: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_ratio: Option<u8>,
}
impl Layout {
    fn normalized(mut self) -> Result<Self, String> {
        self.name = checked(&self.name, "布局名称", 120)?;
        if self.tabs.is_empty()
            || self.tabs.iter().any(|t| {
                t.host_id.is_nil() || t.title.len() > 240 || t.title.chars().any(char::is_control)
            })
        {
            return Err("布局需要至少一个有效主机标签。".into());
        }
        match &self.split {
            LayoutSplit::Tree(tree) => {
                if tree.version != 2 { return Err("不支持此会话布局版本，请更新 Termlume。".into()); }
                let mut indices = std::collections::HashSet::new();
                tree.root.validate(self.tabs.len(), &mut indices)?;
                if indices.len() < 2 || indices.len() != self.tabs.len() {
                    return Err("自定义分屏需要至少两个不同的会话。".into());
                }
                self.direction = "tree".into();
                self.ratio = 50;
                self.row_ratio = None;
            }
            LayoutSplit::Legacy(split) => {
                let unique: std::collections::HashSet<_> = split.iter().collect();
                if !split.is_empty()
                    && (!(2..=4).contains(&split.len()) || unique.len() != split.len() || split.iter().any(|i| *i >= self.tabs.len())) {
                    return Err("分屏配置无效。".into());
                }
                if (split.len() > 2) != (self.direction == "grid") {
                    return Err("四宫格需要 3–4 个不同的会话，双分屏需要 2 个不同的会话。".into());
                }
                if !matches!(self.direction.as_str(), "horizontal" | "vertical" | "grid") { self.direction = "horizontal".into(); }
                self.ratio = self.ratio.clamp(20, 80);
                self.row_ratio = if self.direction == "grid" { Some(self.row_ratio.unwrap_or(50).clamp(20, 80)) } else { None };
            }
        }
        Ok(self)
    }
}
pub fn layout_request(ws: &Workspace, action: &str, value: Value) -> Result<Value, String> {
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    if action == "layouts:list" {
        return Ok(json!(data.layouts));
    }
    let mut layout: Layout = crate::parse(value["layout"].clone())?;
    if !layout.id.is_nil() {
        let old = data
            .layouts
            .iter()
            .find(|l| l.id == layout.id)
            .ok_or("布局已删除。")?;
        if json!(old) != value["expected"] {
            return Err("布局已变化，请刷新。".into());
        }
    } else {
        layout.id = Uuid::new_v4();
    }
    data.layouts.retain(|l| l.id != layout.id);
    if action != "layouts:delete" {
        data.layouts.push(layout.normalized()?);
    }
    if data.layouts.len() > 100 {
        return Err("最多保存 100 个布局。".into());
    }
    let result = json!(data.layouts);
    store.update(data)?;
    Ok(result)
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub theme: String,
    pub terminal_theme: String,
    pub font_family: String,
    pub font_size: u16,
    pub record_commands: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            terminal_theme: "dark".into(),
            font_family: "SFMono-Regular, Menlo, monospace".into(),
            font_size: 14,
            record_commands: false,
        }
    }
}
pub fn preferences_request(ws: &Workspace, value: Value) -> Result<Value, String> {
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    if value.is_null() {
        return Ok(json!(data.preferences));
    }
    let preferences: Preferences = crate::parse(value)?;
    if !matches!(preferences.theme.as_str(), "dark" | "light" | "system")
        || !matches!(preferences.terminal_theme.as_str(), "dark" | "light")
        || !(9..=32).contains(&preferences.font_size)
    {
        return Err("主题或字号无效（字号 9–32）。".into());
    }
    checked(&preferences.font_family, "字体", 240)?;
    data.preferences = preferences;
    let result = json!(data.preferences);
    store.update(data)?;
    Ok(result)
}
