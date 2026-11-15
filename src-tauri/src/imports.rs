use crate::{
    assets::{self, Group},
    error, ssh,
    store::{Data, Fingerprint, Host},
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

const CSV_HEADER: &[&str] = &[
    "format",
    "type",
    "id",
    "name",
    "address",
    "port",
    "username",
    "auth",
    "group",
    "groupId",
    "parentId",
    "jumpHostId",
    "tags",
    "note",
    "logPath",
    "service",
    "keepaliveInterval",
    "connectTimeout",
    "autoReconnect",
    "terminalTheme",
];

pub fn csv_rows(text: &str) -> Result<Vec<Vec<String>>, String> {
    if text.len() > 1024 * 1024 {
        return Err("CSV 超过 1 MiB。".into());
    }
    let text = text.trim_start_matches('\u{feff}');
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut chars = text.chars().peekable();
    let (mut quoted, mut closed) = (false, false);
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    quoted = false;
                    closed = true;
                }
            } else {
                cell.push(c);
            }
        } else {
            match c {
                '"' if cell.is_empty() && !closed => quoted = true,
                ',' => {
                    row.push(std::mem::take(&mut cell));
                    closed = false;
                }
                '\r' | '\n' => {
                    if c == '\r' && chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    row.push(std::mem::take(&mut cell));
                    if row.iter().any(|c| !c.is_empty()) {
                        rows.push(std::mem::take(&mut row));
                    } else {
                        row.clear();
                    }
                    closed = false;
                }
                _ if closed => return Err("CSV 引号后的字符无效。".into()),
                '"' => return Err("CSV 引号位置无效。".into()),
                _ => cell.push(c),
            }
        }
        if row.len() >= 32 || rows.len() > 1001 {
            return Err("CSV 超过 1000 条记录或 32 列。".into());
        }
    }
    if quoted {
        return Err("CSV 引号未闭合。".into());
    }
    row.push(cell);
    if row.iter().any(|c| !c.is_empty()) {
        rows.push(row);
    }
    if rows.len() > 1001 || rows.iter().any(|r| r.len() > 32) {
        return Err("CSV 超过 1000 条记录或 32 列。".into());
    }
    Ok(rows)
}

// Only explicitly listed metadata enters CSV. Never serialize Host/Data wholesale:
// they also carry local credential bindings and executable startup configuration.
fn host_metadata(host: &Host) -> Value {
    json!({
        "id":host.id, "name":host.name, "address":host.address, "port":host.port,
        "username":host.username, "auth":host.auth, "group":host.group,
        "groupId":host.group_id, "jumpHostId":host.jump_host_id, "tags":host.tags,
        "note":host.note, "logPath":host.log_path, "service":host.service,
        "keepaliveInterval":host.keepalive_interval, "connectTimeout":host.connect_timeout,
        "autoReconnect":host.auto_reconnect, "terminalTheme":host.terminal_theme
    })
}
fn group_metadata(group: &Group) -> Value {
    json!({"id":group.id,"name":group.name,"parentId":group.parent_id,
        "port":group.port,"terminalTheme":group.terminal_theme})
}

pub struct CsvExport {
    pub text: String,
    pub hosts: usize,
    pub groups: usize,
}

