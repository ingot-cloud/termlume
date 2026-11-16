use std::{fs::File, io::Read, path::Path};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MAX_DOCUMENT: u64 = 8 * 1024 * 1024;
const FORMAT: &str = "termlume-vault";
const INVALID: &str = "保险库格式或版本无效。";
const UNLOCK_FAILED: &str = "无法解锁保险库，请核对主密码或恢复密钥。";
pub type Key = Zeroizing<[u8; 32]>;

// Local encryption does not enable the optional master-password vault. Its random
// device key is stored separately; a protected workspace uses the vault key instead.
const LOCAL_FORMAT: &str = "termlume-local-workspace";
#[derive(Deserialize, Serialize)]
struct LocalEnvelope {
    format: String,
    version: u32,
    payload: Sealed,
}

// Version 2 binds manual ordering to the encrypted format. Older clients reject it
// rather than silently dropping unknown ordering fields when rewriting a snapshot.
fn document_version(plaintext: &[u8]) -> u32 {
    // Deserialize only metadata: never duplicate credential strings into an unprotected Value.
    #[derive(Default, Deserialize)]
    #[serde(default, rename_all = "camelCase")]
    struct Position { sort_order: Option<u32> }
    #[derive(Deserialize)]
    struct Asset { kind: String, value: Position }
    #[derive(Default, Deserialize)]
    #[serde(default, rename_all = "camelCase")]
    struct Row { sort_order: Option<u32>, asset: Option<Asset> }
    #[derive(Default, Deserialize)]
    #[serde(default, rename_all = "camelCase")]
    struct Document { hosts: Vec<Row>, groups: Vec<Position>, sync_preferences: bool }
    let value = serde_json::from_slice::<Document>(plaintext).unwrap_or_default();
    if value.sync_preferences || value.hosts.iter().any(|h| h.asset.as_ref().is_some_and(|a| a.kind == "preferences")) { return 3; }
    let ordered = value.groups.iter().any(|g| g.sort_order.is_some()) || value.hosts.iter().any(|h| {
        h.sort_order.is_some() || h.asset.as_ref().is_some_and(|a| a.value.sort_order.is_some())
    });
    if ordered { 2 } else { 1 }
}

pub fn encode_local(key: &Key, value: &impl Serialize) -> Result<Vec<u8>, String> {
    let plaintext = Zeroizing::new(serde_json::to_vec(value).map_err(crate::error)?);
    if plaintext.len() > 5 * 1024 * 1024 {
        return Err("工作区数据超过大小上限。".into());
    }
    let version = document_version(&plaintext);
    serde_json::to_vec(&LocalEnvelope {
        format: LOCAL_FORMAT.into(),
        version,
        payload: seal(key, &plaintext, format!("termlume-local-workspace:v{}", version).as_bytes())?,
    }).map_err(crate::error)
}

