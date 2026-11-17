use regex::Regex;
use russh::keys::{
    agent::client::AgentClient,
    ssh_key::{private::{EcdsaKeypair, Ed25519Keypair, RsaKeypair}, EcdsaCurve, LineEnding},
    HashAlg, PrivateKey, PublicKey,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};
#[cfg(target_os = "macos")]
use std::{io::Write, process::{Command, Stdio}};
use zeroize::Zeroizing;

use crate::{error, store::write_exclusive, vault::bounded_read};

pub fn agent_socket() -> Option<PathBuf> {
    if let Some(socket) = std::env::var_os("SSH_AUTH_SOCK").filter(|s| !s.is_empty()) {
        return Some(socket.into());
    }
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("/bin/launchctl")
            .args(["getenv", "SSH_AUTH_SOCK"])
            .output()
            .ok()?;
        let socket = std::str::from_utf8(&out.stdout).ok()?.trim();
        if out.status.success() && Path::new(socket).is_absolute() {
            return Some(socket.into());
        }
    }
    None
}
#[cfg(unix)]
pub async fn agent() -> Result<AgentClient<tokio::net::UnixStream>, String> {
    let socket = agent_socket().ok_or("找不到本机 SSH Agent，请确认已启动并加载密钥。")?;
    AgentClient::connect_uds(socket).await.map_err(error)
}
#[cfg(windows)]
pub async fn agent() -> Result<AgentClient<tokio::net::windows::named_pipe::NamedPipeClient>, String> {
    let pipe = std::env::var_os("SSH_AUTH_SOCK")
        .filter(|value| value.to_string_lossy().starts_with(r"\\.\pipe\"))
        .unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".into());
    tokio::time::timeout(Duration::from_secs(5), AgentClient::connect_named_pipe(pipe))
        .await.map_err(|_| "连接 Windows SSH Agent 超时。".to_owned())?
        .map_err(|_| "SSH Agent 未运行，请启动已有 Agent 并加载密钥，或选择本机私钥/SSH 密码；连接不需要安装系统 OpenSSH。".into())
}
pub async fn agent_keys() -> Value {
    #[cfg(any(unix, windows))]
    {
        if let Ok(Ok(keys)) = tokio::time::timeout(Duration::from_millis(1500), async {
            let mut agent = agent().await?;
            agent.request_identities().await.map_err(error)
        })
        .await
        {
            return json!({"available": true, "keys": keys.iter().enumerate().map(|(i, item)| {
                let key = item.public_key();
                let fallback = format!("Agent 身份 {}", i + 1);
                let name = key.comment().as_str().ok().filter(|s| !s.is_empty()).unwrap_or(&fallback);
                info(&key, name, "", false, false)
            }).collect::<Vec<_>>()});
        }
    }
    json!({"available": false, "keys": []})
}

pub fn read_private_key(path: &Path, passphrase: &str) -> Result<PrivateKey, String> {
    let bytes = Zeroizing::new(bounded_read(path, 256 * 1024)?);
    let text = std::str::from_utf8(&bytes).map_err(error)?;
    russh::keys::decode_secret_key(text, (!passphrase.is_empty()).then_some(passphrase))
        .map_err(|_| "无法读取或解锁私钥，请检查文件与口令。".into())
}

pub async fn add_to_agent(key: &PrivateKey) -> Result<Value, String> {
    #[cfg(any(unix, windows))]
    {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut agent = agent().await?;
            agent.add_identity(key, &[]).await
                .map_err(|_| "SSH Agent 拒绝加载密钥，请检查 Agent 状态或解锁后重试。".to_owned())?;
            Ok(json!({"fingerprint": key.public_key().fingerprint(HashAlg::Sha256).to_string()}))
        }).await.map_err(|_| "SSH Agent 加载密钥超时。".to_owned())?
    }
    #[cfg(not(any(unix, windows)))]
    Err("当前平台不支持 SSH Agent。".into())
}

fn info(key: &PublicKey, name: &str, path: &str, private: bool, encrypted: bool) -> Value {
    json!({"name": name, "path": path, "type": key.algorithm().to_string(), "private": private, "encrypted": encrypted,
        "fingerprint": key.fingerprint(HashAlg::Sha256).to_string(), "publicKey": key.to_openssh().ok()})
}

