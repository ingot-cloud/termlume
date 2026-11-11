use crate::{
    git,
    store::{GitSettings, Row},
    Workspace,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const CHANGE_DELAY: Duration = Duration::from_secs(10);

pub fn configure(ws: &Workspace, settings: GitSettings) -> Result<Value, String> {
    if !matches!(settings.interval_minutes, 0 | 5 | 15 | 30 | 60) {
        return Err("同步频率须为 5、15、30 或 60 分钟，也可以关闭定时同步。".into());
    }
    let _permit = ws.sync_gate.try_lock().map_err(|_| "请等待同步完成。")?;
    let mut store = ws.store.lock().unwrap();
    let mut data = store.data()?.clone();
    if store.key.is_none() || data.sync.is_none() {
        return Err("请先绑定 Git 仓库。".into());
    }
    if settings.paused && data.git_migration.is_some() {
        return Err("请先继续或放弃待完成的 Git 迁移。".into());
    }
    data.git_settings = settings;
    store.update(data)?;
    drop(store);
    Ok(ws.vault_status())
}

struct Schedule {
    epoch: u64,
    settings: GitSettings,
    last_synced: Option<u64>,
    revision: Option<u64>,
    snapshot_hash: Option<[u8; 32]>,
    changed_at: Option<Instant>,
    periodic_at: Option<Instant>,
    opening: bool,
}

impl Schedule {
    fn new(epoch: u64, settings: GitSettings, opening: bool, now: Instant) -> Self {
        let mut schedule = Self {
            epoch,
            settings,
            last_synced: None,
            revision: None,
            snapshot_hash: None,
            changed_at: None,
            periodic_at: None,
            opening,
        };
        schedule.reset_interval(now);
        schedule
    }

    fn reset_interval(&mut self, now: Instant) {
        self.periodic_at = (self.settings.interval_minutes != 0)
            .then(|| now + Duration::from_secs(u64::from(self.settings.interval_minutes) * 60));
    }

    fn observe(
        &mut self,
        revision: u64,
        last_synced: Option<u64>,
        now: Instant,
        snapshot: impl FnOnce() -> Vec<Row>,
        base: &[Row],
    ) -> bool {
        if self.last_synced != last_synced {
            self.last_synced = last_synced;
            self.reset_interval(now);
        }
        if self.settings.after_changes && self.revision != Some(revision) {
            let next = snapshot();
            if next == base {
                self.changed_at = None;
                self.snapshot_hash = None;
            } else {
                // Keep only a digest between ticks, never an unlocked copy of the rows.
                let hash = serde_json::to_vec(&next)
                    .ok()
                    .map(Zeroizing::new)
                    .map(|bytes| Sha256::digest(bytes.as_slice()).into());
                if self.changed_at.is_none() || hash != self.snapshot_hash {
                    self.changed_at = Some(now + CHANGE_DELAY);
                }
                self.snapshot_hash = hash;
            }
            self.revision = Some(revision);
        }
        self.opening
            || self.periodic_at.is_some_and(|at| now >= at)
            || self.changed_at.is_some_and(|at| now >= at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn portable_edits_debounce_and_a_manual_sync_resets_the_interval() {
        let row = |name| {
            serde_json::from_value::<Row>(json!({
                "id": "db6483f4-b3cc-4d62-a61c-754dca119e48", "name": name,
                "address": "example.test", "port": 22, "username": "ops", "auth": "agent"
            }))
            .unwrap()
        };
        let settings = GitSettings {
            after_changes: true,
            interval_minutes: 5,
            ..Default::default()
        };
        let start = Instant::now();
        let mut schedule = Schedule::new(1, settings, false, start);
        let first = row("first");
        let second = row("second");
        let base = [row("original")];
        let at = |seconds| start + Duration::from_secs(seconds);
        assert!(!schedule.observe(1, Some(1), at(0), || vec![first], &base));
        assert!(!schedule.observe(2, Some(1), at(9), || vec![second.clone()], &base));
        assert!(!schedule.observe(3, Some(1), at(18), || vec![second.clone()], &base));
        assert!(schedule.observe(3, Some(1), at(19), || vec![second.clone()], &base));

        let synced = [second];
        assert!(!schedule.observe(4, Some(2), at(20), || synced.to_vec(), &synced));
        assert!(!schedule.observe(4, Some(2), at(300), || synced.to_vec(), &synced));
        assert!(schedule.observe(4, Some(2), at(320), || synced.to_vec(), &synced));
    }
}

pub async fn run(ws: Workspace) {
    let mut open_epoch = None;
    let mut schedule: Option<Schedule> = None;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let (epoch, settings) = {
            let store = ws.store.lock().unwrap();
            let opening = store.key.is_some() && open_epoch != Some(store.epoch);
            open_epoch = store.key.as_ref().map(|_| store.epoch);
            let Some(data) = store.data.as_ref() else {
                schedule = None;
                continue;
            };
            let settings = data.git_settings;
            let Some(binding) = data.sync.as_ref().filter(|binding| {
                binding.commit.is_some()
                    && !settings.paused
                    && data.git_migration.is_none()
                    && (settings.on_unlock
                        || settings.after_changes
                        || settings.interval_minutes != 0)
            }) else {
                schedule = None;
                continue;
            };
            if ws.sync_attention.lock().unwrap().is_some() || ws.conflict.lock().unwrap().is_some()
            {
                schedule = None;
                continue;
            }
            let now = Instant::now();
            if schedule
                .as_ref()
                .is_none_or(|s| s.epoch != store.epoch || s.settings != settings)
            {
                schedule = Some(Schedule::new(
                    store.epoch,
                    settings,
                    opening && settings.on_unlock,
                    now,
                ));
            }
            if !schedule.as_mut().unwrap().observe(
                store.revision,
                binding.last_synced,
                now,
                || data.snapshot(),
                &binding.base,
            ) {
                continue;
            }
            (store.epoch, settings)
        };
        if git::synchronize_automatically(&ws, epoch, settings).await {
            let schedule = schedule.as_mut().unwrap();
            schedule.opening = false;
            schedule.changed_at = None;
            schedule.revision = None;
            schedule.reset_interval(Instant::now());
        }
    }
}
