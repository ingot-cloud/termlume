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

#[derive(Clone, Deserialize, Serialize)]
pub struct Envelope {
    format: String,
    version: u32,
    scope: String,
    pub header: Header,
    payload: Sealed,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Header {
    pub id: Uuid,
    salt: String,
    password: Sealed,
    recovery: Sealed,
}

#[derive(Clone, Deserialize, Serialize)]
struct Sealed {
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
    if password.encode_utf16().count() < 12 {
        return Err("主密码至少需要 12 个字符。".into());
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

impl Envelope {
    pub fn validate(&self, scope: &str) -> Result<(), String> {
        if self.format != FORMAT || self.version != 1 || self.scope != scope {
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
        let plaintext = open(key, &self.payload, &context(&self.header, scope)?)?;
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
    Ok(Envelope {
        format: FORMAT.into(),
        version: 1,
        scope: scope.into(),
        header: header.clone(),
        payload: seal(key, &plaintext, &context(header, scope)?)?,
    })
}

fn context(h: &Header, scope: &str) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&(
        FORMAT,
        1,
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

fn seal(key: &Key, plaintext: &[u8], aad: &[u8]) -> Result<Sealed, String> {
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

fn open(key: &Key, sealed: &Sealed, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce = B64.decode(&sealed.nonce).map_err(crate::error)?;
    if nonce.len() != 24 || sealed.ciphertext.len() as u64 > MAX_DOCUMENT {
        return Err(INVALID.into());
    }
    let data = B64.decode(&sealed.ciphertext).map_err(crate::error)?;
    XChaCha20Poly1305::new((&**key).into())
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: &data, aad })
        .map(Zeroizing::new)
        .map_err(crate::error)
}
