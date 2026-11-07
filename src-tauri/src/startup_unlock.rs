use crate::{error, vault::Key};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub const FAILED: &str = "本机自动解锁失败，请使用主密码、恢复密钥或触控 ID 解锁。";
#[cfg(target_os = "macos")]
const SERVICE: &str = "app.termlume.desktop vault startup unlock";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credential {
    pub vault_id: Uuid,
    pub token: Uuid,
}

impl Credential {
    pub fn account(&self, settings: &Path) -> Result<String, String> {
        let directory = settings
            .parent()
            .ok_or("工作区路径无效。")?
            .canonicalize()
            .map_err(error)?;
        serde_json::to_string(&(directory, self.vault_id, self.token)).map_err(error)
    }
}

pub fn save(account: &str, key: &Key) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return security_framework::passwords::set_generic_password(SERVICE, account, &key[..])
            .map_err(|_| "无法将自动解锁凭据保存到系统钥匙串。".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (account, key);
        Err("当前平台暂不支持本机自动解锁。".into())
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn termlume_startup_key_read(
        service: *const std::ffi::c_char,
        account: *const std::ffi::c_char,
        output: *mut u8,
    ) -> bool;
}

pub fn read(account: &str) -> Result<Key, String> {
    #[cfg(target_os = "macos")]
    {
        let service = std::ffi::CString::new(SERVICE).map_err(error)?;
        let account = std::ffi::CString::new(account).map_err(error)?;
        let mut key = Key::default();
        // This noninteractive query writes exactly 32 bytes only on success.
        if unsafe {
            termlume_startup_key_read(service.as_ptr(), account.as_ptr(), key.as_mut_ptr())
        } {
            return Ok(key);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = account;
    Err(FAILED.into())
}

pub fn delete(account: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return match security_framework::passwords::delete_generic_password(SERVICE, account) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == -25300 => Ok(()), // errSecItemNotFound
            Err(_) => Err("无法删除系统钥匙串中的自动解锁凭据，请重试。".into()),
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        Err("当前平台暂不支持本机自动解锁。".into())
    }
}