pub fn decode_local<T: DeserializeOwned>(key: &Key, bytes: &[u8]) -> Result<T, String> {
    let envelope: LocalEnvelope = serde_json::from_slice(bytes).map_err(crate::error)?;
    if envelope.format != LOCAL_FORMAT || !matches!(envelope.version, 1 | 2 | 3) {
        return Err("本机工作区格式或版本无效。".into());
    }
    let plaintext = open(key, &envelope.payload, format!("termlume-local-workspace:v{}", envelope.version).as_bytes())
        .map_err(|_| "无法解密本机工作区，数据或本机密钥已损坏。".to_string())?;
    serde_json::from_slice(&plaintext).map_err(crate::error)
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Envelope {
    format: String,
    version: u32,
    scope: String,
    pub header: Header,
    payload: Sealed,
}

const GIT_FORMAT: &str = "termlume-git-vault";

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum GitEnvelope {
    Legacy(Envelope),
    Protected(ProtectedGitEnvelope),
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedGitEnvelope {
    format: String,
    version: u32,
    payload: Sealed,
}

// The inner envelope is base64-encoded before the outer layer is sealed.
pub const MAX_GIT_DOCUMENT: u64 = 12 * 1024 * 1024;

pub fn git_key(secret: &str) -> Result<Key, String> {
    recovery_key(secret).map_err(|_| "Git 同步密钥格式无效。".into())
}

impl GitEnvelope {
    #[cfg(test)]
    pub fn protect(envelope: &Envelope, key: &Key) -> Result<Self, String> {
        let bytes = serde_json::to_vec(envelope).map_err(crate::error)?;
        if bytes.len() as u64 > MAX_DOCUMENT {
            return Err("保险库数据超过大小上限。".into());
        }
        Ok(Self::Protected(ProtectedGitEnvelope {
            format: GIT_FORMAT.into(),
            version: 1,
            payload: seal(key, &bytes, b"termlume-git-vault:v1")?,
        }))
    }

    pub fn is_protected(&self) -> bool {
        matches!(self, Self::Protected(_))
    }

    pub fn open(&self, key: Option<&Key>) -> Result<Envelope, String> {
        match self {
            Self::Legacy(envelope) => Ok(envelope.clone()),
            Self::Protected(envelope) => {
                if envelope.format != GIT_FORMAT || envelope.version != 1 {
                    return Err(INVALID.into());
                }
                let key = key.ok_or("请输入这套保险库的旧版同步密钥。")?;
                let bytes = open_with_limit(
                    key,
                    &envelope.payload,
                    b"termlume-git-vault:v1",
                    MAX_GIT_DOCUMENT,
                )
                .map_err(|_| "无法解开旧 Git 快照，请核对旧版同步密钥。")?;
                if bytes.len() as u64 > MAX_DOCUMENT {
                    return Err(INVALID.into());
                }
                serde_json::from_slice(&bytes).map_err(crate::error)
            }
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Header {
    pub id: Uuid,
    salt: String,
    password: Sealed,
    recovery: Sealed,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Sealed {
    nonce: String,
    ciphertext: String,
}

pub fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(crate::error)?;
    if !file.metadata().map_err(crate::error)?.is_file() {
        return Err("请选择普通文件。".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(crate::error)?;
    if bytes.len() as u64 > limit {
        return Err("文件超过允许的大小。".into());
    }
    Ok(bytes)
}

pub fn recovery_code() -> String {
    B64.encode(rand::random::<[u8; 32]>())
}

pub fn recovery_key(secret: &str) -> Result<Key, String> {
    let mut key = Zeroizing::new([0; 32]);
    if B64.decode_slice(secret.trim(), &mut *key).ok() != Some(32) {
        return Err("恢复密钥格式无效。".into());
    }
    Ok(key)
}

fn password_key(password: &str, salt: &[u8]) -> Result<Key, String> {
    if password.is_empty() || password.encode_utf16().count() > 1024 || salt.len() != 16 {
        return Err(UNLOCK_FAILED.into());
    }
    let mut key = Zeroizing::new([0; 32]);
    let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(crate::error)?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut *key)
        .map_err(crate::error)?;
    Ok(key)
}

pub fn create(password: &str, recovery: &str) -> Result<(Key, Header), String> {
    if password.encode_utf16().count() < 8 {
        return Err("主密码至少需要 8 个字符。".into());
    }
    let id = Uuid::new_v4();
    let salt = rand::random::<[u8; 16]>();
    let key = Zeroizing::new(rand::random::<[u8; 32]>());
    let password_key = password_key(password, &salt)?;
    let recovery = recovery_key(recovery)?;
    let header = Header {
        id,
        salt: B64.encode(salt),
        password: seal(
            &password_key,
            &key[..],
            format!("termlume:v1:{id}:password").as_bytes(),
        )?,
        recovery: seal(
            &recovery,
            &key[..],
            format!("termlume:v1:{id}:recovery").as_bytes(),
        )?,
    };
    Ok((key, header))
}

// Rewrap the existing data key: recovery, biometrics and other devices keep
// referring to the same vault. The payload must be re-encoded with this header.
pub fn change_password(key: &Key, header: &Header, password: &str) -> Result<Header, String> {
    if password.encode_utf16().count() < 8 {
        return Err("主密码至少需要 8 个字符。".into());
    }
    let salt = rand::random::<[u8; 16]>();
    let wrapping = password_key(password, &salt)?;
    let mut next = header.clone();
    next.salt = B64.encode(salt);
    next.password = seal(&wrapping, &key[..], format!("termlume:v1:{}:password", header.id).as_bytes())?;
    Ok(next)
}

impl Envelope {
    pub fn validate(&self, scope: &str) -> Result<(), String> {
        if self.format != FORMAT || !matches!(self.version, 1 | 2 | 3) || self.scope != scope {
            return Err(INVALID.into());
        }
        Ok(())
    }

    pub fn unlock<T: DeserializeOwned>(
        &self,
        secret: &str,
        recovery: bool,
        scope: &str,
    ) -> Result<(Key, T), String> {
        self.validate(scope)?;
        let result = (|| {
            let (slot, sealed, wrapping) = if recovery {
                ("recovery", &self.header.recovery, recovery_key(secret)?)
            } else {
                let salt = B64.decode(&self.header.salt).map_err(crate::error)?;
                (
                    "password",
                    &self.header.password,
                    password_key(secret, &salt)?,
                )
            };
            let bytes = open(
                &wrapping,
                sealed,
                format!("termlume:v1:{}:{slot}", self.header.id).as_bytes(),
            )?;
            let mut key = Zeroizing::new([0; 32]);
            if bytes.len() != key.len() {
                return Err(INVALID.into());
            }
            key.copy_from_slice(&bytes);
            let data = self.decode(&key, scope)?;
            Ok((key, data))
        })();
        result.map_err(|_: String| UNLOCK_FAILED.into())
    }

    pub fn decode<T: DeserializeOwned>(&self, key: &Key, scope: &str) -> Result<T, String> {
        self.validate(scope)?;
        let plaintext = open(key, &self.payload, &context(&self.header, scope, self.version)?)?;
        serde_json::from_slice(&plaintext).map_err(crate::error)
    }
}

pub fn encode(
    key: &Key,
    header: &Header,
    scope: &str,
    value: &impl Serialize,
) -> Result<Envelope, String> {
    let plaintext = Zeroizing::new(serde_json::to_vec(value).map_err(crate::error)?);
    if plaintext.len() > 5 * 1024 * 1024 {
        return Err("保险库数据超过大小上限。".into());
    }
    let version = document_version(&plaintext);
    Ok(Envelope {
        format: FORMAT.into(),
        version,
        scope: scope.into(),
        header: header.clone(),
        payload: seal(key, &plaintext, &context(header, scope, version)?)?,
    })
}

fn context(h: &Header, scope: &str, version: u32) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&(
        FORMAT,
        version,
        scope,
        h.id,
        &h.salt,
        &h.password.nonce,
        &h.password.ciphertext,
        &h.recovery.nonce,
        &h.recovery.ciphertext,
    ))
    .map_err(crate::error)
}

pub(crate) fn seal(key: &Key, plaintext: &[u8], aad: &[u8]) -> Result<Sealed, String> {
    let nonce = rand::random::<[u8; 24]>();
    let ciphertext = XChaCha20Poly1305::new((&**key).into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(crate::error)?;
    Ok(Sealed {
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })
}

pub(crate) fn open(key: &Key, sealed: &Sealed, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    open_with_limit(key, sealed, aad, MAX_DOCUMENT)
}

fn open_with_limit(
    key: &Key,
    sealed: &Sealed,
    aad: &[u8],
    limit: u64,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce = B64.decode(&sealed.nonce).map_err(crate::error)?;
    if nonce.len() != 24 || sealed.ciphertext.len() as u64 > limit {
        return Err(INVALID.into());
    }
    let data = B64.decode(&sealed.ciphertext).map_err(crate::error)?;
    XChaCha20Poly1305::new((&**key).into())
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: &data, aad })
        .map(Zeroizing::new)
        .map_err(crate::error)
}
