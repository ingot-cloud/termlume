use crate::vault::Key;

pub const MAX_CREDENTIAL: u64 = 4096;
pub const UNLOCK_FAILED: &str =
    "触控 ID 解锁失败。可重试，或使用主密码或恢复密钥解锁后重新设置触控 ID。";

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn termlume_touch_id_available() -> bool;
    fn termlume_touch_id_enroll(key: *const u8, output: *mut u8, capacity: usize) -> usize;
    fn termlume_touch_id_open(credential: *const u8, length: usize, output: *mut u8) -> bool;
}

pub fn available() -> bool {
    #[cfg(target_os = "macos")]
    // The Swift bridge performs the OS version and hardware checks.
    return unsafe { termlume_touch_id_available() };
    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(target_os = "macos")]
pub fn enroll(key: &Key) -> Result<Vec<u8>, String> {
    let mut credential = vec![0; MAX_CREDENTIAL as usize];
    // The bridge reads the 32-byte key and writes at most the given capacity.
    let len = unsafe {
        termlume_touch_id_enroll(key.as_ptr(), credential.as_mut_ptr(), credential.len())
    };
    if !(1..=credential.len()).contains(&len) {
        return Err("触控 ID 设置失败，请重试。".into());
    }
    credential.truncate(len);
    Ok(credential)
}

#[cfg(not(target_os = "macos"))]
pub fn enroll(_: &Key) -> Result<Vec<u8>, String> {
    Err("触控 ID 当前不可用。".into())
}

#[cfg(target_os = "macos")]
pub fn open(credential: &[u8]) -> Result<Key, String> {
    let mut key = Key::default();
    // The bridge reads this credential slice and writes exactly 32 bytes on success.
    if unsafe { termlume_touch_id_open(credential.as_ptr(), credential.len(), key.as_mut_ptr()) } {
        return Ok(key);
    }
    Err(UNLOCK_FAILED.into())
}

#[cfg(not(target_os = "macos"))]
pub fn open(_: &[u8]) -> Result<Key, String> {
    Err(UNLOCK_FAILED.into())
}
