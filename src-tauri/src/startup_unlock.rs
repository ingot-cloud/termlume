use crate::{error, vault::{self, Key, Sealed}};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub const FAILED: &str = "本机自动解锁失败，请使用主密码、恢复密钥或触控 ID 解锁。";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProtectedKey {
    version: u32,
    payload: Sealed,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credential {
    pub vault_id: Uuid,
    pub token: Uuid,
    // Absent only in old Keychain-backed settings, retained for migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protected: Option<ProtectedKey>,
}

impl Credential {
    pub fn new(vault_id: Uuid) -> Self {
        Self { vault_id, token: Uuid::new_v4(), protected: None }
    }
    pub fn is_legacy(&self) -> bool { self.protected.is_none() }

    pub fn account(&self, settings: &Path) -> Result<String, String> {
        let directory = settings.parent().ok_or("工作区路径无效。")?
            .canonicalize().map_err(error)?;
        serde_json::to_string(&(directory, self.vault_id, self.token)).map_err(error)
    }

    fn context(&self, settings: &Path) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&("termlume-startup-unlock", 1, self.account(settings)?)).map_err(error)
    }

    pub fn protect(&self, settings: &Path, device_key: &Key, key: &Key) -> Result<Self, String> {
        Ok(Self {
            vault_id: self.vault_id,
            token: self.token,
            protected: Some(ProtectedKey {
                version: 1,
                payload: vault::seal(device_key, &key[..], &self.context(settings)?)?,
            }),
        })
    }

    pub fn open(&self, settings: &Path, device_key: &Key) -> Result<Key, String> {
        let protected = self.protected.as_ref().ok_or(FAILED)?;
        if protected.version != 1 { return Err(FAILED.into()); }
        let bytes = vault::open(device_key, &protected.payload, &self.context(settings)?)?;
        let mut key = Key::default();
        if bytes.len() != key.len() { return Err(FAILED.into()); }
        key.copy_from_slice(&bytes);
        Ok(key)
    }
}