pub fn csv_export(data: &Data, scope: &Value) -> Result<CsvExport, String> {
    let mut data = data.clone();
    assets::migrate_groups(&mut data);
    assets::validate_groups(&data)?;
    let host_id = scope.get("hostId").map(|v| crate::id(v)).transpose()?;
    let group_id = scope.get("groupId").map(|v| crate::id(v)).transpose()?;
    if host_id.is_some() && group_id.is_some() {
        return Err("请选择一种导出范围。".into());
    }
    if let Some(id) = host_id {
        data.host(id)?;
    }
    if group_id.is_some_and(|id| !data.groups.iter().any(|g| g.id == id)) {
        return Err("分组已删除，请重新选择。".into());
    }
    let all = host_id.is_none() && group_id.is_none();
    let mut groups: HashSet<Uuid> = if all {
        data.groups.iter().map(|g| g.id).collect()
    } else {
        group_id.into_iter().collect()
    };
    // A group export includes its complete subtree, including empty descendants.
    loop {
        let before = groups.len();
        for group in &data.groups {
            if group.parent_id.is_some_and(|id| groups.contains(&id)) {
                groups.insert(group.id);
            }
        }
        if groups.len() == before {
            break;
        }
    }
    let mut hosts: HashSet<Uuid> = data
        .hosts
        .iter()
        .filter(|h| {
            all || Some(h.id) == host_id || h.group_id.is_some_and(|id| groups.contains(&id))
        })
        .map(|h| h.id)
        .collect();
    // Include jump hosts so an exported target never silently becomes a direct connection.
    loop {
        let before = hosts.len();
        for host in &data.hosts {
            if hosts.contains(&host.id) {
                if let Some(id) = host.jump_host_id {
                    data.host(id)?;
                    hosts.insert(id);
                }
            }
        }
        if hosts.len() == before {
            break;
        }
    }
    for host in data.hosts.iter().filter(|h| hosts.contains(&h.id)) {
        if let Some(id) = host.group_id {
            groups.insert(id);
        }
    }
    loop {
        let before = groups.len();
        for group in &data.groups {
            if groups.contains(&group.id) {
                if let Some(id) = group.parent_id {
                    groups.insert(id);
                }
            }
        }
        if groups.len() == before {
            break;
        }
    }
    let mut records = Vec::new();
    for group in data.groups.iter().filter(|g| groups.contains(&g.id)) {
        let mut row = group_metadata(group);
        row["type"] = json!("group");
        row["group"] = json!(assets::group_path(&data, group.id)?);
        records.push(row);
    }
    for host in data.hosts.iter().filter(|h| hosts.contains(&h.id)) {
        let host = data.connection_host(host.id)?;
        host.jump_host(&data.connection_hosts())?;
        let mut row = host_metadata(&host);
        row["type"] = json!("host");
        records.push(row);
    }
    if records.is_empty() {
        return Err("没有可导出的主机或分组。".into());
    }
    if records.len() > 1000 {
        return Err("单个 CSV 最多导出 1000 条记录，请按分组导出。".into());
    }
    let mut text = format!("\u{feff}{}\r\n", CSV_HEADER.join(","));
    for row in records {
        let cells: Vec<_> = CSV_HEADER
            .iter()
            .map(|key| {
                let cell = if *key == "format" {
                    "termlume-v1".into()
                } else {
                    match &row[*key] {
                        Value::Null => String::new(),
                        Value::String(s) => s.clone(),
                        v => v.to_string(),
                    }
                };
                // Prevent spreadsheet formula execution; the version marker permits lossless decoding.
                let cell = if cell.starts_with(['=', '+', '-', '@', '\'', '\t', '\r', '\n']) {
                    format!("'{cell}")
                } else {
                    cell
                };
                format!("\"{}\"", cell.replace('"', "\"\""))
            })
            .collect();
        text.push_str(&cells.join(","));
        text.push_str("\r\n");
    }
    if text.len() > 1024 * 1024 {
        return Err("CSV 超过 1 MiB，请按分组导出。".into());
    }
    Ok(CsvExport {
        text,
        hosts: hosts.len(),
        groups: groups.len(),
    })
}