pub fn scan(directory: &Path) -> Result<Value, String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"directory": directory, "keys": []}))
        }
        Err(e) => return Err(error(e)),
    };
    let mut keys = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if matches!(
            name,
            "config"
                | "known_hosts"
                | "known_hosts2"
                | "known_hosts.old"
                | "authorized_keys"
                | "authorized_keys2"
        ) || name.chars().any(char::is_control)
            || !entry.file_type().is_ok_and(|t| t.is_file())
        {
            continue;
        }
        let file = entry.path();
        let Some(path) = file.to_str() else { continue };
        let Ok(bytes) = bounded_read(&file, 256 * 1024).map(Zeroizing::new) else {
            continue;
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        if let Ok(key) = PrivateKey::from_openssh(text) {
            keys.push(info(key.public_key(), name, path, true, key.is_encrypted()));
        } else if let Ok(key) = PublicKey::from_openssh(text.trim()) {
            keys.push(info(&key, name, path, false, false));
        } else if text.starts_with("-----BEGIN ") {
            if let Ok(key) = russh::keys::decode_secret_key(text, None) {
                keys.push(info(key.public_key(), name, path, true, false));
            } else if text.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----")
                || text.contains("Proc-Type: 4,ENCRYPTED")
            {
                keys.push(json!({"name": name, "path": path, "type": "SSH", "private": true, "encrypted": true}));
            }
        }
    }
    let pairs: HashMap<_, _> = keys
        .iter()
        .filter(|k| k["private"] == true)
        .filter_map(|k| {
            Some((
                k["path"].as_str()?.to_owned(),
                k["fingerprint"].as_str()?.to_owned(),
            ))
        })
        .collect();
    keys.retain(|k| {
        k["private"] == true
            || k["path"]
                .as_str()
                .and_then(|p| p.strip_suffix(".pub"))
                .and_then(|p| pairs.get(p))
                .is_none_or(|fp| k["fingerprint"] != fp.as_str())
    });
    keys.sort_by(|a, b| {
        b["private"]
            .as_bool()
            .cmp(&a["private"].as_bool())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(json!({"directory": directory, "keys": keys}))
}

fn validate_name(name: &str) -> Result<(), String> {
    static NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,79}$").unwrap());
    if !NAME.is_match(name) || name.ends_with(".pub") {
        return Err("请输入有效的密钥文件名。".into());
    }
    Ok(())
}

pub fn create(directory: &Path, name: &str, private_text: &str, public_text: &str, passphrase: &str) -> Result<Value, String> {
    validate_name(name)?;
    if private_text.len() > 256 * 1024 || private_text.contains('\0') || public_text.len() > 32768 || passphrase.len() > 4096 {
        return Err("密钥内容或口令格式无效。".into());
    }
    let private_text = Zeroizing::new(private_text.trim().replace("\r\n", "\n"));
    let key = russh::keys::decode_secret_key(&private_text, (!passphrase.is_empty()).then_some(passphrase))
        .map_err(|_| "无法读取私钥，请检查内容；加密私钥需要填写正确口令。".to_owned())?;
    if !public_text.trim().is_empty() {
        let public = PublicKey::from_openssh(public_text.trim()).map_err(|_| "公钥格式无效，请填写 OpenSSH 公钥。".to_owned())?;
        if public.fingerprint(HashAlg::Sha256) != key.public_key().fingerprint(HashAlg::Sha256) {
            return Err("公钥与私钥不匹配。".into());
        }
    }
    let encrypted = PrivateKey::from_openssh(&*private_text).is_ok_and(|raw| raw.is_encrypted())
        || private_text.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----") || private_text.contains("Proc-Type: 4,ENCRYPTED");
    let file = directory.join(name);
    let public_path = directory.join(format!("{name}.pub"));
    let pem = Zeroizing::new(format!("{}\n", &*private_text));
    let public = format!("{}\n", key.public_key().to_openssh().map_err(error)?);
    let write_error = |err: std::io::Error| if err.kind() == std::io::ErrorKind::AlreadyExists {
        "已有同名私钥或公钥，请换一个名称。".to_owned()
    } else { error(err) };
    write_exclusive(&file, pem.as_bytes(), 0o600).map_err(write_error)?;
    if let Err(err) = write_exclusive(&public_path, public.as_bytes(), 0o644) {
        let _ = std::fs::remove_file(&file);
        return Err(write_error(err));
    }
    Ok(info(key.public_key(), name, &file.to_string_lossy(), true, encrypted))
}

pub fn generate(directory: &Path, name: &str, passphrase: &str, algorithm: &str, bits: Option<u64>) -> Result<Value, String> {
    validate_name(name)?;
    if passphrase.len() > 1024 || passphrase.contains(['\0', '\r', '\n']) {
        return Err("私钥口令格式无效。".into());
    }
    let data = match (algorithm, bits) {
        ("ed25519", None) => {
            let seed = Zeroizing::new(rand::random::<[u8; 32]>());
            Ed25519Keypair::from_seed(&seed).into()
        }
        ("rsa", None | Some(2048 | 3072 | 4096)) => {
            RsaKeypair::random(&mut rand::rng(), bits.unwrap_or(3072) as usize).map_err(error)?.into()
        }
        ("ecdsa", None | Some(256 | 384 | 521)) => {
            let curve = match bits.unwrap_or(256) {
                384 => EcdsaCurve::NistP384,
                521 => EcdsaCurve::NistP521,
                _ => EcdsaCurve::NistP256,
            };
            EcdsaKeypair::random(&mut rand::rng(), curve).map_err(error)?.into()
        }
        _ => return Err("密钥类型或位数无效。".into()),
    };
    let key = PrivateKey::new(data, name).map_err(error)?;
    let file = directory.join(name);
    let public_path = directory.join(format!("{name}.pub"));
    let public = format!("{}\n", key.public_key().to_openssh().map_err(error)?);
    let encrypted = !passphrase.is_empty();
    let pem = if encrypted {
        key.encrypt(&mut rand::rng(), passphrase)
            .map_err(error)?
            .to_openssh(LineEnding::LF)
    } else {
        key.to_openssh(LineEnding::LF)
    }
    .map_err(error)?;
    write_exclusive(&file, pem.as_bytes(), 0o600).map_err(error)?;
    if let Err(err) = write_exclusive(&public_path, public.as_bytes(), 0o644) {
        let _ = std::fs::remove_file(&file);
        return Err(error(err));
    }
    Ok(info(
        key.public_key(),
        name,
        &file.to_string_lossy(),
        true,
        encrypted,
    ))
}

