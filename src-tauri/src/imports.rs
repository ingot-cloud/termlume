use crate::{
    error, ssh,
    store::{Fingerprint, Host},
};
use serde_json::{json, Value};
use uuid::Uuid;
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
        if row.len() > 32 || rows.len() > 1000 {
            return Err("CSV 超过 1000 行或 32 列。".into());
        }
    }
    if quoted {
        return Err("CSV 引号未闭合。".into());
    }
    row.push(cell);
    if row.iter().any(|c| !c.is_empty()) {
        rows.push(row);
    }
    Ok(rows)
}
pub fn csv_preview(text: &str) -> Result<Value, String> {
    let mut rows = csv_rows(text)?.into_iter();
    let header = rows.next().ok_or("CSV 为空。")?;
    let header: Vec<_> = header.iter().map(|h| h.trim().to_lowercase()).collect();
    let mut seen = std::collections::HashSet::new();
    if header.iter().any(|h| !seen.insert(h)) || !header.iter().any(|h| h == "address") {
        return Err("CSV 表头须包含唯一的 address 列，不能重复列名。".into());
    }
    let allowed = [
        "name", "address", "port", "username", "auth", "group", "tags", "note", "keypath",
    ];
    let warnings: Vec<_> = header
        .iter()
        .filter(|h| !allowed.contains(&h.as_str()))
        .map(|h| format!("忽略不支持的列：{h}"))
        .collect();
    let mut output = Vec::new();
    for row in rows {
        let get = |name: &str| {
            header
                .iter()
                .position(|h| h == name)
                .and_then(|i| row.get(i))
                .map(String::as_str)
                .unwrap_or("")
                .trim()
        };
        let port = if get("port").is_empty() {
            22
        } else {
            get("port").parse::<u16>().unwrap_or(0)
        };
        let auth = if get("auth").is_empty() {
            "agent"
        } else {
            get("auth")
        };
        let host = Host {
            id: Uuid::new_v4(),
            name: get("name").into(),
            address: get("address").into(),
            port,
            username: get("username").into(),
            auth: auth.into(),
            group: get("group").into(),
            note: get("note").into(),
            tags: get("tags")
                .split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            key_path: (!get("keypath").is_empty()).then(|| get("keypath").into()),
            ..Default::default()
        };
        let mut value = json!(host);
        let mut with_username = host.clone();
        with_username.username = "import-user".into();
        let editable = host.username.is_empty() && with_username.normalized(false).is_ok();
        if let Err(issue) = host.normalized(false) {
            value["issue"] = json!(issue);
            value["editable"] = json!(editable);
        }
        output.push(value);
    }
    Ok(json!({"rows":output,"warnings":warnings}))
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