pub fn csv_preview(text: &str) -> Result<Value, String> {
    let mut rows = csv_rows(text)?.into_iter();
    let header = rows.next().ok_or("CSV 为空。")?;
    let header: Vec<_> = header.iter().map(|h| h.trim().to_lowercase()).collect();
    let mut seen = HashSet::new();
    if header.iter().any(|h| !seen.insert(h)) || !header.iter().any(|h| h == "address") {
        return Err("CSV 表头须包含唯一的 address 列，不能重复列名。".into());
    }
    let allowed: HashSet<_> = CSV_HEADER.iter().map(|h| h.to_lowercase()).collect();
    let mut warnings: Vec<_> = header
        .iter()
        .filter(|h| !allowed.contains(*h))
        .map(|h| format!("忽略不支持的列：{h}"))
        .collect();
    warnings.push("密码、私钥、私钥口令及登录配置关联不会导入，请在本机单独配置。".into());
    let mut output = Vec::new();
    let mut groups = Vec::new();
    let mut ids = HashSet::new();
    for (index, row) in rows.enumerate() {
        if row.len() > header.len() {
            return Err(format!("第 {} 条记录的列数与表头不一致。", index + 1));
        }
        let raw = |name: &str| {
            header
                .iter()
                .position(|h| h == name)
                .and_then(|i| row.get(i))
                .map(String::as_str)
                .unwrap_or("")
                .trim()
        };
        if !matches!(raw("format"), "" | "termlume-v1") {
            return Err("CSV 格式版本不支持。".into());
        }
        let get = |name: &str| {
            let s = raw(name);
            if raw("format") == "termlume-v1" {
                if let Some(rest) = s.strip_prefix('\'') {
                    if rest.starts_with(['=', '+', '-', '@', '\'', '\t', '\r', '\n']) {
                        return rest;
                    }
                }
            }
            s
        };
        let uuid = |name: &str| -> Result<Option<Uuid>, String> {
            if get(name).is_empty() {
                Ok(None)
            } else {
                let id = Uuid::parse_str(get(name))
                    .map_err(|_| format!("第 {} 条记录的 {name} 标识无效。", index + 1))?;
                if id.is_nil() {
                    return Err("CSV 标识不能为空 UUID。".into());
                }
                Ok(Some(id))
            }
        };
        let id = uuid("id")?.unwrap_or_else(Uuid::new_v4);
        if !ids.insert(id) {
            return Err("CSV 记录标识重复。".into());
        }
        let number = |name: &str, default: u16| {
            if get(name).is_empty() {
                default
            } else {
                get(name).parse::<u16>().unwrap_or(0)
            }
        };
        let theme = (!get("terminaltheme").is_empty()).then(|| get("terminaltheme").to_owned());
        match get("type") {
            "group" => groups.push(
                Group {
                    id,
                    name: get("name").into(),
                    parent_id: uuid("parentid")?,
                    port: (!get("port").is_empty()).then(|| number("port", 22)),
                    terminal_theme: theme,
                    ..Default::default()
                }
                .normalized()?,
            ),
            "" | "host" => {
                if !matches!(get("autoreconnect"), "" | "true" | "false") {
                    return Err("autoReconnect 须为 true 或 false。".into());
                }
                let tags = if get("tags").starts_with('[') {
                    serde_json::from_str(get("tags")).map_err(|_| "tags JSON 数组无效。")?
                } else {
                    get("tags")
                        .split(';')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .collect()
                };
                let mut host = Host {
                    id,
                    name: get("name").into(),
                    address: get("address").into(),
                    port: number("port", 22),
                    username: get("username").into(),
                    auth: if get("auth").is_empty() {
                        "agent".into()
                    } else {
                        get("auth").into()
                    },
                    group: get("group").into(),
                    group_id: uuid("groupid")?,
                    jump_host_id: uuid("jumphostid")?,
                    note: get("note").into(),
                    tags,
                    log_path: get("logpath").into(),
                    service: get("service").into(),
                    keepalive_interval: if get("keepaliveinterval").is_empty() {
                        15
                    } else {
                        get("keepaliveinterval").parse().unwrap_or(u16::MAX)
                    },
                    connect_timeout: number("connecttimeout", 65),
                    auto_reconnect: get("autoreconnect") == "true",
                    terminal_theme: theme,
                    ..Default::default()
                };
                if host.group_id.is_some() {
                    host.group.clear();
                }
                let mut value = json!(host);
                let mut probe = host.clone();
                probe.username = "import-user".into();
                if let Err(issue) = host.normalized(true) {
                    value["issue"] = json!(issue);
                    value["editable"] = json!(probe.normalized(true).is_ok());
                }
                output.push(value);
            }
            _ => return Err("CSV type 仅支持 host 或 group。".into()),
        }
    }
    let probe = Data {
        groups: groups.clone(),
        ..Default::default()
    };
    assets::validate_groups(&probe)?;
    for value in &mut output {
        let mut host: Host = crate::parse(value.clone())?;
        if let Some(id) = host.group_id {
            host.group = assets::group_path(&probe, id)?;
            value["group"] = json!(host.group);
        }
    }
    let hosts: Vec<Host> = output
        .iter()
        .cloned()
        .map(crate::parse)
        .collect::<Result<_, _>>()?;
    for host in &hosts {
        host.jump_host(&hosts)?;
    }
    if output.is_empty() && groups.is_empty() {
        return Err("CSV 没有可导入的主机或分组。".into());
    }
    Ok(json!({"rows":output,"groups":assets::groups(&probe),"warnings":warnings}))
}