pub fn copy(value: &str) -> Result<(), String> {
    #[cfg(windows)]
    return crate::platform::windows::copy_text(value);
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("/usr/bin/pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(error)?;
        child
            .stdin
            .take()
            .ok_or("无法访问剪贴板。")?
            .write_all(value.as_bytes())
            .map_err(error)?;
        if child.wait().map_err(error)?.success() {
            return Ok(());
        }
    }
    #[cfg(not(windows))]
    Err("无法访问系统剪贴板。".into())
}

#[derive(Default)]
struct Block {
    aliases: Vec<String>,
    defaults: bool,
    settings: HashMap<String, String>,
}

pub fn import_config(text: &str, home: &Path) -> Value {
    static LINE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*(?:=\s*|\s+)(.*)$").unwrap());
    static TOKEN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#""((?:\\.|[^"\\])*)"|'([^']*)'|(#.*$)|([^\s#]+)"#).unwrap());
    let mut blocks = vec![Block {
        defaults: true,
        ..Default::default()
    }];
    let mut warnings = Vec::new();
    for line in text.lines().filter_map(|line| LINE.captures(line)) {
        let key = line[1].to_ascii_lowercase();
        let values: Vec<_> = TOKEN
            .captures_iter(&line[2])
            .take_while(|m| m.get(3).is_none())
            .filter_map(|m| {
                m.get(1)
                    .or_else(|| m.get(2))
                    .or_else(|| m.get(4))
                    .map(|v| v.as_str().replace("\\\"", "\"").replace("\\\\", "\\"))
            })
            .collect();
        match key.as_str() {
            "host" => {
                let defaults = values.len() == 1 && values[0] == "*";
                let complex = !defaults && values.iter().any(|v| v.contains(['*', '?', '!']));
                if complex {
                    warnings.push("已跳过通配符或否定 Host 条目。");
                }
                blocks.push(Block {
                    aliases: if complex || defaults { vec![] } else { values },
                    defaults,
                    settings: HashMap::new(),
                });
            }
            "match" => {
                warnings.push("已跳过 Match 条件块。");
                blocks.push(Block::default());
            }
            "include" => warnings.push("Include 文件需单独选择导入。"),
            _ => {
                if let Some(value) = values.into_iter().next() {
                    blocks
                        .last_mut()
                        .unwrap()
                        .settings
                        .entry(key)
                        .or_insert(value);
                }
            }
        }
    }
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for alias in blocks
        .iter()
        .flat_map(|b| &b.aliases)
        .filter(|alias| seen.insert(*alias))
        .take(1000)
    {
        let mut settings = HashMap::new();
        for block in &blocks {
            if block.defaults || block.aliases.iter().any(|a| a.eq_ignore_ascii_case(alias)) {
                for (key, value) in &block.settings {
                    settings.entry(key.as_str()).or_insert(value.as_str());
                }
            }
        }
        let address = settings.get("hostname").copied().unwrap_or(alias);
        let key = settings
            .get("identityfile")
            .filter(|path| !path.contains(['%', '$']))
            .map(|path| {
                path.strip_prefix("~/")
                    .map(|suffix| home.join(suffix))
                    .unwrap_or_else(|| PathBuf::from(path))
            })
            .filter(|path| path.is_absolute());
        let port = settings
            .get("port")
            .map(|p| p.parse::<u16>().unwrap_or(0))
            .unwrap_or(22);
        let user = settings.get("user").copied().unwrap_or("");
        let route = ["proxyjump", "proxycommand"].iter().any(|key| {
            settings
                .get(key)
                .is_some_and(|v| !v.eq_ignore_ascii_case("none"))
        });
        let invalid = address.is_empty()
            || address.contains(['%', '@', '\\', '/'])
            || address.contains(char::is_whitespace);
        let issue = if route {
            "需要跳板机或代理"
        } else if invalid {
            "主机地址含未解析参数"
        } else if port == 0 {
            "端口无效"
        } else if user.is_empty() {
            "需要填写 SSH 用户名"
        } else {
            ""
        };
        rows.push(json!({"name": alias, "address": address, "username": user, "port": port, "auth": if key.is_some() {"key"} else {"agent"},
            "keyPath": key.unwrap_or_default(), "issue": issue, "editable": user.is_empty() && !invalid && !route && port != 0}));
    }
    warnings.sort_unstable();
    warnings.dedup();
    json!({"rows": rows, "warnings": warnings})
}