/// Imports are additive. Source IDs are references only and never bind destination credentials.
pub fn import_records(data: &mut Data, value: &Value) -> Result<Value, String> {
    let rows: Vec<Host> = crate::parse(value["rows"].clone())?;
    let groups: Vec<Group> =
        crate::parse(value.get("groups").cloned().unwrap_or_else(|| json!([])))?;
    if rows.len() + groups.len() > 1000 {
        return Err("导入数量过多。".into());
    }
    let mut source = Data::default();
    for group in groups {
        source.groups.push(
            Group {
                identity_id: None,
                ..group
            }
            .normalized()?,
        );
    }
    assets::validate_groups(&source)?;
    let previous_groups = data.groups.len();
    let previous_hosts = data.hosts.len();
    assets::migrate_groups(data);
    let mut group_map = HashMap::new();
    // Resolve recursively rather than trusting either source order or IDs.
    fn add_group(
        id: Uuid,
        source: &Data,
        data: &mut Data,
        mapped: &mut HashMap<Uuid, Uuid>,
    ) -> Result<Uuid, String> {
        if let Some(id) = mapped.get(&id) {
            return Ok(*id);
        }
        let group = source
            .groups
            .iter()
            .find(|g| g.id == id)
            .ok_or("CSV 分组引用不存在。")?;
        let parent_id = group
            .parent_id
            .map(|id| add_group(id, source, data, mapped))
            .transpose()?;
        let target = if let Some(g) = data
            .groups
            .iter()
            .find(|g| g.parent_id == parent_id && g.name == group.name)
        {
            g.id
        } else {
            let id = Uuid::new_v4();
            data.groups.push(Group {
                id,
                parent_id,
                identity_id: None,
                ..group.clone()
            });
            id
        };
        mapped.insert(id, target);
        Ok(target)
    }
    for group in &source.groups {
        add_group(group.id, &source, data, &mut group_map)?;
    }
    let mut mapped = HashMap::new();
    let mut pending = Vec::new();
    let mut seen = HashSet::new();
    let resolved = data.connection_hosts();
    for host in rows {
        let source_id = host.id;
        if !source_id.is_nil() && !seen.insert(source_id) {
            return Err("导入主机标识重复。".into());
        }
        // Rebuild from a metadata allowlist, preserving OpenSSH's explicitly selected local path.
        let mut clean: Host = crate::parse(host_metadata(&host))?;
        clean.key_path = host.key_path;
        clean.id = Uuid::new_v4();
        clean.group_id = host
            .group_id
            .map(|id| {
                group_map
                    .get(&id)
                    .copied()
                    .ok_or("请选择主机所属分组及其上级分组。")
            })
            .transpose()?;
        if clean.group_id.is_some() {
            clean.group.clear();
        }
        clean = clean.normalized(true)?;
        let existing = resolved
            .iter()
            .chain(pending.iter())
            .find(|h: &&Host| h.same_endpoint(&clean) && h.username == clean.username);
        let target = if !crate::flag(value, "keepDuplicates") {
            existing.map(|h| h.id)
        } else {
            None
        };
        if let Some(id) = target {
            mapped.insert(source_id, id);
        } else {
            mapped.insert(source_id, clean.id);
            pending.push(clean);
        }
    }
    for host in &mut pending {
        host.jump_host_id = host
            .jump_host_id
            .map(|id| {
                mapped
                    .get(&id)
                    .copied()
                    .ok_or("请同时选择目标主机使用的跳板机。")
            })
            .transpose()?;
    }
    data.hosts.extend(pending);
    assets::migrate_groups(data);
    assets::validate_groups(data)?;
    let resolved = data.connection_hosts();
    for host in data.hosts.iter().skip(previous_hosts) {
        host.jump_host(&resolved)?;
    }
    Ok(
        json!({"hosts":data.connection_hosts(),"count":data.hosts.len()-previous_hosts,"groupCount":data.groups.len()-previous_groups}),
    )
}

pub fn known_preview(text: &str) -> Result<Value, String> {
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    for (number, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 3 || parts[0].starts_with(['@', '|']) {
            warnings.push(format!(
                "第 {} 行：跳过标记、哈希主机名或无效记录。",
                number + 1
            ));
            continue;
        }
        let key = russh::keys::PublicKey::from_openssh(&format!("{} {}", parts[1], parts[2]))
            .map_err(error)?;
        let fingerprint = key.fingerprint(russh::keys::HashAlg::Sha256).to_string();
        if !ssh::valid_fingerprint(&fingerprint) {
            return Err("密钥指纹无效。".into());
        }
        for endpoint in parts[0].split(',') {
            let (address, port) = if endpoint.starts_with('[') {
                let Some((address, port)) = endpoint[1..].split_once("]:") else {
                    continue;
                };
                (address, port.parse::<u16>().unwrap_or(0))
            } else {
                (endpoint, 22)
            };
            if address.contains(['*', '?', '!']) || port == 0 {
                warnings.push(format!("第 {} 行：跳过匹配规则。", number + 1));
                continue;
            }
            let host = Host {
                address: address.into(),
                port,
                username: "validation".into(),
                ..Default::default()
            }
            .normalized(true)?;
            rows.push(Fingerprint {
                address: host.address,
                port,
                fingerprint: fingerprint.clone(),
            });
            if rows.len() > 5000 {
                return Err("信任记录超过 5000 条。".into());
            }
        }
    }
    Ok(json!({"rows":rows,"warnings":warnings}))
}

#[cfg(test)]
mod csv_tests {
    use super::*;
    use crate::{
        assets::{Identity, Secret},
        store::{LocalPassword, Password},
    };

    fn fixture() -> Data {
        let root = Uuid::new_v4();
        let child = Uuid::new_v4();
        let empty = Uuid::new_v4();
        let identity = Uuid::new_v4();
        let jump = Uuid::new_v4();
        Data {
            groups: vec![
                Group {
                    id: child,
                    name: "应用, \"核心\"".into(),
                    parent_id: Some(root),
                    ..Default::default()
                },
                Group {
                    id: empty,
                    name: "空组".into(),
                    parent_id: Some(child),
                    ..Default::default()
                },
                Group {
                    id: root,
                    name: "生产 / 运维".into(),
                    port: Some(2222),
                    identity_id: Some(identity),
                    terminal_theme: Some("light".into()),
                    ..Default::default()
                },
            ],
            identities: vec![Identity {
                id: identity,
                username: "ops".into(),
                auth: "key".into(),
                key_path: Some("/private/sensitive-key".into()),
                password: Some(Secret {
                    secret: "identity-secret".into(),
                }),
                ..Default::default()
            }],
            hosts: vec![
                Host {
                    id: Uuid::new_v4(),
                    name: "=HYPERLINK(\"unsafe\")".into(),
                    address: "api.example.test".into(),
                    group_id: Some(child),
                    inherit_identity: true,
                    inherit_port: true,
                    inherit_theme: true,
                    tags: vec!["api;core".into(), "中文,标签".into()],
                    note: "'quoted, note".into(),
                    log_path: "/var/log/app.log".into(),
                    service: "app.service".into(),
                    keepalive_interval: 30,
                    connect_timeout: 90,
                    auto_reconnect: true,
                    jump_host_id: Some(jump),
                    startup_command: "echo startup-secret".into(),
                    startup_enabled: true,
                    ..Default::default()
                },
                Host {
                    id: jump,
                    name: "跳板".into(),
                    address: "jump.example.test".into(),
                    username: "jump-user".into(),
                    auth: "password".into(),
                    ..Default::default()
                },
            ],
            local_passwords: [(jump, LocalPassword::Legacy("local-secret".into()))]
                .into_iter()
                .collect(),
            portable_passwords: [(
                jump,
                Password {
                    password: "portable-secret".into(),
                    fingerprint: "fingerprint-secret".into(),
                },
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn csv_round_trip_preserves_metadata_hierarchy_and_routes_without_credentials() {
        let data = fixture();
        let export = csv_export(&data, &json!({})).unwrap();
        assert_eq!((export.hosts, export.groups), (2, 3));
        for secret in [
            "sensitive-key",
            "identity-secret",
            "local-secret",
            "portable-secret",
            "fingerprint-secret",
            "startup-secret",
            "keyPath",
            "identityId",
        ] {
            assert!(!export.text.contains(secret), "CSV leaked {secret}");
        }
        assert!(export.text.contains("'=HYPERLINK"));
        let preview = csv_preview(&export.text).unwrap();
        assert!(preview["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["issue"].is_null()));
        let mut target = Data::default();
        let result = import_records(&mut target, &preview).unwrap();
        assert_eq!(result["count"], 2);
        assert_eq!(result["groupCount"], 3);
        let api = target.connection_host(target.hosts[0].id).unwrap();
        assert_eq!(
            (api.port, api.username.as_str(), api.auth.as_str()),
            (2222, "ops", "key")
        );
        assert_eq!(api.name, data.hosts[0].name);
        assert_eq!(api.tags, data.hosts[0].tags);
        assert_eq!(api.note, data.hosts[0].note);
        assert_eq!(api.log_path, data.hosts[0].log_path);
        assert_eq!(api.service, data.hosts[0].service);
        assert_eq!(
            (
                api.keepalive_interval,
                api.connect_timeout,
                api.auto_reconnect
            ),
            (30, 90, true)
        );
        assert_eq!(api.group, "生产 / 运维 / 应用, \"核心\"");
        assert_eq!(api.terminal_theme.as_deref(), Some("light"));
        assert_eq!(api.jump_host_id, Some(target.hosts[1].id));
        assert!(api.key_path.is_none() && api.identity_id.is_none());
        assert!(!api.inherit_identity && !api.startup_enabled && api.startup_command.is_empty());
        assert!(
            target.local_passwords.is_empty()
                && target.portable_passwords.is_empty()
                && target.identities.is_empty()
        );
        assert!(target
            .groups
            .iter()
            .all(|g| g.identity_id.is_none() && !data.groups.iter().any(|old| old.id == g.id)));
        assert_eq!(csv_export(&target, &json!({})).unwrap().groups, 3);
    }

    #[test]
    fn csv_scopes_include_required_ancestors_jump_hosts_and_empty_groups() {
        let data = fixture();
        let one = csv_export(&data, &json!({"hostId":data.hosts[0].id})).unwrap();
        assert_eq!((one.hosts, one.groups), (2, 2));
        let group = csv_export(&data, &json!({"groupId":data.groups[0].id})).unwrap();
        assert_eq!((group.hosts, group.groups), (2, 3));
        let empty = csv_export(&data, &json!({"groupId":data.groups[1].id})).unwrap();
        assert_eq!((empty.hosts, empty.groups), (0, 3));
        let preview = csv_preview(&empty.text).unwrap();
        let mut target = Data::default();
        assert_eq!(
            import_records(&mut target, &preview).unwrap()["groupCount"],
            3
        );
        assert!(target.hosts.is_empty());
        assert!(csv_export(&data, &json!({"groupId":Uuid::new_v4()})).is_err());
    }

    #[test]
    fn csv_import_merges_groups_skips_duplicates_and_remaps_jump_to_existing_host() {
        let data = fixture();
        let preview = csv_preview(&csv_export(&data, &json!({})).unwrap().text).unwrap();
        let existing_id = Uuid::new_v4();
        let mut target = Data {
            hosts: vec![Host {
                id: existing_id,
                ..data.hosts[1].clone()
            }],
            ..Default::default()
        };
        let result = import_records(&mut target, &preview).unwrap();
        assert_eq!(result["count"], 1);
        assert_eq!(target.hosts[1].jump_host_id, Some(existing_id));
        target.groups[0].port = Some(2200);
        let groups = target.groups.clone();
        let hosts = target.hosts.clone();
        let again = import_records(&mut target, &preview).unwrap();
        assert_eq!(again["count"], 0);
        assert_eq!(again["groupCount"], 0);
        assert!(target.groups == groups);
        assert_eq!(target.hosts, hosts);
        let mut duplicates = preview.clone();
        duplicates["keepDuplicates"] = json!(true);
        assert_eq!(
            import_records(&mut target, &duplicates).unwrap()["count"],
            2
        );
        assert_eq!(target.hosts[2].jump_host_id, Some(target.hosts[3].id));
    }

    #[test]
    fn csv_legacy_missing_credentials_validation_and_size_limits() {
        let preview = csv_preview("name,address,username,auth,tags,password,keyPath\nold,valid.test,ops,key,prod;api,secret,/other-machine/key\n").unwrap();
        assert!(preview["rows"][0]["issue"].is_null());
        assert!(preview["rows"][0]["keyPath"].is_null());
        assert_eq!(preview["rows"][0]["tags"], json!(["prod", "api"]));
        assert!(!preview.to_string().contains("secret"));
        assert_eq!(
            csv_preview("address,username\nvalid.test,\n").unwrap()["rows"][0]["editable"],
            true
        );
        assert!(
            !csv_preview("address,port,username\nvalid.test,0,ops\n").unwrap()["rows"][0]["issue"]
                .is_null()
        );
        assert!(csv_preview("address,username\nvalid.test,ops,extra").is_err());
        assert!(csv_rows(&format!("a\n{}", "b\n".repeat(1001))).is_err());
        assert!(csv_rows(&"a".repeat(1024 * 1024 + 1)).is_err());
        let group = Uuid::new_v4();
        assert!(csv_preview(&format!(
            "type,id,name,address,parentId\ngroup,{group},cycle,,{group}"
        ))
        .is_err());
        let data = fixture();
        let mut preview = csv_preview(&csv_export(&data, &json!({})).unwrap().text).unwrap();
        preview["rows"].as_array_mut().unwrap().pop();
        assert!(import_records(&mut Data::default(), &preview).is_err());
    }
}
